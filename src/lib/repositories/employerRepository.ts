import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  correspondents,
  emailParticipants,
  emails,
  employers,
  employerCuration,
  employerDomains,
  employerEffective,
  employerTeamMembers,
  employerTopics,
  topics,
  users,
} from "@/lib/db/schema";
import type { DbClient } from "./types";

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
  team: Array<{ id: string; name: string; email: string | null }>;
}

export class EmployerRepository {
  constructor(private db: DbClient) {}

  private buildWhere(filters: EmployerListFilters): SQL | undefined {
    const searchPattern = filters.search ? `%${filters.search}%` : null;
    return and(
      eq(employers.curation_status, filters.curationStatus ?? "published"),
      filters.status ? eq(employers.status, filters.status) : undefined,
      searchPattern
        ? or(
            ilike(employers.name, searchPattern),
            sql`EXISTS (SELECT 1 FROM ${employerCuration} WHERE ${employerCuration.employer_id} = ${employers.id} AND ${employerCuration.name} ILIKE ${searchPattern})`,
            sql`EXISTS (SELECT 1 FROM ${employerDomains} WHERE ${employerDomains.employer_id} = ${employers.id} AND ${employerDomains.domain} ILIKE ${searchPattern})`,
            sql`EXISTS (SELECT 1 FROM ${correspondents} WHERE ${correspondents.employer_id} = ${employers.id} AND (${correspondents.name} ILIKE ${searchPattern} OR ${correspondents.email} ILIKE ${searchPattern}))`,
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

  async list(filters: EmployerListFilters = {}): Promise<EmployerSummary[]> {
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
        name: sql<string>`COALESCE((SELECT "employer_curation"."name" FROM "employer_curation" WHERE "employer_curation"."employer_id" = "employers"."id"), "employers"."name")`,
        normalized_name: employers.normalized_name,
        industry: sql<
          string | null
        >`COALESCE((SELECT "employer_curation"."industry" FROM "employer_curation" WHERE "employer_curation"."employer_id" = "employers"."id"), "employers"."industry")`,
        status: employers.status,
        curation_status: employers.curation_status,
        created_at: employers.created_at,
        updated_at: employers.updated_at,
        // KPIs are served from the precomputed analytics.mart_crm (RFC MB-205
        // §Phase 5b) rather than recomputed per request — chiefly the
        // response_p50 percentile, which is an O(emails) LATERAL self-join.
        // mart_crm holds the SAME arithmetic as the former inline subqueries
        // (email_count via COUNT(DISTINCT participant email), last_contact via
        // MAX(sent_at), p50/pair_count via the inbound→earliest-outbound reply
        // gap capped at 30 days), one row per employer, refreshed after each
        // ingest — so served numbers are unchanged. Verify with a SELECT-diff
        // before relying on it. CAVEAT: mart_crm groups email_count/
        // last_contact by correspondents.employer_id, so it only stays correct
        // while ingest is the sole writer of those links. If a future UI
        // feature reassigns an already-emailed contact to another firm, refresh
        // the mart on that write (or keep these two columns live).
        email_count: sql<number>`COALESCE((
          SELECT "mart_crm"."email_count"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employers"."id"
        ), 0)`,
        last_contact_at: sql<string | null>`(
          SELECT "mart_crm"."last_contact_at"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employers"."id"
        )`,
        response_p50_seconds: sql<number | null>`(
          SELECT "mart_crm"."response_p50_seconds"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employers"."id"
        )`,
        response_pair_count: sql<number>`COALESCE((
          SELECT "mart_crm"."response_pair_count"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employers"."id"
        ), 0)`,
        primary_pic: sql<EmployerSummary["primary_pic"]>`(
          SELECT jsonb_build_object(
            'id', "correspondents"."id",
            'name', "correspondents"."name",
            'title', "correspondents"."title",
            'email', "correspondents"."email",
            'phone', "correspondents"."phone"
          )
          FROM "correspondents"
          WHERE "correspondents"."employer_id" = "employers"."id"
          ORDER BY "correspondents"."is_primary" DESC, "correspondents"."created_at" ASC
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
        source: sql<"auto" | "manual">`CASE
          WHEN (
            SELECT "correspondents"."source"
            FROM "correspondents"
            WHERE "correspondents"."employer_id" = "employers"."id"
            ORDER BY "correspondents"."created_at" ASC, "correspondents"."id" ASC
            LIMIT 1
          ) = 'mbox' THEN 'auto'::text ELSE 'manual'::text END`,
      })
      .from(employers)
      .where(this.buildWhere(filters))
      .orderBy(
        // Sort by the same mart-sourced last_contact_at selected above, so the
        // order agrees with the displayed value.
        sql`(
          SELECT "mart_crm"."last_contact_at"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employers"."id"
        ) DESC NULLS LAST`,
        asc(employers.name),
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

  async count(filters: EmployerListFilters = {}): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(this.buildWhere(filters));
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

  async countFlagged(): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(eq(employers.curation_status, "flagged"));
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
