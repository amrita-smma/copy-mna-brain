import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { userMemories } from '@/lib/db/schema';
import { EMBEDDING_DIMENSIONS } from '@/lib/bedrock';
import type { DbClient } from './types';

/** mem0's own record, as it writes it. `data` is the memory text. */
export interface UserMemoryPayload {
  data?: string;
  hash?: string;
  createdAt?: string;
  updatedAt?: string;
  user_id?: string;
  [key: string]: unknown;
}

export interface UserMemoryRow {
  id: string;
  memory: string;
  collection: string;
  payload: UserMemoryPayload;
  created_at: string;
  updated_at: string;
  // `db.execute<T>` constrains T to Record<string, unknown>; this row type is
  // used as that T, so it carries the index signature.
  [key: string]: unknown;
}

/** A row plus its cosine distance from the query vector (0 = identical). */
export interface UserMemoryHit extends UserMemoryRow {
  distance: number;
  /** Lexical rank, set only by `keywordSearch`. */
  score?: number;
}

export interface InsertUserMemory {
  id: string;
  memory: string;
  embedding: number[];
  payload: UserMemoryPayload;
}

/** The memories a user sees on Profile → Memory. */
export const MEMORY_COLLECTION = 'memories';

/**
 * How many rows a single list/search may return, whatever the caller asks for.
 * mem0's `getAll` over-fetches (`topK * 4`) to leave room for expiry
 * filtering, so this is deliberately well above any UI page size.
 */
const MAX_ROWS = 500;

/**
 * Data access for `user_memories` — the pgvector table behind the CoPilot's
 * mem0 memory (see `src/lib/memory/`).
 *
 * Scoped to the `userId` passed in, and to nothing else: a memory is about the
 * person, so it follows them into every workspace they belong to. One member
 * still can never read or delete another's — `userId` is on every predicate —
 * but there is deliberately no workspace filter.
 *
 * This is the one repository in the app that is NOT workspace-scoped. The
 * workspace it is constructed with is used only to stamp `workspace_id` as
 * provenance on a write (where a memory was formed); it never narrows a read,
 * which is why reads take no workspace at all.
 *
 * `collection` is mem0's notion of a logical store: `memories` holds the facts
 * themselves, `memories_entities` holds the entity-link index mem0 maintains
 * alongside them. Callers pass it through; nothing here interprets it.
 *
 * Raw `sql` only where the Drizzle builder has no expression — pgvector's
 * `<=>` operator and the `::vector` literal cast. Every other value is bound.
 */
export class UserMemoryRepository {
  constructor(
    private readonly db: DbClient,
    /**
     * Stamped onto new rows as provenance. Null when a memory is formed
     * outside any workspace; never used to filter.
     */
    private readonly originWorkspaceId: string | null = null,
  ) {}

  /** The (user, collection) predicate every query starts from. */
  private scope(userId: string, collection: string) {
    return and(eq(userMemories.user_id, userId), eq(userMemories.collection, collection));
  }

  private static assertDimensions(embedding: number[]): void {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `user_memories expects ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
      );
    }
    // A NaN or Infinity would render as `NaN`/`Infinity` inside the vector
    // literal and come back as a Postgres syntax error from deep inside a
    // query. Say what is actually wrong instead.
    if (!embedding.every(Number.isFinite)) {
      throw new Error('user_memories expects a vector of finite numbers');
    }
  }

  /**
   * pgvector accepts the `'[1,2,3]'` text form. This is the one value that
   * cannot ride as a bound parameter — the literal has to be interpolated and
   * cast — so it is built from numbers only, never from user text.
   */
  private static vectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  /**
   * Insert memories. One statement for the whole batch, never one per row:
   * mem0 hands us every fact it extracted from a turn at once.
   */
  async insertMany(
    userId: string,
    collection: string,
    rows: InsertUserMemory[],
  ): Promise<void> {
    if (rows.length === 0) return;
    rows.forEach((row) => UserMemoryRepository.assertDimensions(row.embedding));

    await this.db.insert(userMemories).values(
      rows.map((row) => ({
        id: row.id,
        user_id: userId,
        workspace_id: this.originWorkspaceId,
        collection,
        memory: row.memory,
        embedding: row.embedding,
        payload: row.payload,
      })),
    );
  }

  /**
   * Nearest memories to `embedding`, closest first. `filters` matches extra
   * keys inside `payload` (mem0 scopes by `agent_id` / `run_id` / its own
   * metadata this way); the workspace and user are NOT taken from there.
   */
  async searchByEmbedding(
    userId: string,
    collection: string,
    embedding: number[],
    topK: number,
    filters: Record<string, string> = {},
  ): Promise<UserMemoryHit[]> {
    UserMemoryRepository.assertDimensions(embedding);
    const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(topK) || 1));
    const literal = UserMemoryRepository.vectorLiteral(embedding);

    const { rows } = await this.db.execute<{
      id: string;
      memory: string;
      collection: string;
      payload: UserMemoryPayload;
      created_at: string;
      updated_at: string;
      distance: number | string;
    }>(sql`
      SELECT id::text AS id, memory, collection, payload,
             created_at, updated_at,
             (embedding <=> ${literal}::vector) AS distance
      FROM user_memories
      WHERE user_id = ${userId}
        AND collection = ${collection}
        ${payloadFilterClause(filters)}
      ORDER BY distance ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  }

