/**
 * rss-enrich — scheduled every 10 minutes.
 *
 * Drains four queues, each bounded so the run stays well inside the Lambda
 * timeout:
 *
 *   1. classify  — Haiku scores pending items; tier thresholds + the daily
 *      per-category cap decide what gets selected.
 *   2. content   — fetch the article body for selected items (3 attempts).
 *   3. translate — detect the language locally and, for non-English items,
 *      have Haiku render title/summary/body into English (3 attempts).
 *   4. embed     — chunk + Bedrock Titan, into rss.item_chunks.
 *
 * Order matters between 3 and 4: hybrid search is English on both halves, so
 * an item must be translated BEFORE it is embedded (the embed queue enforces
 * this itself — see `listPendingEmbedding`).
 *
 * The four stages run sequentially inside one try/catch, so an uncaught
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
import { detectItemLanguage, translateItem } from '../handlers/rssTranslate';
import { chunkArticle } from '../lib/rssChunk';
import { mapWithConcurrency } from '../lib/rssFetch';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { RSS_CATEGORIES, type RssCategory } from '@/lib/db/schema';
import { pipelineLog, pipelineError } from '../lib/pipelineLog';

const SCOPE = 'rss-enrich';

/** Per-run ceilings. Sized so a full run fits comfortably in 10 minutes. */
const CLASSIFY_LIMIT = 200;
const CONTENT_LIMIT = 50;
/**
 * Rows the translate stage will *look at* per run. Generous because looking
 * is free — `detectItemLanguage` is a local heuristic and the English
 * majority is settled in one batched UPDATE with no model call at all.
 */
const DETECT_LIMIT = 200;
/**
 * Rows the translate stage will actually *translate* per run. Far lower,
 * because a translated article costs one model call per ~6 KB of body, so 15
 * long reads is already ~60 calls. Kept separate from `DETECT_LIMIT` so a
 * backlog of English items cannot consume the model budget — that would
 * starve the embed queue, which waits on translation resolving.
 */
const TRANSLATE_LIMIT = 15;
const EMBED_LIMIT = 25;
const CONTENT_CONCURRENCY = 5;
const DEFAULT_DAILY_CAP = 25;

