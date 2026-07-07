import { loadSecretsFromSsm } from '../secrets';
import * as zlib from 'node:zlib';
import { sql } from 'drizzle-orm';
import { createLambdaDb } from '../db';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client } from '@aws-sdk/client-s3';
import { Transform } from 'node:stream';
import * as unzipper from 'unzipper';
import {
  loadVaultCredentials,
  getVaultAccessToken,
  pollVaultExport,
  downloadExportFileStream,
  closeVaultMatter,
  type VaultExportFile,
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
  // Snapshot of the custodian list resolved by vault-archive-start at
  // creation time — used (not a fresh DB lookup) so entries are matched
  // against exactly what was requested for this export, even if a custodian
  // mailbox is un-synced between start and poll.
  custodian_emails: string[];
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

async function claimForProcessing(
  db: Awaited<ReturnType<typeof createLambdaDb>>['db'],
  id: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`UPDATE analytics.vault_exports
        SET status = 'processing', updated_at = now()
        WHERE id = ${id}
          AND status = 'exporting'
        RETURNING id`,
  );
  return rows.length > 0;
}

function byteCounter(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

async function processZipFile(
  opts: {
    token: string;
    file: VaultExportFile;
    row: VaultExportsRow;
    s3: S3Client;
    mboxRepo: MboxFileRepository;
    year: number;
    month: number;
    day?: number;
    windowStartIso: string;
    windowEndIso: string;
  },
): Promise<number> {
  let filesUploaded = 0;
  let mboxEntries = 0;

  const zipStream = await downloadExportFileStream(opts.token, opts.file);
  const parser = zipStream.pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of parser) {
    const entryPath = entry.path;
    if (entry.type === 'Directory' || !entryPath.endsWith('.mbox')) {
      await entry.autodrain().promise();
      continue;
    }

    mboxEntries++;
    const gzip = zlib.createGzip();
    let compressedSize = 0;
    const compressedCounter = byteCounter((bytes) => {
      compressedSize += bytes;
    });

    const basename = entryPath.split('/').pop() ?? entryPath;
    const custodian = inferCustodianFromEntry(entryPath, opts.row.custodian_emails);
    const s3Key = buildS3Key(
      opts.year,
      opts.month,
      opts.row.mode as 'monthly' | 'daily',
      custodian,
      opts.row.export_id,
      basename,
      opts.day,
    );

    const uploadBody = entry.pipe(gzip).pipe(compressedCounter);
    const upload = new Upload({
      client: opts.s3,
      params: {
        Bucket: S3_MBOX_BUCKET,
        Key: s3Key,
        Body: uploadBody,
        ContentType: 'application/x-mbox',
        ContentEncoding: 'gzip',
      },
    });
    await upload.done();
    log(`uploaded ${s3Key} (${compressedSize} bytes compressed)`);
    const uncompressedSize =
      (entry.vars as { uncompressedSize?: number }).uncompressedSize ??
      entry.extra?.uncompressedSize ??
      null;

    const inserted = await opts.mboxRepo.insertIgnore({
      source: 'vault',
      s3_bucket: S3_MBOX_BUCKET,
      s3_key: s3Key,
      size_bytes: compressedSize,
      uncompressed_size_bytes: uncompressedSize,
      custodian_email: custodian,
      window_start: opts.windowStartIso,
      window_end: opts.windowEndIso,
      vault_matter_id: opts.row.matter_id,
      vault_export_id: opts.row.export_id,
      mode: opts.row.mode,
      job_id: null,
      parse_status: 'pending',
    });

    if (inserted) {
      filesUploaded++;
    } else {
      log(`skipped duplicate mbox_files row for ${s3Key}`);
    }
  }

  log(`${opts.file.objectName}: ${mboxEntries} MBOX entries`);
  return filesUploaded;
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
      sql`SELECT id, matter_id, export_id, window_start, window_end, mode, custodian_emails
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
    let status: Awaited<ReturnType<typeof pollVaultExport>>;
    try {
      status = await pollVaultExport(token, row.matter_id, row.export_id);
    } catch (err) {
      // Matter was closed before we could poll — treat as terminal failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FAILED_PRECONDITION') || msg.includes('state OPEN')) {
        await setStatus(db, row.id, 'failed');
        log(`matter already closed, cannot poll — status=failed`);
        return { ok: true, action: 'failed' };
      }
      throw err;
    }
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
    const claimed = await claimForProcessing(db, row.id);
    if (!claimed) {
      log(`export ${row.export_id} was already claimed by another invocation`);
      return { ok: true, action: 'claimed_elsewhere' };
    }

    const region = process.env.AWS_REGION || 'ap-southeast-3';
    const endpoint = process.env.AWS_S3_ENDPOINT;
    const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';

    const s3 = new S3Client({
      region,
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
        filesUploaded += await processZipFile({
          token,
          file,
          row,
          s3,
          mboxRepo,
          year,
          month,
          day,
          windowStartIso,
          windowEndIso,
        });
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
