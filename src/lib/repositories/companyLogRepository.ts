import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import { companies, companyLogs } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

type CompanyLogSummary = Pick<Tables<'company_logs'>, 'id' | 'action' | 'created_at'>;

type CompanyLogSummaryWithCompany = CompanyLogSummary & {
  company_id: string | null;
};

/**
 * Action prefix of the log a Deal Sponsor auto-assignment writes (MB-830):
 * `AUTO_ASSIGNED_SPONSOR:<user id>`, with the reason in `comments`. The
 * reason stays out of the action because stage-move readers pattern-match
 * actions (e.g. `%_TO_%`) and a banker or firm name must never look like one.
 */
export const AUTO_ASSIGNED_SPONSOR_ACTION = 'AUTO_ASSIGNED_SPONSOR';

export function autoAssignedSponsorAction(userId: string): string {
  return `${AUTO_ASSIGNED_SPONSOR_ACTION}:${userId}`;
}

/** The user id an auto-assignment log names, or `null` for any other action. */
export function parseAutoAssignedSponsorAction(action: string | null | undefined): string | null {
  const prefix = `${AUTO_ASSIGNED_SPONSOR_ACTION}:`;
  return action?.startsWith(prefix) ? action.slice(prefix.length) || null : null;
}

/** The latest Deal Sponsor auto-assignment of one company. */
export interface AutoSponsorLog {
  company_id: string;
  user_id: string;
  reason: string | null;
  created_at: string | null;
}

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

  /**
   * The latest Deal Sponsor auto-assignment of each company, in one query.
   * Companies never auto-assigned are absent. `[]`-safe like the other bulk
   * reads.
   */
  async findLatestAutoSponsorLogs(companyIds: string[]): Promise<Map<string, AutoSponsorLog>> {
    const latest = new Map<string, AutoSponsorLog>();
    if (companyIds.length === 0) return latest;
    const rows = await this.db
      .select({
        company_id: companyLogs.company_id,
        action: companyLogs.action,
        comments: companyLogs.comments,
        created_at: companyLogs.created_at,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companies.id, companyLogs.company_id))
      .where(
        and(
          inArray(companyLogs.company_id, companyIds),
          eq(companies.workspace_id, this.workspaceId),
          like(companyLogs.action, `${AUTO_ASSIGNED_SPONSOR_ACTION}:%`),
        ),
      )
      .orderBy(asc(companyLogs.company_id), desc(companyLogs.created_at));
    for (const row of rows) {
      const userId = parseAutoAssignedSponsorAction(row.action);
      if (!row.company_id || !userId || latest.has(row.company_id)) continue;
      latest.set(row.company_id, {
        company_id: row.company_id,
        user_id: userId,
        reason: row.comments,
        created_at: row.created_at,
      });
    }
    return latest;
  }

  async insertMany(
    entries: Array<Pick<TablesInsert<'company_logs'>, 'company_id' | 'action' | 'comments'>>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(companyLogs).values(entries);
  }
}
