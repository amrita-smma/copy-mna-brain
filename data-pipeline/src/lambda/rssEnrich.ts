/**
 * rss-enrich — scheduled every 10 minutes.
 *
 * Drains three queues, each bounded so the run stays well inside the Lambda
 * timeout:
 *
 *   1. classify — Haiku scores pending items; tier thresholds + the daily
 *      per-category cap decide what gets selected.
 *   2. content  — fetch the article body for selected items (3 attempts).
 *   3. embed    — chunk + Bedrock Titan, into rss.item_chunks.
 *
 * The three stages run sequentially inside one try/catch, so an uncaught
 * throw in an earlier stage (e.g. `countSelectedToday` failing) does abort
 * the invocation before later stages run — isolation is NOT stage-level.
 * What is isolated is per-item, within a stage: one bad article's content
 * fetch or embedding is caught and skipped without taking down the rest of
 * that stage's queue (see the try/catch inside `runEmbedding`, and
 * `mapWithConcurrency` in `runContentFetch`). Combined with every stage
 * being idempotent — work is claimed by status columns, so a crashed run
 * simply leaves items in their previous state — a whole-invocation abort is
 * self-healing: the next run 10 minutes later just resumes where this one
 * left off.
 */
import { loadSecretsFromSsm } from '../secrets';
import { createLambdaDb } from '../db';
import { RssRepository } from '../repositories';
import {
  classifyBatch,
  decideSelections,
  CLASSIFY_BATCH_SIZE,
  type ClassifiableItem,
  type SelectionDecision,
} from '../handlers/rssClassify';
import { fetchArticleContent } from '../lib/rssContent';
import { chunkArticle } from '../lib/rssChunk';
import { mapWithConcurrency } from '../lib/rssFetch';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { RSS_CATEGORIES, type RssCategory } from '@/lib/db/schema';
import { pipelineLog, pipelineError } from '../lib/pipelineLog';

const SCOPE = 'rss-enrich';

/** Per-run ceilings. Sized so a full run fits comfortably in 10 minutes. */
const CLASSIFY_LIMIT = 200;
const CONTENT_LIMIT = 50;
const EMBED_LIMIT = 25;
const CONTENT_CONCURRENCY = 5;
const DEFAULT_DAILY_CAP = 25;

export interface RssEnrichResult {
  run_id: string;
  classified: number;
  selected: number;
  content_fetched: number;
  content_failed: number;
  items_embedded: number;
  chunks_written: number;
}

export const handler = async (
  _event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; result: RssEnrichResult }> => {
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  const repo = new RssRepository(db);
  const runId = await repo.startRun('enrich');

  const result: RssEnrichResult = {
    run_id: runId,
    classified: 0,
    selected: 0,
    content_fetched: 0,
    content_failed: 0,
    items_embedded: 0,
    chunks_written: 0,
  };

  try {
    await runClassification(repo, result);
    await runContentFetch(repo, result);
    await runEmbedding(repo, result);

    await repo.finishRun(runId, toStats(result), null);
    pipelineLog(SCOPE, 'done', { run_id: runId, ...toStats(result) });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.finishRun(runId, toStats(result), message).catch(() => undefined);
    pipelineError(SCOPE, 'failed', err, { run_id: runId });
    throw err;
  } finally {
    await pgClient.end();
  }
};

async function runClassification(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const pending = await repo.listPendingClassification(CLASSIFY_LIMIT);
  if (pending.length === 0) return;

  const cap = Number(process.env.RSS_DAILY_CAP_PER_CATEGORY ?? DEFAULT_DAILY_CAP);
  const usedToday = await repo.countSelectedToday();
  // Remaining budget is shared across the batches in this run, so a big
  // backlog can't blow through the cap by splitting into several batches.
  const remaining: Partial<Record<RssCategory, number>> = {};
  for (const category of RSS_CATEGORIES) {
    remaining[category] = Math.max(0, cap - (usedToday[category] ?? 0));
  }

  const decisions: SelectionDecision[] = [];
  for (let offset = 0; offset < pending.length; offset += CLASSIFY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CLASSIFY_BATCH_SIZE) as ClassifiableItem[];
    const verdicts = await classifyBatch(batch);
    // A failed model call yields no verdicts; skip the batch so its items stay
    // `pending` and get retried, rather than being rejected by default.
    if (verdicts.length === 0) continue;

    const batchDecisions = decideSelections(verdicts, batch, remaining);
    for (const decision of batchDecisions) {
      if (decision.relevance !== 'selected') continue;
      const item = batch.find((i) => i.id === decision.id);
      if (!item) continue;
      remaining[item.category] = Math.max(0, (remaining[item.category] ?? 0) - 1);
    }
    decisions.push(...batchDecisions);
  }

  if (decisions.length === 0) return;
  await repo.applyClassifications(decisions);
  result.classified = decisions.length;
  result.selected = decisions.filter((d) => d.relevance === 'selected').length;
}

async function runContentFetch(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingContent(CONTENT_LIMIT);
  if (queue.length === 0) return;

  await mapWithConcurrency(queue, CONTENT_CONCURRENCY, async (row) => {
    const outcome = await fetchArticleContent(row.link);
    if (outcome.kind === 'ok') {
      await repo.recordContentSuccess(row.id, outcome.text);
      result.content_fetched++;
    } else {
      await repo.recordContentFailure(row.id, outcome.reason);
      result.content_failed++;
    }
  });
}

async function runEmbedding(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingEmbedding(EMBED_LIMIT);
  if (queue.length === 0) return;

  const bedrock = new BedrockEmbeddingClient();

  for (const row of queue) {
    // Items whose content fetch terminally failed still get one chunk from
    // title + summary, so a paywalled story is degraded in RAG, not absent.
    const body = row.content_text ?? row.summary ?? '';
    const texts = chunkArticle(row.title, body);
    if (texts.length === 0) continue;

    try {
      const chunks = [];
      for (const text of texts) {
        chunks.push({ text, embedding: await bedrock.embed(text) });
      }
      await repo.saveChunks(row.id, chunks);
      result.items_embedded++;
      result.chunks_written += chunks.length;
    } catch (err) {
      // Leave embedded_at NULL so the next run retries this item; one bad
      // article must not stall the queue behind it.
      pipelineError(SCOPE, 'embedding failed', err, { item_id: row.id });
    }
  }
}

function toStats(result: RssEnrichResult): Record<string, number> {
  return {
    classified: result.classified,
    selected: result.selected,
    content_fetched: result.content_fetched,
    content_failed: result.content_failed,
    items_embedded: result.items_embedded,
    chunks_written: result.chunks_written,
  };
}
