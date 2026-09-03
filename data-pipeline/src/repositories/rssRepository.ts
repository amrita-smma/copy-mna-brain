import { and, asc, eq, sql } from 'drizzle-orm';
import { rssFeeds, rssItems, rssIngestRuns, rssItemChunks } from '@/lib/db/schema';
import type { DbClient } from '@/lib/repositories';
import type { FeedRow, NormalizedItem } from '../handlers/rssNormalize';
import type { ClassifiableItem, SelectionDecision } from '../handlers/rssClassify';
import { MAX_CONTENT_ATTEMPTS } from '../lib/rssConstants';

/**
 * Consecutive failed polls before a feed is retired to `dead`. The PoC found
 * ~35% of a raw seed catalog was already rotten, so feeds must retire
 * themselves rather than wait for a human to notice.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Rows per INSERT statement. 1000+ item batches would blow the pg parameter cap. */
const INSERT_CHUNK = 500;

export interface FeedHealthUpdate {
  id: string;
  ok: boolean;
  /** Fresh validators from a 200. Omitted on 304 or failure — the old ones stand. */
  etag?: string | null;
  lastModified?: string | null;
}

/** A feed plus its stored HTTP validators, which is what the poller needs. */
export type PollableFeed = FeedRow & {
  etag: string | null;
  last_modified: string | null;
};

export interface ContentQueueRow {
  id: string;
  link: string;
  title: string;
  summary: string | null;
}

export interface EmbeddableRow {
  id: string;
  title: string;
  content_text: string | null;
  summary: string | null;
  content_status: string;
}

/** Data access for the ingest Lambdas. Global — the rss schema has no tenant column. */
export class RssRepository {
  constructor(private readonly db: DbClient) {}

  async listActiveFeeds(): Promise<PollableFeed[]> {
    return this.db
      .select({
        id: rssFeeds.id,
        category: rssFeeds.category,
        source_name: rssFeeds.source_name,
        feed_url: rssFeeds.feed_url,
        region: rssFeeds.region,
        tier: rssFeeds.tier,
        etag: rssFeeds.etag,
        last_modified: rssFeeds.last_modified,
      })
      .from(rssFeeds)
      .where(eq(rssFeeds.status, 'active'))
      .orderBy(asc(rssFeeds.category), asc(rssFeeds.source_name)) as Promise<PollableFeed[]>;
  }

  /**
   * Insert a batch, ignoring items already in the lake. The rows the DB
   * actually accepted ARE the genuinely-new set — this replaces the PoC's
   * SQLite "seen ids" ledger with the unique index itself, so it stays correct
   * even with two pollers running at once.
   */
  async insertNewItems(items: NormalizedItem[]): Promise<NormalizedItem[]> {
    if (items.length === 0) return [];

    const byHash = new Map(items.map((i) => [i.item_hash, i]));
    const created: NormalizedItem[] = [];

    for (let offset = 0; offset < items.length; offset += INSERT_CHUNK) {
      const chunk = items.slice(offset, offset + INSERT_CHUNK);
      const inserted = await this.db
        .insert(rssItems)
        .values(chunk)
        .onConflictDoNothing({ target: rssItems.item_hash })
        .returning({ item_hash: rssItems.item_hash });

      for (const row of inserted) {
        const match = byHash.get(row.item_hash);
        if (match) created.push(match);
      }
    }

    return created;
  }

  /**
   * Apply per-feed poll outcomes in ONE statement. A loop of 263 UPDATEs would
   * be a write-side N+1; `jsonb_to_recordset` lets the whole batch travel as a
   * single bound parameter.
   */
  async applyFeedHealth(updates: FeedHealthUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const payload = JSON.stringify(
      updates.map((u) => ({
        id: u.id,
        ok: u.ok,
        etag: u.etag ?? null,
        last_modified: u.lastModified ?? null,
      })),
    );

    await this.db.execute(sql`
      UPDATE rss.feeds AS f SET
        etag = COALESCE(u.etag, f.etag),
        last_modified = COALESCE(u.last_modified, f.last_modified),
        last_polled_at = now(),
        last_success_at = CASE WHEN u.ok THEN now() ELSE f.last_success_at END,
        consecutive_failures = CASE WHEN u.ok THEN 0 ELSE f.consecutive_failures + 1 END,
        status = CASE
          WHEN NOT u.ok AND f.consecutive_failures + 1 >= ${MAX_CONSECUTIVE_FAILURES}
          THEN 'dead'
          ELSE f.status
        END,
        updated_at = now()
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS u(id uuid, ok boolean, etag text, last_modified text)
      WHERE f.id = u.id
    `);
  }

  async startRun(kind: 'poll' | 'enrich'): Promise<string> {
    const [row] = await this.db
      .insert(rssIngestRuns)
      .values({ kind })
      .returning({ id: rssIngestRuns.id });
    return row.id;
  }

