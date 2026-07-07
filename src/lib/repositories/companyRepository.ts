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
  investmentThesis,
  screenings,
  users,
} from "@/lib/db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbClient, Tables, TablesInsert, TablesUpdate } from "./types";
import type { DealStage } from "@/lib/types";
import {
  companyRowToGraphNode,
  type CompanyGraphMirror,
} from "./companyRelationRepository";

// Common legal/entity suffixes peeled off a company name before fuzzy
// matching so "Acme Ltd.", "Acme Co." and "Acme" collapse to the same base.
// Matched case-insensitively, with or without a trailing period, and only
// when preceded by whitespace/comma so embedded letters (e.g. "Cisco") survive.
const COMPANY_NAME_SUFFIXES = [
  "ltd",
  "limited",
  "co",
  "company",
  "inc",
  "incorporated",
  "llc",
  "llp",
  "corp",
  "corporation",
  "group",
  "holdings",
  "holding",
  "gmbh",
  "ag",
  "sa",
  "spa",
  "plc",
  "pte",
  "pvt",
  "bv",
  "nv",
  "sdn",
  "bhd",
  "tbk",
] as const;

/**
 * Normalize a company name for fuzzy matching by stripping a leading
 * Indonesian "PT" entity marker and any trailing legal/entity suffixes
 * (Ltd., Co., Inc., Sdn Bhd, Tbk, ...). Exported for unit testing.
 */
export function stripCompanySuffix(name: string): string {
  let result = name.trim();
  // Drop a leading "PT" / "PT." entity marker (common in Indonesia).
  result = result.replace(/^pt\.?\s+/i, "").trim();
  // Peel trailing suffix tokens repeatedly so multi-word endings like
  // "Sdn Bhd" or "Holdings Ltd." are fully removed.
  let changed = true;
  while (changed) {
    changed = false;
    const stripped = result.replace(/[.,]+$/g, "").trim();
    for (const suffix of COMPANY_NAME_SUFFIXES) {
      const re = new RegExp(`[\\s,]+${suffix}$`, "i");
      if (re.test(stripped)) {
        result = stripped.replace(re, "").trim();
        changed = true;
        break;
      }
    }
  }
  return result.replace(/[.,]+$/g, "").trim();
}

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
  offset?: number;
  /**
   * Case-insensitive ILIKE filter against `companies.target` OR
   * `companies.project_name` — a row matches when the substring appears in
   * either, so companies named in one language and code-named in another
   * (e.g. a Mandarin target with an English project name) are findable by
   * both. Used by the lightweight lookup endpoint that powers the
   * "Matched Company" combobox in the AI File Dump upload form.
   */
  targetSearch?: string;
}

/**
 * Filters shared by the AI-agent read tools (`query_companies` and
 * `get_company_stats` in src/lib/agents/analysis/tools/). Every field is
 * optional and AND-combined. Text fields are partial (ILIKE) matches; enum
 * fields are exact. Revenue/EBITDA bounds resolve against the FY2024 row in
 * `company_financials`.
 */
export interface CompanyAgentFilters {
  segment?: string;
  geography?: string;
  watchlistStatus?: string;
  stage?: string;
  /** Match any of several pipeline stages (exact). Combined with OR. */
  stageIn?: string[];
  name?: string;
  ownership?: string;
  companyFocus?: string;
  source?: "inbound" | "outbound";
  status?: "active" | "dropped";
  dealType?: "majority" | "minority";
  /** Deal sponsor user name (partial, case-insensitive; deal_sponsor is a uuid FK to users). */
  dealSponsor?: string;
  banker?: string;
  /** When set, keep only companies that have (true) / lack (false) an AI Opinion verdict. */
  hasAiOpinion?: boolean;
  /** Exact AI Opinion verdict (case-insensitive): pass | fail | tentative. */
  aiOpinionVerdict?: "pass" | "fail" | "tentative";
  minRevenue?: number;
  maxRevenue?: number;
  minEbitda?: number;
  maxEbitda?: number;
  /**
   * Keep only companies created on/after this timestamp (inclusive). Compared
   * against `companies.created_at`; accepts any Postgres-parseable date string
   * (e.g. "2026-01-01" or a full ISO-8601 timestamp).
   */
  createdAfter?: string;
  /** Keep only companies created on/before this timestamp (inclusive). */
  createdBefore?: string;
  /** Free-text ILIKE across target, project_name, segment, and geography. */
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
  track: Pick<Tables<"investment_thesis">, "id" | "title"> | null;
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

function buildFilterWhere(filters: CompanyFilters, workspaceId: string): SQL | undefined {
  const conditions: (SQL | undefined)[] = [eq(companies.workspace_id, workspaceId)];
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
    conditions.push(ne(companies.status, "dropped"));
  }
  if (filters.createdAfter)
    conditions.push(gte(companies.created_at, filters.createdAfter));
  if (filters.targetSearch && filters.targetSearch.trim().length > 0) {
    const term = `%${filters.targetSearch.trim()}%`;
    conditions.push(
      or(ilike(companies.target, term), ilike(companies.project_name, term)),
    );
  }
  return and(...conditions);
}

