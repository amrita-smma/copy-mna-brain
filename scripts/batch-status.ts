/**
 * Check an Anthropic Message Batch's progress directly against the Anthropic API.
 *
 * Usage:
 *   pnpm batch:status <batchId> [--watch]
 *
 *   <batchId>  Either the Anthropic batch id (msgbatch_...) — queried straight
 *              against the API with no DB hit — or our internal llm_batches.id
 *              (a UUID), which is first resolved to its anthropic_batch_id.
 *   --watch    Poll every 10s until the batch ends (processing_status='ended').
 *
 * Examples:
 *   pnpm batch:status msgbatch_01ABC...
 *   pnpm batch:status 3f9c1a2e-... --watch
 */
import { config } from 'dotenv';
// Load .env.local first (then .env as fallback) BEFORE importing anything that
// reads env at module scope (db client, Anthropic key). dotenv won't overwrite
// already-set vars, so .env.local wins. Mirrors scripts/status.ts.
config({ path: '.env.local' });
config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_INTERVAL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve our internal llm_batches.id (UUID) → anthropic_batch_id via the DB. */
async function resolveAnthropicBatchId(internalId: string): Promise<string> {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const c = createPostgresClientFromEnv({ prepare: false });
  try {
    const rows = await c<{ anthropic_batch_id: string }[]>`
      SELECT anthropic_batch_id FROM analytics.llm_batches WHERE id = ${internalId} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error(`no llm_batches row with id=${internalId}`);
    }
    return rows[0].anthropic_batch_id;
  } finally {
    await c.end();
  }
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

interface RequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

function printBatch(batch: {
  id: string;
  processing_status: string;
  request_counts: RequestCounts;
  created_at: string;
  ended_at: string | null;
  expires_at: string | null;
  results_url: string | null;
}): void {
  const rc = batch.request_counts;
  const total =
    rc.processing + rc.succeeded + rc.errored + rc.canceled + rc.expired;
  const done = rc.succeeded + rc.errored + rc.canceled + rc.expired;

  console.log(`\nbatch        ${batch.id}`);
  console.log(`status       ${batch.processing_status}`);
  console.log(
    `progress     ${done}/${total} (${pct(done, total)})   processing=${rc.processing}`,
  );
  console.log(
    `  succeeded  ${rc.succeeded}   errored ${rc.errored}   canceled ${rc.canceled}   expired ${rc.expired}`,
  );
  console.log(`created_at   ${batch.created_at}`);
  console.log(`ended_at     ${batch.ended_at ?? '—'}`);
  console.log(`expires_at   ${batch.expires_at ?? '—'}`);
  if (batch.results_url) console.log(`results_url  ${batch.results_url}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const input = args.find((a) => !a.startsWith('--'));

  if (!input) {
    console.error('usage: pnpm batch:status <batchId> [--watch]');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not configured');
    process.exit(1);
  }

  const anthropicBatchId = UUID_RE.test(input)
    ? await resolveAnthropicBatchId(input)
    : input;

  if (UUID_RE.test(input)) {
    console.log(`resolved ${input} → ${anthropicBatchId}`);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // First (and possibly only) fetch.
  let batch = await client.messages.batches.retrieve(anthropicBatchId);
  printBatch(batch);

  if (!watch) return;

  while (batch.processing_status !== 'ended') {
    await sleep(POLL_INTERVAL_MS);
    batch = await client.messages.batches.retrieve(anthropicBatchId);
    printBatch(batch);
  }
  console.log('\nbatch ended.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
