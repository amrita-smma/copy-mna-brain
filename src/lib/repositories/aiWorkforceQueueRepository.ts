import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { aiWorkforceQueue } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

// Single source of truth: rows come from Drizzle's $inferSelect on the table.
// Re-exported as WorkforceQueueRow for compatibility with MB-151 callers that
// were written against the original hand-typed shape.
export type WorkforceQueueRow = Tables<'ai_workforce_queue'>;
export type WorkforceStatus = WorkforceQueueRow['status'];
type Row = WorkforceQueueRow;
type Status = WorkforceStatus;

type TriggerSource = 'chat' | 'cron' | 'webhook' | 'api';

/**
 * Explicit insert shape used by the MB-151 enqueue() path. New code should
 * prefer `TablesInsert<'ai_workforce_queue'>` which is wider and stays in
 * sync with the Drizzle schema automatically.
 */
export interface WorkforceQueueInsert {
  agent_name: string;
  trigger_source: TriggerSource;
  trigger_meta?: Record<string, unknown>;
  input: Record<string, unknown>;
  priority?: number;
  parent_run_id?: string | null;
  origin_routine_id?: string | null;
  idempotency_key?: string | null;
  triggered_by_user_id?: string | null;
}

const TERMINAL_STATUSES: readonly Status[] = [
  'succeeded',
  'failed',
  'rejected',
  'timed_out',
] as const;

// Advisory lock key for the dispatcher critical section. Chosen as an
// arbitrary but stable bigint so concurrent dispatcherTick() callers serialize
// across the EXISTS(running) precheck + atomic claim. Without this, two
// callers can both pass the precheck and claim different rows, violating
// global-serial execution. Released automatically on tx commit/rollback.
// 0x4d42313437 = ASCII "MB147"; using BigInt() rather than the `n` literal
// suffix because the tsconfig target is ES2017.
const DISPATCHER_LOCK_KEY = BigInt('0x4d42313437');

export class AiWorkforceQueueRepository {
  constructor(private readonly db: DbClient) {}

  // ─────────────────────────────────────────────────────────────────────
  // MB-151 surface — simple CRUD used by /api/workforce-queue routes
  // ─────────────────────────────────────────────────────────────────────

  async enqueue(data: WorkforceQueueInsert): Promise<Row> {
    const [row] = await this.db
      .insert(aiWorkforceQueue)
      .values({
        agent_name: data.agent_name,
        trigger_source: data.trigger_source,
        trigger_meta: data.trigger_meta ?? {},
        input: data.input,
        priority: data.priority ?? 0,
        parent_run_id: data.parent_run_id ?? null,
        origin_routine_id: data.origin_routine_id ?? null,
        idempotency_key: data.idempotency_key ?? null,
        triggered_by_user_id: data.triggered_by_user_id ?? null,
      } as TablesInsert<'ai_workforce_queue'>)
      .returning();
    return row;
  }

  async list({ limit = 100 }: { limit?: number } = {}): Promise<Row[]> {
    return this.db
      .select()
      .from(aiWorkforceQueue)
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
  }

  async findById(id: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByToolCallId(toolCallId: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(
        sql`${aiWorkforceQueue.trigger_meta}->>'tool_call_id' = ${toolCallId}`,
      )
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(1);
    return row ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // MB-147 surface — queue mechanics: idempotency, atomic claim, reaper
  // ─────────────────────────────────────────────────────────────────────

  async findByIdempotencyKey(key: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.idempotency_key, key))
      .limit(1);
    return row ?? null;
  }

  // Returns the existing row (id) when the idempotency_key already exists;
  // otherwise inserts and returns the new row.
  async createOrGetByIdempotencyKey(
    input: TablesInsert<'ai_workforce_queue'>,
  ): Promise<{ row: Row; created: boolean }> {
    if (!input.idempotency_key) {
      const [row] = await this.db
        .insert(aiWorkforceQueue)
        .values(input)
        .returning();
      return { row, created: true };
    }

    const inserted = await this.db
      .insert(aiWorkforceQueue)
      .values(input)
      .onConflictDoNothing({ target: aiWorkforceQueue.idempotency_key })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };

