import { and, eq, sql } from 'drizzle-orm';
import { workspaceTableLayouts } from '@/lib/db/schema';
import type { DbClient } from './types';

/** One stored table layout for the repository's workspace. */
export interface WorkspaceTableLayoutRow {
  tableId: string;
  layout: unknown;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * Per-workspace column layouts in the `workspace_table_layouts` table. One row =
 * one table's layout (order / hidden / groups) for one workspace. Pure data
 * access — the shape of `layout` is owned by the caller (ColumnLayoutState).
 */
export class WorkspaceTableLayoutRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** Every stored layout for the workspace, so one request hydrates all tables. */
  async findAll(): Promise<WorkspaceTableLayoutRow[]> {
    const rows = await this.db
      .select({
        tableId: workspaceTableLayouts.table_id,
        layout: workspaceTableLayouts.layout,
        updatedAt: workspaceTableLayouts.updated_at,
        updatedBy: workspaceTableLayouts.updated_by,
      })
      .from(workspaceTableLayouts)
      .where(eq(workspaceTableLayouts.workspace_id, this.workspaceId));
    return rows.map((row) => ({
      tableId: row.tableId,
      layout: row.layout,
      updatedAt: row.updatedAt ?? null,
      updatedBy: row.updatedBy ?? null,
    }));
  }

  /** One table's stored layout, or null when the workspace has never saved it. */
  async findByTableId(tableId: string): Promise<WorkspaceTableLayoutRow | null> {
    const [row] = await this.db
      .select({
        tableId: workspaceTableLayouts.table_id,
        layout: workspaceTableLayouts.layout,
        updatedAt: workspaceTableLayouts.updated_at,
        updatedBy: workspaceTableLayouts.updated_by,
      })
      .from(workspaceTableLayouts)
      .where(
        and(
          eq(workspaceTableLayouts.workspace_id, this.workspaceId),
          eq(workspaceTableLayouts.table_id, tableId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      tableId: row.tableId,
      layout: row.layout,
      updatedAt: row.updatedAt ?? null,
      updatedBy: row.updatedBy ?? null,
    };
  }

  /** Insert or replace one table's layout, returning the stored `updated_at`. */
  async upsert(
    tableId: string,
    layout: unknown,
    updatedBy?: string | null,
  ): Promise<string | null> {
    const [row] = await this.db
      .insert(workspaceTableLayouts)
      .values({
        workspace_id: this.workspaceId,
        table_id: tableId,
        layout,
        updated_by: updatedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [workspaceTableLayouts.workspace_id, workspaceTableLayouts.table_id],
        set: { layout, updated_by: updatedBy ?? null, updated_at: sql`now()` },
      })
      .returning({ updatedAt: workspaceTableLayouts.updated_at });
    return row?.updatedAt ?? null;
  }

  /** Drop one table's stored layout, returning it to the declared defaults. */
  async delete(tableId: string): Promise<void> {
    await this.db
      .delete(workspaceTableLayouts)
      .where(
        and(
          eq(workspaceTableLayouts.workspace_id, this.workspaceId),
          eq(workspaceTableLayouts.table_id, tableId),
        ),
      );
  }
}
