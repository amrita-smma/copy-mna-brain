/**
 * mem0's `VectorStore` interface, implemented over `UserMemoryRepository`.
 *
 * mem0 ships a `pgvector` provider, but it opens and holds its own
 * `pg.Client`, provisions a database if one is missing, and runs `CREATE
 * TABLE` at request time. All three are wrong here: this app runs on Vercel
 * behind a shared pool (an unpooled client per lambda is exactly the
 * connection exhaustion the backend rules warn about), and its schema is owned
 * by Drizzle migrations, not by a library's startup path.
 *
 * So mem0 keeps the part it is good at — extracting facts from a
 * conversation and deciding ADD / UPDATE / DELETE against what is already
 * known — and storage goes through the normal repository on the normal pool.
 * Everything here is a thin translation between mem0's `(id, vector, payload)`
 * shape and `user_memories`.
 *
 * One instance is bound to one (user, collection). mem0 still passes `user_id`
 * in its filters; it is checked against the bound user rather than trusted, so
 * a filter can never widen the scope.
 */
import {
  MEMORY_COLLECTION,
  type UserMemoryHit,
  type UserMemoryPayload,
  type UserMemoryRepository,
  type UserMemoryRow,
} from '@/lib/repositories';

/** mem0's `VectorStoreResult`, restated so this module doesn't import types from `mem0ai/oss`. */
export interface MemoryVectorRecord {
  id: string;
  payload: Record<string, unknown>;
  score?: number;
}

export interface DrizzleMemoryVectorStoreConfig {
  repository: UserMemoryRepository;
  userId: string;
  /** mem0's logical store. `memories`, or `memories_entities` for its entity index. */
  collectionName?: string;
}

/**
 * Identity mem0 asks the store for when it builds a telemetry id. Telemetry is
 * off (see `client.ts`), so this only has to be stable and non-identifying.
 */
const TELEMETRY_ID = 'mna-brain';

/**
 * pgvector's `<=>` is cosine *distance* (0 = identical). mem0 reads `score` as
 * a *similarity* — it defaults to a `>= 0.1` threshold and treats `< 0.5` as a
 * weak entity match — so the polarity has to be flipped on the way out.
 */
function toScore(hit: UserMemoryHit): number {
  return typeof hit.score === 'number' ? hit.score : 1 - hit.distance;
}

function toRecord(row: UserMemoryRow, score?: number): MemoryVectorRecord {
  return {
    id: row.id,
    // mem0 reads the memory text off `payload.data`. Older rows (or an import
    // that wrote the column directly) fall back to the column.
    payload: { ...row.payload, data: row.payload.data ?? row.memory },
    ...(score === undefined ? {} : { score }),
  };
}

export class DrizzleMemoryVectorStore {
  private readonly repository: UserMemoryRepository;
  private readonly userId: string;
  private readonly collectionName: string;
  private telemetryId = TELEMETRY_ID;

  constructor(config: DrizzleMemoryVectorStoreConfig) {
    if (!config?.repository) {
      throw new Error('DrizzleMemoryVectorStore requires a UserMemoryRepository');
    }
    if (!config.userId) {
      throw new Error('DrizzleMemoryVectorStore requires a userId');
    }
    this.repository = config.repository;
    this.userId = config.userId;
    this.collectionName = config.collectionName ?? MEMORY_COLLECTION;
  }

  /** The table already exists — it is a migration, not a startup side effect. */
  async initialize(): Promise<void> {}

  /**
   * mem0's filters, minus the scoping key this store owns. `user_id` is
   * dropped rather than forwarded: the bound user is the only one reachable,
   * and letting it through as a payload filter would only let mem0 narrow to a
   * user it cannot read anyway. Non-string values (mem0's advanced operator
   * objects) are dropped too — the repository matches `payload->>k` as text.
   */
  private payloadFilters(filters?: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (key === 'user_id') continue;
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, unknown>[],
  ): Promise<void> {
    if (ids.length !== vectors.length || ids.length !== payloads.length) {
      throw new Error('insert expects ids, vectors and payloads of the same length');
    }

    await this.repository.insertMany(
      this.userId,
      this.collectionName,
      ids.map((id, i) => {
        const payload = (payloads[i] ?? {}) as UserMemoryPayload;
        const text = typeof payload.data === 'string' ? payload.data : '';
        return {
          id,
          memory: text,
          embedding: vectors[i]!,
          // Stamped rather than trusted: whatever mem0 put in `user_id`, the
          // row belongs to the user this store is bound to.
          payload: { ...payload, user_id: this.userId },
        };
      }),
    );
  }

  async search(
    query: number[],
    topK = 5,
    filters?: Record<string, unknown>,
  ): Promise<MemoryVectorRecord[]> {
    const hits = await this.repository.searchByEmbedding(
      this.userId,
      this.collectionName,
      query,
      topK,
      this.payloadFilters(filters),
    );
    return hits.map((hit) => toRecord(hit, toScore(hit)));
  }

  /**
   * The lexical half of mem0's hybrid recall. mem0 tolerates a null (it just
   * skips the BM25 blend), so a failure here degrades to pure vector search
   * rather than failing the turn.
   */
  async keywordSearch(
    query: string,
    topK = 5,
    filters?: Record<string, unknown>,
  ): Promise<MemoryVectorRecord[] | null> {
    try {
      const hits = await this.repository.keywordSearch(
        this.userId,
        this.collectionName,
        query,
        topK,
        this.payloadFilters(filters),
      );
      return hits.map((hit) => toRecord(hit, toScore(hit)));
    } catch (err) {
      console.error('[memory] keyword search failed, falling back to vector only:', err);
      return null;
    }
  }

  async get(vectorId: string): Promise<MemoryVectorRecord | null> {
    const row = await this.repository.findById(this.userId, vectorId);
    return row ? toRecord(row) : null;
  }

  async update(
    vectorId: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const next = { ...(payload as UserMemoryPayload), user_id: this.userId };
    const text = typeof next.data === 'string' ? next.data : '';
    await this.repository.update(this.userId, vectorId, text, vector, next);
  }

  async delete(vectorId: string): Promise<void> {
    await this.repository.deleteByIds(this.userId, [vectorId]);
  }

  /**
   * mem0 calls this `[results, count]`. The count is the length of this page,
   * not a total: mem0 only ever reads the array, and a second `count(*)` per
   * listing would be a query nobody looks at.
   */
  async list(
    filters?: Record<string, unknown>,
    topK = 100,
  ): Promise<[MemoryVectorRecord[], number]> {
    const rows = await this.repository.list(
      this.userId,
      this.collectionName,
      topK,
      this.payloadFilters(filters),
    );
    const records = rows.map((row) => toRecord(row));
    return [records, records.length];
  }

  /** mem0's "drop the collection" — here, every memory this user has in it. */
  async deleteCol(): Promise<void> {
    await this.repository.deleteAll(this.userId, this.collectionName);
  }

  async getUserId(): Promise<string> {
    return this.telemetryId;
  }

  async setUserId(userId: string): Promise<void> {
    this.telemetryId = userId;
  }
}
