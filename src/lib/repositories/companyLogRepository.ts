import { and, asc, eq, inArray } from 'drizzle-orm';
import { companies, companyLogs } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

type CompanyLogSummary = Pick<Tables<'company_logs'>, 'id' | 'action' | 'created_at'>;

type CompanyLogSummaryWithCompany = CompanyLogSummary & {
  company_id: string | null;
};

export class CompanyLogRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findByCompanyId(companyId: string): Promise<CompanyLogSummary[]> {
    return this.db
      .select({
        id: companyLogs.id,
        action: companyLogs.action,
        created_at: companyLogs.created_at,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companies.id, companyLogs.company_id))
      .where(and(eq(companyLogs.company_id, companyId), eq(companies.workspace_id, this.workspaceId)))
      .orderBy(asc(companyLogs.created_at));
  }

  /**
   * Bulk variant of {@link findByCompanyId}: fetch the logs for many companies
   * in a single query, tagged with their `company_id` so the caller can group
   * them. Ordered by `created_at` ascending across the whole result. Returns
   * `[]` for an empty id list — `inArray` with an empty array crashes Drizzle.
   */
  async findByCompanyIds(
    companyIds: string[],
  ): Promise<CompanyLogSummaryWithCompany[]> {
    if (companyIds.length === 0) return [];
    return this.db
      .select({
        id: companyLogs.id,
        company_id: companyLogs.company_id,
        action: companyLogs.action,
        created_at: companyLogs.created_at,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companies.id, companyLogs.company_id))
      .where(
        and(
          inArray(companyLogs.company_id, companyIds),
          eq(companies.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(asc(companyLogs.created_at));
  }

  async insert(
    entry: Pick<TablesInsert<'company_logs'>, 'company_id' | 'action'>,
  ): Promise<void> {
    await this.db.insert(companyLogs).values(entry);
  }

  async insertMany(
    entries: Array<Pick<TablesInsert<'company_logs'>, 'company_id' | 'action'>>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(companyLogs).values(entries);
  }
}
