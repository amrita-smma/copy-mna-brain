import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { aiWorkforceQueue } from '@/lib/db/schema';
import type { HumanDecision, PendingUserMessage } from '@/lib/db/schema';
import type {
  TaskErrorPayload,
  TaskNotification,
} from '@/lib/notifications/types';
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

/** Whether a run has finished (successfully or not) and will never progress. */
export function isTerminalWorkforceStatus(status: Status): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Advisory lock key for the dispatcher critical section. Chosen as an
// arbitrary but stable bigint so concurrent dispatcherTick() callers serialize
// across the EXISTS(running) precheck + atomic claim. Without this, two
// callers can both pass the precheck and claim different rows, violating
// global-serial execution. Released automatically on tx commit/rollback.
// 0x4d42313437 = ASCII "MB147"; using BigInt() rather than the `n` literal
// suffix because the tsconfig target is ES2017.
const DISPATCHER_LOCK_KEY = BigInt('0x4d42313437');

export class AiWorkforceQueueRepository {
  /**
   * @param workspaceId Applied only to the MB-151 CRUD surface below (the
   *   `/api/workforce-queue` routes a user browses). The MB-147 dispatcher
   *   surface (claim/lock/heartbeat/status-transition methods) intentionally
   *   stays workspace-agnostic: RFC Story 4 specifies one shared worker queue
   *   across every workspace for cost throttling, so the claim query must see
   *   every workspace's pending rows, not just this one. Do not add workspace
   *   scoping to `claimNextRunnable`/`hasRunning`/`findStuckRunning` — that
   *   would silently break the shared-worker model.
   */
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

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
        workspace_id: this.workspaceId,
      } as TablesInsert<'ai_workforce_queue'>)
      .returning();
    return row;
  }

  async list({ limit = 100 }: { limit?: number } = {}): Promise<Row[]> {
    return this.db
      .select()
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.workspace_id, this.workspaceId))
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
  }

  async listFiltered({
    status,
    agentName,
    triggeredByUserId,
    limit = 10,
  }: {
    status?: Status | Status[];
    agentName?: string;
    triggeredByUserId?: string;
    limit?: number;
  }): Promise<Row[]> {
    const conditions = [eq(aiWorkforceQueue.workspace_id, this.workspaceId)];
    if (status !== undefined) {
      const statuses = Array.isArray(status) ? status : [status];
      if (statuses.length === 0) return [];
      conditions.push(inArray(aiWorkforceQueue.status, statuses));
    }
    if (agentName) {
      conditions.push(eq(aiWorkforceQueue.agent_name, agentName));
    }
    if (triggeredByUserId) {
      conditions.push(eq(aiWorkforceQueue.triggered_by_user_id, triggeredByUserId));
    }

    return this.db
      .select()
      .from(aiWorkforceQueue)
      .where(and(...conditions))
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
  }

  async findActiveByCompanyId(
    agentName: string,
    companyId: string,
  ): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.agent_name, agentName),
          sql`${aiWorkforceQueue.trigger_meta}->>'company_id' = ${companyId}`,
          sql`${aiWorkforceQueue.status} NOT IN ('succeeded', 'failed', 'rejected', 'timed_out')`,
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(1);
    return row ?? null;
  }

  /**
   * Batched {@link findActiveByCompanyId}: the subset of `companyIds` that
   * already have a non-terminal run for `agentName`. Lets a bulk caller ask
   * "which of these are already in flight?" in one query instead of one
   * lookup per company inside a loop.
   */
  async findActiveCompanyIds(
    agentName: string,
    companyIds: string[],
  ): Promise<Set<string>> {
    if (companyIds.length === 0) return new Set();
    const rows = await this.db
      .select({
        company_id: sql<string>`${aiWorkforceQueue.trigger_meta}->>'company_id'`,
      })
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.agent_name, agentName),
          inArray(sql`${aiWorkforceQueue.trigger_meta}->>'company_id'`, companyIds),
          sql`${aiWorkforceQueue.status} NOT IN ('succeeded', 'failed', 'rejected', 'timed_out')`,
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
        ),
      );
    return new Set(rows.map((r) => r.company_id).filter(Boolean));
  }

  /** Same idempotency check as {@link findActiveByCompanyId}, keyed on a
   * `fund_asset_id` instead — used by FundAiOpinionService to avoid
   * stacking duplicate in-flight Fund AI Opinion runs for a holding. */
  async findActiveByFundAssetId(
    agentName: string,
    fundAssetId: string,
  ): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.agent_name, agentName),
          sql`${aiWorkforceQueue.trigger_meta}->>'fund_asset_id' = ${fundAssetId}`,
          sql`${aiWorkforceQueue.status} NOT IN ('succeeded', 'failed', 'rejected', 'timed_out')`,
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(1);
    return row ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // MB-147 surface — queue mechanics: idempotency, atomic claim, reaper.
  // Deliberately NOT workspace-scoped — see the constructor doc comment.
  // ─────────────────────────────────────────────────────────────────────

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
      const locked = (
        lockResult as unknown as { rows: Array<{ locked: boolean }> }
      ).rows[0]?.locked;
      if (!locked) return null;

      const existsResult = await tx.execute<{ has_running: boolean }>(
        sql`SELECT EXISTS(SELECT 1 FROM ai_workforce_queue WHERE status = 'running') AS has_running`,
      );
      const hasRunning = (
        existsResult as unknown as { rows: Array<{ has_running: boolean }> }
      ).rows[0]?.has_running;
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
      const claimed = (claimResult as unknown as { rows: Row[] }).rows[0];
      return claimed ?? null;
    });
  }

  async hasRunning(): Promise<boolean> {
    const result = await this.db.execute<{ has_running: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM ai_workforce_queue WHERE status = 'running') AS has_running`,
    );
    return (
      (result as unknown as { rows: Array<{ has_running: boolean }> }).rows[0]?.has_running ??
      false
    );
  }

  /**
   * For each of the given rows, count how many rows GLOBALLY (any workspace)
   * would be claimed before it — the true "jobs in front" figure under the
   * shared single-worker queue model (RFC: "Share queues (show how many jobs
   * in front)"). A workspace-local count is misleading here: another
   * workspace's higher-priority or earlier-created row still claims the slot
   * first, invisibly to this workspace's own queue view.
   *
   * Also returns `aheadOtherWorkspaces`, the subset of that count belonging
   * to a *different* workspace than the target row's own — used for the "N
   * jobs ahead · other workspaces" summary. This must NOT be derived by
   * subtracting a same-workspace guess from `aheadGlobally`: a target's own
   * workspace can itself have a `resume_ready` row (shown under "In
   * progress", not "Queued"), which always outranks a plain `pending` row
   * and would otherwise be miscounted as "another workspace's" job ahead of
   * you. Filtering by `workspace_id` directly in the query sidesteps that.
   *
   * Mirrors claimNextRunnable's exact ordering: resume_ready before pending,
   * then priority DESC, then created_at ASC. Ids not currently in
   * ('pending', 'resume_ready') aren't in this map — "ahead" is meaningless
   * for a row that's already running or terminal.
   */
  async getGlobalQueuePositions(
    ids: string[],
  ): Promise<Map<string, { aheadGlobally: number; aheadOtherWorkspaces: number }>> {
    if (ids.length === 0) return new Map();
    const targets = await this.db
      .select({
        id: aiWorkforceQueue.id,
        status: aiWorkforceQueue.status,
        priority: aiWorkforceQueue.priority,
        created_at: aiWorkforceQueue.created_at,
        workspace_id: aiWorkforceQueue.workspace_id,
      })
      .from(aiWorkforceQueue)
      .where(
        and(
          inArray(aiWorkforceQueue.id, ids),
          inArray(aiWorkforceQueue.status, ['pending', 'resume_ready']),
        ),
      );

    // One count query per target row rather than a single correlated
    // subquery: a scalar subquery referencing the outer row's columns by
    // name is ambiguous here, since the subquery's own FROM (aliased `g`,
    // same physical table) has columns of the same name — Postgres resolves
    // the unqualified reference to the innermost scope (`g`) instead of the
    // outer row, silently comparing every row to itself. Binding the
    // target's own values as parameters instead of column references
    // sidesteps the ambiguity entirely. Bounded by the size of `ids` (one
    // workspace's own pending/resume_ready rows — small in practice).
    const result = new Map<string, { aheadGlobally: number; aheadOtherWorkspaces: number }>();
    for (const target of targets) {
      const statusPriority = target.status === 'resume_ready' ? 0 : 1;
      const countResult = await this.db.execute<{
        ahead_count: string;
        ahead_count_other: string;
      }>(sql`
        SELECT
          COUNT(*) AS ahead_count,
          COUNT(*) FILTER (WHERE g.workspace_id != ${target.workspace_id}) AS ahead_count_other
        FROM ai_workforce_queue g
        WHERE g.status IN ('pending', 'resume_ready')
          AND (
            (CASE WHEN g.status = 'resume_ready' THEN 0 ELSE 1 END) < ${statusPriority}
            OR (
              (CASE WHEN g.status = 'resume_ready' THEN 0 ELSE 1 END) = ${statusPriority}
              AND (
                g.priority > ${target.priority}
                OR (g.priority = ${target.priority} AND g.created_at < ${target.created_at})
              )
            )
          )
      `);
      const row = (
        countResult as unknown as { rows: Array<{ ahead_count: string; ahead_count_other: string }> }
      ).rows[0];
      result.set(target.id, {
        aheadGlobally: Number(row?.ahead_count ?? '0'),
        aheadOtherWorkspaces: Number(row?.ahead_count_other ?? '0'),
      });
    }
    return result;
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
  // a from-scratch re-run), and starts in status='pending'. Inherits the
  // original row's workspace_id (not `this.workspaceId`) so a retry always
  // lands in the same workspace as the run being retried.
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
        workspace_id: original.workspace_id,
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
    newStatus?: Status,
  ): Promise<{ row: Row; queue_position: number }> {
    const updatePayload: Omit<Partial<typeof aiWorkforceQueue.$inferInsert>, 'pending_user_messages'> & { pending_user_messages?: any } = {
      pending_user_messages: sql`${aiWorkforceQueue.pending_user_messages} || ${JSON.stringify([message])}::jsonb`,
    };
    if (newStatus) {
      updatePayload.status = newStatus;
      if (newStatus === 'pending') {
        updatePayload.started_at = null;
        updatePayload.ended_at = null;
        updatePayload.error = null;
      }
    }
    const [row] = await this.db
      .update(aiWorkforceQueue)
      .set(updatePayload)
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

  // Notifications are persisted under `error.notifications` so the existing
  // shape (e.g. { code: 'cancelled_by_user', ... }) is preserved untouched.
  // Read-modify-write is wrapped in a tx with SELECT … FOR UPDATE so two
  // concurrent appends don't lose one another's notification.
  async addNotification(
    id: string,
    notification: TaskNotification,
  ): Promise<Row> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ error: aiWorkforceQueue.error })
        .from(aiWorkforceQueue)
        .where(eq(aiWorkforceQueue.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new Error(`ai_workforce_queue row ${id} not found`);
      const existing = toTaskErrorPayload(current.error);
      const next: TaskErrorPayload = {
        ...existing,
        notifications: [...(existing.notifications ?? []), notification],
      };
      const [row] = await tx
        .update(aiWorkforceQueue)
        .set({ error: next as Row['error'] })
        .where(eq(aiWorkforceQueue.id, id))
        .returning();
      if (!row) throw new Error(`ai_workforce_queue row ${id} not found`);
      return row;
    });
  }

  async dismissNotification(
    id: string,
    notificationId: string,
  ): Promise<Row> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ error: aiWorkforceQueue.error })
        .from(aiWorkforceQueue)
        .where(eq(aiWorkforceQueue.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new Error(`ai_workforce_queue row ${id} not found`);
      const existing = toTaskErrorPayload(current.error);
      const dismissedAt = new Date().toISOString();
      const next: TaskErrorPayload = {
        ...existing,
        notifications: (existing.notifications ?? []).map((n) =>
          n.id === notificationId && n.dismissedAt === null
            ? { ...n, dismissedAt }
            : n,
        ),
      };
      const [row] = await tx
        .update(aiWorkforceQueue)
        .set({ error: next as Row['error'] })
        .where(eq(aiWorkforceQueue.id, id))
        .returning();
      if (!row) throw new Error(`ai_workforce_queue row ${id} not found`);
      return row;
    });
  }

  listNotifications(row: Row, { includeDismissed = false } = {}): TaskNotification[] {
    const payload = toTaskErrorPayload(row.error);
    const all = payload.notifications ?? [];
    return includeDismissed ? all : all.filter((n) => n.dismissedAt === null);
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

function toTaskErrorPayload(error: Row['error']): TaskErrorPayload {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return {};
  return error as TaskErrorPayload;
}
