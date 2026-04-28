import {
  and,
  asc,
  count as drizzleCount,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  companies,
  companyAssignees,
  companyFinancials,
  companyLogs,
  criterias,
  dealDocuments,
  dealLinks,
  dealNotes,
  files,
  screenings,
  users,
} from "@/lib/db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbClient, Tables, TablesInsert, TablesUpdate } from "./types";
import type { DealStage } from "@/lib/types";

export interface CompanyFilters {
  id?: string;
  stage?: string;
  stageIn?: string[];
  excludeStage?: string;
  stageNotNull?: boolean;
  excludeDropped?: boolean;
  createdAfter?: string;
  orderBy?: string;
  orderDir?: "asc" | "desc";
  limit?: number;
}

/** Filters used by AI-agent tool calls (queryCompanies in src/lib/agent/tools.ts). */
export interface CompanyAgentFilters {
  segment?: string;
  geography?: string;
  watchlistStatus?: string;
  minRevenue?: number;
  maxRevenue?: number;
  minEbitda?: number;
  searchTerm?: string;
  limit?: number;
}

type CompanyLogRow = {
  id: string;
  action: string;
  created_at: string | null;
};

type ScreeningWithCriteria = Tables<"screenings"> & {
  criterias: Pick<Tables<"criterias">, "id" | "name" | "prompt"> | null;
};

type MatchedFile = Pick<
  Tables<"files">,
  "id" | "file_name" | "file_link" | "file_date" | "created_at"
>;

export type CompanyDetails = {
  logs: CompanyLogRow[];
  notes: Tables<"deal_notes">[];
  links: Tables<"deal_links">[];
  documents: Tables<"deal_documents">[];
  screenings: ScreeningWithCriteria[];
  matchedFiles: MatchedFile[];
};

const ORDERABLE_COLUMNS: Record<string, AnyPgColumn> = {
  created_at: companies.created_at,
  updated_at: companies.updated_at,
  entry_id: companies.entry_id,
};

function buildFilterWhere(filters: CompanyFilters): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (filters.id) conditions.push(eq(companies.id, filters.id));
  if (filters.stage)
    conditions.push(eq(companies.pipeline_stage, filters.stage as DealStage));
  if (filters.stageIn && filters.stageIn.length > 0) {
    conditions.push(
      inArray(companies.pipeline_stage, filters.stageIn as DealStage[]),
    );
  }
  if (filters.excludeStage)
    conditions.push(
      ne(companies.pipeline_stage, filters.excludeStage as DealStage),
    );
  if (filters.stageNotNull)
    conditions.push(isNotNull(companies.pipeline_stage));
  if (filters.excludeDropped) {
    conditions.push(
      or(isNull(companies.status), ne(companies.status, "dropped")),
    );
  }
  if (filters.createdAfter)
    conditions.push(gte(companies.created_at, filters.createdAfter));
  if (conditions.length === 0) return undefined;
  return and(...conditions);
}

