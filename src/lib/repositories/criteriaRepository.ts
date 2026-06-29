import { asc, eq } from 'drizzle-orm';
import { criterias } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class CriteriaRepository {
  constructor(private readonly db: DbClient) {}

  /** All criteria, or only those belonging to a given Track when `thesisId` is set. */
  async findAll(thesisId?: string): Promise<Tables<'criterias'>[]> {
    return this.db
      .select()
      .from(criterias)
      .where(thesisId ? eq(criterias.investment_thesis_id, thesisId) : undefined)
      .orderBy(asc(criterias.created_at));
  }

  async insert(
    data: Pick<TablesInsert<'criterias'>, 'name' | 'prompt' | 'investment_thesis_id'>,
  ): Promise<Tables<'criterias'>> {
    const [row] = await this.db.insert(criterias).values(data).returning();
    return row;
  }

  async update(
    id: string,
    updates: Pick<TablesUpdate<'criterias'>, 'name' | 'prompt' | 'investment_thesis_id'>,
  ): Promise<Tables<'criterias'>> {
    const [row] = await this.db
      .update(criterias)
      .set(updates)
      .where(eq(criterias.id, id))
      .returning();
    if (!row) throw new Error(`Criteria ${id} not found`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(criterias).where(eq(criterias.id, id));
  }
}
