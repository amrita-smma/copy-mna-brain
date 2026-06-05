import { desc, eq } from 'drizzle-orm';
import { dealNotes } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class DealNoteRepository {
  constructor(private readonly db: DbClient) {}

  async findByDealId(dealId: string): Promise<Tables<'deal_notes'>[]> {
    return this.db
      .select()
      .from(dealNotes)
      .where(eq(dealNotes.deal_id, dealId))
      .orderBy(desc(dealNotes.created_at));
  }

  async insert(data: TablesInsert<'deal_notes'>): Promise<Tables<'deal_notes'>> {
    const [row] = await this.db.insert(dealNotes).values(data).returning();
    return row;
  }

  async insertMany(rows: TablesInsert<'deal_notes'>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(dealNotes).values(rows);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(dealNotes).where(eq(dealNotes.id, id));
  }
}
