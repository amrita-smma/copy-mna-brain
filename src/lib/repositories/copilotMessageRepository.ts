import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notExists, sql } from 'drizzle-orm';
import { copilotMessages, jobs } from '@/lib/db/schema';
import { EMBEDDING_DIMENSIONS } from '@/lib/bedrock';
import type { DbClient } from './types';

export type CopilotMessageRow = typeof copilotMessages.$inferSelect;

/** One stored message, as the history writer inserts it. */
export interface NewCopilotMessage {
  chat_id: string;
  user_id: string;
  bot_id: string | null;
  role: 'user' | 'assistant';
  author_bot_id?: string | null;
  parts: unknown[];
  text: string;
  /** The row's id when the writer chose it up front (a question row the turn already runs under); the database picks one otherwise. */
  id?: string;
  /** The model and effort tier a turn ran on; set on its question row only. */
  model?: string | null;
  effort_tier?: string | null;
}

/** A history-search hit: one stored exchange (an assistant row). */
export interface ChatHistoryHit {
  id: string;
  chat_id: string;
  bot_id: string | null;
  bot_name: string | null;
  text: string;
  created_at: string;
  score: number;
}

export interface ChatHistorySearch {
  userId: string;
  /** Limit to one bot's thread; omitted searches all of the user's bots. */
  botId?: string;
  query: string;
  /** The query's embedding; null searches full text only. */
  embedding: number[] | null;
  limit: number;
  since?: string;
  until?: string;
}

const MAX_PAGE = 100;
/** At most this many turns per page. */
const MAX_TURNS = 50;
/** A backstop on rows per turn page; a turn is normally a user and an assistant row. */
const MAX_TURN_PAGE_ROWS = 500;
const MAX_HITS = 20;
/** How many candidates each ranking contributes before fusion. */
const CANDIDATES = 50;
/** Reciprocal-rank-fusion constant (the usual 60). */
const RRF_K = 60;

/**
 * The Copilot's stored chat history (`copilot_messages`). Workspace-scoped like
 * every repository; history search is additionally always scoped to one user.
 */
