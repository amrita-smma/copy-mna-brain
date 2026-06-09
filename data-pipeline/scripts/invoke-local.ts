/**
 * Local Lambda invoker — run a pipeline Lambda entrypoint on your machine
 * exactly as EventBridge would, against your local Postgres + MinIO (per
 * .env.local). No AWS, no SAM, no Docker-for-Lambda needed.
 *
 * Usage:
 *   pnpm --filter data-pipeline invoke <name> [jsonPayload]
 *
 * Examples:
 *   pnpm --filter data-pipeline invoke crmIngest '{"limit":50}'
 *   pnpm --filter data-pipeline invoke vaultParse '{"limit":2}'
 *   pnpm --filter data-pipeline invoke crmLlmSubmit '{"limit":3,"mode":"sync"}'
 *
 * Loads .env.local (then .env) the same way scripts/migrate.ts does, so it
 * picks up DB_*, AWS_S3_ENDPOINT, ANTHROPIC_API_KEY, GOOGLE_VAULT_SERVICE_ACCOUNT.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root is two levels up from data-pipeline/scripts/.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

const HANDLERS = [
  'crmIngest',
  'crmLlmSubmit',
  'crmLlmFetch',
  'crmDomainClassify',
  'vaultParse',
  'vaultArchiveStart',
  'vaultArchivePoll',
] as const;

type HandlerName = (typeof HANDLERS)[number];

async function main() {
  const name = process.argv[2] as HandlerName | undefined;
  const payloadArg = process.argv[3];

  if (!name || !HANDLERS.includes(name)) {
    console.error(`Usage: pnpm --filter data-pipeline invoke <name> [jsonPayload]`);
    console.error(`  name ∈ ${HANDLERS.join(', ')}`);
    process.exit(1);
  }

  let event: unknown = {};
  if (payloadArg) {
    try {
      event = JSON.parse(payloadArg);
    } catch {
      console.error(`Invalid JSON payload: ${payloadArg}`);
      process.exit(1);
    }
  }

  console.log(`▶ invoking ${name} with`, event);
  const started = Date.now();

  // Dynamic import AFTER dotenv so module-level env reads see the values.
  const mod = await import(`../src/lambda/${name}.ts`);
  const result = await mod.handler(event, {});

  console.log(`✓ ${name} finished in ${Date.now() - started}ms`);
  console.dir(result, { depth: 6 });
}

main().catch((err) => {
  console.error('✗ invocation failed:', err);
  process.exit(1);
});
