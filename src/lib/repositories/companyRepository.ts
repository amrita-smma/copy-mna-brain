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
  notInArray,
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
   * "Matched Company" combobox in the Smart Files upload form.
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
  /**
   * Restrict to an explicit set of company ids. This is the handoff channel
   * between `query_companies` (which prints the ids) and the artifact builders
   * (Excel / Company Card), so an export covers exactly the rows the user just
   * saw. An empty array matches nothing.
   */
  ids?: string[];
  /** Drop these company ids from the result (used by graph "not connected" filters). */
  excludeIds?: string[];
  entryId?: number;
  watchlistId?: number;
  segment?: string;
  segmentRelatedOfferings?: string;
  geography?: string;
  website?: string;
  watchlistStatus?: string;
  stage?: string;
  /** Match any of several pipeline stages (exact). Combined with OR. */
  stageIn?: string[];
  name?: string;
  /** Partial match against any of the company's stored alternative names. */
  alias?: string;
  ownership?: string;
  companyFocus?: string;
  comments?: string;
  remarks?: string;
  thesisContent?: string;
  promotedReasons?: string;
  source?: "inbound" | "outbound";
  status?: "active" | "dropped";
  dealType?: "majority" | "minority";
  /** Deal sponsor user name (partial, case-insensitive; deal_sponsor is a uuid FK to users). */
  dealSponsor?: string;
  /** Deal captain user name (partial, case-insensitive; deal_captain is a uuid FK to users). */
  dealCaptain?: string;
  /** Entered-by user name (partial, case-insensitive; entered_by is a uuid FK to users). */
  enteredBy?: string;
  /** Dropped-by user name (partial, case-insensitive; dropped_by is a uuid FK to users). */
  droppedBy?: string;
  originator?: string;
  banker?: string;
  bankerSource?: string;
  advisor?: string;
  docType?: string;
  stake?: string;
  dealSize?: string;
  workflowStatus?: string;
  keyRationale?: string;
  droppedReason?: string;
  /**
   * Effective "live process" status, mirroring `isDealLive()`: TRUE/FALSE on
   * `is_live` wins, otherwise the presence of a non-empty advisor decides.
   */
  isLive?: boolean;
  /** Keep only companies that have (true) / lack (false) an NBO due date. */
  hasNboDate?: boolean;
  nboAfter?: string;
  nboBefore?: string;
  /** Keep only companies flagged as a possible duplicate (true) / not flagged (false). */
  hasPossibleDuplicate?: boolean;
  /** Keep only companies manually matched to this investment-thesis (Track) id. */
  matchedTrackId?: string;
  /** When set, keep only companies that have (true) / lack (false) an AI Opinion verdict. */
  hasAiOpinion?: boolean;
  /** Exact AI Opinion verdict (case-insensitive): pass | fail | tentative. */
  aiOpinionVerdict?: "pass" | "fail" | "tentative";
  /** AI Opinion run lifecycle (case-insensitive): processing | completed | failed. */
  aiOpinionStatus?: string;
  /** Partial match against the AI Opinion rationale text. */
  aiOpinionSummary?: string;
  aiOpinionUpdatedAfter?: string;
  aiOpinionUpdatedBefore?: string;
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
  updatedAfter?: string;
  updatedBefore?: string;
  lastActivityAfter?: string;
  lastActivityBefore?: string;
  droppedAfter?: string;
  droppedBefore?: string;
  /** Keep only dropped companies with (true) / without (false) a scheduled resurface. */
  hasResurfaceScheduled?: boolean;
  resurfaceAfter?: string;
  resurfaceBefore?: string;
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
  | "id"
  | "file_name"
  | "file_link"
  | "file_date"
  | "created_at"
  | "file_type"
  | "structured_notes"
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

/**
 * A company the current user personally owns, as returned by
 * {@link CompanyRepository.findOwnedByUser}. The three `is_*` flags say *why*
 * it is theirs — a company can be matched by more than one of them.
 */
