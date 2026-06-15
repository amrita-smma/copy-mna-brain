/**
 * Upload a local .mbox file to MinIO and register it in analytics.mbox_files
 * as a pending-parse entry. The local equivalent of vaultArchivePoll.
 *
 * Usage:
 *   pnpm --filter data-pipeline upload-mbox \
 *     --file /path/to/archive.mbox \
 *     --custodian user@example.com \
 *     [--window-start 2026-01-01T00:00:00Z] \
 *     [--window-end   2026-01-31T23:59:59Z]
 *
 * Env requirements (loaded from .env.local then .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   AWS_S3_ENDPOINT        e.g. http://localhost:9000
 *   AWS_S3_MBOX_BUCKET     defaults to 'mbox-archive'
 */
import { config } from 'dotenv';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

function parseArgs(argv: string[]): {
  file: string;
  custodian: string;
  windowStart: string;
  windowEnd: string;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const file = get('--file');
  const custodian = get('--custodian');

  if (!file) {
    console.error('Error: --file <path> is required');
    process.exit(1);
  }
  if (!custodian) {
    console.error('Error: --custodian <email> is required');
    process.exit(1);
  }

  const now = new Date();
  const defaultWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const defaultWindowEnd = now.toISOString();

  return {
    file,
    custodian,
    windowStart: get('--window-start') ?? defaultWindowStart,
    windowEnd: get('--window-end') ?? defaultWindowEnd,
  };
}

function buildS3Key(custodian: string, originalBasename: string, uploadId: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeName = originalBasename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `local/${year}/${mm}/${custodian}/${uploadId}__${safeName}.gz`;
}

async function main() {
  // Dynamic imports happen here — AFTER dotenv has populated process.env.
  const { S3Client } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const { createLambdaDb } = await import('../src/db');
  const { MboxFileRepository } = await import('../src/repositories');

  const { file, custodian, windowStart, windowEnd } = parseArgs(process.argv);

  console.log(`[upload-mbox] file      : ${file}`);
  console.log(`[upload-mbox] custodian : ${custodian}`);
  console.log(`[upload-mbox] window    : ${windowStart} → ${windowEnd}`);
  console.log(`[upload-mbox] AWS_ACCESS_KEY_ID present: ${!!process.env.AWS_ACCESS_KEY_ID}`);

  const bucket = process.env.AWS_S3_MBOX_BUCKET || 'mbox-archive';
  const region = process.env.AWS_REGION || 'ap-southeast-3';
  const endpoint = process.env.AWS_S3_ENDPOINT;

  const s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });

  const uncompressedSize = statSync(file).size;
  const uploadId = randomUUID();
  const s3Key = buildS3Key(custodian, basename(file), uploadId);

  console.log(`[upload-mbox] uncompressed: ${(uncompressedSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[upload-mbox] uploading to s3://${bucket}/${s3Key}`);

  // Stream file → gzip → multipart S3 upload (no full-file buffering).
  const gzipStream = createReadStream(file).pipe(createGzip());

  let compressedSize = 0;
  gzipStream.on('data', (chunk: Buffer) => { compressedSize += chunk.length; });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: s3Key,
      Body: gzipStream,
      ContentType: 'application/x-mbox',
      ContentEncoding: 'gzip',
    },
  });

  upload.on('httpUploadProgress', (p) => {
    if (p.loaded) {
      process.stdout.write(`\r[upload-mbox] uploaded ${(p.loaded / 1024 / 1024).toFixed(1)} MB...`);
    }
  });

  await upload.done();
  process.stdout.write('\n');
  console.log(`[upload-mbox] upload complete (${(compressedSize / 1024 / 1024).toFixed(1)} MB compressed)`);

  // Register in mbox_files.
  const { pgClient, db } = await createLambdaDb();
  try {
    const repo = new MboxFileRepository(db as never);
    const row = await repo.insert({
      source: 'local',
      s3_bucket: bucket,
      s3_key: s3Key,
      size_bytes: compressedSize,
      uncompressed_size_bytes: uncompressedSize,
      custodian_email: custodian,
      window_start: windowStart,
      window_end: windowEnd,
      vault_matter_id: null,
      vault_export_id: null,
      mode: 'manual',
      job_id: null,
      parse_status: 'pending',
    });
    console.log(`[upload-mbox] registered mbox_file id=${row.id}`);
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('[upload-mbox] fatal:', err);
  process.exit(1);
});
