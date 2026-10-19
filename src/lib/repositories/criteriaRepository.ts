import { and, asc, eq, inArray } from 'drizzle-orm';
import { criterias, investmentThesis } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class CriteriaRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceTrackIds() {
    return this.db
      .select({ id: investmentThesis.id })
      .from(investmentThesis)
      .where(eq(investmentThesis.workspace_id, this.workspaceId));
  }

  /** All criteria, or only those belonging to a given Track when `thesisId` is set. */
  async findAll(thesisId?: string): Promise<Tables<'criterias'>[]> {
    const workspaceCond = inArray(criterias.investment_thesis_id, this.workspaceTrackIds());
    return this.db
      .select()
      .from(criterias)
      .where(thesisId ? and(eq(criterias.investment_thesis_id, thesisId), workspaceCond) : workspaceCond)
      .orderBy(asc(criterias.created_at));
  }

  async insert(
    data: Pick<TablesInsert<'criterias'>, 'name' | 'prompt' | 'investment_thesis_id' | 'must_pass'>,
  ): Promise<Tables<'criterias'>> {
    const [row] = await this.db.insert(criterias).values(data).returning();
    return row;
  }

  async update(
    id: string,
    updates: Pick<TablesUpdate<'criterias'>, 'name' | 'prompt' | 'investment_thesis_id' | 'must_pass'>,
  ): Promise<Tables<'criterias'>> {
    const [row] = await this.db
      .update(criterias)
      .set(updates)
      .where(and(eq(criterias.id, id), inArray(criterias.investment_thesis_id, this.workspaceTrackIds())))
      .returning();
    if (!row) throw new Error(`Criteria ${id} not found`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(criterias)
      .where(and(eq(criterias.id, id), inArray(criterias.investment_thesis_id, this.workspaceTrackIds())));
  }
}
