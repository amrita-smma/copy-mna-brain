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
   * Case-insensitive ILIKE filter against `companies.target`. The substring
   * is matched anywhere — used by the lightweight lookup endpoint that
   * powers the "Matched Company" combobox in the AI File Dump upload form.
   */
  targetSearch?: string;
}

/** Filters used by AI-agent tool calls (queryCompanies in src/lib/agents/analysis/tools/query_companies.ts). */
export interface CompanyAgentFilters {
  segment?: string;
  geography?: string;
  watchlistStatus?: string;
  stage?: string;
  name?: string;
  ownership?: string;
  companyFocus?: string;
  source?: "inbound" | "outbound";
  status?: "active" | "dropped";
  minRevenue?: number;
  maxRevenue?: number;
  minEbitda?: number;
  maxEbitda?: number;
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
    conditions.push(ne(companies.status, "dropped"));
  }
  if (filters.createdAfter)
    conditions.push(gte(companies.created_at, filters.createdAfter));
  if (filters.targetSearch && filters.targetSearch.trim().length > 0) {
    conditions.push(ilike(companies.target, `%${filters.targetSearch.trim()}%`));
  }
  if (conditions.length === 0) return undefined;
  return and(...conditions);
}

export class CompanyRepository {
  /**
   * @param db    Postgres client — the source of truth.
   * @param graph Optional Neo4j mirror. When wired (by the container), every
   *   company write is reflected onto the graph so Neo4j follows Postgres:
   *   inserts/updates upsert the node, deletes remove it. Graph failures are
   *   best-effort and never fail the Postgres write. Left undefined in unit
   *   tests and in contexts without a graph backend (e.g. job handlers).
   */
  constructor(
    private readonly db: DbClient,
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
      .where(eq(companies.id, id))
      .limit(1);
    if (!row) throw new Error(`Company ${id} not found`);
    return row;
  }

  async findAll(filters: CompanyFilters = {}): Promise<Tables<"companies">[]> {
    const { orderBy = "updated_at", orderDir = "desc", limit, offset } = filters;
    const where = buildFilterWhere(filters);
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
      .from(companies);
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
      .from(companies);
  }

  async findByNameFuzzy(namePart: string): Promise<Tables<"companies"> | null> {
    const trimmed = namePart.trim();
    // Floor at 5 chars to avoid short acronyms (e.g. "ENJ", "SEB") spuriously
    // substring-matching unrelated companies. Callers that pass a short name
    // get null and store free text rather than a wrong link.
    if (trimmed.length < 5) return null;
    // Strip legal/entity suffixes (Ltd., Co., Inc., PT, Tbk, ...) so a new
    // "Acme Ltd." matches an existing "Acme Co." — same base name, different
    // ending. Substring-match on the base then catches it in either direction.
    // Fall back to the full name if stripping leaves too little to match on.
    const base = stripCompanySuffix(trimmed);
    const term = base.length >= 3 ? base : trimmed;
    const [row] = await this.db
      .select()
      .from(companies)
      .where(or(
        ilike(companies.target, `%${term}%`),
        ilike(companies.project_name, `%${term}%`),
      ))
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
    if (filters.stage) {
      conditions.push(eq(companies.pipeline_stage, filters.stage as DealStage));
    }
    if (filters.name) {
      const term = `%${filters.name}%`;
      conditions.push(
        or(ilike(companies.target, term), ilike(companies.project_name, term)),
      );
    }
    if (filters.ownership) {
      conditions.push(ilike(companies.ownership, `%${filters.ownership}%`));
    }
    if (filters.companyFocus) {
      conditions.push(
        ilike(companies.company_focus, `%${filters.companyFocus}%`),
      );
    }
    if (filters.source) {
      conditions.push(eq(companies.source, filters.source));
    }
    if (filters.status) {
      conditions.push(eq(companies.status, filters.status));
    }
    // Revenue/EBITDA filters apply against fiscal_year 2024 rows in company_financials.
    const needsFinancialsJoin =
      filters.minRevenue !== undefined ||
      filters.maxRevenue !== undefined ||
      filters.minEbitda !== undefined ||
      filters.maxEbitda !== undefined;
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
    if (filters.maxEbitda !== undefined) {
      conditions.push(lte(companyFinancials.ebitda_usd_mn, filters.maxEbitda));
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
    await this.mirrorUpsert([row]);
    return row;
  }

  async insertMany(list: TablesInsert<"companies">[]): Promise<void> {
    if (list.length === 0) return;
    const rows = await this.db.insert(companies).values(list).returning();
    await this.mirrorUpsert(rows);
  }

  async update(
    id: string,
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies">[]> {
    const rows = await this.db
      .update(companies)
      .set(updates)
      .where(eq(companies.id, id))
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
      .where(inArray(companies.id, ids))
      .returning();
    await this.mirrorUpsert(rows);
    return rows;
  }

  async countUnreviewed(source?: string): Promise<number> {
    const conditions = [eq(companies.review_state, 'unreviewed'), eq(companies.status, 'active')];
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
      .where(and(inArray(companies.id, ids), eq(companies.status, "dropped")));
    return rows.map((r) => r.id);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(companies).where(eq(companies.id, id));
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
          track_id_inner: investmentThesis.id,
          track_title: investmentThesis.title,
        })
        .from(screenings)
        .leftJoin(criterias, eq(criterias.id, screenings.criteria_id))
        .leftJoin(investmentThesis, eq(investmentThesis.id, screenings.track_id))
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
