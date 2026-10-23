import { and, eq, inArray, sql } from 'drizzle-orm';
import { correspondentCuration } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type CorrespondentCuration = Tables<'correspondent_curation'>;

export interface CorrespondentCurationEdit {
  name?: string | null;
  title?: string | null;
  phone?: string | null;
  type?: string | null;
  department?: string | null;
  specialization?: string | null;
  seniority?: string | null;
  coverage_region?: string | null;
  linkedin_url?: string | null;
  bio?: string | null;
}

const EDITABLE_FIELDS = [
  'name',
  'title',
  'phone',
  'type',
  'department',
  'specialization',
  'seniority',
  'coverage_region',
  'linkedin_url',
  'bio',
] as const;

/**
 * Human overlay for correspondent machine fields (RFC §3.4), one row per
 * (workspace, contact) since MB-687 — an edit in one workspace never shows in
 * another. The CRM UI and @crm_contact are the only writers; the ETL never
 * touches it. The workspace's PIC is not here: it is
 * `employer_curation.primary_correspondent_id`. Reads merge via the
 * `correspondent_workspace_effective` view.
 */
export class CorrespondentCurationRepository {
  constructor(private readonly db: DbClient) {}

  async findByCorrespondentId(
    workspaceId: string,
    correspondentId: string,
  ): Promise<CorrespondentCuration | null> {
    const [row] = await this.db
      .select()
      .from(correspondentCuration)
      .where(
        and(
          eq(correspondentCuration.workspace_id, workspaceId),
          eq(correspondentCuration.correspondent_id, correspondentId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findManyByCorrespondentIds(
    workspaceId: string,
    ids: string[],
  ): Promise<CorrespondentCuration[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(correspondentCuration)
      .where(
        and(
          eq(correspondentCuration.workspace_id, workspaceId),
          inArray(correspondentCuration.correspondent_id, ids),
        ),
      );
  }

  /** Upsert this workspace's overlay; only provided fields are written. */
  async upsert(
    workspaceId: string,
    correspondentId: string,
    edit: CorrespondentCurationEdit,
    editedBy: string | null,
  ): Promise<CorrespondentCuration> {
    const set: Record<string, unknown> = { edited_at: sql`now()`, edited_by: editedBy };
    const values: TablesInsert<'correspondent_curation'> = {
      workspace_id: workspaceId,
      correspondent_id: correspondentId,
      edited_by: editedBy,
    };
    for (const f of EDITABLE_FIELDS) {
      if (f in edit) {
        const v = edit[f] ?? null;
        set[f] = v;
        (values as Record<string, unknown>)[f] = v;
      }
    }

    const [row] = await this.db
      .insert(correspondentCuration)
      .values(values)
      .onConflictDoUpdate({
        target: [correspondentCuration.workspace_id, correspondentCuration.correspondent_id],
        set,
      })
      .returning();
    return row;
  }

  /**
   * Batch overlay write for the CSV import: one INSERT … ON CONFLICT for every
   * row. Unlike `upsert`, an absent/blank field never clears an existing
   * overlay value — `COALESCE(EXCLUDED.f, current.f)` — so a sparse import row
   * only fills in what it actually carries.
   */
  async fillMany(
    workspaceId: string,
    edits: Array<{ correspondentId: string; edit: CorrespondentCurationEdit }>,
    editedBy: string | null,
  ): Promise<void> {
    if (edits.length === 0) return;
    // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement.
    const byId = new Map<string, CorrespondentCurationEdit>();
    for (const { correspondentId, edit } of edits) {
      byId.set(correspondentId, { ...byId.get(correspondentId), ...edit });
    }
    const values = Array.from(byId, ([correspondentId, edit]) => {
      const row: Record<string, unknown> = {
        workspace_id: workspaceId,
        correspondent_id: correspondentId,
        edited_by: editedBy,
      };
      for (const f of EDITABLE_FIELDS) row[f] = edit[f] ?? null;
      return row as TablesInsert<'correspondent_curation'>;
    });
    const set: Record<string, unknown> = {
      edited_at: sql`now()`,
      edited_by: sql`EXCLUDED.edited_by`,
    };
    for (const f of EDITABLE_FIELDS) {
      set[f] = sql.raw(`COALESCE(EXCLUDED.${f}, correspondent_curation.${f})`);
    }
    await this.db
      .insert(correspondentCuration)
      .values(values)
      .onConflictDoUpdate({
        target: [correspondentCuration.workspace_id, correspondentCuration.correspondent_id],
        set,
      });
  }

  async clear(workspaceId: string, correspondentId: string): Promise<void> {
    await this.db
      .delete(correspondentCuration)
      .where(
        and(
          eq(correspondentCuration.workspace_id, workspaceId),
          eq(correspondentCuration.correspondent_id, correspondentId),
        ),
      );
  }
}
