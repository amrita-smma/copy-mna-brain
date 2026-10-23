import { and, eq, inArray, sql } from 'drizzle-orm';
import { employerCuration } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export type EmployerCuration = Tables<'employer_curation'>;

export interface EmployerCurationEdit {
  name?: string | null;
  industry?: string | null;
  /** The workspace's chosen PIC; null goes back to the oldest contact. */
  primary_correspondent_id?: string | null;
}

const EDITABLE_FIELDS = ['name', 'industry', 'primary_correspondent_id'] as const;

/**
 * Human overlay for employer machine fields (RFC §3.3), one row per
 * (workspace, firm) since MB-687 — a rename, an industry fix or a PIC pick in
 * one workspace never shows in another. The CRM UI is the only writer; the ETL
 * never touches it. A NULL column means "no override — use the machine value
 * on `employers`". Reads merge via the `employer_workspace_effective` view.
 */
export class EmployerCurationRepository {
  constructor(private readonly db: DbClient) {}

  async findByEmployerId(
    workspaceId: string,
    employerId: string,
  ): Promise<EmployerCuration | null> {
    const [row] = await this.db
      .select()
      .from(employerCuration)
      .where(
        and(
          eq(employerCuration.workspace_id, workspaceId),
          eq(employerCuration.employer_id, employerId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findManyByEmployerIds(
    workspaceId: string,
    ids: string[],
  ): Promise<EmployerCuration[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(employerCuration)
      .where(
        and(
          eq(employerCuration.workspace_id, workspaceId),
          inArray(employerCuration.employer_id, ids),
        ),
      );
  }

  /**
   * Upsert this workspace's overlay for an employer. Only the provided fields
   * are written, so editing `name` never clobbers an `industry` override or
   * the PIC pick.
   */
  async upsert(
    workspaceId: string,
    employerId: string,
    edit: EmployerCurationEdit,
    editedBy: string | null,
  ): Promise<EmployerCuration> {
    const set: Record<string, unknown> = { edited_at: sql`now()`, edited_by: editedBy };
    const values: Record<string, unknown> = {
      workspace_id: workspaceId,
      employer_id: employerId,
      edited_by: editedBy,
    };
    for (const f of EDITABLE_FIELDS) {
      if (f in edit) {
        set[f] = edit[f] ?? null;
        values[f] = edit[f] ?? null;
      }
    }

    const [row] = await this.db
      .insert(employerCuration)
      .values(values as typeof employerCuration.$inferInsert)
      .onConflictDoUpdate({
        target: [employerCuration.workspace_id, employerCuration.employer_id],
        set,
      })
      .returning();
    return row;
  }

  /** Remove this workspace's overlay row (every field back to the machine value). */
  async clear(workspaceId: string, employerId: string): Promise<void> {
    await this.db
      .delete(employerCuration)
      .where(
        and(
          eq(employerCuration.workspace_id, workspaceId),
          eq(employerCuration.employer_id, employerId),
        ),
      );
  }
}
