/**
 * rss-poll — scheduled every 30 minutes.
 *
 * Conditional-GETs every active feed, normalizes entries, inserts the
 * genuinely-new ones into rss.items, archives them to S3 bronze, and records
 * per-feed health. Deliberately does NO enrichment: classification, article
 * fetching and embedding all run in rss-enrich so a slow scrape or a flaky LLM
 * can never delay the next poll.
 *
 * Idempotent: 304s skip unchanged feeds, and the unique index on item_hash
 * makes re-inserting a seen item a no-op.
 */
import Parser from 'rss-parser';
import { loadSecretsFromSsm } from '../secrets';
import { createLambdaDb } from '../db';
import { RssRepository, type FeedHealthUpdate } from '../repositories';
import { fetchFeed, mapWithConcurrency, POLL_CONCURRENCY } from '../lib/rssFetch';
import { writeBronze } from '../lib/rssBronze';
import {
  normalizeEntries,
  MAX_ITEMS_PER_FEED,
  type NormalizedItem,
} from '../handlers/rssNormalize';
import { pipelineLog, pipelineError } from '../lib/pipelineLog';

const SCOPE = 'rss-poll';

export interface RssPollResult {
  run_id: string;
  feeds_polled: number;
  unchanged: number;
  failed: number;
  items_parsed: number;
  items_new: number;
  bronze_keys: string[];
}

export const handler = async (
  _event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; result: RssPollResult }> => {
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  const repo = new RssRepository(db);
  const runId = await repo.startRun('poll');
  const runTimestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  const result: RssPollResult = {
    run_id: runId,
    feeds_polled: 0,
    unchanged: 0,
    failed: 0,
    items_parsed: 0,
    items_new: 0,
    bronze_keys: [],
  };

  try {
    const feeds = await repo.listActiveFeeds();
    result.feeds_polled = feeds.length;
    pipelineLog(SCOPE, 'polling', { run_id: runId, feeds: feeds.length });

    const parser = new Parser();
    const health: FeedHealthUpdate[] = [];
    const parsedItems: NormalizedItem[] = [];

    const outcomes = await mapWithConcurrency(feeds, POLL_CONCURRENCY, async (feed) => {
      const fetched = await fetchFeed(feed);
      if (fetched.kind !== 'fresh') return { feed, fetched, items: [] as NormalizedItem[] };

      try {
        const parsed = await parser.parseString(fetched.xml);
        return {
          feed,
          fetched,
          items: normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED),
        };
      } catch (err) {
        // Malformed XML is a feed problem, not a run problem — convert it into
        // a health signal so the feed eventually retires itself.
        const reason = err instanceof Error ? err.message : String(err);
        return {
          feed,
          fetched: { kind: 'failed' as const, reason: `parse: ${reason.slice(0, 120)}` },
          items: [] as NormalizedItem[],
        };
      }
    });

    for (const { feed, fetched, items } of outcomes) {
      if (fetched.kind === 'unchanged') {
        result.unchanged++;
        health.push({ id: feed.id, ok: true });
        continue;
      }
      if (fetched.kind === 'failed') {
        result.failed++;
        health.push({ id: feed.id, ok: false });
        continue;
      }
      health.push({
        id: feed.id,
        ok: true,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      });
      parsedItems.push(...items);
    }

    result.items_parsed = parsedItems.length;

    const created = await repo.insertNewItems(parsedItems);
    result.items_new = created.length;

    // Bronze mirrors what actually entered the lake, so re-runs don't append
    // duplicate archive lines.
    result.bronze_keys = await writeBronze(created, runTimestamp);

    await repo.applyFeedHealth(health);
    await repo.finishRun(runId, toStats(result), null);

    pipelineLog(SCOPE, 'done', {
      run_id: runId,
      feeds: result.feeds_polled,
      unchanged: result.unchanged,
      failed: result.failed,
      items_new: result.items_new,
    });
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

function toStats(result: RssPollResult): Record<string, number> {
  return {
    feeds_polled: result.feeds_polled,
    unchanged: result.unchanged,
    failed: result.failed,
    items_parsed: result.items_parsed,
    items_new: result.items_new,
    bronze_objects: result.bronze_keys.length,
  };
}
