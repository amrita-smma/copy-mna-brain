import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  correspondentEffective,
  correspondents,
  emailParticipants,
  emails,
  employers,
  employerCuration,
  employerDomains,
  employerEffective,
  employerNotes,
  employerRelatedCompanies,
  employerTeamMembers,
  employerTopics,
  topics,
  users,
  workspaceCorrespondents,
} from "@/lib/db/schema";
import type { DbClient } from "./types";
import { escapeLikePattern } from "./insightRepository";
import type { EmployerListSort, SortDirection } from "@/lib/crm/employerListSort";

export type Employer = typeof employers.$inferSelect;
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
 * One column of the employer's `analytics.mart_crm` row for this workspace,
 * correlated on "employers"."id". Written with hard-coded "table"."column"
 * text because the `select({...})` shorthand strips table qualifiers from
 * column references inside the select clause (see `list`).
 */
function martCrmColumn<T = unknown>(column: string, workspaceId: string): SQL<T> {
  return sql<T>`(
    SELECT "mart_crm".${sql.identifier(column)}
    FROM "analytics"."mart_crm"
    WHERE "mart_crm"."employer_id" = "employers"."id"
      AND "mart_crm"."workspace_id" = ${workspaceId}
  )`;
}

/** The employer's curated name / industry when a human set one, else the ingested value. */
function curatedColumn<T = unknown>(column: "name" | "industry"): SQL<T> {
  return sql<T>`COALESCE((SELECT "employer_curation".${sql.identifier(column)} FROM "employer_curation" WHERE "employer_curation"."employer_id" = "employers"."id"), "employers".${sql.identifier(column)})`;
}

