/**
 * Process a local .mbox (or .mbox.gz) fixture directly through the single-pass
 * ephemeral processor — the local equivalent of what vault-archive-poll does
 * per Vault entry. No S3/MinIO upload, no mbox_files row.
 *
 * Usage (from repo root; `--filter` cwd is data-pipeline/):
 *   pnpm --filter data-pipeline process-mbox \
 *     --file fixtures/ephemeral-email-demo.mbox \
 *     --custodian analyst@starcapital.co.id
 *
 * Optional:
 *   --source-key <key>   stable resume key (default: local::<basename>)
 *
 * Env (loaded from .env.local then .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *   ANTHROPIC_API_KEY
 *   INTERNAL_API_URL + ADMIN_SECRET (for Smart Files attachment upload)
 */
import { config } from 'dotenv';
import { resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

function resolveMboxPath(input: string): string {
  if (isAbsolute(input) && existsSync(input)) return input;
  const candidates = [
    resolve(process.cwd(), input),
    resolve(packageRoot, input),
    resolve(repoRoot, input),
    resolve(packageRoot, input.replace(/^data-pipeline\//, '')),
    resolve(repoRoot, input.replace(/^data-pipeline\//, 'data-pipeline/')),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `mbox file not found: ${input}\n` +
      `Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      `Tip: with pnpm --filter data-pipeline, use --file fixtures/ephemeral-email-demo.mbox`,
  );
}

function parseArgs(argv: string[]): {
  file: string;
  custodian: string;
  sourceKey: string;
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
  const resolved = resolveMboxPath(file);
  return {
    file: resolved,
    custodian,
    sourceKey: get('--source-key') ?? `local::${basename(resolved)}`,
  };
}

async function main() {
  const { file, custodian, sourceKey } = parseArgs(process.argv);

  console.log(`[process-mbox] file      : ${file}`);
  console.log(`[process-mbox] custodian : ${custodian}`);
  console.log(`[process-mbox] source_key: ${sourceKey}`);

  // Dynamic imports AFTER dotenv so module-level env reads see the values.
  const { createLambdaDb } = await import('../src/db');
  const { processMboxSource } = await import('../src/handlers/emailProcess');

  const openStream = () =>
    file.endsWith('.gz')
      ? createReadStream(file).pipe(createGunzip())
      : createReadStream(file);

  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await processMboxSource(
      {
        sourceKey,
        custodianEmail: custodian,
        exportId: null,
        openStream,
      },
      {},
      { db: db as never },
    );
    console.log('[process-mbox] result:');
    console.dir(result, { depth: 6 });
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('[process-mbox] fatal:', err);
  process.exit(1);
});
