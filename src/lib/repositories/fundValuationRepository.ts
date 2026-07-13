import { and, desc, eq, inArray } from 'drizzle-orm';
import { fundValuations, funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FundValuationRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceFundIds() {
    return this.db
      .select({ id: funds.id })
      .from(funds)
      .where(eq(funds.workspace_id, this.workspaceId));
  }

  /** All snapshots for a fund, most recent `as_of_date` first. */
  async findByFundId(fundId: string): Promise<Tables<'fund_valuations'>[]> {
    return this.db
      .select()
      .from(fundValuations)
      .where(
        and(
          eq(fundValuations.fund_id, fundId),
          inArray(fundValuations.fund_id, this.workspaceFundIds()),
        ),
      )
      .orderBy(desc(fundValuations.as_of_date));
  }

  async findLatestByFundId(fundId: string): Promise<Tables<'fund_valuations'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundValuations)
      .where(
        and(
          eq(fundValuations.fund_id, fundId),
          inArray(fundValuations.fund_id, this.workspaceFundIds()),
        ),
      )
      .orderBy(desc(fundValuations.as_of_date))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<Tables<'fund_valuations'> | undefined> {
    const [row] = await this.db
      .select()
      .from(fundValuations)
      .where(
        and(eq(fundValuations.id, id), inArray(fundValuations.fund_id, this.workspaceFundIds())),
      )
      .limit(1);
    return row;
  }

  async insert(data: TablesInsert<'fund_valuations'>): Promise<Tables<'fund_valuations'>> {
    const [row] = await this.db.insert(fundValuations).values(data).returning();
    return row;
  }

  /**
   * Insert a snapshot, or overwrite it in place if one already exists for
   * this `(fund_id, as_of_date)` — reprocessing the same as_of_date (e.g. a
   * corrected NAV statement) updates atomically instead of racing a
   * separate find-then-insert-or-update against the unique constraint.
   */
  async upsert(data: TablesInsert<'fund_valuations'>): Promise<Tables<'fund_valuations'>> {
    const [row] = await this.db
      .insert(fundValuations)
      .values(data)
      .onConflictDoUpdate({
        target: [fundValuations.fund_id, fundValuations.as_of_date],
        set: { ...data, updated_at: new Date().toISOString() },
      })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'fund_valuations'>,
  ): Promise<Tables<'fund_valuations'> | undefined> {
    const [row] = await this.db
      .update(fundValuations)
      .set(updates)
      .where(
        and(eq(fundValuations.id, id), inArray(fundValuations.fund_id, this.workspaceFundIds())),
      )
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(fundValuations)
      .where(
        and(eq(fundValuations.id, id), inArray(fundValuations.fund_id, this.workspaceFundIds())),
      );
  }
}