export class CopilotMessageRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** Insert rows in order (their `seq` follows the array order). */
  async insertMany(rows: NewCopilotMessage[]): Promise<Pick<CopilotMessageRow, 'id' | 'role'>[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(copilotMessages)
      .values(rows.map((r) => ({ ...r, workspace_id: this.workspaceId })))
      .returning({ id: copilotMessages.id, role: copilotMessages.role });
  }

  /** Remove one row (a question whose turn never reached the thread). */
  async deleteById(id: string): Promise<void> {
    await this.db
      .delete(copilotMessages)
      .where(and(eq(copilotMessages.id, id), eq(copilotMessages.workspace_id, this.workspaceId)));
  }

  /**
   * One page of a thread, oldest first. `before` is a `seq` cursor: the page
   * holds the `limit` messages just before it (the newest when omitted).
   * Reads one extra row to tell whether an earlier page exists.
   */
  async listPage(
    chatId: string,
    { before, limit }: { before?: number; limit: number },
  ): Promise<{ rows: CopilotMessageRow[]; hasMore: boolean }> {
    const size = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_PAGE);
    const rows = await this.db
      .select()
      .from(copilotMessages)
      .where(
        and(
          eq(copilotMessages.chat_id, chatId),
          eq(copilotMessages.workspace_id, this.workspaceId),
          before !== undefined ? lt(copilotMessages.seq, before) : undefined,
        ),
      )
      .orderBy(desc(copilotMessages.seq))
      .limit(size + 1);
    const hasMore = rows.length > size;
    return { rows: (hasMore ? rows.slice(0, size) : rows).reverse(), hasMore };
  }

  /**
   * The last `turns` turns before `before` (or the newest), oldest first. A
   * turn starts at a user row and runs to the next one, so a page never splits
   * one. `hasMore` when an earlier user row exists; rows before the thread's
   * first user row ride along with its oldest page.
   */
  async listTurnsPage(
    chatId: string,
    { before, turns }: { before?: number; turns: number },
  ): Promise<{ rows: CopilotMessageRow[]; hasMore: boolean }> {
    const count = Math.min(Math.max(Math.trunc(turns) || 1, 1), MAX_TURNS);
    const scope = and(
      eq(copilotMessages.chat_id, chatId),
      eq(copilotMessages.workspace_id, this.workspaceId),
      before !== undefined ? lt(copilotMessages.seq, before) : undefined,
    );
    // The turn starts, newest first, plus one to tell whether more remain.
    const starts = await this.db
      .select({ seq: copilotMessages.seq })
      .from(copilotMessages)
      .where(and(scope, eq(copilotMessages.role, 'user')))
      .orderBy(desc(copilotMessages.seq))
      .limit(count + 1);
    const hasMore = starts.length > count;
    const from = hasMore ? starts[count - 1].seq : undefined;
    const rows = await this.db
      .select()
      .from(copilotMessages)
      .where(and(scope, from !== undefined ? gte(copilotMessages.seq, from) : undefined))
      .orderBy(asc(copilotMessages.seq))
      .limit(MAX_TURN_PAGE_ROWS);
    return { rows, hasMore };
  }

  async findById(id: string): Promise<CopilotMessageRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotMessages)
      .where(and(eq(copilotMessages.id, id), eq(copilotMessages.workspace_id, this.workspaceId)))
      .limit(1);
    return row ?? null;
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`setEmbedding expects ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`);
    }
    await this.db
      .update(copilotMessages)
      .set({ embedding })
      .where(and(eq(copilotMessages.id, id), eq(copilotMessages.workspace_id, this.workspaceId)));
  }

  /**
   * Hybrid search over one user's stored exchanges: the nearest by embedding
   * and the best full-text matches, merged with reciprocal-rank fusion. Names
   * and numbers (which embeddings handle poorly) still match through the
   * full-text half; an exchange not yet embedded is still found by it.
   *
   * Raw `sql`: pgvector's `<=>` and window functions have no builder form.
   * Every value is a bound parameter except the vector literal, which pgvector
   * needs as cast text (see `RssItemChunkRepository.vectorSearch`).
   */
  async hybridSearch(search: ChatHistorySearch): Promise<ChatHistoryHit[]> {
    const query = search.query.trim();
    if (!query) return [];
    if (search.embedding && search.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `hybridSearch expects ${EMBEDDING_DIMENSIONS} dimensions, got ${search.embedding.length}`,
      );
    }
    const limit = Math.min(Math.max(Math.trunc(search.limit) || 1, 1), MAX_HITS);

    const scope = sql`
      m.user_id = ${search.userId}
      AND m.workspace_id = ${this.workspaceId}
      AND m.role = 'assistant'
      ${search.botId ? sql`AND m.bot_id = ${search.botId}` : sql``}
      ${search.since ? sql`AND m.created_at >= ${search.since}::timestamptz` : sql``}
      ${search.until ? sql`AND m.created_at <= ${search.until}::timestamptz` : sql``}
    `;

    const vectorRanked = search.embedding
      ? sql`
          SELECT m.id, row_number() OVER (ORDER BY m.embedding <=> ${`[${search.embedding.join(',')}]`}::vector) AS r
          FROM copilot_messages m
          WHERE ${scope} AND m.embedding IS NOT NULL
          ORDER BY m.embedding <=> ${`[${search.embedding.join(',')}]`}::vector
          LIMIT ${CANDIDATES}`
      : sql`SELECT NULL::uuid AS id, NULL::bigint AS r WHERE FALSE`;

    const { rows } = await this.db.execute<{
      id: string;
      chat_id: string;
      bot_id: string | null;
      bot_name: string | null;
      text: string;
      created_at: string;
      score: number | string;
    }>(sql`
      WITH vec AS (${vectorRanked}),
      lex AS (
        SELECT m.id, row_number() OVER (ORDER BY ts_rank_cd(m.search, q) DESC) AS r
        FROM copilot_messages m, plainto_tsquery('simple', ${query}) q
        WHERE ${scope} AND m.search @@ q
        ORDER BY ts_rank_cd(m.search, q) DESC
        LIMIT ${CANDIDATES}
      ),
      fused AS (
        SELECT coalesce(vec.id, lex.id) AS id,
               coalesce(1.0 / (${RRF_K} + vec.r), 0) + coalesce(1.0 / (${RRF_K} + lex.r), 0) AS score
        FROM vec FULL OUTER JOIN lex ON lex.id = vec.id
      )
      SELECT m.id::text AS id, m.chat_id::text AS chat_id, m.bot_id::text AS bot_id,
             b.name AS bot_name, m.text, m.created_at::text AS created_at, f.score
      FROM fused f
      JOIN copilot_messages m ON m.id = f.id
      LEFT JOIN bots b ON b.id = m.bot_id
      ORDER BY f.score DESC, m.created_at DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }
}

/**
 * Stored exchanges that never got a vector, newest first, across every
 * workspace — for the dispatch cron, which runs with no workspace and queues
 * each workspace's batch through its own container. An exchange misses its
 * vector when the embedding job could not be queued or failed (Bedrock down,
 * or the `chat_message_embedding` job type missing from a fresh database, as
 * it was until the migrate repair); until then it is findable by full text
 * only. A row an embedding job already holds (pending or running) is left
 * out, so one tick cannot queue it twice. Deliberately the only
 * cross-workspace read here.
 */
export async function findUnembeddedChatMessages(
  db: DbClient,
  limit: number,
): Promise<{ id: string; workspace_id: string }[]> {
  const queued = db
    .select({ one: sql`1` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'chat_message_embedding'),
        inArray(jobs.status, ['pending', 'running']),
        sql`${jobs.payload}->'messageIds' ? ${copilotMessages.id}::text`,
      ),
    );
  return db
    .select({ id: copilotMessages.id, workspace_id: copilotMessages.workspace_id })
    .from(copilotMessages)
    .where(
      and(
        eq(copilotMessages.role, 'assistant'),
        isNull(copilotMessages.embedding),
        ne(copilotMessages.text, ''),
        notExists(queued),
      ),
    )
    .orderBy(desc(copilotMessages.created_at))
    .limit(limit);
}
