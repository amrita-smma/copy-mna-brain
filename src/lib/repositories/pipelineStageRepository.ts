import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { pipelineStages } from '@/lib/db/schema';
import type { DbClient } from './types';

export type PipelineStageRow = typeof pipelineStages.$inferSelect;
export type PipelineStagePatch = Partial<Pick<PipelineStageRow, 'code' | 'name' | 'description'>>;
/** A full edit of one stage's text fields, for `updateMany`. */
export type PipelineStageEdit = Pick<PipelineStageRow, 'key' | 'code' | 'name' | 'description'>;
export interface NewPipelineStage {
  key: string;
  code: string;
  name: string;
  description: string;
}

/** A workspace's pipeline stages. Live and soft-deleted rows alike. */
export class PipelineStageRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private byKey(key: string) {
    return and(eq(pipelineStages.workspace_id, this.workspaceId), eq(pipelineStages.key, key));
  }

  /** Every stage, soft-deleted ones included, in position order. */
  async list(): Promise<PipelineStageRow[]> {
    return this.db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.workspace_id, this.workspaceId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.created_at));
  }

  async findByKey(key: string): Promise<PipelineStageRow | undefined> {
    const [row] = await this.db.select().from(pipelineStages).where(this.byKey(key)).limit(1);
    return row;
  }

  /**
   * Insert a stage directly after `afterPosition`, shifting every later stage
   * (soft-deleted ones too, so they keep their relative place) down by one.
   * One transaction, two set-based statements.
   */
  async insertAfter(afterPosition: number, stage: NewPipelineStage): Promise<PipelineStageRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(pipelineStages)
        .set({ position: sql`${pipelineStages.position} + 1` })
        .where(
          and(
            eq(pipelineStages.workspace_id, this.workspaceId),
            gt(pipelineStages.position, afterPosition),
          ),
        );
      const [row] = await tx
        .insert(pipelineStages)
        .values({ ...stage, workspace_id: this.workspaceId, position: afterPosition + 1 })
        .returning();
      return row;
    });
  }

  /** Update a live stage's code, name or description. `undefined` when no live stage has the key. */
  async update(key: string, patch: PipelineStagePatch): Promise<PipelineStageRow | undefined> {
    const [row] = await this.db
      .update(pipelineStages)
      .set(patch)
      .where(and(this.byKey(key), isNull(pipelineStages.deleted_at)))
      .returning();
    return row;
  }

  /**
   * Save several live stages' code, name and description at once, in one
   * transaction of two set-based statements. Postgres checks the live-code
   * unique index row by row, so a swap (L1 ↔ L2) would collide mid-statement:
   * the first statement parks every edited code on a value derived from the
   * stage's unique key, and the second writes the final values. Returns the
   * updated rows; a key with no live stage is skipped.
   */
  async updateMany(edits: readonly PipelineStageEdit[]): Promise<PipelineStageRow[]> {
    if (edits.length === 0) return [];
    const keys = edits.map((e) => e.key);
    const caseOf = (field: 'code' | 'name' | 'description') =>
      sql`CASE ${pipelineStages.key} ${sql.join(
        edits.map((e) => sql`WHEN ${e.key} THEN ${e[field]}`),
        sql` `,
      )} END`;
    const editedLive = and(
      eq(pipelineStages.workspace_id, this.workspaceId),
      inArray(pipelineStages.key, keys),
      isNull(pipelineStages.deleted_at),
    );
    return this.db.transaction(async (tx) => {
      await tx
        .update(pipelineStages)
        .set({ code: sql`'~' || ${pipelineStages.key}` })
        .where(editedLive);
      return tx
        .update(pipelineStages)
        .set({
          code: caseOf('code'),
          name: caseOf('name'),
          description: caseOf('description'),
          updated_at: sql`now()`,
        })
        .where(editedLive)
        .returning();
    });
  }

  /** Set several stages' positions in one statement. */
  async setPositions(positions: ReadonlyArray<{ key: string; position: number }>): Promise<void> {
    if (positions.length === 0) return;
    const cases = sql.join(
      positions.map((p) => sql`WHEN ${p.key} THEN ${p.position}::integer`),
      sql` `,
    );
    await this.db
      .update(pipelineStages)
      .set({ position: sql`CASE ${pipelineStages.key} ${cases} END` })
      .where(
        and(
          eq(pipelineStages.workspace_id, this.workspaceId),
          inArray(
            pipelineStages.key,
            positions.map((p) => p.key),
          ),
        ),
      );
  }

  /**
   * Which of the given stage keys are deleted stages, across the given
   * workspaces — the one read not scoped to this repository's workspace. The
   * deal-resurface cron sweeps every workspace at once and needs to know
   * whether a resurfacing deal's stage still exists. Returns
   * `${workspaceId}:${key}` pairs; one query for the whole sweep.
   */
  async findDeletedStageRefs(workspaceIds: string[], keys: string[]): Promise<Set<string>> {
    if (workspaceIds.length === 0 || keys.length === 0) return new Set();
    const rows = await this.db
      .select({ workspace_id: pipelineStages.workspace_id, key: pipelineStages.key })
      .from(pipelineStages)
      .where(
        and(
          inArray(pipelineStages.workspace_id, workspaceIds),
          inArray(pipelineStages.key, keys),
          isNotNull(pipelineStages.deleted_at),
        ),
      );
    return new Set(rows.map((r) => `${r.workspace_id}:${r.key}`));
  }

  /** Soft-delete a live stage. `undefined` when no live stage has the key. */
  async softDelete(key: string): Promise<PipelineStageRow | undefined> {
    const [row] = await this.db
      .update(pipelineStages)
      .set({ deleted_at: sql`now()` })
      .where(and(this.byKey(key), isNull(pipelineStages.deleted_at)))
      .returning();
    return row;
  }
}
