import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  correspondents,
  emailParticipants,
  emails,
  employers,
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
        name: employers.name,
        normalized_name: employers.normalized_name,
        industry: employers.industry,
        status: employers.status,
        curation_status: employers.curation_status,
        created_at: employers.created_at,
        updated_at: employers.updated_at,
        // Count any email that touches this firm via a participant (sender or
        // to/cc), not just emails whose sender's domain matches. Otherwise an
        // employer we only ever send TO (or one whose people are only CC'd)
        // shows 0 emails even though they're clearly in the conversation.
        // DISTINCT collapses cases where multiple people at the same firm are
        // on the same email.
        email_count: sql<number>`COALESCE((
          SELECT COUNT(DISTINCT "email_participants"."email_id")
          FROM "email_participants"
          JOIN "correspondents" ON "correspondents"."id" = "email_participants"."correspondent_id"
          WHERE "correspondents"."employer_id" = "employers"."id"
        ), 0)`,
        last_contact_at: sql<string | null>`(
          SELECT MAX("emails"."sent_at")
          FROM "email_participants"
          JOIN "correspondents" ON "correspondents"."id" = "email_participants"."correspondent_id"
          JOIN "emails" ON "emails"."id" = "email_participants"."email_id"
          WHERE "correspondents"."employer_id" = "employers"."id"
        )`,
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
        // Match the participant-based last_contact_at computed above, so the
        // sort order agrees with the displayed value.
        sql`(
          SELECT MAX("emails"."sent_at")
          FROM "email_participants"
          JOIN "correspondents" ON "correspondents"."id" = "email_participants"."correspondent_id"
          JOIN "emails" ON "emails"."id" = "email_participants"."email_id"
          WHERE "correspondents"."employer_id" = "employers"."id"
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

  async findById(id: string): Promise<Employer | undefined> {
    const rows = await this.db
      .select()
      .from(employers)
      .where(eq(employers.id, id))
      .limit(1);
    return rows[0];
  }

  async findByNormalizedName(
    normalizedName: string,
  ): Promise<Employer | undefined> {
    const rows = await this.db
      .select()
      .from(employers)
      .where(eq(employers.normalized_name, normalizedName))
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
      .from(employers)
      .where(inArray(employers.id, ids))
      .orderBy(desc(employers.updated_at));
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
      .from(employers)
      .where(eq(employers.curation_status, "flagged"))
      .orderBy(asc(employers.created_at));
  }
}
