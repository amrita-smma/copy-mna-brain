import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { aiWorkforceQueue, insights, routines, users } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';
import { ACTIVE_WORKFORCE_STATUSES } from './aiWorkforceQueueRepository';

export type RoutineRow = Tables<'routines'>;
export type RoutineInsert = TablesInsert<'routines'>;
export type RoutineUpdate = TablesUpdate<'routines'>;
/**
 * `insight_agent_key` is the refreshed insight's current binding, so the rail
 * can name the agent in a paused routine's notice (MB-560) without a second
 * request.
 */
export type RoutineListRow = RoutineRow & {
  insight_name: string | null;
  insight_agent_key: string | null;
};

/** A bot's routine, with its creator's name for the bot's Routines tab. */
export type BotRoutineRow = RoutineRow & { created_by_name: string | null };

export interface InsightRefreshTarget {
  name: string;
  archived: boolean;
  agentKey: string | null;
}

const ROUTINE_DISPATCHER_LOCK_KEY = BigInt('0x4d4231343852'); // "MB148R"

export class RoutinesRepository {
  /**
   * @param workspaceId Stamped on every routine this repository creates.
   *   `routines.workspace_id` is nullable only for pre-tenancy rows that
   *   predate this column; `is_system` is orthogonal (marks a routine as
   *   service-authored rather than user-authored) and every `is_system`
   *   routine still belongs to exactly one workspace.
   */
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async create(data: RoutineInsert): Promise<RoutineRow> {
    const [row] = await this.db
      .insert(routines)
      .values({ ...data, workspace_id: data.workspace_id ?? this.workspaceId })
      .returning();
    return row;
  }

  private scopeCond() {
    return or(eq(routines.workspace_id, this.workspaceId), isNull(routines.workspace_id));
  }

