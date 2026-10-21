import { and, eq, inArray, sql } from 'drizzle-orm';
import { companies, companyAnalyses } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class CompanyAnalysisRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByCompanyId(companyId: string): Promise<Tables<'company_analyses'> | null> {
    const [row] = await this.db
      .select()
      .from(companyAnalyses)
      .where(and(eq(companyAnalyses.company_id, companyId), inArray(companyAnalyses.company_id, this.workspaceCompanyIds())))
      .limit(1);
    return row ?? null;
  }

  async findCompletedByCompanyId(companyId: string): Promise<Tables<'company_analyses'> | null> {
    const [row] = await this.db
      .select()
      .from(companyAnalyses)
      .where(
        and(
          eq(companyAnalyses.company_id, companyId),
          eq(companyAnalyses.status, 'completed'),
          inArray(companyAnalyses.company_id, this.workspaceCompanyIds()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Batched {@link findCompletedByCompanyId}: the subset of `companyIds` that
   * have a completed Company Card, in one query.
   */
  async findCompletedCompanyIds(companyIds: string[]): Promise<Set<string>> {
    if (companyIds.length === 0) return new Set();
    const rows = await this.db
      .select({ company_id: companyAnalyses.company_id })
      .from(companyAnalyses)
      .where(
        and(
          inArray(companyAnalyses.company_id, companyIds),
          eq(companyAnalyses.status, 'completed'),
          inArray(companyAnalyses.company_id, this.workspaceCompanyIds()),
        ),
      )
      .orderBy(companyAnalyses.company_id);
    return new Set(rows.map((r) => r.company_id));
  }

  async insert(data: TablesInsert<'company_analyses'>): Promise<Tables<'company_analyses'>> {
    const [row] = await this.db.insert(companyAnalyses).values(data).returning();
    return row;
  }

  async upsertByCompanyId(data: TablesInsert<'company_analyses'>): Promise<void> {
    // Drop company_id from the UPDATE set so the conflict-key is never self-updated.
    const { company_id: _ignored, ...rest } = data;
    void _ignored;
    await this.db
      .insert(companyAnalyses)
      .values(data)
      .onConflictDoUpdate({
        target: companyAnalyses.company_id,
        // Double-cast via `unknown`: the `sql\`now()\`` value isn't a plain string so it
        // doesn't match `Partial<$inferSelect>` directly. Drizzle accepts `SQL` fragments
        // at runtime; the cast tells TS to trust us.
        set: { ...rest, updated_at: sql`now()` } as unknown as TablesUpdate<'company_analyses'>,
      });
  }

  async updateByCompanyId(
    companyId: string,
    updates: TablesUpdate<'company_analyses'>,
  ): Promise<Tables<'company_analyses'>> {
    const [row] = await this.db
      .update(companyAnalyses)
      .set(updates)
      .where(and(eq(companyAnalyses.company_id, companyId), inArray(companyAnalyses.company_id, this.workspaceCompanyIds())))
      .returning();
    if (!row) throw new Error(`Company analysis for ${companyId} not found`);
    return row;
  }

  async deleteByCompanyId(companyId: string): Promise<void> {
    await this.db
      .delete(companyAnalyses)
      .where(and(eq(companyAnalyses.company_id, companyId), inArray(companyAnalyses.company_id, this.workspaceCompanyIds())));
  }
}