export class CompanyRepository {
  /**
   * @param db    Postgres client — the source of truth.
   * @param workspaceId Active workspace — applied as a predicate on every
   *   read/update/delete and stamped on every insert.
   * @param graph Optional Neo4j mirror. When wired (by the container), every
   *   company write is reflected onto the graph so Neo4j follows Postgres:
   *   inserts/updates upsert the node, deletes remove it. Graph failures are
   *   best-effort and never fail the Postgres write. Left undefined in unit
   *   tests and in contexts without a graph backend (e.g. job handlers).
   */
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly graph?: CompanyGraphMirror,
  ) {}

  /** Upsert the given company rows onto the graph node, swallowing failures. */
  private async mirrorUpsert(rows: Tables<"companies">[]): Promise<void> {
    if (!this.graph || rows.length === 0) return;
    try {
      await Promise.all(
        rows.map((row) => this.graph!.upsertCompany(companyRowToGraphNode(row))),
      );
    } catch (err) {
      console.error(
        "[CompanyRepository] failed to mirror company upsert to graph DB",
        err,
      );
    }
  }

  /** Remove the company node from the graph, swallowing failures. */
  private async mirrorDelete(id: string): Promise<void> {
    if (!this.graph) return;
    try {
      await this.graph.deleteCompany(id);
    } catch (err) {
      console.error(
        `[CompanyRepository] failed to mirror company ${id} deletion to graph DB`,
        err,
      );
    }
  }

  async findById(id: string): Promise<Tables<"companies">> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.workspace_id, this.workspaceId)))
      .limit(1);
    if (!row) throw new Error(`Company ${id} not found`);
    return row;
  }

  async findAll(filters: CompanyFilters = {}): Promise<Tables<"companies">[]> {
    const { orderBy = "updated_at", orderDir = "desc", limit, offset } = filters;
    const where = buildFilterWhere(filters, this.workspaceId);
    const orderCol = ORDERABLE_COLUMNS[orderBy] ?? companies.updated_at;
    const orderExpr = orderDir === "asc" ? asc(orderCol) : desc(orderCol);

    const base = this.db
      .select()
      .from(companies)
      .where(where)
      .orderBy(orderExpr);
    const withLimit = limit ? base.limit(limit) : base;
    return offset ? withLimit.offset(offset) : withLimit;
  }

  /**
   * `id` + `ai_opinion_status` for every company with an in-flight AI Opinion
   * run (`ai_opinion_status = 'processing'`). Backs the companies SSE stream:
   * when a company leaves this set the snapshot changes, signalling the client
   * to refresh so the verdict swaps in.
   */
  async findProcessingAiOpinions(): Promise<
    Array<{ id: string; ai_opinion_status: string | null }>
  > {
    return this.db
      .select({
        id: companies.id,
        ai_opinion_status: companies.ai_opinion_status,
      })
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          eq(companies.ai_opinion_status, "processing"),
        ),
      );
  }

  /**
   * Lightweight paginated lookup returning `id` + `target` + `project_name`.
   * Used by the AI File Dump "Matched Company" / "Project Name" pickers —
   * server-side ILIKE search via `targetSearch` matches against either
   * `target` OR `project_name`, so users can find a row by either name.
   * Project-only companies (target null but project_name set) are included
   * so they're pickable too.
   * Offset/limit pagination so the dropdown can load on demand instead of
   * all at once. Ordered by target (then project_name) ascending for a
   * stable alphabetical list with project-only rows trailing.
   */
  async findIdAndTargetPage(
    filters: Pick<CompanyFilters, "limit" | "offset" | "targetSearch"> = {},
  ): Promise<
    Array<{ id: string; target: string | null; project_name: string | null }>
  > {
    const { limit, offset, targetSearch } = filters;
    const conditions: (SQL | undefined)[] = [
      eq(companies.workspace_id, this.workspaceId),
      or(isNotNull(companies.target), isNotNull(companies.project_name)),
    ];
    if (targetSearch && targetSearch.trim().length > 0) {
      const term = `%${targetSearch.trim()}%`;
      conditions.push(
        or(ilike(companies.target, term), ilike(companies.project_name, term)),
      );
    }
    const where = and(...conditions);

    const base = this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
      })
      .from(companies)
      .where(where)
      .orderBy(asc(companies.target), asc(companies.project_name));
    const withLimit = limit ? base.limit(limit) : base;
    return offset ? withLimit.offset(offset) : withLimit;
  }

  async count(
    filters: Omit<CompanyFilters, "orderBy" | "orderDir" | "limit"> = {},
  ): Promise<number> {
    const where = buildFilterWhere(filters, this.workspaceId);
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
      .from(companies)
      .where(eq(companies.workspace_id, this.workspaceId));
    return rows.map((c) => c.target ?? "").filter(Boolean);
  }

  /**
   * Distinct, non-empty `banker` values already saved across all companies —
   * feeds the creatable "Banker / Source" combobox so a banker entered on one
   * deal can be reused on another instead of being retyped (which risks
   * spelling drift). Deduped case-insensitively, keeping the first-seen
   * casing, and sorted case-insensitively for a stable dropdown.
   */
  async findBankerNames(): Promise<string[]> {
    const rows = await this.db
      .select({ banker: companies.banker })
      .from(companies)
      .where(eq(companies.workspace_id, this.workspaceId));
    const byKey = new Map<string, string>();
    for (const r of rows) {
      const value = r.banker?.trim();
      if (value && !byKey.has(value.toLowerCase())) {
        byKey.set(value.toLowerCase(), value);
      }
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  async findAllIdAndTarget(): Promise<
    Array<{ id: string; target: string | null; project_name: string | null }>
  > {
    return this.db
      .select({ id: companies.id, target: companies.target, project_name: companies.project_name })
      .from(companies)
      .where(eq(companies.workspace_id, this.workspaceId));
  }

  async findByNameFuzzy(namePart: string): Promise<Tables<"companies"> | null> {
    const trimmed = namePart.trim();
    if (!trimmed) return null;
    // Short acronyms (e.g. "TSMC", "SEB") would spuriously substring-match
    // unrelated companies, so below 5 chars we require an exact
    // (case-insensitive) name match instead of skipping the lookup — skipping
    // let every relationship edge naming "TSMC" create a fresh discovered row.
    if (trimmed.length < 5) {
      const lowered = trimmed.toLowerCase();
      const [row] = await this.db
        .select()
        .from(companies)
        .where(or(
          sql`lower(${companies.target}) = ${lowered}`,
          sql`lower(${companies.project_name}) = ${lowered}`,
        ))
        .limit(1);
      return row ?? null;
    }
    // Strip legal/entity suffixes (Ltd., Co., Inc., PT, Tbk, ...) so a new
    // "Acme Ltd." matches an existing "Acme Co." — same base name, different
    // ending. Substring-match on the base then catches it in either direction.
    // Fall back to the full name if stripping leaves too little to match on.
    const base = stripCompanySuffix(trimmed);
    const term = base.length >= 3 ? base : trimmed;
    // Match case-insensitively by folding both sides to lower case explicitly
    // rather than relying on the column collation. Escape LIKE metacharacters
    // (\, %, _) in the term so names containing them match literally instead of
    // acting as wildcards. ESCAPE '\' makes the backslash escapes take effect.
    const escaped = term.replace(/[\\%_]/g, "\\$&").toLowerCase();
    const pattern = `%${escaped}%`;
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(
        eq(companies.workspace_id, this.workspaceId),
        or(
          sql`lower(${companies.target}) like ${pattern} escape '\\'`,
          sql`lower(${companies.project_name}) like ${pattern} escape '\\'`,
        ),
      ))
      .limit(1);
    return row ?? null;
  }

  /**
   * Translate {@link CompanyAgentFilters} into a SQL condition list shared by
   * the agent read paths. Revenue/EBITDA bounds require a join onto
   * `company_financials` (FY2024); `needsFinancialsJoin` tells the caller
   * whether to add that join. Returned conditions are AND-combined by callers.
   */
  private buildAgentConditions(filters: CompanyAgentFilters): {
    conditions: SQL[];
    needsFinancialsJoin: boolean;
  } {
    const conditions: SQL[] = [eq(companies.workspace_id, this.workspaceId)];
    const push = (c: SQL | undefined) => {
      if (c) conditions.push(c);
    };

    if (filters.segment) push(ilike(companies.segment, `%${filters.segment}%`));
    if (filters.geography)
      push(ilike(companies.geography, `%${filters.geography}%`));
    if (filters.watchlistStatus)
      push(ilike(companies.watchlist_status, `%${filters.watchlistStatus}%`));
    if (filters.stage)
      push(eq(companies.pipeline_stage, filters.stage as DealStage));
    if (filters.stageIn && filters.stageIn.length > 0)
      push(inArray(companies.pipeline_stage, filters.stageIn as DealStage[]));
    if (filters.name) {
      const term = `%${filters.name}%`;
      push(
        or(ilike(companies.target, term), ilike(companies.project_name, term)),
      );
    }
    if (filters.ownership)
      push(ilike(companies.ownership, `%${filters.ownership}%`));
    if (filters.companyFocus)
      push(ilike(companies.company_focus, `%${filters.companyFocus}%`));
    if (filters.source) push(eq(companies.source, filters.source));
    if (filters.status) push(eq(companies.status, filters.status));
    if (filters.dealType) push(eq(companies.deal_type, filters.dealType));
    // deal_sponsor holds a users.id uuid — match the filter term against the
    // sponsor user's name via a subquery.
    if (filters.dealSponsor)
      push(
        inArray(
          companies.deal_sponsor,
          this.db
            .select({ id: users.id })
            .from(users)
            .where(ilike(users.name, `%${filters.dealSponsor}%`)),
        ),
      );
    if (filters.banker) push(ilike(companies.banker, `%${filters.banker}%`));
    if (filters.hasAiOpinion === true)
      push(isNotNull(companies.ai_opinion_verdict));
    if (filters.hasAiOpinion === false)
      push(isNull(companies.ai_opinion_verdict));
    if (filters.aiOpinionVerdict)
      push(
        sql`lower(${companies.ai_opinion_verdict}) = ${filters.aiOpinionVerdict.toLowerCase()}`,
      );

    if (filters.createdAfter)
      push(gte(companies.created_at, filters.createdAfter));
    if (filters.createdBefore)
      push(lte(companies.created_at, filters.createdBefore));

    // Revenue/EBITDA filters apply against fiscal_year 2024 rows in company_financials.
    const needsFinancialsJoin =
      filters.minRevenue !== undefined ||
      filters.maxRevenue !== undefined ||
      filters.minEbitda !== undefined ||
      filters.maxEbitda !== undefined;
    if (needsFinancialsJoin) push(eq(companyFinancials.fiscal_year, 2024));
    if (filters.minRevenue !== undefined)
      push(gte(companyFinancials.revenue_usd_mn, filters.minRevenue));
    if (filters.maxRevenue !== undefined)
      push(lte(companyFinancials.revenue_usd_mn, filters.maxRevenue));
    if (filters.minEbitda !== undefined)
      push(gte(companyFinancials.ebitda_usd_mn, filters.minEbitda));
    if (filters.maxEbitda !== undefined)
      push(lte(companyFinancials.ebitda_usd_mn, filters.maxEbitda));

    if (filters.searchTerm) {
      const term = `%${filters.searchTerm}%`;
      push(
        or(
          ilike(companies.target, term),
          ilike(companies.project_name, term),
          ilike(companies.segment, term),
          ilike(companies.geography, term),
        ),
      );
    }

    return { conditions, needsFinancialsJoin };
  }

  async searchForAgent(
    filters: CompanyAgentFilters,
  ): Promise<Tables<"companies">[]> {
    const { conditions, needsFinancialsJoin } =
      this.buildAgentConditions(filters);
    const where = and(...conditions);
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

  /**
   * Like {@link searchForAgent} but returns the FULL matching set (no display
   * cap) for aggregate computation in `get_company_stats`. Accepts the same
   * {@link CompanyAgentFilters}. A defensive upper bound keeps a pathological
   * call from materializing an unbounded result.
   */
  async findForAgentStats(
    filters: CompanyAgentFilters,
  ): Promise<Tables<"companies">[]> {
    const { conditions, needsFinancialsJoin } =
      this.buildAgentConditions(filters);
    // The stats snapshot summarizes the origination pipeline only. `discovered`
    // rows are auto-created relationship-graph stubs that sit outside the L0–L5
    // funnel, so they must never inflate the aggregate — exclude them here
    // (this is stats-only; searchForAgent/query_companies still surfaces them).
    conditions.push(ne(companies.pipeline_stage, "discovered" as DealStage));
    const where = and(...conditions);
    const HARD_CAP = 5000;
    if (needsFinancialsJoin) {
      const rows = await this.db
        .select({ company: companies })
        .from(companies)
        .innerJoin(
          companyFinancials,
          eq(companyFinancials.company_id, companies.id),
        )
        .where(where)
        .limit(HARD_CAP);
      return rows.map((r) => r.company);
    }
    return this.db.select().from(companies).where(where).limit(HARD_CAP);
  }

  async insert(
    company: Omit<TablesInsert<"companies">, "workspace_id">,
  ): Promise<Tables<"companies">> {
    const [row] = await this.db
      .insert(companies)
      .values({ ...company, workspace_id: this.workspaceId })
      .returning();
    await this.mirrorUpsert([row]);
    return row;
  }

  async insertMany(list: Array<Omit<TablesInsert<"companies">, "workspace_id">>): Promise<void> {
    if (list.length === 0) return;
    const rows = await this.db
      .insert(companies)
      .values(list.map((c) => ({ ...c, workspace_id: this.workspaceId })))
      .returning();
    await this.mirrorUpsert(rows);
  }

  async update(
    id: string,
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies">[]> {
    const rows = await this.db
      .update(companies)
      .set(updates)
      .where(and(eq(companies.id, id), eq(companies.workspace_id, this.workspaceId)))
      .returning();
    await this.mirrorUpsert(rows);
    return rows;
  }

  async updateMany(
    ids: string[],
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies">[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .update(companies)
      .set(updates)
      .where(and(inArray(companies.id, ids), eq(companies.workspace_id, this.workspaceId)))
      .returning();
    await this.mirrorUpsert(rows);
    return rows;
  }

  /**
   * Dropped deals whose scheduled resurface time has passed. Scanned by the
   * resurface cron; covered by the partial idx_companies_resurface_due index.
   */
  async findDueForResurface(nowIso: string): Promise<Tables<"companies">[]> {
    return this.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.status, "dropped"),
          isNotNull(companies.resurface_at),
          lte(companies.resurface_at, nowIso),
        ),
      );
  }

  async countUnreviewed(source?: string): Promise<number> {
    const conditions = [
      eq(companies.pipeline_stage, 'unreviewed'),
      eq(companies.status, 'active'),
      eq(companies.workspace_id, this.workspaceId),
    ];
    if (source && source !== 'all') {
      conditions.push(eq(companies.source, source as 'inbound' | 'outbound'));
    }
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(companies)
      .where(and(...conditions));
    return Number(row?.value ?? 0);
  }

  async findDroppedIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          inArray(companies.id, ids),
          eq(companies.status, "dropped"),
          eq(companies.workspace_id, this.workspaceId),
        ),
      );
    return rows.map((r) => r.id);
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(companies)
      .where(and(eq(companies.id, id), eq(companies.workspace_id, this.workspaceId)));
    await this.mirrorDelete(id);
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
      .innerJoin(companies, eq(companies.id, companyAssignees.company_id))
      .where(
        and(
          eq(companyAssignees.company_id, companyId),
          eq(companies.workspace_id, this.workspaceId),
        ),
      )
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
      .innerJoin(companies, eq(companies.id, companyAssignees.company_id))
      .where(
        and(
          inArray(companyAssignees.company_id, companyIds),
          eq(companies.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(asc(users.name));
  }

  async setAssignees(companyId: string, userIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(companyAssignees)
        .where(
          and(
            eq(companyAssignees.company_id, companyId),
            inArray(
              companyAssignees.company_id,
              tx.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId)),
            ),
          ),
        );
      if (userIds.length > 0) {
        const unique = Array.from(new Set(userIds));
        await tx
          .insert(companyAssignees)
          .values(
            unique.map((user_id) => ({
              company_id: companyId,
              user_id,
            })),
          );
      }
    });
  }

  async runL1Filters(id: string): Promise<unknown> {
    // Use named-arg syntax to match the original Supabase `.rpc()` calling
    // convention (`deal_id_param`), so behavior is identical if the prod
    // function is declared with strict named-only semantics or defaults on
    // other positional parameters.
    //
    // NOTE: this calls into a Postgres stored function that isn't
    // workspace-aware at the SQL level. It's keyed by `id` (a specific
    // company's primary key), so it can't cross into another workspace's
    // data, but it's a known gap for the Story 3 SQL-enforcement pass.
    const result = await this.db.execute<{ run_l1_filters: unknown }>(
      sql`SELECT run_l1_filters(deal_id_param => ${id}) AS run_l1_filters`,
    );
    return result[0]?.run_l1_filters ?? null;
  }

  async findDetails(id: string): Promise<CompanyDetails> {
    const workspaceCompanyIds = this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.workspace_id, this.workspaceId));

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
        .where(and(eq(companyLogs.company_id, id), inArray(companyLogs.company_id, workspaceCompanyIds)))
        .orderBy(asc(companyLogs.created_at)),

      this.db
        .select()
        .from(dealNotes)
        .where(and(eq(dealNotes.deal_id, id), inArray(dealNotes.deal_id, workspaceCompanyIds)))
        .orderBy(desc(dealNotes.created_at)),

      this.db
        .select()
        .from(dealLinks)
        .where(and(eq(dealLinks.deal_id, id), inArray(dealLinks.deal_id, workspaceCompanyIds)))
        .orderBy(desc(dealLinks.created_at)),

      this.db
        .select()
        .from(dealDocuments)
        .where(and(eq(dealDocuments.deal_id, id), inArray(dealDocuments.deal_id, workspaceCompanyIds)))
        .orderBy(desc(dealDocuments.created_at)),

      this.db
        .select({
          screening: screenings,
          criteria_id_inner: criterias.id,
          criteria_name: criterias.name,
          criteria_prompt: criterias.prompt,
          track_id_inner: investmentThesis.id,
          track_title: investmentThesis.title,
        })
        .from(screenings)
        .leftJoin(criterias, eq(criterias.id, screenings.criteria_id))
        .leftJoin(investmentThesis, eq(investmentThesis.id, screenings.track_id))
        .where(and(eq(screenings.company_id, id), inArray(screenings.company_id, workspaceCompanyIds)))
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
          and(
            sql`${files.matched_companies} @> ${JSON.stringify([{ id }])}::jsonb`,
            eq(files.workspace_id, this.workspaceId),
          ),
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
        track:
          r.track_id_inner === null
            ? null
            : { id: r.track_id_inner, title: r.track_title! },
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
