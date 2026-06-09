import { loadSecretsFromSsm } from '../secrets';
import * as zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { sql } from 'drizzle-orm';
import { createLambdaDb } from '../db';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  loadVaultCredentials,
  getVaultAccessToken,
  pollVaultExport,
  downloadExportFile,
  closeVaultMatter,
  VAULT_CUSTODIAN_EMAILS,
} from '@/lib/services/googleVaultService';
import { inferCustodianFromEntry, buildS3Key } from '../handlers/vaultArchive';
import { S3_MBOX_BUCKET } from '@/lib/s3';
import { MboxFileRepository } from '../repositories';

const log = (msg: string) => console.log(`[vault-archive-poll] ${msg}`);

interface VaultExportsRow extends Record<string, unknown> {
  id: string;
  matter_id: string;
  export_id: string;
  window_start: string;
  window_end: string;
  mode: string;
}

async function setStatus(
  db: Awaited<ReturnType<typeof createLambdaDb>>['db'],
  id: string,
  status: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE analytics.vault_exports
        SET status = ${status}, updated_at = now()
        WHERE id = ${id}`,
  );
}

export const handler = async (
  _event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; action: string }> => {
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  const mboxRepo = new MboxFileRepository(db as never);

  try {
    // 1. Pick ONE row to process (oldest first).
    const [row] = await db.execute<VaultExportsRow>(
      sql`SELECT id, matter_id, export_id, window_start, window_end, mode
          FROM analytics.vault_exports
          WHERE status = 'exporting'
          ORDER BY created_at
          LIMIT 1`,
    );

    if (!row) {
      log('no in-flight exports');
      return { ok: true, action: 'idle' };
    }

    log(`processing export ${row.export_id} matter ${row.matter_id}`);

    const creds = loadVaultCredentials();
    const subject = process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
    const token = await getVaultAccessToken(creds, subject);

    // 2. Poll the export status exactly once.
    const status = await pollVaultExport(token, row.matter_id, row.export_id);
    log(`poll result: ${status.status}`);

    if (status.status === 'IN_PROGRESS') {
      // Still running — return and let EventBridge call us again.
      return { ok: true, action: 'waiting' };
    }

    if (status.status === 'FAILED') {
      // EVERY terminal path must close the matter.
      try {
        await closeVaultMatter(token, row.matter_id);
      } catch (err) {
        console.error(`[vault-archive-poll] failed to close matter ${row.matter_id}:`, err);
      }
      await setStatus(db, row.id, 'failed');
      log(`export FAILED — matter closed, status=failed`);
      return { ok: true, action: 'failed' };
    }

    // status.status === 'COMPLETED'
    const region = process.env.AWS_REGION || 'ap-southeast-3';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials not configured');
    const endpoint = process.env.AWS_S3_ENDPOINT;
    const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';

    const s3 = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint, forcePathStyle } : {}),
    });

    const windowStart = new Date(row.window_start);
    const year = windowStart.getUTCFullYear();
    const month = windowStart.getUTCMonth() + 1;
    const day = row.mode === 'daily' ? windowStart.getUTCDate() : undefined;
    const windowStartIso = row.window_start;
    const windowEndIso = row.window_end;

    let filesUploaded = 0;

    try {
      for (const file of status.files) {
        if (!file.objectName.endsWith('.zip')) continue;
        log(`downloading ${file.objectName}`);
        const zipBuffer = await downloadExportFile(token, file);

        let zip: AdmZip;
        try {
          zip = new AdmZip(zipBuffer);
        } catch (err) {
          console.error(`[vault-archive-poll] failed to open zip ${file.objectName}:`, err);
          throw err;
        }

        const mboxEntries = zip.getEntries().filter((e) => e.entryName.endsWith('.mbox'));
        log(`${file.objectName}: ${mboxEntries.length} MBOX entries`);

        for (const entry of mboxEntries) {
          const mboxBuffer = entry.getData();
          const uncompressedSize = mboxBuffer.length;
          const gzipped = zlib.gzipSync(mboxBuffer);
          const compressedSize = gzipped.length;

          const basename = entry.entryName.split('/').pop() ?? entry.entryName;
          const custodian = inferCustodianFromEntry(entry.entryName, VAULT_CUSTODIAN_EMAILS);
          const s3Key = buildS3Key(year, month, row.mode as 'monthly' | 'daily', custodian, row.export_id, basename, day);

          // Use @aws-sdk/lib-storage Upload for multipart S3 upload.
          const upload = new Upload({
            client: s3,
            params: {
              Bucket: S3_MBOX_BUCKET,
              Key: s3Key,
              Body: Readable.from(gzipped),
              ContentType: 'application/x-mbox',
              ContentEncoding: 'gzip',
            },
          });
          await upload.done();
          log(`uploaded ${s3Key} (${compressedSize} bytes compressed)`);

          await mboxRepo.insert({
            source: 'vault',
            s3_bucket: S3_MBOX_BUCKET,
            s3_key: s3Key,
            size_bytes: compressedSize,
            uncompressed_size_bytes: uncompressedSize,
            custodian_email: custodian,
            window_start: windowStartIso,
            window_end: windowEndIso,
            vault_matter_id: row.matter_id,
            vault_export_id: row.export_id,
            mode: row.mode,
            job_id: null,
            parse_status: 'pending',
          });

          filesUploaded++;
        }
      }
    } catch (err) {
      // Even on upload failure, close the matter (terminal path).
      try {
        await closeVaultMatter(token, row.matter_id);
      } catch (closeErr) {
        console.error(`[vault-archive-poll] failed to close matter on error:`, closeErr);
      }
      await setStatus(db, row.id, 'failed');
      throw err;
    }

    // COMPLETED terminal path — close matter, set archived.
    try {
      await closeVaultMatter(token, row.matter_id);
    } catch (err) {
      console.error(`[vault-archive-poll] failed to close matter after archive (non-fatal):`, err);
    }
    await setStatus(db, row.id, 'archived');
    log(`archived ${filesUploaded} files, status=archived`);
    return { ok: true, action: 'archived' };
  } finally {
    await pgClient.end();
  }
};