export interface UserOwnedCompanyRow {
  id: string;
  target: string | null;
  project_name: string | null;
  pipeline_stage: Tables<"companies">["pipeline_stage"];
  status: Tables<"companies">["status"];
  geography: string | null;
  segment: string | null;
  last_activity_at: string | null;
  updated_at: string | null;
  is_assignee: boolean;
  is_sponsor: boolean;
  is_captain: boolean;
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
    const row = await this.findByIdOrNull(id);
    if (!row) throw new Error(`Company ${id} not found`);
    return row;
  }

  /**
   * Same exact, workspace-scoped lookup as {@link findById} but returns `null`
   * instead of throwing when there's no such row. Callers that treat "not
   * found" as an ordinary outcome (e.g. the agent's `get_company_details`,
   * which reports it back to the model) use this.
   */
  async findByIdOrNull(id: string): Promise<Tables<"companies"> | null> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.workspace_id, this.workspaceId)))
      .limit(1);
    return row ?? null;
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
   * Used by the Smart Files "Matched Company" / "Project Name" pickers —
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

  /**
   * Per-stage headcount, further split by the two columns the dashboard's
   * inbound/outbound rule reads (`source`, falling back to `watchlist_status`).
   *
   * Grouping on all three keeps the bucketing rule itself in the service rather
   * than duplicating it as SQL, while still returning a bounded aggregate —
   * stages x sources x statuses — instead of the whole companies table, which
   * is what the dashboard used to download just to count rows client-side.
   */
  async countByStageAndSource(
    filters: Omit<CompanyFilters, "orderBy" | "orderDir" | "limit"> = {},
  ): Promise<
    Array<{
      stage: string | null;
      source: string | null;
      watchlist_status: string | null;
      count: number;
    }>
  > {
    const where = buildFilterWhere(filters, this.workspaceId);
    const rows = await this.db
      .select({
        stage: companies.pipeline_stage,
        source: companies.source,
        watchlist_status: companies.watchlist_status,
        count: drizzleCount(),
      })
      .from(companies)
      .where(where)
      .groupBy(
        companies.pipeline_stage,
        companies.source,
        companies.watchlist_status,
      );
    return rows.map((r) => ({
      stage: r.stage === null ? null : String(r.stage),
      source: r.source === null ? null : String(r.source),
      watchlist_status: r.watchlist_status ?? null,
      count: Number(r.count),
    }));
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

  /**
   * Display-name columns for a set of companies in one query. Batched
   * counterpart to {@link findById} for callers that would otherwise read one
   * company per id inside a loop (e.g. bulk Company Card regeneration).
   */
  async findIdAndNameByIds(
    ids: string[],
  ): Promise<Array<{ id: string; target: string | null; project_name: string | null }>> {
    if (ids.length === 0) return [];
    return this.db
      .select({ id: companies.id, target: companies.target, project_name: companies.project_name })
      .from(companies)
      .where(and(inArray(companies.id, ids), eq(companies.workspace_id, this.workspaceId)));
  }

  async findAllIdAndTarget(): Promise<
    Array<{ id: string; target: string | null; project_name: string | null }>
  > {
    return this.db
      .select({ id: companies.id, target: companies.target, project_name: companies.project_name })
      .from(companies)
      .where(eq(companies.workspace_id, this.workspaceId));
  }

  /**
   * Every company whose target, project name, or recorded alias equals `name`
   * case-insensitively. Unlike {@link findByNameFuzzy} this is an identity
   * check, not a "did you mean" lookup: it never strips legal suffixes and
   * never substring-matches, so it can be used to answer "does this exact name
   * already belong to a company?" — which is what a rename has to ask before
   * it forks one company into two records. Returns all matches (normally zero
   * or one) so the caller can ignore the row it is renaming.
   */
  async findByExactName(name: string): Promise<Tables<"companies">[]> {
    const lowered = name.trim().toLowerCase();
    if (!lowered) return [];
    return this.db
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspace_id, this.workspaceId),
          or(
            sql`lower(${companies.target}) = ${lowered}`,
            sql`lower(${companies.project_name}) = ${lowered}`,
            sql`exists (select 1 from jsonb_array_elements_text(coalesce(${companies.aliases}, '[]'::jsonb)) as elem(txt) where lower(txt) = ${lowered})`,
          ),
        ),
      )
      .orderBy(asc(companies.id));
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
        .where(and(
          eq(companies.workspace_id, this.workspaceId),
          or(
            sql`lower(${companies.target}) = ${lowered}`,
            sql`lower(${companies.project_name}) = ${lowered}`,
            // Also match a recorded alias exactly (case-insensitive) so a short
            // name absorbed into another company via "combine" still resolves.
            sql`exists (select 1 from jsonb_array_elements_text(coalesce(${companies.aliases}, '[]'::jsonb)) as elem(txt) where lower(txt) = ${lowered})`,
          ),
        ))
        // Prefer a real name match over an alias-only one, and keep the pick
        // stable when several rows tie — an unordered limit(1) is a coin flip.
        .orderBy(
          asc(sql`case when lower(${companies.target}) = ${lowered} or lower(${companies.project_name}) = ${lowered} then 0 else 1 end`),
          asc(companies.id),
        )
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
    const prefixPattern = `${escaped}%`;
    const loweredFull = trimmed.toLowerCase();
    const loweredTerm = term.toLowerCase();
    // A bare `limit(1)` over a substring match is a coin flip whenever one name
    // contains another — "杭州华友" also matches "杭州华友新材料", and Postgres is
    // free to return either. Rank the candidates so the closest name always
    // wins: exact on the full input, then exact on the suffix-stripped base,
    // then a prefix match, then any substring. Shortest name breaks a tie
    // (it's the least-embellished record), and the id makes it total.
    //
    // Aliases are ranked alongside the names, not left in the "everything else"
    // bucket: a company that absorbed "杭州华友" as an alias via "combine" must
    // outrank a leftover stub that merely starts with it, or the combine is
    // undone on the next lookup.
    const aliasMatches = (predicate: SQL) =>
      sql`exists (select 1 from jsonb_array_elements_text(coalesce(${companies.aliases}, '[]'::jsonb)) as elem(txt) where ${predicate})`;
    const matchRank = sql<number>`case
      when lower(${companies.target}) = ${loweredFull}
        or lower(${companies.project_name}) = ${loweredFull}
        or ${aliasMatches(sql`lower(txt) = ${loweredFull}`)} then 0
      when lower(${companies.target}) = ${loweredTerm}
        or lower(${companies.project_name}) = ${loweredTerm}
        or ${aliasMatches(sql`lower(txt) = ${loweredTerm}`)} then 1
      when lower(${companies.target}) like ${prefixPattern} escape '\\'
        or lower(${companies.project_name}) like ${prefixPattern} escape '\\'
        or ${aliasMatches(sql`lower(txt) like ${prefixPattern} escape '\\'`)} then 2
      else 3
    end`;
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(
        eq(companies.workspace_id, this.workspaceId),
        or(
          sql`lower(${companies.target}) like ${pattern} escape '\\'`,
          sql`lower(${companies.project_name}) like ${pattern} escape '\\'`,
          // Also substring-match any recorded alias so a name absorbed into
          // another company via "combine" resolves to that company instead of
          // spawning a fresh `discovered` duplicate.
          sql`exists (select 1 from jsonb_array_elements_text(coalesce(${companies.aliases}, '[]'::jsonb)) as elem(txt) where lower(txt) like ${pattern} escape '\\')`,
        ),
      ))
      .orderBy(
        asc(matchRank),
        asc(sql`coalesce(char_length(${companies.target}), 2147483647)`),
        asc(companies.id),
      )
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

    // An explicit id list is the narrowest possible scope. An EMPTY list means
    // "the caller resolved zero companies", which must match nothing — never
    // silently widen to the whole workspace (and never hand Drizzle an empty
    // inArray, which it cannot compile).
    if (filters.ids) {
      if (filters.ids.length === 0) push(sql`false`);
      else push(inArray(companies.id, filters.ids));
    }
    if (filters.excludeIds && filters.excludeIds.length > 0)
      push(notInArray(companies.id, filters.excludeIds));
    if (filters.entryId !== undefined)
      push(eq(companies.entry_id, filters.entryId));
    if (filters.watchlistId !== undefined)
      push(eq(companies.watchlist_id, filters.watchlistId));
    if (filters.segment) push(ilike(companies.segment, `%${filters.segment}%`));
    if (filters.segmentRelatedOfferings)
      push(
        ilike(
          companies.segment_related_offerings,
          `%${filters.segmentRelatedOfferings}%`,
        ),
      );
    if (filters.geography)
      push(ilike(companies.geography, `%${filters.geography}%`));
    if (filters.website) push(ilike(companies.website, `%${filters.website}%`));
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
    if (filters.alias) {
      // aliases is a jsonb string array — unnest it and match any element.
      const term = `%${filters.alias.toLowerCase()}%`;
      push(
        sql`exists (select 1 from jsonb_array_elements_text(coalesce(${companies.aliases}, '[]'::jsonb)) as alias_elem(txt) where lower(txt) like ${term})`,
      );
    }
    if (filters.ownership)
      push(ilike(companies.ownership, `%${filters.ownership}%`));
    if (filters.companyFocus)
      push(ilike(companies.company_focus, `%${filters.companyFocus}%`));
    if (filters.comments)
      push(ilike(companies.comments, `%${filters.comments}%`));
    if (filters.remarks) push(ilike(companies.remarks, `%${filters.remarks}%`));
    if (filters.thesisContent)
      push(ilike(companies.thesis_content, `%${filters.thesisContent}%`));
    if (filters.promotedReasons)
      push(ilike(companies.promoted_reasons, `%${filters.promotedReasons}%`));
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
    if (filters.dealCaptain)
      push(
        inArray(
          companies.deal_captain,
          this.db
            .select({ id: users.id })
            .from(users)
            .where(ilike(users.name, `%${filters.dealCaptain}%`)),
        ),
      );
    if (filters.enteredBy)
      push(
        inArray(
          companies.entered_by,
          this.db
            .select({ id: users.id })
            .from(users)
            .where(ilike(users.name, `%${filters.enteredBy}%`)),
        ),
      );
    if (filters.droppedBy)
      push(
        inArray(
          companies.dropped_by,
          this.db
            .select({ id: users.id })
            .from(users)
            .where(ilike(users.name, `%${filters.droppedBy}%`)),
        ),
      );
    if (filters.originator)
      push(ilike(companies.originator, `%${filters.originator}%`));
    if (filters.banker) push(ilike(companies.banker, `%${filters.banker}%`));
    if (filters.bankerSource)
      push(ilike(companies.banker_source, `%${filters.bankerSource}%`));
    if (filters.advisor) push(ilike(companies.advisor, `%${filters.advisor}%`));
    if (filters.docType) push(ilike(companies.doc_type, `%${filters.docType}%`));
    if (filters.stake) push(ilike(companies.stake, `%${filters.stake}%`));
    if (filters.dealSize)
      push(ilike(companies.deal_size, `%${filters.dealSize}%`));
    if (filters.workflowStatus)
      push(ilike(companies.workflow_status, `%${filters.workflowStatus}%`));
    if (filters.keyRationale)
      push(ilike(companies.key_rationale, `%${filters.keyRationale}%`));
    if (filters.droppedReason)
      push(ilike(companies.dropped_reason, `%${filters.droppedReason}%`));

    // "Live process" mirrors isDealLive(): the is_live override wins when set,
    // otherwise a non-empty advisor makes the deal live.
    const hasAdvisor = sql`${companies.advisor} is not null and btrim(${companies.advisor}) <> ''`;
    if (filters.isLive === true)
      push(
        sql`(${companies.is_live} = true or (${companies.is_live} is null and ${hasAdvisor}))`,
      );
    if (filters.isLive === false)
      push(
        sql`(${companies.is_live} = false or (${companies.is_live} is null and not (${hasAdvisor})))`,
      );

    if (filters.hasNboDate === true) push(isNotNull(companies.nbo_date));
    if (filters.hasNboDate === false) push(isNull(companies.nbo_date));
    if (filters.nboAfter) push(gte(companies.nbo_date, filters.nboAfter));
    if (filters.nboBefore) push(lte(companies.nbo_date, filters.nboBefore));

    if (filters.hasPossibleDuplicate === true)
      push(isNotNull(companies.possible_duplicate_company_id));
    if (filters.hasPossibleDuplicate === false)
      push(isNull(companies.possible_duplicate_company_id));
    if (filters.matchedTrackId)
      push(
        sql`coalesce(${companies.matched_track_ids}, '[]'::jsonb) @> ${JSON.stringify([filters.matchedTrackId])}::jsonb`,
      );

    if (filters.hasAiOpinion === true)
      push(isNotNull(companies.ai_opinion_verdict));
    if (filters.hasAiOpinion === false)
      push(isNull(companies.ai_opinion_verdict));
    if (filters.aiOpinionVerdict)
      push(
        sql`lower(${companies.ai_opinion_verdict}) = ${filters.aiOpinionVerdict.toLowerCase()}`,
      );
    if (filters.aiOpinionStatus)
      push(
        sql`lower(${companies.ai_opinion_status}) = ${filters.aiOpinionStatus.toLowerCase()}`,
      );
    if (filters.aiOpinionSummary)
      push(ilike(companies.ai_opinion_summary, `%${filters.aiOpinionSummary}%`));
    if (filters.aiOpinionUpdatedAfter)
      push(
        gte(companies.ai_opinion_updated_at, filters.aiOpinionUpdatedAfter),
      );
    if (filters.aiOpinionUpdatedBefore)
      push(
        lte(companies.ai_opinion_updated_at, filters.aiOpinionUpdatedBefore),
      );

    if (filters.createdAfter)
      push(gte(companies.created_at, filters.createdAfter));
    if (filters.createdBefore)
      push(lte(companies.created_at, filters.createdBefore));
    if (filters.updatedAfter)
      push(gte(companies.updated_at, filters.updatedAfter));
    if (filters.updatedBefore)
      push(lte(companies.updated_at, filters.updatedBefore));
    if (filters.lastActivityAfter)
      push(gte(companies.last_activity_at, filters.lastActivityAfter));
    if (filters.lastActivityBefore)
      push(lte(companies.last_activity_at, filters.lastActivityBefore));
    if (filters.droppedAfter)
      push(gte(companies.dropped_at, filters.droppedAfter));
    if (filters.droppedBefore)
      push(lte(companies.dropped_at, filters.droppedBefore));
    if (filters.hasResurfaceScheduled === true)
      push(isNotNull(companies.resurface_at));
    if (filters.hasResurfaceScheduled === false)
      push(isNull(companies.resurface_at));
    if (filters.resurfaceAfter)
      push(gte(companies.resurface_at, filters.resurfaceAfter));
    if (filters.resurfaceBefore)
      push(lte(companies.resurface_at, filters.resurfaceBefore));

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
    // `discovered` rows are auto-created relationship-graph stubs that sit
    // outside the L0–L5 origination funnel, so the agent search defaults to
    // excluding them unless explicitly requested. An explicit id list opts out:
    // the caller already chose those exact rows, so second-guessing the stage
    // would silently drop companies the user asked for by id.
    if (
      !filters.ids &&
      filters.stage !== "discovered" &&
      !filters.stageIn?.includes("discovered")
    ) {
      conditions.push(ne(companies.pipeline_stage, "discovered" as DealStage));
    }
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
    // unless explicitly requested (or unless the caller pinned an exact id set,
    // e.g. an Excel export of rows query_companies already returned).
    if (
      !filters.ids &&
      filters.stage !== "discovered" &&
      !filters.stageIn?.includes("discovered")
    ) {
      conditions.push(ne(companies.pipeline_stage, "discovered" as DealStage));
    }
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

  /**
   * Atomically flips `ai_opinion_status` to 'failed' only if it is still
   * 'processing'. A single conditional UPDATE avoids the read-then-write gap
   * a `findById` + `update` pair would have against a concurrent tool write.
   */
  async markAiOpinionFailedIfProcessing(id: string): Promise<void> {
    const rows = await this.db
      .update(companies)
      .set({ ai_opinion_status: "failed" })
      .where(
        and(
          eq(companies.id, id),
          eq(companies.workspace_id, this.workspaceId),
          eq(companies.ai_opinion_status, "processing"),
        ),
      )
      .returning();
    await this.mirrorUpsert(rows);
  }

  /**
   * Persist a completed AI Opinion only while the company is still
   * `processing`. Prevents a cancelled/superseded workforce run from
   * resurrecting a verdict after `markAiOpinionFailedIfProcessing` (or a
   * newer dispatch) has already moved the row on.
   */
  async completeAiOpinionIfProcessing(
    id: string,
    updates: TablesUpdate<"companies">,
  ): Promise<Tables<"companies"> | undefined> {
    const rows = await this.db
      .update(companies)
      .set(updates)
      .where(
        and(
          eq(companies.id, id),
          eq(companies.workspace_id, this.workspaceId),
          eq(companies.ai_opinion_status, "processing"),
        ),
      )
      .returning();
    await this.mirrorUpsert(rows);
    return rows[0];
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

  /**
   * The subset of `ids` that exist in this workspace. A single batched query —
   * used to keep cross-store results (e.g. the Neo4j relationship graph, whose
   * nodes carry no workspace_id) scoped to the caller's own companies.
   */
  async findExistingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(inArray(companies.id, ids), eq(companies.workspace_id, this.workspaceId)),
      );
    return rows.map((r) => r.id);
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(companies)
      .where(and(eq(companies.id, id), eq(companies.workspace_id, this.workspaceId)));
    await this.mirrorDelete(id);
  }

  /**
   * The active companies this user personally owns in this workspace — they
   * are an explicit assignee, the Deal Sponsor, or the Deal Captain. Backs the
   * mobile profile page's "my companies" cards.
   *
   * One query, not three: the assignee membership comes from a LEFT JOIN
   * pre-filtered to this user (so the join cannot fan a company out into
   * several rows) and the two column roles are plain predicates. `relation`
   * flags come back on the row, so the caller never re-queries per company.
   *
   * Ordered newest-touched first (`last_activity_at`, falling back to
   * `updated_at`), with `id` breaking ties so the order is stable.
   */
  async findOwnedByUser(
    userId: string,
    limit = 20,
  ): Promise<UserOwnedCompanyRow[]> {
    return this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        status: companies.status,
        geography: companies.geography,
        segment: companies.segment,
        last_activity_at: companies.last_activity_at,
        updated_at: companies.updated_at,
        is_assignee: sql<boolean>`${companyAssignees.user_id} IS NOT NULL`,
        is_sponsor: sql<boolean>`${companies.deal_sponsor} = ${userId}`,
        is_captain: sql<boolean>`${companies.deal_captain} = ${userId}`,
      })
      .from(companies)
      .leftJoin(
        companyAssignees,
        and(
          eq(companyAssignees.company_id, companies.id),
          eq(companyAssignees.user_id, userId),
        ),
      )
      .where(this.ownedByUserWhere(userId))
      .orderBy(
        desc(sql`COALESCE(${companies.last_activity_at}, ${companies.updated_at})`),
        asc(companies.id),
      )
      .limit(limit);
  }

  /** How many companies {@link findOwnedByUser} matches, for the "+N more" tail. */
  async countOwnedByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: drizzleCount() })
      .from(companies)
      .leftJoin(
        companyAssignees,
        and(
          eq(companyAssignees.company_id, companies.id),
          eq(companyAssignees.user_id, userId),
        ),
      )
      .where(this.ownedByUserWhere(userId));
    return Number(row?.total ?? 0);
  }

  /** Shared by the page and its count so the two can never disagree. */
  private ownedByUserWhere(userId: string): SQL | undefined {
    return and(
      eq(companies.workspace_id, this.workspaceId),
      eq(companies.status, "active"),
      or(
        isNotNull(companyAssignees.user_id),
        eq(companies.deal_sponsor, userId),
        eq(companies.deal_captain, userId),
      ),
    );
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
    return (result as unknown as { rows: Array<{ run_l1_filters: unknown }> }).rows[0]?.run_l1_filters ?? null;
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
          file_type: files.file_type,
          structured_notes: files.structured_notes,
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
