import { and, desc, eq, inArray } from 'drizzle-orm';
import { investmentThesis } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class InvestmentThesisRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findActive(): Promise<Tables<'investment_thesis'> | null> {
    const [row] = await this.db
      .select()
      .from(investmentThesis)
      .where(and(eq(investmentThesis.is_active, true), eq(investmentThesis.workspace_id, this.workspaceId)))
      .orderBy(desc(investmentThesis.created_at))
      .limit(1);
    return row ?? null;
  }

  /** All active theses (the scanning set), newest first. */
  async findAllActive(): Promise<Tables<'investment_thesis'>[]> {
    return this.db
      .select()
      .from(investmentThesis)
      .where(and(eq(investmentThesis.is_active, true), eq(investmentThesis.workspace_id, this.workspaceId)))
      .orderBy(desc(investmentThesis.created_at));
  }

  async findByIds(ids: string[]): Promise<Tables<'investment_thesis'>[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(investmentThesis)
      .where(inArray(investmentThesis.id, ids))
      .orderBy(desc(investmentThesis.created_at));
  }

  async findActiveList(
    limit = 3,
  ): Promise<Pick<Tables<'investment_thesis'>, 'title' | 'content'>[]> {
    return this.db
      .select({ title: investmentThesis.title, content: investmentThesis.content })
      .from(investmentThesis)
      .where(and(eq(investmentThesis.is_active, true), eq(investmentThesis.workspace_id, this.workspaceId)))
      .orderBy(desc(investmentThesis.updated_at))
      .limit(limit);
  }

  /** All theses ("Tracks"), newest first. Used by the Track Settings manager. */
  async findAll(): Promise<Tables<'investment_thesis'>[]> {
    return this.db
      .select()
      .from(investmentThesis)
      .where(eq(investmentThesis.workspace_id, this.workspaceId))
      .orderBy(desc(investmentThesis.created_at));
  }

  async deleteById(id: string): Promise<void> {
    await this.db
      .delete(investmentThesis)
      .where(and(eq(investmentThesis.id, id), eq(investmentThesis.workspace_id, this.workspaceId)));
  }

  /**
   * Set the active scanning set: marks the given theses active and every other
   * thesis in this workspace inactive. Passing `[]` deactivates all of this
   * workspace's theses.
   */
  async setActive(ids: string[]): Promise<void> {
    await this.db
      .update(investmentThesis)
      .set({ is_active: false })
      .where(eq(investmentThesis.workspace_id, this.workspaceId));
    if (ids.length === 0) return;
    await this.db
      .update(investmentThesis)
      .set({ is_active: true })
      .where(and(inArray(investmentThesis.id, ids), eq(investmentThesis.workspace_id, this.workspaceId)));
  }

  async updateMany(
    ids: string[],
    updates: TablesUpdate<'investment_thesis'>,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(investmentThesis)
      .set(updates)
      .where(and(inArray(investmentThesis.id, ids), eq(investmentThesis.workspace_id, this.workspaceId)));
  }

  async insert(
    data: Omit<TablesInsert<'investment_thesis'>, 'workspace_id'>,
  ): Promise<Tables<'investment_thesis'>> {
    const [row] = await this.db
      .insert(investmentThesis)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'investment_thesis'>,
  ): Promise<Tables<'investment_thesis'>> {
    const [row] = await this.db
      .update(investmentThesis)
      .set(updates)
      .where(and(eq(investmentThesis.id, id), eq(investmentThesis.workspace_id, this.workspaceId)))
      .returning();
    if (!row) throw new Error(`Investment thesis ${id} not found`);
    return row;
  }
}
