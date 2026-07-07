import { and, eq, inArray } from 'drizzle-orm';
import { companies, companyFxAdjustments } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class CompanyFxAdjustmentRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByCompany(companyId: string): Promise<Tables<'company_fx_adjustments'>[]> {
    return this.db
      .select()
      .from(companyFxAdjustments)
      .where(
        and(
          eq(companyFxAdjustments.company_id, companyId),
          inArray(companyFxAdjustments.company_id, this.workspaceCompanyIds()),
        ),
      )
      .orderBy(companyFxAdjustments.fiscal_year);
  }

  async findByCompanies(companyIds: string[]): Promise<Tables<'company_fx_adjustments'>[]> {
    if (companyIds.length === 0) return [];
    return this.db
      .select()
      .from(companyFxAdjustments)
      .where(
        and(
          inArray(companyFxAdjustments.company_id, companyIds),
          inArray(companyFxAdjustments.company_id, this.workspaceCompanyIds()),
        ),
      )
      .orderBy(companyFxAdjustments.fiscal_year);
  }

  async upsert(data: TablesInsert<'company_fx_adjustments'>): Promise<void> {
    await this.db
      .insert(companyFxAdjustments)
      .values(data)
      .onConflictDoUpdate({
        target: [companyFxAdjustments.company_id, companyFxAdjustments.fiscal_year],
        set: {
          currency: data.currency,
          revenue_local: data.revenue_local,
          ebitda_local: data.ebitda_local,
          assumed_forex: data.assumed_forex,
          forex_change_vs_prior: data.forex_change_vs_prior,
          revenue_cagr_domestic: data.revenue_cagr_domestic,
          updated_at: new Date().toISOString(),
        },
      });
  }

  async bulkUpsertForCompany(
    companyId: string,
    rows: Array<Omit<TablesInsert<'company_fx_adjustments'>, 'company_id'>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(companyFxAdjustments)
          .values({ ...row, company_id: companyId })
          .onConflictDoUpdate({
            target: [companyFxAdjustments.company_id, companyFxAdjustments.fiscal_year],
            set: {
              currency: row.currency,
              revenue_local: row.revenue_local,
              ebitda_local: row.ebitda_local,
              assumed_forex: row.assumed_forex,
              forex_change_vs_prior: row.forex_change_vs_prior,
              revenue_cagr_domestic: row.revenue_cagr_domestic,
              updated_at: new Date().toISOString(),
            },
          });
      }
    });
  }
}
