import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  correspondentCuration,
  correspondentWorkspaceEffective,
  correspondents,
  emailParticipants,
  emails,
  employers,
  employerCuration,
  employerDomains,
  employerEffective,
  employerNotes,
  employerWorkspaceEffective,
  employerRelatedCompanies,
  employerTeamMembers,
  employerTopics,
  users,
  workspaceCorrespondents,
} from "@/lib/db/schema";
import type { DbClient } from "./types";
import { escapeLikePattern } from "./insightRepository";
import type { EmployerListSort, SortDirection } from "@/lib/crm/employerListSort";

// Read from the effective views, which leave out the classifier's bookkeeping.
export type Employer = Omit<typeof employers.$inferSelect, "industry_classified_at">;
export type EmployerInsert = typeof employers.$inferInsert;
export type EmployerUpdate = Partial<EmployerInsert>;

export interface EmployerListFilters {
  search?: string;
  status?: "inbound" | "outbound";
  curationStatus?: "published" | "flagged";
  /** Restrict to employers whose latest email is on/after this ISO timestamp. */
  lastContactAfter?: string;
  /**
   * Restrict to employers whose latest email is strictly before this ISO
   * timestamp — or who have no emails at all (treating `created_at` as a
   * fallback). Mirrors `countStaleEmployers` so the "More than N days" filter
   * lines up with the insights bar count.
   */
  lastContactBefore?: string;
  /** Topic ids (any-match). */
  topicIds?: string[];
  /** Team member user ids (any-match). */
  teamUserIds?: string[];
  /** Sort column; defaults to last contact. Rows without a value always sort last. */
  sort?: EmployerListSort;
  /** Defaults to `desc` (latest contact first). */
  sortDir?: SortDirection;
  limit?: number;
  offset?: number;
}

/**
 * One row per employer card on the CRM page. Aggregates the bits the list view
 * needs (primary PIC, last-contact, email count) so it can render without a
 * second round-trip per card.
 */
export interface EmployerSummary {
  id: string;
  name: string;
  normalized_name: string;
  industry: string | null;
  status: string;
  curation_status: string;
  source: "auto" | "manual";
  created_at: string;
  updated_at: string;
  primary_pic: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  email_count: number;
  last_contact_at: string | null;
  // Median time (seconds) between an inbound email from this firm and our next
  // outbound reply (paired via in_reply_to, gaps capped at 30 days). Null when
  // there are no answered exchanges. `response_pair_count` is the sample size
  // behind the median, so the UI can hide/qualify low-confidence values.
  response_p50_seconds: number | null;
  response_pair_count: number;
  topics: Array<{
    id: string;
    name: string;
    source: string;
    is_highlight: boolean;
  }>;
  /**
   * Set only when the list was searched: the firm's visible contacts whose
   * name or email matched (`CorrespondentRepository.searchInEmployers`). Empty
   * when the firm matched on its own name/domain, which means "show everyone".
   */
  matched_contacts?: MatchedContact[];
  team: Array<{ id: string; name: string; email: string | null }>;
}

/** A contact that matched a CRM list search, as shown on the firm's row. */
export interface MatchedContact {
  id: string;
  employer_id: string;
  name: string;
  title: string | null;
  email: string | null;
}

/**
 * One column of the employer's `analytics.mart_crm` row for this workspace.
 * `list` LEFT JOINs mart_crm once on (employer_id, workspace_id) — its unique
 * key, so the join cannot fan out rows — instead of a correlated lookup per
 * column per row. Hard-coded "table"."column" text because the
 * `select({...})` shorthand strips table qualifiers from column references
 * inside the select clause (see `list`).
 */
function martCrmColumn<T = unknown>(column: string): SQL<T> {
  return sql<T>`"mart_crm".${sql.identifier(column)}`;
}

/**
 * The employer's name / industry as this workspace curated it, else the
 * ingested value. Curation is per workspace (MB-687); `list` LEFT JOINs this
 * workspace's employer_curation row on its primary key (workspace_id,
 * employer_id).
 */
function curatedColumn<T = unknown>(column: "name" | "industry"): SQL<T> {
  return sql<T>`COALESCE("employer_curation".${sql.identifier(column)}, "employers".${sql.identifier(column)})`;
}