export interface RssEnrichResult {
  run_id: string;
  classified: number;
  selected: number;
  content_fetched: number;
  content_failed: number;
  translated: number;
  translation_skipped: number;
  translation_failed: number;
  /** Non-English items detected but past this run's `TRANSLATE_LIMIT`. */
  translation_deferred: number;
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
    translated: 0,
    translation_skipped: 0,
    translation_failed: 0,
    translation_deferred: 0,
    items_embedded: 0,
    chunks_written: 0,
  };

  try {
    await runClassification(repo, result);
    await runContentFetch(repo, result);
    await runTranslation(repo, result);
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
  // Overridable per environment (see RSS_CLASSIFY_LIMIT in the pipeline-compute
  // Terraform module) — staging caps this far below CLASSIFY_LIMIT so a 10-minute
  // schedule doesn't run the same Haiku/Bedrock cost as production.
  const classifyLimit = Number(process.env.RSS_CLASSIFY_LIMIT ?? CLASSIFY_LIMIT);
  const pending = await repo.listPendingClassification(classifyLimit);
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

/**
 * Detect each queued item's language and translate the non-English ones.
 *
 * Two passes, because the two halves of the work cost wildly different
 * amounts. Detection is a local heuristic — free — so the whole
 * `DETECT_LIMIT` window is examined and every English (or too-short-to-judge)
 * item is settled in ONE batched UPDATE. Only what survives that filter is
 * handed to Haiku, up to the much smaller `TRANSLATE_LIMIT`.
 *
 * Splitting them is not just an optimisation. The embed queue waits on
 * translation resolving, so if a backlog of English items could consume the
 * model budget, embedding would stall behind work that never needed a model
 * in the first place.
 *
 * The translation pass is sequential, unlike the content fetch: a single
 * article can already fan out to ~10 model calls internally
 * (`CHUNK_CONCURRENCY` in `rssTranslate`), so running items concurrently on
 * top of that would multiply into a burst large enough to hit API rate
 * limits.
 *
 * Per-item isolation matches the other stages — a thrown error is recorded as
 * a failed attempt and the queue keeps draining. `translateItem` already
 * converts model/API errors into a `failed` outcome; the try/catch is for
 * everything else (a DB write blowing up mid-stage), so one bad row cannot
 * abort the invocation before embedding runs.
 */
async function runTranslation(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingTranslation(DETECT_LIMIT);
  if (queue.length === 0) return;

  const settled: { id: string; language: string | null }[] = [];
  const candidates: typeof queue = [];
  for (const row of queue) {
    const detection = detectItemLanguage(row);
    if (detection.isEnglish || detection.language === null) {
      settled.push({ id: row.id, language: detection.language });
    } else {
      candidates.push(row);
    }
  }

  if (settled.length > 0) {
    await repo.markTranslationNotNeeded(settled);
    result.translation_skipped += settled.length;
  }

  const batch = candidates.slice(0, TRANSLATE_LIMIT);
  // Never let a capped queue read as "everything is handled": the deferred
  // rows are picked up by the next run, and the count says so out loud.
  result.translation_deferred = candidates.length - batch.length;
  if (result.translation_deferred > 0) {
    pipelineLog(SCOPE, 'translation deferred to next run', {
      deferred: result.translation_deferred,
      limit: TRANSLATE_LIMIT,
    });
  }

  for (const row of batch) {
    try {
      const outcome = await translateItem(row);

      if (outcome.kind === 'translated') {
        await repo.recordTranslationSuccess(row.id, {
          language: outcome.language,
          title: outcome.title,
          summary: outcome.summary,
          content: outcome.content,
        });
        result.translated++;
      } else if (outcome.kind === 'not_needed') {
        // Unreachable via the filter above (same pure detector, same input),
        // but handled rather than trusted — a silent fall-through here would
        // leave the row queued forever.
        await repo.markTranslationNotNeeded([{ id: row.id, language: outcome.language }]);
        result.translation_skipped++;
      } else {
        await repo.recordTranslationFailure(row.id, outcome.reason);
        result.translation_failed++;
      }
    } catch (err) {
      pipelineError(SCOPE, 'translation failed', err, { item_id: row.id });
      const reason = err instanceof Error ? err.message : String(err);
      // Best-effort: if THIS write also fails the item simply stays queued and
      // the next run retries it, which is the same outcome by another route.
      await repo.recordTranslationFailure(row.id, reason).catch(() => undefined);
      result.translation_failed++;
    }
  }
}

async function runEmbedding(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingEmbedding(EMBED_LIMIT);
  if (queue.length === 0) return;

  const bedrock = new BedrockEmbeddingClient();

  for (const row of queue) {
    // Embed the ENGLISH rendering whenever there is one. Both halves of
    // hybrid search are English — an English query embedding and a trigram
    // ILIKE over English words — so indexing a Japanese body would leave the
    // item unreachable by any query a user would actually type. Items that
    // needed no translation, or whose translation exhausted its attempts,
    // fall through to the original text unchanged.
    const title = row.title_en ?? row.title;
    // Items whose content fetch terminally failed still get one chunk from
    // title + summary, so a paywalled story is degraded in RAG, not absent.
    const body =
      row.content_text_en ?? row.content_text ?? row.summary_en ?? row.summary ?? '';
    const texts = chunkArticle(title, body);
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
    translated: result.translated,
    translation_skipped: result.translation_skipped,
    translation_failed: result.translation_failed,
    translation_deferred: result.translation_deferred,
    items_embedded: result.items_embedded,
    chunks_written: result.chunks_written,
  };
}
