import { and, eq, inArray } from 'drizzle-orm';
import { companies, companyScreeningDerived } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class CompanyScreeningDerivedRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByCompany(
    companyId: string,
  ): Promise<Tables<'company_screening_derived'> | null> {
    const [row] = await this.db
      .select()
      .from(companyScreeningDerived)
      .where(
        and(
          eq(companyScreeningDerived.company_id, companyId),
          inArray(companyScreeningDerived.company_id, this.workspaceCompanyIds()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findByCompanies(
    companyIds: string[],
  ): Promise<Tables<'company_screening_derived'>[]> {
    if (companyIds.length === 0) return [];
    return this.db
      .select()
      .from(companyScreeningDerived)
      .where(
        and(
          inArray(companyScreeningDerived.company_id, companyIds),
          inArray(companyScreeningDerived.company_id, this.workspaceCompanyIds()),
        ),
      );
  }

  async upsertByCompany(data: TablesInsert<'company_screening_derived'>): Promise<void> {
    const { company_id, ...rest } = data;
    void company_id;
    await this.db
      .insert(companyScreeningDerived)
      .values(data)
      .onConflictDoUpdate({
        target: companyScreeningDerived.company_id,
        set: {
          ...rest,
          updated_at: new Date().toISOString(),
        },
      });
  }

  async deleteByCompany(companyId: string): Promise<void> {
    await this.db
      .delete(companyScreeningDerived)
      .where(
        and(
          eq(companyScreeningDerived.company_id, companyId),
          inArray(companyScreeningDerived.company_id, this.workspaceCompanyIds()),
        ),
      );
  }
}
