import { and, desc, eq, inArray } from 'drizzle-orm';
import { companies, dealNotes } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class DealNoteRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByDealId(dealId: string): Promise<Tables<'deal_notes'>[]> {
    return this.db
      .select()
      .from(dealNotes)
      .where(and(eq(dealNotes.deal_id, dealId), inArray(dealNotes.deal_id, this.workspaceCompanyIds())))
      .orderBy(desc(dealNotes.created_at));
  }

  async insert(data: TablesInsert<'deal_notes'>): Promise<Tables<'deal_notes'>> {
    const [row] = await this.db.insert(dealNotes).values(data).returning();
    return row;
  }

  async insertMany(rows: Array<TablesInsert<'deal_notes'>>): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(dealNotes).values(rows);
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(dealNotes)
      .where(and(eq(dealNotes.id, id), inArray(dealNotes.deal_id, this.workspaceCompanyIds())));
  }
}