    const existing = await this.findByIdempotencyKey(input.idempotency_key);
    if (!existing) {
      throw new Error(
        `idempotency_key ${input.idempotency_key} conflicted but row not found`,
      );
    }
    return { row: existing, created: false };
  }

  // Atomically claim the next runnable row.
  //
  // Serialized via pg_try_advisory_xact_lock so concurrent dispatcher invocations
  // cannot both pass the "is anything running?" precheck and each claim a
  // different row. Without the advisory lock the predicate-only approach in
  // the RFC leaks a race window when N callers fire within milliseconds.
  //
  // Returns null when:
  //   - another dispatcher is holding the lock (race lost — benign)
  //   - something is already running (global-serial guard)
  //   - the queue has no runnable rows
  //
  // resume_ready rows are always preferred over pending (status_priority
  // dominates the row's own priority column).
  async claimNextRunnable(): Promise<Row | null> {
    return this.db.transaction(async (tx) => {
      const lockResult = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${DISPATCHER_LOCK_KEY}) AS locked`,
      );
      const locked = (lockResult as unknown as Array<{ locked: boolean }>)[0]
        ?.locked;
      if (!locked) return null;

      const existsResult = await tx.execute<{ has_running: boolean }>(
        sql`SELECT EXISTS(SELECT 1 FROM ai_workforce_queue WHERE status = 'running') AS has_running`,
      );
      const hasRunning = (
        existsResult as unknown as Array<{ has_running: boolean }>
      )[0]?.has_running;
      if (hasRunning) return null;

      const claimResult = await tx.execute<Row>(sql`
        UPDATE ai_workforce_queue r
        SET status = 'running',
            started_at = NOW(),
            last_heartbeat_at = NOW()
        WHERE r.id = (
          SELECT id FROM ai_workforce_queue
          WHERE status IN ('resume_ready', 'pending')
          ORDER BY
            CASE WHEN status = 'resume_ready' THEN 0 ELSE 1 END,
            priority DESC,
            created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      const claimed = (claimResult as unknown as Row[])[0];
      return claimed ?? null;
    });
  }

  async hasRunning(): Promise<boolean> {
    const result = await this.db.execute<{ has_running: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM ai_workforce_queue WHERE status = 'running') AS has_running`,
    );
    return (
      (result as unknown as Array<{ has_running: boolean }>)[0]?.has_running ??
      false
    );
  }

  // Find rows stuck in 'running' with stale heartbeats. Used by the reaper.
  async findStuckRunning(stalerThanIso: string): Promise<Row[]> {
    return this.db
      .select()
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.status, 'running'),
          lte(aiWorkforceQueue.last_heartbeat_at, stalerThanIso),
        ),
      );
  }

  async markSucceeded(id: string, output: unknown): Promise<Row> {
    return this.updateStatusOrThrow(id, {
      status: 'succeeded',
      output: (output ?? null) as Row['output'],
      ended_at: new Date().toISOString(),
      error: null,
    });
  }

  async markFailed(id: string, error: Record<string, unknown>): Promise<Row> {
    return this.updateStatusOrThrow(id, {
      status: 'failed',
      error: error as Row['error'],
      ended_at: new Date().toISOString(),
    });
  }

  async markResumeReady(
    id: string,
    reason: string,
    resumeToken?: string,
  ): Promise<Row> {
    const patch: Partial<Row> = {
      status: 'resume_ready',
      resume_reason: reason,
    };
    if (resumeToken !== undefined) patch.resume_token = resumeToken;
    return this.updateStatusOrThrow(id, patch);
  }

  async heartbeat(id: string): Promise<void> {
    await this.db
      .update(aiWorkforceQueue)
      .set({ last_heartbeat_at: new Date().toISOString() })
      .where(eq(aiWorkforceQueue.id, id));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(aiWorkforceQueue)
      .set({ title })
      .where(eq(aiWorkforceQueue.id, id));
  }

  private async updateStatusOrThrow(
    id: string,
    patch: Partial<Row>,
  ): Promise<Row> {
    const [row] = await this.db
      .update(aiWorkforceQueue)
      .set(patch as TablesUpdate<'ai_workforce_queue'>)
      .where(eq(aiWorkforceQueue.id, id))
      .returning();
    if (!row) throw new Error(`ai_workforce_queue row ${id} not found`);
    return row;
  }

  static isTerminal(status: Status): boolean {
    return TERMINAL_STATUSES.includes(status);
  }
}