/**
 * The columns of `Employer`, read from `employer_workspace_effective` so a
 * single-firm read carries this workspace's edits. Selected explicitly to keep
 * the view's workspace_id / primary_correspondent_id off the `Employer` shape.
 */
const workspaceEmployerColumns = {
  id: employerWorkspaceEffective.id,
  name: employerWorkspaceEffective.name,
  normalized_name: employerWorkspaceEffective.normalized_name,
  industry: employerWorkspaceEffective.industry,
  status: employerWorkspaceEffective.status,
  curation_status: employerWorkspaceEffective.curation_status,
  created_at: employerWorkspaceEffective.created_at,
  updated_at: employerWorkspaceEffective.updated_at,
};

/** One firm as the industry classifier sees it. */
export interface FirmIndustryEvidence {
  id: string;
  name: string;
  domains: string[];
  contacts: Array<{ title: string | null; specialization: string | null; bio: string | null }>;
}

export class EmployerRepository {
  constructor(private db: DbClient) {}

  /**
   * Ids of every employer this workspace has a relationship with. One
   * uncorrelated UNION — each branch is an index scan keyed by workspace_id,
   * hashed once by the planner — rather than four correlated EXISTS probes
   * per employer row, which scaled with the shared employers table instead of
   * this workspace's own CRM.
   */
  private visibleEmployerIds(workspaceId: string): SQL {
    return sql`
      SELECT ${correspondents.employer_id} FROM ${correspondents}
      JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondents.id}
      WHERE ${workspaceCorrespondents.workspace_id} = ${workspaceId}
      UNION
      SELECT ${employerRelatedCompanies.employer_id} FROM ${employerRelatedCompanies}
      WHERE ${employerRelatedCompanies.workspace_id} = ${workspaceId}
        AND ${employerRelatedCompanies.dismissed_at} IS NULL
      UNION
      SELECT ${employerNotes.employer_id} FROM ${employerNotes}
      WHERE ${employerNotes.workspace_id} = ${workspaceId}
        AND ${employerNotes.deleted_at} IS NULL
      UNION
      SELECT ${employerTopics.employer_id} FROM ${employerTopics}
      WHERE ${employerTopics.workspace_id} = ${workspaceId}`;
  }

  /**
   * Ids of employers matching the (already escaped) substring pattern: the
   * firm name, this workspace's curated name, a domain, or a person this
   * workspace can see by their overlay-aware name or email.
   *
   * Each branch is served by a trigram GIN index
   * (20261029000001_crm_search_trigram_indexes.sql), so a search costs index
   * lookups, not a scan of every firm and contact. The person branch finds
   * candidates through the indexed base columns (correspondents.name/email,
   * correspondent_curation.name) and then re-checks the workspace view, so it
   * matches exactly what the card shows: never a contact this workspace
   * cannot see, never a stale ingested name this workspace renamed.
   */
  private searchMatchIds(pattern: string, workspaceId: string): SQL {
    return sql`
      SELECT ${employers.id} FROM ${employers} WHERE ${employers.name} ILIKE ${pattern}
      UNION
      SELECT ${employerCuration.employer_id} FROM ${employerCuration}
      WHERE ${employerCuration.workspace_id} = ${workspaceId}
        AND ${employerCuration.name} ILIKE ${pattern}
      UNION
      SELECT ${employerDomains.employer_id} FROM ${employerDomains} WHERE ${employerDomains.domain} ILIKE ${pattern}
      UNION
      SELECT ${correspondentWorkspaceEffective.employer_id} FROM ${correspondentWorkspaceEffective}
      WHERE ${correspondentWorkspaceEffective.workspace_id} = ${workspaceId}
        AND ${correspondentWorkspaceEffective.id} IN (
          SELECT ${correspondents.id} FROM ${correspondents}
          WHERE ${correspondents.name} ILIKE ${pattern} OR ${correspondents.email} ILIKE ${pattern}
          UNION
          SELECT ${correspondentCuration.correspondent_id} FROM ${correspondentCuration}
          WHERE ${correspondentCuration.workspace_id} = ${workspaceId}
            AND ${correspondentCuration.name} ILIKE ${pattern}
        )
        AND (${correspondentWorkspaceEffective.name} ILIKE ${pattern} OR ${correspondentWorkspaceEffective.email} ILIKE ${pattern})`;
  }

