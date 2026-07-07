import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { aiWorkforceQueue, routines } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export type RoutineRow = Tables<'routines'>;
export type RoutineInsert = TablesInsert<'routines'>;
export type RoutineUpdate = TablesUpdate<'routines'>;

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

  /** This workspace's own routines plus legacy pre-tenancy rows with no workspace_id. */
  async list(opts: { includeArchived?: boolean } = {}): Promise<RoutineRow[]> {
    const where = opts.includeArchived
      ? this.scopeCond()
      : and(this.scopeCond(), isNull(routines.archived_at));
    return this.db
      .select()
      .from(routines)
      .where(where)
      .orderBy(desc(routines.created_at));
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
      const locked = (lockResult as unknown as Array<{ locked: boolean }>)[0]?.locked;
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
   * Count rows in `ai_workforce_queue` spawned by this routine. Used by the
   * routines GET endpoint so the UI can show "N runs total" without paging
   * the full history.
   */
  async countRuns(routineId: string): Promise<number> {
    const result = await this.db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM ai_workforce_queue WHERE origin_routine_id = ${routineId}`,
    );
    return (result as unknown as Array<{ count: number }>)[0]?.count ?? 0;
  }

  /**
   * List the workforce runs spawned by this routine, newest first. Used by
   * the RoutineCanvas's run-history list.
   */
  async listRuns(routineId: string, limit = 50): Promise<Tables<'ai_workforce_queue'>[]> {
    return this.db
      .select()
      .from(aiWorkforceQueue)
      .where(eq(aiWorkforceQueue.origin_routine_id, routineId))
      .orderBy(desc(aiWorkforceQueue.created_at))
      .limit(limit);
  }
}
