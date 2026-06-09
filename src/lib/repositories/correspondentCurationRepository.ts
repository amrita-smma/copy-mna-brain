import { eq, inArray, sql } from 'drizzle-orm';
import { correspondentCuration } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type CorrespondentCuration = Tables<'correspondent_curation'>;

export interface CorrespondentCurationEdit {
  name?: string | null;
  title?: string | null;
  phone?: string | null;
  type?: string | null;
}

const EDITABLE_FIELDS = ['name', 'title', 'phone', 'type'] as const;

/**
 * Human overlay for correspondent machine fields (RFC §3.4). The CRM UI is the
 * only writer; the ETL never touches it. `is_primary` is deliberately NOT here
 * (it stays on the base table so the one-primary-per-employer unique index
 * keeps enforcing). Reads merge via the `correspondent_effective` view.
 */
export class CorrespondentCurationRepository {
  constructor(private readonly db: DbClient) {}

  async findByCorrespondentId(
    correspondentId: string,
  ): Promise<CorrespondentCuration | null> {
    const [row] = await this.db
      .select()
      .from(correspondentCuration)
      .where(eq(correspondentCuration.correspondent_id, correspondentId))
      .limit(1);
    return row ?? null;
  }

  async findManyByCorrespondentIds(
    ids: string[],
  ): Promise<CorrespondentCuration[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(correspondentCuration)
      .where(inArray(correspondentCuration.correspondent_id, ids));
  }

  /** Upsert the overlay; only provided fields are written. */
  async upsert(
    correspondentId: string,
    edit: CorrespondentCurationEdit,
    editedBy: string | null,
  ): Promise<CorrespondentCuration> {
    const set: Record<string, unknown> = { edited_at: sql`now()`, edited_by: editedBy };
    const values: TablesInsert<'correspondent_curation'> = {
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
      .onConflictDoUpdate({ target: correspondentCuration.correspondent_id, set })
      .returning();
    return row;
  }

  async clear(correspondentId: string): Promise<void> {
    await this.db
      .delete(correspondentCuration)
      .where(eq(correspondentCuration.correspondent_id, correspondentId));
  }
}