  private buildWhere(
    filters: EmployerListFilters,
    workspaceId: string,
  ): SQL | undefined {
    const searchPattern = filters.search
      ? `%${escapeLikePattern(filters.search)}%`
      : null;
    return and(
      eq(employers.curation_status, filters.curationStatus ?? "published"),
      // Workspace visibility: an employer shows up if this workspace has any
      // relationship with it — a visible correspondent, a related-company
      // link, a note, or a private topic. Employer identity itself stays
      // shared/unscoped — this only gates which shared employers appear in
      // this workspace's CRM list. All four workspace-scoped CRM surfaces
      // this PR introduced must be listed here, or a workspace that has only
      // written one of them (e.g. a note, with no correspondent) can never
      // find that employer again via the normal list view.
      //
      // The correspondent/related-company branches mirror
      // CorrespondentRepository.visibleCorrespondentIds /
      // EmployerRelatedCompanyRepository.listForEmployer: workspace
      // membership alone, with no `user_workspaces.is_email_synced` gate on
      // the mailbox-sync-derived rows (`source='ingest'` for correspondents,
      // `'auto'` for related-companies). That gate used to hide already-
      // ingested CRM data the moment the workspace's last synced member
      // toggled sync off; sync now only governs which mailboxes the pipeline
      // pulls from. Keep this branch list in step with those two reads so
      // the list and the detail card never disagree.
      sql`${employers.id} IN (${this.visibleEmployerIds(workspaceId)})`,
      filters.status ? eq(employers.status, filters.status) : undefined,
      searchPattern
        ? sql`${employers.id} IN (${this.searchMatchIds(searchPattern, workspaceId)})`
        : undefined,
      filters.lastContactAfter
        ? sql`EXISTS (
            SELECT 1 FROM ${emailParticipants}
            JOIN ${correspondents} ON ${correspondents.id} = ${emailParticipants.correspondent_id}
            JOIN ${emails}          ON ${emails.id}          = ${emailParticipants.email_id}
            WHERE ${correspondents.employer_id} = ${employers.id}
              AND ${emails.sent_at} >= ${filters.lastContactAfter}
          )`
        : undefined,
      filters.lastContactBefore
        ? sql`COALESCE(
            (SELECT MAX(${emails.sent_at})
             FROM ${emailParticipants}
             JOIN ${correspondents} ON ${correspondents.id} = ${emailParticipants.correspondent_id}
             JOIN ${emails}         ON ${emails.id}         = ${emailParticipants.email_id}
             WHERE ${correspondents.employer_id} = ${employers.id}),
            ${employers.created_at}
          ) < ${filters.lastContactBefore}`
        : undefined,
      filters.topicIds && filters.topicIds.length > 0
        ? sql`EXISTS (SELECT 1 FROM ${employerTopics} WHERE ${employerTopics.employer_id} = ${employers.id} AND ${employerTopics.workspace_id} = ${workspaceId} AND ${inArray(employerTopics.topic_id, filters.topicIds)})`
        : undefined,
      filters.teamUserIds && filters.teamUserIds.length > 0
        ? sql`EXISTS (SELECT 1 FROM ${employerTeamMembers} WHERE ${employerTeamMembers.employer_id} = ${employers.id} AND ${employerTeamMembers.workspace_id} = ${workspaceId} AND ${inArray(employerTeamMembers.user_id, filters.teamUserIds)})`
        : undefined,
    );
  }

