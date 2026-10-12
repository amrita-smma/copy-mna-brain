import { and, count as drizzleCount, desc, eq, inArray } from 'drizzle-orm';
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

  /** Newest first. Pass `limit` when the caller only renders a recent slice — pair it with `countByDealId` for the true total. */
  async findByDealId(dealId: string, limit?: number): Promise<Tables<'deal_notes'>[]> {
    const query = this.db
      .select()
      .from(dealNotes)
      .where(and(eq(dealNotes.deal_id, dealId), inArray(dealNotes.deal_id, this.workspaceCompanyIds())))
      .orderBy(desc(dealNotes.created_at));
    return limit === undefined ? query : query.limit(limit);
  }

  async countByDealId(dealId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(dealNotes)
      .where(and(eq(dealNotes.deal_id, dealId), inArray(dealNotes.deal_id, this.workspaceCompanyIds())));
    return Number(row?.value ?? 0);
  }

  async insert(data: TablesInsert<'deal_notes'>): Promise<Tables<'deal_notes'>> {
    const [row] = await this.db.insert(dealNotes).values(data).returning();
    return row;
  }

  async insertMany(rows: Array<TablesInsert<'deal_notes'>>): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(dealNotes).values(rows);
  }

  /**
   * Rewrites a note's body in place. Returns `null` when no row matched —
   * either the id is unknown or it belongs to another workspace's company —
   * so the caller can tell "not found" from "updated".
   */
  async update(
    id: string,
    data: Pick<TablesInsert<'deal_notes'>, 'content'>,
  ): Promise<Tables<'deal_notes'> | null> {
    const [row] = await this.db
      .update(dealNotes)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(and(eq(dealNotes.id, id), inArray(dealNotes.deal_id, this.workspaceCompanyIds())))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(dealNotes)
      .where(and(eq(dealNotes.id, id), inArray(dealNotes.deal_id, this.workspaceCompanyIds())));
  }
}