  async findById(id: string): Promise<RoutineRow | null> {
    const [row] = await this.db
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), this.scopeCond()))
      .limit(1);
    return row ?? null;
  }

  /**
   * This workspace's own `is_system` routine matching `title` — e.g. the
   * per-workspace market-scanning routine. Scoped strictly to this
   * workspace (not `scopeCond()`'s legacy-NULL fallback) since every
   * `is_system` routine created going forward carries a real workspace_id.
   */
  async findSystemRoutineByTitle(title: string): Promise<RoutineRow | null> {
    const [row] = await this.db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.workspace_id, this.workspaceId),
          eq(routines.is_system, true),
          eq(routines.title, title),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * This workspace's non-archived routine for the given insight, or null.
   * Scoped strictly to this workspace (not scopeCond()'s legacy-NULL fallback).
   */
  async findActiveByInsightId(insightId: string): Promise<RoutineRow | null> {
    const [row] = await this.db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.workspace_id, this.workspaceId),
          eq(routines.insight_id, insightId),
          isNull(routines.archived_at),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The active refresh routines of many insights in one query — the batched
   * {@link findActiveByInsightId}, with the same filters, for the insight
   * list's refresh badges. Ordered by `insight_id` so callers can group in one
   * pass. At most one per insight (`uq_routines_active_insight`); insights
   * without one are absent. Guard: `[]` without querying for no ids.
   */
  async findActiveByInsightIds(insightIds: string[]): Promise<RoutineRow[]> {
    if (insightIds.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.workspace_id, this.workspaceId),
          inArray(routines.insight_id, insightIds),
          isNull(routines.archived_at),
        ),
      )
      .orderBy(asc(routines.insight_id));
  }

  /**
   * Look up insight names for the given IDs in a single query. Deliberately
   * NOT workspace-scoped: the cron tick fires routines across workspaces.
   * Guard: returns an empty Map without querying if insightIds is empty.
   */
  async findInsightNamesByIds(insightIds: string[]): Promise<Map<string, string>> {
    if (insightIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({
        id: insights.id,
        name: insights.name,
      })
      .from(insights)
      .where(inArray(insights.id, insightIds));

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.id, row.name);
    }
    return map;
  }

  /**
   * One inArray query, NOT workspace-scoped (same reason as findInsightNamesByIds);
   * empty → new Map() with no DB call. `agentKey` is the insight's raw binding
   * (null when unbound), which the fire tick resolves into the run's agent.
   */
  async findInsightRefreshTargetsByIds(
    insightIds: string[],
  ): Promise<Map<string, InsightRefreshTarget>> {
    if (insightIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({
        id: insights.id,
        name: insights.name,
        archived_at: insights.archived_at,
        agent_key: insights.agent_key,
      })
      .from(insights)
      .where(inArray(insights.id, insightIds));

    const map = new Map<string, InsightRefreshTarget>();
    for (const row of rows) {
      map.set(row.id, {
        name: row.name,
        archived: Boolean(row.archived_at),
        agentKey: row.agent_key ?? null,
      });
    }
    return map;
  }

  /**
   * A workforce routine by id: null for a bot's routine, which only the bot's
   * own routes manage (`BotRoutineService`).
   */
  async findWorkforceRoutineById(id: string): Promise<RoutineRow | null> {
    const row = await this.findById(id);
    return row && row.bot_id === null ? row : null;
  }

  /**
   * This workspace's own workforce routines plus legacy pre-tenancy rows with
   * no workspace_id. Bot routines are listed per bot (`listForBot`).
   */
  async list(opts: { includeArchived?: boolean } = {}): Promise<RoutineListRow[]> {
    const where = opts.includeArchived
      ? and(this.scopeCond(), isNull(routines.bot_id))
      : and(this.scopeCond(), isNull(routines.bot_id), isNull(routines.archived_at));
    return this.db
      .select({
        ...getTableColumns(routines),
        insight_name: insights.name,
        insight_agent_key: insights.agent_key,
      })
      .from(routines)
      .leftJoin(insights, eq(insights.id, routines.insight_id))
      .where(where)
      .orderBy(desc(routines.created_at));
  }

  /**
   * A bot's live routines, oldest first, each with its creator's name. With
   * `createdBy`, only that user's (Brain Bot's routines are each user's own).
   */
  async listForBot(botId: string, opts: { createdBy?: string } = {}): Promise<BotRoutineRow[]> {
    const conditions = [eq(routines.workspace_id, this.workspaceId), eq(routines.bot_id, botId), isNull(routines.archived_at)];
    if (opts.createdBy) conditions.push(eq(routines.created_by, opts.createdBy));
    return this.db
      .select({ ...getTableColumns(routines), created_by_name: users.name })
      .from(routines)
      .leftJoin(users, eq(users.id, routines.created_by))
      .where(and(...conditions))
      .orderBy(asc(routines.created_at), asc(routines.id));
  }

  /** One of a bot's live routines, or null; with `createdBy`, only if that user made it. */
  async findForBot(botId: string, id: string, opts: { createdBy?: string } = {}): Promise<BotRoutineRow | null> {
    const [row] = await this.db
      .select({ ...getTableColumns(routines), created_by_name: users.name })
      .from(routines)
      .leftJoin(users, eq(users.id, routines.created_by))
      .where(
        and(
          eq(routines.id, id),
          eq(routines.workspace_id, this.workspaceId),
          eq(routines.bot_id, botId),
          isNull(routines.archived_at),
          opts.createdBy ? eq(routines.created_by, opts.createdBy) : undefined,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async update(id: string, patch: RoutineUpdate): Promise<RoutineRow> {
    const [row] = await this.db
      .update(routines)
      .set({ ...patch, updated_at: sql`now()` as unknown as string })
      .where(and(eq(routines.id, id), this.scopeCond()))
      .returning();
    if (!row) throw new Error(`routine ${id} not found`);
    return row;
  }

  async archive(id: string): Promise<RoutineRow> {
    return this.update(id, { archived_at: new Date().toISOString(), enabled: false });
  }

  /**
   * Atomically claim a batch of routines whose `next_fire_at` has passed.
   *
   * Serialized via pg_try_advisory_xact_lock so two concurrent firing ticks
   * (e.g. cron route racing the in-process fire-and-forget trigger) can't
   * both load the same set of due rows and double-fire. The lock loser
   * receives an empty array and exits cleanly.
   *
   * Returns the locked rows. Caller is responsible for enqueuing the
   * corresponding workforce runs and calling `markFired` to advance
   * next_fire_at — all within the same transaction is not required because
   * markFired uses the routine's id as the primary key and is idempotent on
   * the timestamp it's writing.
   */
  async claimDue(now: Date, limit = 25): Promise<RoutineRow[]> {
    return this.db.transaction(async (tx) => {
      const lockResult = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ROUTINE_DISPATCHER_LOCK_KEY}) AS locked`,
      );
      const locked = (lockResult as unknown as { rows: Array<{ locked: boolean }> }).rows[0]?.locked;
      if (!locked) return [];

      const nowIso = now.toISOString();
      const due = await tx
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.enabled, true),
            isNull(routines.archived_at),
            lte(routines.next_fire_at, nowIso),
          ),
        )
        .orderBy(asc(routines.next_fire_at))
        .limit(limit);
      return due;
    });
  }

  /**
   * Record that a routine fired and advance its schedule. The caller computes
   * the next_fire_at from the cron expression after enqueuing the run, so the
   * write happens after the side-effect succeeds.
   */
  async markFired(
    id: string,
    firedAt: Date,
    nextFireAt: string,
  ): Promise<void> {
    await this.db
      .update(routines)
      .set({
        last_fired_at: firedAt.toISOString(),
        next_fire_at: nextFireAt,
      })
      .where(eq(routines.id, id));
  }

  /**
   * Record a fire only if the routine is still due at `dueAt` — a conditional
   * advance, so of two ticks that both claimed it, exactly one wins. True for
   * the winner, which then sends the routine's message. Bot routines fire
   * this way: they leave no workforce run whose idempotency key would
   * collapse a double fire. Unscoped by id, like markFired.
   */
  async advanceIfDue(id: string, dueAt: string, firedAt: Date, nextFireAt: string): Promise<boolean> {
    const rows = await this.db
      .update(routines)
      .set({ last_fired_at: firedAt.toISOString(), next_fire_at: nextFireAt })
      .where(and(eq(routines.id, id), eq(routines.next_fire_at, dueAt)))
      .returning({ id: routines.id });
    return rows.length > 0;
  }

  /**
   * Undo {@link advanceIfDue} when the message could not be queued — the
   * routine stays due at `dueAt` so the next tick can retry.
   */
  async revertFireAdvance(
    id: string,
    advancedNextFireAt: string,
    dueAt: string,
    lastFiredAt: string | null,
  ): Promise<void> {
    await this.db
      .update(routines)
      .set({ next_fire_at: dueAt, last_fired_at: lastFiredAt })
      .where(and(eq(routines.id, id), eq(routines.next_fire_at, advancedNextFireAt)));
  }

  /**
   * Advance a routine's schedule without recording a fire — for a due routine
   * the tick skipped (e.g. its previous run is still active), so it doesn't
   * come due again on every tick. Unscoped by id, like markFired.
   */
  async advanceSchedule(id: string, nextFireAt: string): Promise<void> {
    await this.db
      .update(routines)
      .set({ next_fire_at: nextFireAt })
      .where(eq(routines.id, id));
  }

  /**
   * The subset of `routineIds` that already have a run that hasn't finished
   * (queued, running, waiting on a human, queued to resume…). One query for a
   * whole tick's due routines. Unscoped: the cron tick spans workspaces and
   * routine ids are globally unique.
   */
  async findActiveRunRoutineIds(routineIds: string[]): Promise<Set<string>> {
    if (routineIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ origin_routine_id: aiWorkforceQueue.origin_routine_id })
      .from(aiWorkforceQueue)
      .where(
        and(
          inArray(aiWorkforceQueue.origin_routine_id, routineIds),
          inArray(aiWorkforceQueue.status, [...ACTIVE_WORKFORCE_STATUSES]),
        ),
      )
      .orderBy(asc(aiWorkforceQueue.origin_routine_id));
    return new Set(
      rows
        .map((r) => r.origin_routine_id)
        .filter((id): id is string => id !== null),
    );
  }

  /**
   * The newest refresh run of `insightId` that hasn't finished (queued,
   * running, waiting on a human…), or null — the run-now guard (MB-552), so a
   * second "Refresh now" doesn't stack a parallel refresh. Covers a routine's
   * runs and one-off refreshes alike: both name the insight in trigger_meta,
   * a retried run only in input. Workspace-scoped; the status filter keeps the
   * scan to the handful of live rows.
   */
  async findActiveInsightRefreshRunId(insightId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: aiWorkforceQueue.id })
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.workspace_id, this.workspaceId),
          inArray(aiWorkforceQueue.status, [...ACTIVE_WORKFORCE_STATUSES]),
          or(
            sql`(${aiWorkforceQueue.trigger_meta}->>'insight_id') = ${insightId}`,
            sql`(${aiWorkforceQueue.input}->>'insight_id') = ${insightId}`,
          ),
        ),
      )
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Unscoped by id, like markFired (the cron tick's repo is bound to the legacy workspace).
   * Sets enabled=false, updated_at=now().
   */
  async pause(id: string): Promise<void> {
    await this.db
      .update(routines)
      .set({
        enabled: false,
        updated_at: sql`now()` as unknown as string,
      })
      .where(eq(routines.id, id));
  }

  /**
   * Pause every enabled, non-archived insight refresh routine whose insight is
   * bound to one of `agentKeys` (MB-560) — one set-based UPDATE … FROM
   * insights. Sets paused_reason='agent_deprecated' + paused_at so a rebind can
   * tell this pause from a manual one. Already-paused routines (manual or
   * system) are untouched because of the `enabled` filter, so re-running every
   * tick is a no-op once they're paused. Unscoped: the cron tick spans
   * workspaces. Empty `agentKeys` → no query. Returns the paused routine ids.
   */
  async pauseForDeprecatedAgents(agentKeys: string[]): Promise<string[]> {
    if (agentKeys.length === 0) return [];
    const rows = await this.db
      .update(routines)
      .set({
        enabled: false,
        paused_reason: 'agent_deprecated',
        paused_at: sql`now()` as unknown as string,
        updated_at: sql`now()` as unknown as string,
      })
      .from(insights)
      .where(
        and(
          eq(routines.insight_id, insights.id),
          eq(routines.enabled, true),
          isNull(routines.archived_at),
          inArray(insights.agent_key, agentKeys),
        ),
      )
      .returning({ id: routines.id });
    return rows.map((r) => r.id);
  }

  /**
   * Resume a routine the system paused (MB-560): enabled=true, reason and
   * paused_at cleared, next_fire_at set to the caller's recomputed instant.
   * Cadence columns are untouched. The `paused_reason IS NOT NULL` guard is
   * what makes a manual pause impossible to re-enable here, even under a race
   * with the toggle. Scoped strictly to this workspace. Null when nothing
   * matched (not found, not system-paused, or another workspace's).
   */
  async resumeFromAgentPause(id: string, nextFireAt: string): Promise<RoutineRow | null> {
    const [row] = await this.db
      .update(routines)
      .set({
        enabled: true,
        paused_reason: null,
        paused_at: null,
        next_fire_at: nextFireAt,
        updated_at: sql`now()` as unknown as string,
      })
      .where(
        and(
          eq(routines.id, id),
          eq(routines.workspace_id, this.workspaceId),
          isNotNull(routines.paused_reason),
          isNull(routines.archived_at),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Count rows in `ai_workforce_queue` spawned by this routine. Used by the
   * routines GET endpoint so the UI can show "N runs total" without paging
   * the full history.
   */
  async countRuns(routineId: string): Promise<number> {
    const result = await this.db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM ai_workforce_queue WHERE origin_routine_id = ${routineId} AND workspace_id = ${this.workspaceId}`,
    );
    return (result as unknown as { rows: Array<{ count: number }> }).rows[0]?.count ?? 0;
  }

  /**
   * List the workforce runs spawned by this routine, newest first. Used by
   * the RoutineCanvas's run-history list.
   */
  async listRuns(routineId: string, limit = 50): Promise<Tables<'ai_workforce_queue'>[]> {
    return this.db
      .select()
      .from(aiWorkforceQueue)
      .where(
        and(
          eq(aiWorkforceQueue.origin_routine_id, routineId),
          eq(aiWorkforceQueue.workspace_id, this.workspaceId)
        )
      )
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
  }
}