  /**
   * Lexical half of mem0's hybrid recall, over the lemmatized text mem0 stores
   * on `payload.textLemmatized`. Deliberately un-indexed: the predicate is
   * already narrowed to one user's memories, which is a handful of rows, so a
   * GIN index would cost more to maintain than it saves.
   *
   * Returns `ts_rank_cd`'s raw score; mem0 normalizes it before blending.
   */
  async keywordSearch(
    userId: string,
    collection: string,
    query: string,
    topK: number,
    filters: Record<string, string> = {},
  ): Promise<UserMemoryHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(topK) || 1));

    const { rows } = await this.db.execute<{
      id: string;
      memory: string;
      collection: string;
      payload: UserMemoryPayload;
      created_at: string;
      updated_at: string;
      score: number | string;
    }>(sql`
      SELECT id::text AS id, memory, collection, payload, created_at, updated_at,
             ts_rank_cd(
               to_tsvector('simple', coalesce(payload->>'textLemmatized', memory)),
               plainto_tsquery('simple', ${trimmed})
             ) AS score
      FROM user_memories
      WHERE user_id = ${userId}
        AND collection = ${collection}
        AND to_tsvector('simple', coalesce(payload->>'textLemmatized', memory))
            @@ plainto_tsquery('simple', ${trimmed})
        ${payloadFilterClause(filters)}
      ORDER BY score DESC
      LIMIT ${limit}
    `);

    // mem0 reads `score`; `distance` is carried so one hit type serves both
    // halves of hybrid search.
    return rows.map((row) => ({
      ...row,
      distance: 1 - Number(row.score),
      score: Number(row.score),
    })) as UserMemoryHit[];
  }

  /** One memory, or null when it is missing or belongs to someone else. */
  async findById(userId: string, id: string): Promise<UserMemoryRow | null> {
    const rows = await this.db
      .select({
        id: userMemories.id,
        memory: userMemories.memory,
        collection: userMemories.collection,
        payload: userMemories.payload,
        created_at: userMemories.created_at,
        updated_at: userMemories.updated_at,
      })
      .from(userMemories)
      .where(
        and(eq(userMemories.id, id), eq(userMemories.user_id, userId)),
      )
      .limit(1);

    return (rows[0] as UserMemoryRow | undefined) ?? null;
  }

  /** Replace a memory's text, vector and payload. No-op when it isn't theirs. */
  async update(
    userId: string,
    id: string,
    memory: string,
    embedding: number[],
    payload: UserMemoryPayload,
  ): Promise<void> {
    UserMemoryRepository.assertDimensions(embedding);
    await this.db
      .update(userMemories)
      .set({
        memory,
        embedding,
        payload,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(eq(userMemories.id, id), eq(userMemories.user_id, userId)),
      );
  }

  /**
   * Newest first. Used by Profile → Memory and by mem0's `getAll`.
   *
   * `offset` pages the listing. mem0 never passes one; it exists so the UI can
   * reach past the first page rather than leaving older memories unreachable —
   * and therefore undeletable — once a user accumulates more than one page.
   */
  async list(
    userId: string,
    collection: string,
    limit: number,
    filters: Record<string, string> = {},
    offset = 0,
  ): Promise<UserMemoryRow[]> {
    const capped = Math.min(MAX_ROWS, Math.max(1, Math.floor(limit) || 1));
    const skip = Math.max(0, Math.floor(offset) || 0);

    // Payload filters have no builder expression, so a filtered list falls
    // back to the same raw form the vector search uses.
    if (Object.keys(filters).length > 0) {
      const { rows } = await this.db.execute<UserMemoryRow>(sql`
        SELECT id::text AS id, memory, collection, payload, created_at, updated_at
        FROM user_memories
        WHERE user_id = ${userId}
          AND collection = ${collection}
          ${payloadFilterClause(filters)}
        ORDER BY created_at DESC
        LIMIT ${capped}
        OFFSET ${skip}
      `);
      return rows;
    }

    return (await this.db
      .select({
        id: userMemories.id,
        memory: userMemories.memory,
        collection: userMemories.collection,
        payload: userMemories.payload,
        created_at: userMemories.created_at,
        updated_at: userMemories.updated_at,
      })
      .from(userMemories)
      .where(this.scope(userId, collection))
      .orderBy(desc(userMemories.created_at))
      .limit(capped)
      .offset(skip)) as UserMemoryRow[];
  }

  /** How many memories this user has. */
  async count(userId: string, collection: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(userMemories)
      .where(this.scope(userId, collection));
    return Number(rows[0]?.count ?? 0);
  }

  /** Delete by id. Returns how many rows went — 0 when it wasn't theirs. */
  async deleteByIds(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const deleted = await this.db
      .delete(userMemories)
      .where(
        and(inArray(userMemories.id, ids), eq(userMemories.user_id, userId)),
      )
      .returning({ id: userMemories.id });
    return deleted.length;
  }

  /** Drop every memory this user has in a collection. */
  async deleteAll(userId: string, collection: string): Promise<number> {
    const deleted = await this.db
      .delete(userMemories)
      .where(this.scope(userId, collection))
      .returning({ id: userMemories.id });
    return deleted.length;
  }
}

/**
 * `AND payload->>'k' = 'v'` for each extra filter mem0 passes, as one
 * fragment. Keys are rendered as bound parameters too (`payload->>$n`), so a
 * key is never concatenated into SQL text.
 */
function payloadFilterClause(filters: Record<string, string>) {
  const entries = Object.entries(filters);
  if (entries.length === 0) return sql``;
  return sql.join(
    entries.map(([key, value]) => sql` AND payload->>${key} = ${value}`),
    sql``,
  );
}
