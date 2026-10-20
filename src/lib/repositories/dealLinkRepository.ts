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

  async findById(id: string): Promise<Tables<'deal_links'>> {
    const [row] = await this.db
      .select()
      .from(dealLinks)
      .where(and(eq(dealLinks.id, id), inArray(dealLinks.deal_id, this.workspaceCompanyIds())))
      .limit(1);
    if (!row) throw new Error(`Deal link ${id} not found`);
    return row;
  }

  /** Flags one link as the deal's Featured Slide. Callers clear the previous holder first. */
  async markFeatured(id: string): Promise<void> {
    await this.db
      .update(dealLinks)
      .set({ is_featured: true })
      .where(and(eq(dealLinks.id, id), inArray(dealLinks.deal_id, this.workspaceCompanyIds())));
  }

  /** Unfeatures whichever link currently holds the deal's featured slide, if any. */
  async clearFeaturedByDealId(dealId: string): Promise<void> {
    await this.db
      .update(dealLinks)
      .set({ is_featured: false })
      .where(
        and(
          eq(dealLinks.deal_id, dealId),
          eq(dealLinks.is_featured, true),
          inArray(dealLinks.deal_id, this.workspaceCompanyIds()),
        ),
      );
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