  /**
   * Leading ORDER BY term for `list`. Each key sorts on the same expression
   * its column displays (mart-sourced KPIs, curated name/industry), so the
   * order agrees with what the row shows. Whitelisted: an unknown key falls
   * back to last contact, and the direction is only ever ASC or DESC.
   * NULLS LAST in both directions — firms never contacted stay at the bottom.
   */
  private orderByFor(filters: EmployerListFilters, workspaceId: string): SQL {
    const expressions: Record<EmployerListSort, SQL> = {
      name: sql`LOWER(${curatedColumn("name")})`,
      industry: sql`LOWER(NULLIF(${curatedColumn("industry")}, ''))`,
      // Same pick as the primary_pic select: this workspace's chosen PIC,
      // else the oldest correspondent it can see.
      primary_pic: sql`(
        SELECT LOWER("cwe"."name")
        FROM "correspondent_workspace_effective" "cwe"
        WHERE "cwe"."employer_id" = "employers"."id"
          AND "cwe"."workspace_id" = ${workspaceId}
        ORDER BY "cwe"."is_primary" DESC, "cwe"."created_at" ASC, "cwe"."id" ASC
        LIMIT 1
      )`,
      response_p50: martCrmColumn("response_p50_seconds"),
      last_contact: martCrmColumn("last_contact_at"),
      emails: sql`COALESCE(${martCrmColumn("email_count")}, 0)`,
      team_members: sql`(
        SELECT COUNT(*)
        FROM "employer_team_members"
        WHERE "employer_team_members"."employer_id" = "employers"."id"
          AND "employer_team_members"."workspace_id" = ${workspaceId}
      )`,
    };
    const expression = expressions[filters.sort ?? "last_contact"] ?? expressions.last_contact;
    const direction = filters.sortDir === "asc" ? sql`ASC` : sql`DESC`;
    return sql`${expression} ${direction} NULLS LAST`;
  }

