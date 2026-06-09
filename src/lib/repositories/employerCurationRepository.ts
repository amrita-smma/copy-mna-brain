import { eq, inArray, sql } from 'drizzle-orm';
import { employerCuration } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export type EmployerCuration = Tables<'employer_curation'>;

export interface EmployerCurationEdit {
  name?: string | null;
  industry?: string | null;
}

/**
 * Human overlay for employer machine fields (RFC §3.3). The CRM UI is the only
 * writer; the ETL never touches it. A NULL column means "no override — use the
 * machine value on `employers`". Reads merge via the `employer_effective` view.
 */
export class EmployerCurationRepository {
  constructor(private readonly db: DbClient) {}

  async findByEmployerId(employerId: string): Promise<EmployerCuration | null> {
    const [row] = await this.db
      .select()
      .from(employerCuration)
      .where(eq(employerCuration.employer_id, employerId))
      .limit(1);
    return row ?? null;
  }

  async findManyByEmployerIds(ids: string[]): Promise<EmployerCuration[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(employerCuration)
      .where(inArray(employerCuration.employer_id, ids));
  }

  /**
   * Upsert the overlay for an employer. Only the provided fields are written,
   * so editing `name` never clobbers an existing `industry` override.
   */
  async upsert(
    employerId: string,
    edit: EmployerCurationEdit,
    editedBy: string | null,
  ): Promise<EmployerCuration> {
    const set: Record<string, unknown> = { edited_at: sql`now()`, edited_by: editedBy };
    if ('name' in edit) set.name = edit.name ?? null;
    if ('industry' in edit) set.industry = edit.industry ?? null;

    const [row] = await this.db
      .insert(employerCuration)
      .values({
        employer_id: employerId,
        name: 'name' in edit ? (edit.name ?? null) : null,
        industry: 'industry' in edit ? (edit.industry ?? null) : null,
        edited_by: editedBy,
      })
      .onConflictDoUpdate({ target: employerCuration.employer_id, set })
      .returning();
    return row;
  }

  /** Remove the whole overlay row (reset every field back to the machine value). */
  async clear(employerId: string): Promise<void> {
    await this.db
      .delete(employerCuration)
      .where(eq(employerCuration.employer_id, employerId));
  }
}
