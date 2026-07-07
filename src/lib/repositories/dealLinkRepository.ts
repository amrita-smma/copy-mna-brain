import { and, desc, eq, inArray } from 'drizzle-orm';
import { companies, dealLinks } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class DealLinkRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByDealId(dealId: string): Promise<Tables<'deal_links'>[]> {
    return this.db
      .select()
      .from(dealLinks)
      .where(and(eq(dealLinks.deal_id, dealId), inArray(dealLinks.deal_id, this.workspaceCompanyIds())))
      .orderBy(desc(dealLinks.created_at));
  }

  async insert(data: TablesInsert<'deal_links'>): Promise<Tables<'deal_links'>> {
    const [row] = await this.db.insert(dealLinks).values(data).returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(dealLinks)
      .where(and(eq(dealLinks.id, id), inArray(dealLinks.deal_id, this.workspaceCompanyIds())));
  }
}
