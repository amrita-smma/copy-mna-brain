import { and, asc, eq, inArray } from 'drizzle-orm';
import { companies, companySlides } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class CompanySlidesRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByCompanyId(companyId: string): Promise<Tables<'company_slides'>[]> {
    return this.db
      .select()
      .from(companySlides)
      .where(and(eq(companySlides.company_id, companyId), inArray(companySlides.company_id, this.workspaceCompanyIds())))
      .orderBy(asc(companySlides.sort_order));
  }

  async insert(data: TablesInsert<'company_slides'>): Promise<Tables<'company_slides'>> {
    const [row] = await this.db.insert(companySlides).values(data).returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'company_slides'>,
  ): Promise<Tables<'company_slides'>> {
    const [row] = await this.db
      .update(companySlides)
      .set(updates)
      .where(and(eq(companySlides.id, id), inArray(companySlides.company_id, this.workspaceCompanyIds())))
      .returning();
    if (!row) throw new Error(`Company slide ${id} not found`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(companySlides)
      .where(and(eq(companySlides.id, id), inArray(companySlides.company_id, this.workspaceCompanyIds())));
  }
}
