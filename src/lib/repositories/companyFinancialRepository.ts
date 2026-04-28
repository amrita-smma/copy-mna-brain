import { and, eq, inArray } from 'drizzle-orm';
import { companyFinancials } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class CompanyFinancialRepository {
  constructor(private readonly db: DbClient) {}

  async findByCompany(companyId: string): Promise<Tables<'company_financials'>[]> {
    return this.db
      .select()
      .from(companyFinancials)
      .where(eq(companyFinancials.company_id, companyId))
      .orderBy(companyFinancials.fiscal_year);
  }

  async findByCompanyAndYear(
    companyId: string,
    fiscalYear: number,
  ): Promise<Tables<'company_financials'> | null> {
    const [row] = await this.db
      .select()
      .from(companyFinancials)
      .where(
        and(
          eq(companyFinancials.company_id, companyId),
          eq(companyFinancials.fiscal_year, fiscalYear),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findLatestByCompanies(companyIds: string[]): Promise<Tables<'company_financials'>[]> {
    if (companyIds.length === 0) return [];
    const all = await this.db
      .select()
      .from(companyFinancials)
      .where(inArray(companyFinancials.company_id, companyIds))
      .orderBy(companyFinancials.company_id, companyFinancials.fiscal_year);
    const latestByCompany = new Map<string, Tables<'company_financials'>>();
    for (const row of all) {
      latestByCompany.set(row.company_id, row);
    }
    return Array.from(latestByCompany.values());
  }

  async findByCompaniesAndYears(
    companyIds: string[],
    years: number[],
  ): Promise<Tables<'company_financials'>[]> {
    if (companyIds.length === 0 || years.length === 0) return [];
    return this.db
      .select()
      .from(companyFinancials)
      .where(
        and(
          inArray(companyFinancials.company_id, companyIds),
          inArray(companyFinancials.fiscal_year, years),
        ),
      );
  }

  async findByCompanies(companyIds: string[]): Promise<Tables<'company_financials'>[]> {
    if (companyIds.length === 0) return [];
    return this.db
      .select()
      .from(companyFinancials)
      .where(inArray(companyFinancials.company_id, companyIds))
      .orderBy(companyFinancials.company_id, companyFinancials.fiscal_year);
  }

  async upsert(data: TablesInsert<'company_financials'>): Promise<void> {
    await this.db
      .insert(companyFinancials)
      .values(data)
      .onConflictDoUpdate({
        target: [companyFinancials.company_id, companyFinancials.fiscal_year],
        set: {
          revenue_usd_mn: data.revenue_usd_mn,
          ebitda_usd_mn: data.ebitda_usd_mn,
          ev_usd_mn: data.ev_usd_mn,
          ebitda_margin: data.ebitda_margin,
          ev_ebitda: data.ev_ebitda,
          revenue_cagr_vs_prior: data.revenue_cagr_vs_prior,
          updated_at: new Date().toISOString(),
        },
      });
  }

  async bulkUpsertForCompany(
    companyId: string,
    rows: Array<Omit<TablesInsert<'company_financials'>, 'company_id'>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(companyFinancials)
          .values({ ...row, company_id: companyId })
          .onConflictDoUpdate({
            target: [companyFinancials.company_id, companyFinancials.fiscal_year],
            set: {
              revenue_usd_mn: row.revenue_usd_mn,
              ebitda_usd_mn: row.ebitda_usd_mn,
              ev_usd_mn: row.ev_usd_mn,
              ebitda_margin: row.ebitda_margin,
              ev_ebitda: row.ev_ebitda,
              revenue_cagr_vs_prior: row.revenue_cagr_vs_prior,
              updated_at: new Date().toISOString(),
            },
          });
      }
    });
  }

  async deleteByCompanyAndYears(companyId: string, years: number[]): Promise<void> {
    if (years.length === 0) return;
    await this.db
      .delete(companyFinancials)
      .where(
        and(
          eq(companyFinancials.company_id, companyId),
          inArray(companyFinancials.fiscal_year, years),
        ),
      );
  }
}