  async list(
    filters: EmployerListFilters = {},
    workspaceId: string,
  ): Promise<EmployerSummary[]> {
    // NOTE: Drizzle's `select({ key: tableObject, ... })` shorthand strips
    // table qualifiers from every column reference inside the select clause —
    // including those nested in `sql\`\`` correlated subqueries. That makes
    // bare `"id"` ambiguous between employers/emails/correspondents. Workaround:
    // hard-code "table"."column" inside these select-clause subqueries. The
    // WHERE / ORDER BY clauses below do qualify correctly, so ${col} works there.
    const rows = await this.db
      .select({
        id: employers.id,
        // Effective (overlay-aware) name/industry — this workspace's
        // override (LEFT JOINed below) wins.
        name: curatedColumn<string>("name"),
        normalized_name: employers.normalized_name,
        industry: curatedColumn<string | null>("industry"),
        status: employers.status,
        curation_status: employers.curation_status,
        created_at: employers.created_at,
        updated_at: employers.updated_at,
        // KPIs are served from the precomputed analytics.mart_crm (RFC MB-205
        // §Phase 5b) rather than recomputed per request — chiefly the
        // response_p50 percentile, which is an O(emails) LATERAL self-join.
        // mart_crm is keyed by (workspace_id, employer_id) — see
        // 20260705000004_workspace_scoped_marts.sql — and the LEFT JOIN below
        // matches on both, so a shared employer's numbers never sum across
        // every workspace's activity.
        // CAVEAT: mart_crm groups email_count/last_contact by
        // correspondents.employer_id, so it only stays correct while ingest
        // is the sole writer of those links. If a future UI feature
        // reassigns an already-emailed contact to another firm, refresh the
        // mart on that write (or keep these two columns live).
        email_count: sql<number>`COALESCE(${martCrmColumn("email_count")}, 0)`,
        last_contact_at: martCrmColumn<string | null>("last_contact_at"),
        response_p50_seconds: martCrmColumn<number | null>("response_p50_seconds"),
        response_pair_count: sql<number>`COALESCE(${martCrmColumn("response_pair_count")}, 0)`,
        // Scoped to correspondents THIS workspace can see — the rows of
        // correspondent_workspace_effective — with this workspace's profile
        // edits applied. The workspace's chosen PIC (`is_primary`, from
        // employer_curation.primary_correspondent_id) wins; otherwise the
        // oldest visible one. Same rule as CorrespondentRepository's
        // findByEmployerId, so the list and the detail card agree.
        primary_pic: sql<EmployerSummary["primary_pic"]>`(
          SELECT jsonb_build_object(
            'id', "cwe"."id",
            'name', "cwe"."name",
            'title', "cwe"."title",
            'email', "cwe"."email",
            'phone', "cwe"."phone"
          )
          FROM "correspondent_workspace_effective" "cwe"
          WHERE "cwe"."employer_id" = "employers"."id"
            AND "cwe"."workspace_id" = ${workspaceId}
          ORDER BY "cwe"."is_primary" DESC, "cwe"."created_at" ASC, "cwe"."id" ASC
          LIMIT 1
        )`,
        topics: sql<EmployerSummary["topics"]>`COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', "topics"."id",
            'name', "topics"."name",
            'source', "employer_topics"."source",
            'is_highlight', "employer_topics"."is_highlight"
          ) ORDER BY "employer_topics"."is_highlight" DESC, "employer_topics"."source" ASC, "topics"."name" ASC)
          FROM "employer_topics"
          JOIN "topics" ON "topics"."id" = "employer_topics"."topic_id"
          WHERE "employer_topics"."employer_id" = "employers"."id"
            AND "employer_topics"."workspace_id" = ${workspaceId}
            AND ("topics"."workspace_id" IS NULL OR "topics"."workspace_id" = ${workspaceId})
        ), '[]'::jsonb)`,
        team: sql<EmployerSummary["team"]>`COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', "users"."id",
            'name', "users"."name",
            'email', "users"."email"
          ) ORDER BY "users"."name" ASC)
          FROM "employer_team_members"
          JOIN "users" ON "users"."id" = "employer_team_members"."user_id"
          WHERE "employer_team_members"."employer_id" = "employers"."id"
            AND "employer_team_members"."workspace_id" = ${workspaceId}
        ), '[]'::jsonb)`,
        // Auto vs manual is decided by the FIRST correspondent ever registered
        // for this employer — if it came from the mbox ingest the employer is
        // auto; otherwise (UI-created, future API source, etc.) it's manual.
        // We lock in based on origin instead of "has emails right now" so the
        // badge doesn't flip when revert/re-ingest temporarily empties data.
        // Scoped to correspondents visible to this workspace — the first
        // correspondent visible to THIS workspace, not the globally-first one
        // (which may belong to a custodian this workspace can't see).
        source: sql<"auto" | "manual">`CASE
          WHEN (
            SELECT "correspondents"."source"
            FROM "correspondents"
            JOIN "workspace_correspondents"
              ON "workspace_correspondents"."correspondent_id" = "correspondents"."id"
              AND "workspace_correspondents"."workspace_id" = ${workspaceId}
            WHERE "correspondents"."employer_id" = "employers"."id"
            ORDER BY "correspondents"."created_at" ASC, "correspondents"."id" ASC
            LIMIT 1
          ) = 'mbox' THEN 'auto'::text ELSE 'manual'::text END`,
      })
      .from(employers)
      .leftJoin(
        employerCuration,
        and(
          eq(employerCuration.employer_id, employers.id),
          eq(employerCuration.workspace_id, workspaceId),
        ),
      )
      .leftJoin(
        sql`"analytics"."mart_crm"`,
        sql`"mart_crm"."employer_id" = ${employers.id} AND "mart_crm"."workspace_id" = ${workspaceId}`,
      )
      .where(this.buildWhere(filters, workspaceId))
      .orderBy(
        this.orderByFor(filters, workspaceId),
        asc(employers.name),
        asc(employers.id),
      )
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      normalized_name: r.normalized_name,
      industry: r.industry,
      status: r.status,
      curation_status: r.curation_status,
      source: r.source,
      created_at: r.created_at,
      updated_at: r.updated_at,
      primary_pic: r.primary_pic ?? null,
      email_count: Number(r.email_count ?? 0),
      last_contact_at: r.last_contact_at ?? null,
      response_p50_seconds:
        r.response_p50_seconds == null ? null : Number(r.response_p50_seconds),
      response_pair_count: Number(r.response_pair_count ?? 0),
      topics: r.topics ?? [],
      team: r.team ?? [],
    }));
  }

  async count(
    filters: EmployerListFilters = {},
    workspaceId: string,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(this.buildWhere(filters, workspaceId));
    return Number(rows[0]?.n ?? 0);
  }

  // Reads a user sees go through the workspace view so this workspace's
  // overlay wins (RFC §3, per workspace since MB-687).
  async findById(id: string, workspaceId: string): Promise<Employer | undefined> {
    const rows = await this.db
      .select(workspaceEmployerColumns)
      .from(employerWorkspaceEffective)
      .where(
        and(
          eq(employerWorkspaceEffective.id, id),
          eq(employerWorkspaceEffective.workspace_id, workspaceId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  // Matching by the machine key: the shared row, no workspace overlay. The
  // ingest and the "does this firm exist" checks only need its id.

  async findByNormalizedName(
    normalizedName: string,
  ): Promise<Employer | undefined> {
    const rows = await this.db
      .select()
      .from(employerEffective)
      .where(eq(employerEffective.normalized_name, normalizedName))
      .limit(1);
    return rows[0];
  }

  async findByNormalizedNames(normalizedNames: string[]): Promise<Employer[]> {
    if (normalizedNames.length === 0) return [];
    return this.db
      .select()
      .from(employerEffective)
      .where(inArray(employerEffective.normalized_name, normalizedNames))
      .orderBy(asc(employerEffective.normalized_name));
  }

  async insert(data: EmployerInsert): Promise<Employer> {
    const [row] = await this.db.insert(employers).values(data).returning();
    return row;
  }

  async update(
    id: string,
    data: EmployerUpdate,
  ): Promise<Employer | undefined> {
    const [row] = await this.db
      .update(employers)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(eq(employers.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(employers).where(eq(employers.id, id));
  }

  async findByIds(ids: string[], workspaceId: string): Promise<Employer[]> {
    if (ids.length === 0) return [];
    return this.db
      .select(workspaceEmployerColumns)
      .from(employerWorkspaceEffective)
      .where(
        and(
          inArray(employerWorkspaceEffective.id, ids),
          eq(employerWorkspaceEffective.workspace_id, workspaceId),
        ),
      )
      .orderBy(desc(employerWorkspaceEffective.updated_at));
  }

  async countFlagged(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(
        and(
          eq(employers.curation_status, "flagged"),
          sql`EXISTS (
            SELECT 1 FROM ${correspondents}
            JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondents.id}
            WHERE ${correspondents.employer_id} = ${employers.id}
              AND ${workspaceCorrespondents.workspace_id} = ${workspaceId}
          )`
        )
      );
    return Number(rows[0]?.n ?? 0);
  }

  async listFlagged(workspaceId: string): Promise<Employer[]> {
    return this.db
      .select(workspaceEmployerColumns)
      .from(employerWorkspaceEffective)
      .where(
        and(
          eq(employerWorkspaceEffective.curation_status, "flagged"),
          eq(employerWorkspaceEffective.workspace_id, workspaceId),
        ),
      )
      .orderBy(asc(employerWorkspaceEffective.created_at));
  }

  /**
   * Claim up to `limit` firms for the industry classifier, newest first: firms
   * with a contact visible in this workspace, no machine industry, no industry
   * this workspace typed in, and no classifier attempt since `retryBefore`.
   * Claiming stamps `industry_classified_at`, so a concurrent sweep skips them
   * (`SKIP LOCKED`) and a firm the model could not place waits until
   * `retryBefore` passes it again. Returns the claimed ids.
   */
  async claimForIndustryClassification(
    workspaceId: string,
    retryBefore: string,
    limit: number,
  ): Promise<string[]> {
    if (!workspaceId || limit <= 0) return [];
    const { rows } = await this.db.execute<{ id: string }>(sql`
      UPDATE ${employers} AS claimed
      SET industry_classified_at = now()
      WHERE claimed.id IN (
        SELECT e.id
        FROM ${employers} e
        WHERE e.industry IS NULL
          AND (e.industry_classified_at IS NULL OR e.industry_classified_at < ${retryBefore})
          AND NOT EXISTS (
            SELECT 1 FROM ${employerCuration} c
            WHERE c.employer_id = e.id
              AND c.workspace_id = ${workspaceId}
              AND c.industry IS NOT NULL
          )
          AND EXISTS (
            SELECT 1
            FROM ${correspondents} co
            JOIN ${workspaceCorrespondents} wc
              ON wc.correspondent_id = co.id AND wc.workspace_id = ${workspaceId}
            WHERE co.employer_id = e.id
          )
        ORDER BY e.created_at DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING claimed.id
    `);
    return rows.map((r) => r.id);
  }

  /**
   * Undo `claimForIndustryClassification` for firms whose labelling call
   * failed, so the next sweep retries them instead of waiting out the window.
   */
  async releaseIndustryClaims(employerIds: string[]): Promise<void> {
    if (employerIds.length === 0) return;
    await this.db
      .update(employers)
      .set({ industry_classified_at: null })
      .where(and(inArray(employers.id, employerIds), sql`${employers.industry} IS NULL`));
  }

  /**
   * What the industry classifier sees of each firm, in three batched reads:
   * its machine name, its mail domains, and up to `contactsPerFirm` of the
   * contacts visible in this workspace — title / stated focus / bio as the
   * workspace sees them, so a Get Full Profile bio (an overlay) counts.
   * Contacts with a bio come first. Never email notes, which are private to
   * the people on the email.
   */
  async findIndustryEvidence(
    workspaceId: string,
    employerIds: string[],
    contactsPerFirm = 6,
  ): Promise<FirmIndustryEvidence[]> {
    const ids = [...new Set(employerIds)];
    if (!workspaceId || ids.length === 0) return [];
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const [firms, domainRows, contactRows] = await Promise.all([
      this.db
        .select({ id: employers.id, name: employers.name })
        .from(employers)
        .where(inArray(employers.id, ids))
        .orderBy(asc(employers.id)),
      this.db
        .select({ employerId: employerDomains.employer_id, domain: employerDomains.domain })
        .from(employerDomains)
        .where(inArray(employerDomains.employer_id, ids))
        .orderBy(asc(employerDomains.employer_id), asc(employerDomains.domain)),
      this.db.execute<{
        employer_id: string;
        title: string | null;
        specialization: string | null;
        bio: string | null;
      }>(sql`
        SELECT employer_id, title, specialization, bio
        FROM (
          SELECT
            co.employer_id,
            co.title,
            co.specialization,
            left(co.bio, 400) AS bio,
            row_number() OVER (
              PARTITION BY co.employer_id
              ORDER BY (co.bio IS NULL), (co.title IS NULL), co.created_at
            ) AS rn
          FROM ${correspondentWorkspaceEffective} co
          WHERE co.workspace_id = ${workspaceId}
            AND co.employer_id IN (${idList})
            AND (co.title IS NOT NULL OR co.specialization IS NOT NULL OR co.bio IS NOT NULL)
        ) ranked
        WHERE rn <= ${contactsPerFirm}
        ORDER BY employer_id, rn
      `),
    ]);

    const domainsById = new Map<string, string[]>();
    for (const r of domainRows) {
      const list = domainsById.get(r.employerId) ?? [];
      list.push(r.domain);
      domainsById.set(r.employerId, list);
    }
    const contactsById = new Map<string, FirmIndustryEvidence['contacts']>();
    for (const r of contactRows.rows) {
      const list = contactsById.get(r.employer_id) ?? [];
      list.push({ title: r.title, specialization: r.specialization, bio: r.bio });
      contactsById.set(r.employer_id, list);
    }
    return firms.map((f) => ({
      id: f.id,
      name: f.name,
      domains: domainsById.get(f.id) ?? [],
      contacts: contactsById.get(f.id) ?? [],
    }));
  }

  /**
   * Write classifier labels in one statement. Only fills a NULL machine
   * industry, so a value set meanwhile (a pipeline override, a seed) is kept;
   * the per-workspace curation overlay is never touched and still wins on
   * read. Returns the ids actually written.
   */
  async fillIndustries(rows: Array<{ id: string; industry: string }>): Promise<string[]> {
    if (rows.length === 0) return [];
    const values = sql.join(
      rows.map((r) => sql`(${r.id}::uuid, ${r.industry})`),
      sql`, `,
    );
    const { rows: written } = await this.db.execute<{ id: string }>(sql`
      UPDATE ${employers} AS e
      SET industry = v.industry
      FROM (VALUES ${values}) AS v(id, industry)
      WHERE e.id = v.id AND e.industry IS NULL
      RETURNING e.id
    `);
    return written.map((r) => r.id);
  }

  /**
   * Bulk upsert by `normalized_name`. Mirrors the on-conflict semantics from
   * `crmIngest` employer upsert: name overwrites, industry only
   * fills in NULLs (so manual UI edits to industry survive re-runs).
   * Returns `{ id, normalized_name }` per row so callers can build a
   * domain→id map.
   */
  async upsertBatch(
    rows: EmployerInsert[],
  ): Promise<Array<{ id: string; normalized_name: string }>> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: Array<{ id: string; normalized_name: string }> = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(employers)
        .values(chunk)
        .onConflictDoUpdate({
          target: employers.normalized_name,
          set: {
            name: sql`EXCLUDED.name`,
            industry: sql`COALESCE(EXCLUDED.industry, ${employers.industry})`,
          },
        })
        .returning({
          id: employers.id,
          normalized_name: employers.normalized_name,
        });
      out.push(...res);
    }
    return out;
  }
}
