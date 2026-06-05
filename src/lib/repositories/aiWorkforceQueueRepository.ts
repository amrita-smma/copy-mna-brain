import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { aiWorkforceQueue } from '@/lib/db/schema';
import type { HumanDecision, PendingUserMessage } from '@/lib/db/schema';
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

  // User-initiated cancellation. Flips the row to a terminal `failed` state
  // with an explicit cancellation marker in the error payload so the row is
  // distinguishable from agent-side failures (and so the dispatcher's
  // hasRunning() check correctly sees nothing running). For in-flight rows
  // (status='running', etc.) the WDK workflow keeps executing in the
  // background — its eventual markSucceeded/markFailed write is rejected
  // here because the row's status is already terminal at the DB level,
  // satisfied via the `not(isTerminal)` precondition.
  //
  // Returns null when the row is already in a terminal state (idempotent —
  // double-click on Cancel is benign).
  async cancelById(
    id: string,
    options: { userId?: string | null; reason?: string } = {},
  ): Promise<Row | null> {
    const error: Record<string, unknown> = {
      code: 'cancelled_by_user',
      cancelled_at: new Date().toISOString(),
    };
    if (options.userId) error.cancelled_by_user_id = options.userId;
    if (options.reason) error.reason = options.reason;

    const [row] = await this.db
      .update(aiWorkforceQueue)
      .set({
        status: 'failed',
        error: error as Row['error'],
        ended_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(aiWorkforceQueue.id, id),
          sql`${aiWorkforceQueue.status} NOT IN ('succeeded', 'failed', 'rejected', 'timed_out')`,
        ),
      )
      .returning();
    return row ?? null;
  }

  // Enqueue a fresh copy of an existing row. The original stays terminal;
  // the new row carries `retried_from_id` pointing back at it.
  //
  // Preserves agent_name, trigger_source, input, priority, parent_run_id,
  // origin_routine_id, and triggered_by_user_id (so attribution and
  // routine-membership are correct). Drops idempotency_key (a retry by
  // definition is a fresh attempt and shouldn't collide with the original
  // key), drops trigger_meta (HITL tool_call_id contexts don't transfer to
  // a from-scratch re-run), and starts in status='pending'.
  async retryById(
    originalId: string,
    options: { userId?: string | null } = {},
  ): Promise<Row> {
    const original = await this.findById(originalId);
    if (!original) {
      throw new Error(`ai_workforce_queue row ${originalId} not found`);
    }

    const [row] = await this.db
      .insert(aiWorkforceQueue)
      .values({
        agent_name: original.agent_name,
        trigger_source: original.trigger_source,
        input: original.input,
        priority: original.priority,
        parent_run_id: original.parent_run_id,
        origin_routine_id: original.origin_routine_id,
        triggered_by_user_id: options.userId ?? original.triggered_by_user_id,
        title: original.title,
        retried_from_id: original.id,
      } as TablesInsert<'ai_workforce_queue'>)
      .returning();
    return row;
  }

  // Transition to resume_ready and stash the resume payload for the workflow
  // to consume. `resumeToken` carries the LangGraph resume payload as a
  // JSON-encoded string (the column is `text`); the workflow JSON.parses it
  // and feeds it to `graph.resume`, then calls clearResumeToken once consumed.
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

  async clearResumeToken(id: string): Promise<void> {
    await this.db
      .update(aiWorkforceQueue)
      .set({ resume_token: null })
      .where(eq(aiWorkforceQueue.id, id));
  }

  // Bulk renumber row priorities (drag-to-reorder writes through this).
  // Each call wraps all updates in a single transaction so a reorder either
  // applies fully or not at all; intermediate inconsistencies never reach
  // the dispatcher's claim query.
  async setPriorities(
    updates: Array<{ id: string; priority: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(aiWorkforceQueue)
          .set({ priority: u.priority })
          .where(eq(aiWorkforceQueue.id, u.id));
      }
    });
  }

  // Transition to waiting_for_human_input — the agent emitted a HITL
  // interrupt and is paused awaiting a decision from the task creator.
  async markWaitingForHumanInput(id: string, reason: string): Promise<Row> {
    return this.updateStatusOrThrow(id, {
      status: 'waiting_for_human_input',
      resume_reason: reason,
    });
  }

  // Append one HumanDecision to the JSONB array. Uses `||` jsonb concat so
  // we never have to read-then-write — safe under concurrent decisions for
  // the same row even though the API enforces single-creator serialization.
  async appendDecision(id: string, decision: HumanDecision): Promise<Row> {
    const [row] = await this.db
      .update(aiWorkforceQueue)
      .set({
        human_decisions: sql`${aiWorkforceQueue.human_decisions} || ${JSON.stringify([decision])}::jsonb`,
      })
      .where(eq(aiWorkforceQueue.id, id))
      .returning();
    if (!row) throw new Error(`ai_workforce_queue row ${id} not found`);
    return row;
  }

  // Append one PendingUserMessage to the JSONB buffer. Same `||` concat
  // pattern as appendDecision — safe under concurrent appends. Returns the
  // updated row plus the 1-indexed position the message occupies in the
  // buffer (position 1 = next to be consumed).
  async appendPendingUserMessage(
    id: string,
    message: PendingUserMessage,
  ): Promise<{ row: Row; queue_position: number }> {
    const [row] = await this.db
      .update(aiWorkforceQueue)
      .set({
        pending_user_messages: sql`${aiWorkforceQueue.pending_user_messages} || ${JSON.stringify([message])}::jsonb`,
      })
      .where(eq(aiWorkforceQueue.id, id))
      .returning();
    if (!row) throw new Error(`ai_workforce_queue row ${id} not found`);
    return { row, queue_position: row.pending_user_messages.length };
  }

  // Atomically read-and-clear the pending_user_messages buffer. Wrapped in
  // a transaction with SELECT ... FOR UPDATE so a concurrent append from the
  // /message route either lands before the lock is taken (gets consumed) or
  // after the clear (stays for the next claim) — never duplicated, never
  // lost. Called by runAgent's load step before invoke/resume.
  async consumePendingUserMessages(
    id: string,
  ): Promise<PendingUserMessage[]> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ msgs: aiWorkforceQueue.pending_user_messages })
        .from(aiWorkforceQueue)
        .where(eq(aiWorkforceQueue.id, id))
        .for('update')
        .limit(1);
      const messages = current?.msgs ?? [];
      if (messages.length === 0) return [];
      await tx
        .update(aiWorkforceQueue)
        .set({ pending_user_messages: [] })
        .where(eq(aiWorkforceQueue.id, id));
      return messages;
    });
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