export class EmployerRepository {
  constructor(private db: DbClient) {}

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
      sql`(
        EXISTS (
          SELECT 1 FROM ${correspondents}
          JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondents.id}
          WHERE ${correspondents.employer_id} = ${employers.id}
            AND ${workspaceCorrespondents.workspace_id} = ${workspaceId}
        )
        OR EXISTS (
          SELECT 1 FROM ${employerRelatedCompanies}
          WHERE ${employerRelatedCompanies.employer_id} = ${employers.id}
            AND ${employerRelatedCompanies.workspace_id} = ${workspaceId}
            AND ${employerRelatedCompanies.dismissed_at} IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM ${employerNotes}
          WHERE ${employerNotes.employer_id} = ${employers.id}
            AND ${employerNotes.workspace_id} = ${workspaceId}
        )
        OR EXISTS (
          SELECT 1 FROM ${employerTopics}
          JOIN ${topics} ON ${topics.id} = ${employerTopics.topic_id}
          WHERE ${employerTopics.employer_id} = ${employers.id}
            AND ${topics.workspace_id} = ${workspaceId}
        )
      )`,
      filters.status ? eq(employers.status, filters.status) : undefined,
      searchPattern
        ? or(
            ilike(employers.name, searchPattern),
            sql`EXISTS (SELECT 1 FROM ${employerCuration} WHERE ${employerCuration.employer_id} = ${employers.id} AND ${employerCuration.name} ILIKE ${searchPattern})`,
            sql`EXISTS (SELECT 1 FROM ${employerDomains} WHERE ${employerDomains.employer_id} = ${employers.id} AND ${employerDomains.domain} ILIKE ${searchPattern})`,
            // A person search: the overlay-aware (curated) name or the email,
            // and only contacts this workspace can see — otherwise a firm
            // surfaces for a match its card would never show.
            sql`EXISTS (
              SELECT 1 FROM ${correspondentEffective}
              JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondentEffective.id}
              WHERE ${correspondentEffective.employer_id} = ${employers.id}
                AND ${workspaceCorrespondents.workspace_id} = ${workspaceId}
                AND (${correspondentEffective.name} ILIKE ${searchPattern} OR ${correspondentEffective.email} ILIKE ${searchPattern})
            )`,
          )
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
        ? sql`EXISTS (SELECT 1 FROM ${employerTopics} WHERE ${employerTopics.employer_id} = ${employers.id} AND ${inArray(employerTopics.topic_id, filters.topicIds)})`
        : undefined,
      filters.teamUserIds && filters.teamUserIds.length > 0
        ? sql`EXISTS (SELECT 1 FROM ${employerTeamMembers} WHERE ${employerTeamMembers.employer_id} = ${employers.id} AND ${inArray(employerTeamMembers.user_id, filters.teamUserIds)})`
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
      // Same pick as the primary_pic select: the oldest correspondent this
      // workspace can see.
      primary_pic: sql`(
        SELECT LOWER("correspondents"."name")
        FROM "correspondents"
        JOIN "workspace_correspondents"
          ON "workspace_correspondents"."correspondent_id" = "correspondents"."id"
          AND "workspace_correspondents"."workspace_id" = ${workspaceId}
        WHERE "correspondents"."employer_id" = "employers"."id"
        ORDER BY "correspondents"."created_at" ASC, "correspondents"."id" ASC
        LIMIT 1
      )`,
      response_p50: martCrmColumn("response_p50_seconds", workspaceId),
      last_contact: martCrmColumn("last_contact_at", workspaceId),
      emails: sql`COALESCE(${martCrmColumn("email_count", workspaceId)}, 0)`,
      team_members: sql`(
        SELECT COUNT(*)
        FROM "employer_team_members"
        WHERE "employer_team_members"."employer_id" = "employers"."id"
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
        // Effective (overlay-aware) name/industry — human override wins. The
        // rest of this query stays correlated on "employers"."id".
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
        // mart_crm is now keyed by (workspace_id, employer_id) — see
        // 20260705000004_workspace_scoped_marts.sql — so every correlated
        // subquery below must filter by this workspace too, or a shared
        // employer's numbers would sum across every workspace's activity.
        // CAVEAT: mart_crm groups email_count/last_contact by
        // correspondents.employer_id, so it only stays correct while ingest
        // is the sole writer of those links. If a future UI feature
        // reassigns an already-emailed contact to another firm, refresh the
        // mart on that write (or keep these two columns live).
        email_count: sql<number>`COALESCE(${martCrmColumn("email_count", workspaceId)}, 0)`,
        last_contact_at: martCrmColumn<string | null>("last_contact_at", workspaceId),
        response_p50_seconds: martCrmColumn<number | null>("response_p50_seconds", workspaceId),
        response_pair_count: sql<number>`COALESCE(${martCrmColumn("response_pair_count", workspaceId)}, 0)`,
        // Scoped to correspondents THIS workspace can see (workspace_correspondents),
        // ordered by whether this workspace designated them primary
        // (workspace_primary_correspondents — see
        // 20260705000004_workspace_primary_correspondents.sql), falling back to
        // oldest-visible when no explicit designation exists. Unscoped reads
        // here previously leaked another workspace's private contact.
        // Same visibility rule as CorrespondentRepository.visibleCorrespondentIds
        // — workspace membership only, no email-sync gate — otherwise the
        // list could show a "primary contact" that findByEmployerId's detail
        // read wouldn't (or hide one it would).
        primary_pic: sql<EmployerSummary["primary_pic"]>`(
          SELECT jsonb_build_object(
            'id', "correspondents"."id",
            'name', "correspondents"."name",
            'title', "correspondents"."title",
            'email', "correspondents"."email",
            'phone', "correspondents"."phone"
          )
          FROM "correspondents"
          JOIN "workspace_correspondents"
            ON "workspace_correspondents"."correspondent_id" = "correspondents"."id"
            AND "workspace_correspondents"."workspace_id" = ${workspaceId}
          WHERE "correspondents"."employer_id" = "employers"."id"
          ORDER BY "correspondents"."created_at" ASC, "correspondents"."id" ASC
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

  // Reads go through the effective view so the human overlay wins (RFC §3).
  async findById(id: string): Promise<Employer | undefined> {
    const rows = await this.db
      .select()
      .from(employerEffective)
      .where(eq(employerEffective.id, id))
      .limit(1);
    return rows[0];
  }

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

  async findByIds(ids: string[]): Promise<Employer[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(employerEffective)
      .where(inArray(employerEffective.id, ids))
      .orderBy(desc(employerEffective.updated_at));
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

  async listFlagged(): Promise<Employer[]> {
    return this.db
      .select()
      .from(employerEffective)
      .where(eq(employerEffective.curation_status, "flagged"))
      .orderBy(asc(employerEffective.created_at));
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