export class CompanyRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<Tables<"companies">> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(eq(companies.id, id))
      .limit(1);
    if (!row) throw new Error(`Company ${id} not found`);
    return row;
  }

  async findAll(filters: CompanyFilters = {}): Promise<Tables<"companies">[]> {
    const { orderBy = "updated_at", orderDir = "desc", limit } = filters;
    const where = buildFilterWhere(filters);
    const orderCol = ORDERABLE_COLUMNS[orderBy] ?? companies.updated_at;
    const orderExpr = orderDir === "asc" ? asc(orderCol) : desc(orderCol);

    const query = this.db
      .select()
      .from(companies)
      .where(where)
      .orderBy(orderExpr);
    return limit ? query.limit(limit) : query;
  }

  async count(
    filters: Omit<CompanyFilters, "orderBy" | "orderDir" | "limit"> = {},
  ): Promise<number> {
    const where = buildFilterWhere(filters);
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(companies)
      .where(where);
    return Number(row?.value ?? 0);
  }

  async countAll(): Promise<number> {
    return this.count({});
  }

  async findTargetNames(): Promise<string[]> {
    const rows = await this.db
      .select({ target: companies.target })
      .from(companies);
    return rows.map((c) => c.target ?? "").filter(Boolean);
  }

  async findAllIdAndTarget(): Promise<
    Array<{ id: string; target: string | null }>
  > {
    return this.db
      .select({ id: companies.id, target: companies.target })
      .from(companies);
  }

  async findByNameFuzzy(namePart: string): Promise<Tables<"companies"> | null> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(ilike(companies.target, `%${namePart}%`))
      .limit(1);
    return row ?? null;
  }

  async searchForAgent(
    filters: CompanyAgentFilters,
  ): Promise<Tables<"companies">[]> {
    const conditions: (SQL | undefined)[] = [];
    if (filters.segment)
      conditions.push(ilike(companies.segment, `%${filters.segment}%`));
    if (filters.geography)
      conditions.push(ilike(companies.geography, `%${filters.geography}%`));
    if (filters.watchlistStatus) {
      conditions.push(
        ilike(companies.watchlist_status, `%${filters.watchlistStatus}%`),
      );
    }
    // Revenue/EBITDA filters apply against fiscal_year 2024 rows in company_financials.
    const needsFinancialsJoin =
      filters.minRevenue !== undefined ||
      filters.maxRevenue !== undefined ||
      filters.minEbitda !== undefined;
    if (needsFinancialsJoin) {
      conditions.push(eq(companyFinancials.fiscal_year, 2024));
    }
    if (filters.minRevenue !== undefined) {
      conditions.push(
        gte(companyFinancials.revenue_usd_mn, filters.minRevenue),
      );
    }
    if (filters.maxRevenue !== undefined) {
      conditions.push(
        lte(companyFinancials.revenue_usd_mn, filters.maxRevenue),
      );
    }
    if (filters.minEbitda !== undefined) {
      conditions.push(gte(companyFinancials.ebitda_usd_mn, filters.minEbitda));
    }
    if (filters.searchTerm) {
      const term = `%${filters.searchTerm}%`;
      conditions.push(
        or(
          ilike(companies.target, term),
          ilike(companies.segment, term),
          ilike(companies.geography, term),
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(filters.limit ?? 50, 50);
    if (needsFinancialsJoin) {
      const rows = await this.db
        .select({ company: companies })
        .from(companies)
        .innerJoin(
          companyFinancials,
          eq(companyFinancials.company_id, companies.id),
        )
        .where(where)
        .limit(limit);
      return rows.map((r) => r.company);
    }
    return this.db.select().from(companies).where(where).limit(limit);
  }

  async insert(
    company: TablesInsert<"companies">,
  ): Promise<Tables<"companies">> {
    const [row] = await this.db.insert(companies).values(company).returning();
    return row;
  }

  async insertMany(list: TablesInsert<"companies">[]): Promise<void> {
    if (list.length === 0) return;
    await this.db.insert(companies).values(list);
  }

  async update(
    id: string,
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies">[]> {
    return this.db
      .update(companies)
      .set(updates)
      .where(eq(companies.id, id))
      .returning();
  }

  async updateMany(
    ids: string[],
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies">[]> {
    if (ids.length === 0) return [];
    return this.db
      .update(companies)
      .set(updates)
      .where(inArray(companies.id, ids))
      .returning();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(companies).where(eq(companies.id, id));
  }

  async findAssignees(
    companyId: string,
  ): Promise<Array<Pick<Tables<"users">, "id" | "name" | "email" | "role">>> {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(companyAssignees)
      .innerJoin(users, eq(users.id, companyAssignees.user_id))
      .where(eq(companyAssignees.company_id, companyId))
      .orderBy(asc(users.name));
  }

  async findAssigneesByCompanies(
    companyIds: string[],
  ): Promise<
    Array<
      Pick<Tables<"users">, "id" | "name" | "email" | "role"> & {
        company_id: string;
      }
    >
  > {
    if (companyIds.length === 0) return [];
    return this.db
      .select({
        company_id: companyAssignees.company_id,
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(companyAssignees)
      .innerJoin(users, eq(users.id, companyAssignees.user_id))
      .where(inArray(companyAssignees.company_id, companyIds))
      .orderBy(asc(users.name));
  }

  async setAssignees(companyId: string, userIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(companyAssignees)
        .where(eq(companyAssignees.company_id, companyId));
      if (userIds.length > 0) {
        const unique = Array.from(new Set(userIds));
        await tx
          .insert(companyAssignees)
          .values(
            unique.map((user_id) => ({ company_id: companyId, user_id })),
          );
      }
    });
  }

  async runL1Filters(id: string): Promise<unknown> {
    // Use named-arg syntax to match the original Supabase `.rpc()` calling
    // convention (`deal_id_param`), so behavior is identical if the prod
    // function is declared with strict named-only semantics or defaults on
    // other positional parameters.
    const result = await this.db.execute<{ run_l1_filters: unknown }>(
      sql`SELECT run_l1_filters(deal_id_param => ${id}) AS run_l1_filters`,
    );
    return result[0]?.run_l1_filters ?? null;
  }

  async findDetails(id: string): Promise<CompanyDetails> {
    const [
      logsRes,
      notesRes,
      linksRes,
      docsRes,
      screeningsRes,
      matchedFilesRes,
    ] = await Promise.all([
      this.db
        .select({
          id: companyLogs.id,
          action: companyLogs.action,
          created_at: companyLogs.created_at,
        })
        .from(companyLogs)
        .where(eq(companyLogs.company_id, id))
        .orderBy(asc(companyLogs.created_at)),

      this.db
        .select()
        .from(dealNotes)
        .where(eq(dealNotes.deal_id, id))
        .orderBy(desc(dealNotes.created_at)),

      this.db
        .select()
        .from(dealLinks)
        .where(eq(dealLinks.deal_id, id))
        .orderBy(desc(dealLinks.created_at)),

      this.db
        .select()
        .from(dealDocuments)
        .where(eq(dealDocuments.deal_id, id))
        .orderBy(desc(dealDocuments.created_at)),

      this.db
        .select({
          screening: screenings,
          criteria_id_inner: criterias.id,
          criteria_name: criterias.name,
          criteria_prompt: criterias.prompt,
        })
        .from(screenings)
        .leftJoin(criterias, eq(criterias.id, screenings.criteria_id))
        .where(eq(screenings.company_id, id))
        .orderBy(desc(screenings.created_at)),

      this.db
        .select({
          id: files.id,
          file_name: files.file_name,
          file_link: files.file_link,
          file_date: files.file_date,
          created_at: files.created_at,
        })
        .from(files)
        .where(
          sql`${files.matched_companies} @> ${JSON.stringify([{ id }])}::jsonb`,
        )
        .orderBy(desc(files.created_at))
        .limit(100),
    ]);

    const mappedScreenings: ScreeningWithCriteria[] = screeningsRes.map(
      (r) => ({
        ...r.screening,
        criterias:
          r.criteria_id_inner === null
            ? null
            : {
                id: r.criteria_id_inner,
                name: r.criteria_name!,
                prompt: r.criteria_prompt!,
              },
      }),
    );

    return {
      logs: logsRes,
      notes: notesRes,
      links: linksRes,
      documents: docsRes,
      screenings: mappedScreenings,
      matchedFiles: matchedFilesRes,
    };
  }
}