  async finishRun(
    id: string,
    stats: Record<string, number>,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .update(rssIngestRuns)
      .set({ finished_at: sql`now()`, stats, error })
      .where(eq(rssIngestRuns.id, id));
  }

  /** Oldest-first so a backlog drains in publication order. */
  async listPendingClassification(limit: number): Promise<ClassifiableItem[]> {
    return this.db
      .select({
        id: rssItems.id,
        category: rssItems.category,
        source_name: rssItems.source_name,
        feed_tier: rssItems.feed_tier,
        title: rssItems.title,
        summary: rssItems.summary,
      })
      .from(rssItems)
      .where(eq(rssItems.relevance, 'pending'))
      .orderBy(asc(rssItems.ingested_at))
      .limit(limit) as Promise<ClassifiableItem[]>;
  }

  /**
   * Today's selections per category, for the daily cap. Counted in UTC so the
   * budget resets at the same instant as the ingest_date partitions in bronze.
   */
  async countSelectedToday(): Promise<Record<string, number>> {
    const result = await this.db.execute(sql`
      SELECT category, count(*)::text AS count
      FROM rss.items
      WHERE relevance = 'selected'
        AND classified_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      GROUP BY category
    `);
    const rows = queryRows<{ category: string; count: string }>(result);
    return Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
  }

  /**
   * Persist a batch of verdicts in one statement. Selecting an item also
   * enqueues it for content fetching, so classification and queueing can never
   * drift apart.
   */
  async applyClassifications(decisions: SelectionDecision[]): Promise<void> {
    if (decisions.length === 0) return;

    const payload = JSON.stringify(
      decisions.map((d) => ({
        id: d.id,
        relevance: d.relevance,
        score: d.score,
        labels: d.labels,
      })),
    );

    await this.db.execute(sql`
      UPDATE rss.items AS i SET
        relevance = u.relevance,
        relevance_score = u.score,
        llm_labels = u.labels,
        classified_at = now(),
        content_status = CASE WHEN u.relevance = 'selected' THEN 'pending' ELSE i.content_status END
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS u(id uuid, relevance text, score real, labels jsonb)
      WHERE i.id = u.id
    `);
  }

  async listPendingContent(limit: number): Promise<ContentQueueRow[]> {
    return this.db
      .select({
        id: rssItems.id,
        link: rssItems.link,
        title: rssItems.title,
        summary: rssItems.summary,
      })
      .from(rssItems)
      .where(and(eq(rssItems.relevance, 'selected'), eq(rssItems.content_status, 'pending')))
      .orderBy(asc(rssItems.ingested_at))
      .limit(limit) as Promise<ContentQueueRow[]>;
  }

  async recordContentSuccess(id: string, text: string): Promise<void> {
    await this.db
      .update(rssItems)
      .set({
        content_text: text,
        content_status: 'fetched',
        content_fetched_at: sql`now()`,
        content_error: null,
      })
      .where(eq(rssItems.id, id));
  }

  /**
   * Burn one attempt. The item stays `pending` (and therefore retryable) until
   * the budget is spent, then goes `failed` so it stops being picked up — the
   * UI still lists it with its summary and a link to the original.
   */
  async recordContentFailure(id: string, reason: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE rss.items SET
        content_attempts = content_attempts + 1,
        content_error = ${reason.slice(0, 500)},
        content_status = CASE
          WHEN content_attempts + 1 >= ${MAX_CONTENT_ATTEMPTS} THEN 'failed'
          ELSE 'pending'
        END
      WHERE id = ${id}::uuid
    `);
  }

  /**
   * Items ready to embed: successfully fetched, or terminally failed (those
   * get a title+summary chunk so RAG recall degrades gracefully instead of
   * dropping the story entirely).
   */
  async listPendingEmbedding(limit: number): Promise<EmbeddableRow[]> {
    const result = await this.db.execute(sql`
      SELECT id, title, content_text, summary, content_status
      FROM rss.items
      WHERE relevance = 'selected'
        AND embedded_at IS NULL
        AND content_status IN ('fetched', 'failed')
      ORDER BY ingested_at ASC
      LIMIT ${limit}
    `);
    return queryRows<EmbeddableRow>(result);
  }

  async saveChunks(
    itemId: string,
    chunks: { text: string; embedding: number[] }[],
  ): Promise<void> {
    if (chunks.length === 0) return;

    await this.db
      .insert(rssItemChunks)
      .values(
        chunks.map((chunk, chunk_index) => ({
          item_id: itemId,
          chunk_index,
          text: chunk.text,
          embedding: chunk.embedding,
        })),
      )
      .onConflictDoNothing();

    await this.db
      .update(rssItems)
      .set({ embedded_at: sql`now()` })
      .where(eq(rssItems.id, itemId));
  }
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
