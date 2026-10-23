import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  correspondents,
  correspondentEffective,
  employerEffective,
  workspaceCorrespondents,
} from "@/lib/db/schema";
import type { DbClient } from "./types";
import type { MatchedContact } from "./employerRepository";
import { escapeLikePattern } from "./insightRepository";

export type Correspondent = typeof correspondents.$inferSelect;
export type CorrespondentInsert = typeof correspondents.$inferInsert;
export type CorrespondentUpdate = Partial<CorrespondentInsert>;

/**
 * SQL twin of `isAddressLikeName` (`@/lib/crm/contactName`): the name is
 * empty after trimming, contains `@`, or equals the email case-insensitively.
 */
function addressLikeNameSql(name: SQL, email: SQL): SQL {
  return sql`(COALESCE(btrim(${name}), '') = '' OR strpos(${name}, '@') > 0 OR lower(btrim(${name})) = lower(btrim(COALESCE(${email}, ''))))`;
}

/**
 * Facets for the banker-matching search (`CorrespondentRepository.search`).
 *
 * Every facet is OPTIONAL and every provided facet is scored, not required: a
 * row is returned when it matches at least one facet, ranked by the weighted
 * sum of the facets it matched. That is deliberate — a "US LBO" ask should put
 * the LevFin banker covering North America on top, then still show the LevFin
 * banker covering Greater China and the North America sector-coverage banker
 * rather than returning nothing because no single row matched both.
 *
 * Callers pass already-expanded terms (see `@/lib/crm/geoExpansion` and
 * `@/lib/crm/dealExpertise`); the repository only matches them.
 */
export interface CorrespondentSearchFilters {
  /** Free text, substring-matched across banker, firm and profile fields. */
  keyword?: string;
  /** Banker name or email fragment (substring). */
  banker?: string;
  /** Firm name fragment (substring). */
  firm?: string;
  /** Desk names, any-of, matched against `department`. */
  departments?: string[];
  /** Expertise terms, any-of, matched across specialization / title / bio. */
  expertise?: string[];
  /** Coverage labels that cover the deal precisely (e.g. "North America"). */
  regions?: string[];
  /** Umbrella coverage labels (e.g. "Global") — scored below `regions`. */
  broadRegions?: string[];
  /** Seniority labels, any-of, matched across seniority / title. */
  seniorities?: string[];
  /** Firm industry terms, any-of. */
  industries?: string[];
  /** Firm topic names, any-of. */
  topics?: string[];
  limit?: number;
}

/** One ranked banker, with the firm context needed to act on the match. */
export interface CorrespondentSearchResult {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  department: string | null;
  specialization: string | null;
  seniority: string | null;
  coverage_region: string | null;
  linkedin_url: string | null;
  bio: string | null;
  employer_id: string;
  employer_name: string;
  employer_industry: string | null;
  last_contact_at: string | null;
  email_count: number;
  /** Weighted sum of the facets this row matched. */
  match_score: number;
  /** Which facets matched, by `CorrespondentSearchFilters` key. */
  matched: string[];
}

/** Relative worth of each facet when ranking. */
const FACET_WEIGHTS = {
  banker: 4,
  firm: 4,
  departments: 3,
  regions: 3,
  expertise: 2,
  topics: 2,
  industries: 2,
  keyword: 2,
  seniorities: 1,
  broadRegions: 1,
} as const;

type FacetKey = keyof typeof FACET_WEIGHTS;

interface Facet {
  key: FacetKey;
  predicate: SQL;
}

/**
 * Escape the LIKE metacharacters so a user-typed `%` or `_` is matched
 * literally. Without this, `banker: "%"` compiles to `ILIKE '%%%'` and the
 * facet matches every row in the workspace.
 */
function likePattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, "\\$&")}%`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary alternation regex for a term list — "US" must not match
 * "Russia" and "M&A" must not match "M&As Unlimited". Returns null when the
 * list has no usable term, so the caller can skip the facet entirely.
 *
 * The `\y` anchors are applied per term and only on a side that ends in a word
 * character: a term like "U.S." has no word boundary after its trailing dot,
 * so anchoring there would make it match nothing at all.
 */
function termsRegex(terms: string[] | undefined): string | null {
  const cleaned = (terms ?? []).map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const anchored = cleaned.map((term) => {
    const lead = /^[\w]/.test(term) ? "\\y" : "";
    const tail = /[\w]$/.test(term) ? "\\y" : "";
    return `${lead}${escapeRegex(term)}${tail}`;
  });
  return `(${anchored.join("|")})`;
}

export class CorrespondentRepository {
  constructor(private db: DbClient) {}

  /**
   * Correspondent identity is shared/global (see workspace_correspondents
   * migration comment) — `workspaceId` here is a required read-time filter,
   * not a constructor-bound scope, because crmIngest needs unscoped writes
   * through this same class. Mirrors the `workspaceTrackIds()`
   * derived-table subquery idiom used by CriteriaRepository/TrackVariableRepository.
   *
   * Membership in this workspace is the ONLY visibility rule — every source
   * (`manual`, `direct`, `ingest`) is equally durable. The old
   * `source='ingest'` branch additionally required this workspace to have at
   * least one `user_workspaces.is_email_synced = true` member, so turning a
   * member's mailbox sync off retroactively hid CRM contacts that had
   * already been ingested. Sync state governs which mailboxes the pipeline
   * *pulls* from (`findSyncedCustodianEmails` /
   * `findWorkspaceIdsBySyncedEmail`), not what a workspace member can *read*.
   */
  private visibleCorrespondentIds(workspaceId: string) {
    return this.db
      .select({ id: workspaceCorrespondents.correspondent_id })
      .from(workspaceCorrespondents)
      .where(eq(workspaceCorrespondents.workspace_id, workspaceId));
  }

  // Reads go through the effective view so the human overlay wins (RFC §3.4).
  // Primary PIC is always the oldest visible correspondent — no user-settable
  // designation, just positional: first in the sorted list.
  async findByEmployerId(
    employerId: string,
    workspaceId: string,
  ): Promise<Correspondent[]> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.employer_id, employerId),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .orderBy(asc(correspondentEffective.created_at), asc(correspondentEffective.id));
    return rows.map((r, i) => ({ ...r, is_primary: i === 0 }));
  }

  /**
   * Batched counterpart to findByEmployerId — the primary-PIC lookup for many
   * employers in one query. `is_primary` stays positional (oldest visible
   * correspondent per employer), computed by grouping the ordered rows and
   * flagging the first of each employer's group. Callers group by
   * `employer_id` to reconstruct each employer's list.
   */
  async findByEmployerIds(
    employerIds: string[],
    workspaceId: string,
  ): Promise<Correspondent[]> {
    if (employerIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          inArray(correspondentEffective.employer_id, employerIds),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .orderBy(
        asc(correspondentEffective.employer_id),
        asc(correspondentEffective.created_at),
        asc(correspondentEffective.id),
      );
    const seen = new Set<string>();
    return rows.map((r) => {
      const isPrimary = !seen.has(r.employer_id);
      seen.add(r.employer_id);
      return { ...r, is_primary: isPrimary };
    });
  }

  /**
   * Build the scored facet list from the filters. Each facet is a boolean SQL
   * predicate plus the key it reports itself under; the caller turns them into
   * the WHERE (any match), the score (weighted sum) and the `matched` array.
   *
   * Name/firm/keyword facets match by substring (`ILIKE %x%`) so a partial
   * name still finds its owner; every term-list facet matches by
   * word-boundary regex (`~*`) so "US" cannot hit "Russia" and the short desk
   * abbreviations ("DCM", "ECM", "M&A") stay usable.
   */
  private searchFacets(
    filters: CorrespondentSearchFilters,
    workspaceId: string,
  ): Facet[] {
    const facets: Facet[] = [];

    const push = (key: FacetKey, predicate: SQL | undefined) => {
      if (predicate) facets.push({ key, predicate });
    };

    // Term-list facets: one word-boundary regex per facet, OR-ed across the
    // columns that facet is allowed to look at.
    const regexFacet = (
      key: FacetKey,
      terms: string[] | undefined,
      columns: SQL[],
    ) => {
      const pattern = termsRegex(terms);
      if (!pattern) return;
      push(
        key,
        or(...columns.map((column) => sql`${column} ~* ${pattern}`)),
      );
    };

    if (filters.banker?.trim()) {
      const pattern = likePattern(filters.banker);
      push(
        "banker",
        sql`(${correspondentEffective.name} ILIKE ${pattern} OR ${correspondentEffective.email} ILIKE ${pattern})`,
      );
    }

    if (filters.firm?.trim()) {
      push("firm", sql`${employerEffective.name} ILIKE ${likePattern(filters.firm)}`);
    }

    regexFacet("departments", filters.departments, [
      sql`${correspondentEffective.department}`,
    ]);
    regexFacet("expertise", filters.expertise, [
      sql`${correspondentEffective.specialization}`,
      sql`${correspondentEffective.title}`,
      sql`${correspondentEffective.bio}`,
    ]);
    regexFacet("regions", filters.regions, [
      sql`${correspondentEffective.coverage_region}`,
    ]);
    regexFacet("broadRegions", filters.broadRegions, [
      sql`${correspondentEffective.coverage_region}`,
    ]);
    regexFacet("seniorities", filters.seniorities, [
      sql`${correspondentEffective.seniority}`,
      sql`${correspondentEffective.title}`,
    ]);
    regexFacet("industries", filters.industries, [
      sql`${employerEffective.industry}`,
    ]);

    const topicPattern = termsRegex(filters.topics);
    if (topicPattern) {
      push(
        "topics",
        sql`EXISTS (
          SELECT 1 FROM "employer_topics"
          JOIN "topics" ON "topics"."id" = "employer_topics"."topic_id"
          WHERE "employer_topics"."employer_id" = "employer_effective"."id"
            AND ("topics"."workspace_id" IS NULL OR "topics"."workspace_id" = ${workspaceId})
            AND "topics"."name" ~* ${topicPattern}
        )`,
      );
    }

    if (filters.keyword?.trim()) {
      const pattern = likePattern(filters.keyword);
      push(
        "keyword",
        or(
          sql`${correspondentEffective.name} ILIKE ${pattern}`,
          sql`${correspondentEffective.title} ILIKE ${pattern}`,
          sql`${correspondentEffective.department} ILIKE ${pattern}`,
          sql`${correspondentEffective.specialization} ILIKE ${pattern}`,
          sql`${correspondentEffective.seniority} ILIKE ${pattern}`,
          sql`${correspondentEffective.coverage_region} ILIKE ${pattern}`,
          sql`${correspondentEffective.bio} ILIKE ${pattern}`,
          sql`${correspondentEffective.email} ILIKE ${pattern}`,
          sql`${employerEffective.name} ILIKE ${pattern}`,
          sql`${employerEffective.industry} ILIKE ${pattern}`,
        ),
      );
    }

    return facets;
  }

  /**
   * Rank the workspace's bankers against a deal profile — desk, coverage
   * region, expertise, seniority, firm industry and firm topics.
   *
   * This is the read behind "which banker can help me close this deal?". It is
   * scored-OR rather than filtered-AND (see `CorrespondentSearchFilters`): a
   * row needs to match only one facet to come back, and `match_score` /
   * `matched` tell the caller how good the fit is and why. Ties break on
   * recency of contact, so an equally-qualified banker we actually talk to
   * outranks a dormant one.
   *
   * One query regardless of how many bankers match — firm name/industry come
   * from the join and last-contact/email-count from the precomputed
   * `analytics.mart_crm`, so there is no per-row follow-up read.
   */
  async search(
    filters: CorrespondentSearchFilters,
    workspaceId: string,
  ): Promise<CorrespondentSearchResult[]> {
    const facets = this.searchFacets(filters, workspaceId);
    // No usable facet would mean "score every banker 0" — return nothing
    // instead of the whole address book.
    if (facets.length === 0) return [];

    const score = sql<number>`(${sql.join(
      facets.map(
        (facet) =>
          sql`CASE WHEN ${facet.predicate} THEN ${FACET_WEIGHTS[facet.key]} ELSE 0 END`,
      ),
      sql` + `,
    )})`;

    const matched = sql<string[]>`array_remove(ARRAY[${sql.join(
      facets.map(
        (facet) =>
          sql`CASE WHEN ${facet.predicate} THEN ${facet.key}::text END`,
      ),
      sql`, `,
    )}], NULL::text)`;

    // mart_crm is keyed by (workspace_id, employer_id) — see
    // 20260705000004_workspace_scoped_marts.sql — so both halves of the key
    // must be filtered or a shared firm's numbers sum across workspaces.
    // Column references are hard-coded and quoted here because Drizzle strips
    // table qualifiers inside select-clause subqueries (see EmployerRepository.list).
    const lastContact = sql<string | null>`(
      SELECT "mart_crm"."last_contact_at"
      FROM "analytics"."mart_crm"
      WHERE "mart_crm"."employer_id" = "employer_effective"."id"
        AND "mart_crm"."workspace_id" = ${workspaceId}
    )`;

    const rows = await this.db
      .select({
        id: correspondentEffective.id,
        name: correspondentEffective.name,
        title: correspondentEffective.title,
        email: correspondentEffective.email,
        phone: correspondentEffective.phone,
        department: correspondentEffective.department,
        specialization: correspondentEffective.specialization,
        seniority: correspondentEffective.seniority,
        coverage_region: correspondentEffective.coverage_region,
        linkedin_url: correspondentEffective.linkedin_url,
        bio: correspondentEffective.bio,
        employer_id: employerEffective.id,
        employer_name: employerEffective.name,
        employer_industry: employerEffective.industry,
        last_contact_at: lastContact,
        email_count: sql<number>`COALESCE((
          SELECT "mart_crm"."email_count"
          FROM "analytics"."mart_crm"
          WHERE "mart_crm"."employer_id" = "employer_effective"."id"
            AND "mart_crm"."workspace_id" = ${workspaceId}
        ), 0)`,
        match_score: score,
        matched,
      })
      .from(correspondentEffective)
      .innerJoin(
        employerEffective,
        eq(employerEffective.id, correspondentEffective.employer_id),
      )
      .where(
        and(
          inArray(
            correspondentEffective.id,
            this.visibleCorrespondentIds(workspaceId),
          ),
          eq(employerEffective.curation_status, "published"),
          or(...facets.map((facet) => facet.predicate)),
        ),
      )
      .orderBy(
        sql`${score} DESC`,
        sql`${lastContact} DESC NULLS LAST`,
        asc(correspondentEffective.name),
      )
      .limit(Math.min(Math.max(filters.limit ?? 10, 1), 50));

    return rows.map((row) => ({
      ...row,
      email_count: Number(row.email_count ?? 0),
      match_score: Number(row.match_score ?? 0),
      matched: row.matched ?? [],
    }));
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.id, id),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, is_primary: false };
  }

  async findByEmployerAndEmail(
    employerId: string,
    email: string,
  ): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.employer_id, employerId),
          sql`lower(${correspondentEffective.email}) = ${email.trim().toLowerCase()}`,
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Every correspondent whose email matches one of `emails`, case-insensitively
   * and across ALL employers. Email is the join key between manually-added and
   * email-ingested contacts, and the two paths can disagree on the employer
   * (a human picks a firm; ingest derives one from the domain), so dedupe must
   * not be scoped to `(employer_id, email)`.
   *
   * Ordered by lowercased email, then manual-before-auto, then oldest, so
   * callers can take the first row per email as the canonical contact.
   * Backed by `idx_correspondent_email_lower`.
   */
  async findByEmails(emails: string[]): Promise<Correspondent[]> {
    const lowered = [
      ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
    ];
    if (lowered.length === 0) return [];
    const lowerEmail = sql<string>`lower(${correspondentEffective.email})`;
    return this.db
      .select()
      .from(correspondentEffective)
      .where(inArray(lowerEmail, lowered))
      .orderBy(
        asc(lowerEmail),
        sql`CASE WHEN ${correspondentEffective.origin} = 'manual' THEN 0 ELSE 1 END`,
        asc(correspondentEffective.created_at),
      );
  }

  /**
   * Contacts under `employerIds` whose overlay-aware name or email contains
   * `search` (case-insensitive), restricted to this workspace's visible
   * contacts. Backs the CRM list's person search: one query for the whole
   * page of firms, ordered by employer then name so the caller can group in
   * a single pass. Capped at `limit` rows overall.
   */
  async searchInEmployers(
    employerIds: string[],
    search: string,
    workspaceId: string,
    limit = 1000,
  ): Promise<MatchedContact[]> {
    const term = search.trim();
    if (employerIds.length === 0 || !term) return [];
    const pattern = `%${escapeLikePattern(term)}%`;
    return this.db
      .select({
        id: correspondentEffective.id,
        employer_id: correspondentEffective.employer_id,
        name: correspondentEffective.name,
        title: correspondentEffective.title,
        email: correspondentEffective.email,
      })
      .from(correspondentEffective)
      .where(
        and(
          inArray(correspondentEffective.employer_id, employerIds),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
          or(
            ilike(correspondentEffective.name, pattern),
            ilike(correspondentEffective.email, pattern),
          ),
        ),
      )
      .orderBy(asc(correspondentEffective.employer_id), asc(correspondentEffective.name))
      .limit(limit);
  }

  /**
   * Plain multi-row insert for human-created contacts (CSV import). Callers
   * dedupe by email first via `findByEmails`; a concurrent insert racing on
   * `(employer_id, email)` is skipped rather than overwriting a row.
   */
  async insertMany(
    rows: CorrespondentInsert[],
  ): Promise<Array<{ id: string; email: string | null }>> {
    if (rows.length === 0) return [];
    const values = rows.map(({ is_primary: _ignored, ...rest }) => rest);
    return this.db
      .insert(correspondents)
      .values(values)
      .onConflictDoNothing({
        target: [correspondents.employer_id, correspondents.email],
        where: sql`email IS NOT NULL`,
      })
      .returning({ id: correspondents.id, email: correspondents.email });
  }

  async insert(data: CorrespondentInsert, workspaceId: string): Promise<Correspondent> {
    const { is_primary: _ignored, ...rest } = data;
    const [row] = await this.db
      .insert(correspondents)
      .values(rest)
      .returning();
    return { ...row, is_primary: false };
  }

  async update(
    id: string,
    data: CorrespondentUpdate,
    workspaceId: string,
  ): Promise<Correspondent | undefined> {
    const { is_primary: _ignored, ...rest } = data;
    if (Object.keys(rest).length === 0) {
      return this.findById(id, workspaceId);
    }
    const [row] = await this.db
      .update(correspondents)
      .set({ ...rest, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(correspondents.id, id),
          inArray(correspondents.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .returning();
    if (!row) return undefined;
    return { ...row, is_primary: false };
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(correspondents)
      .where(
        and(
          eq(correspondents.id, id),
          inArray(correspondents.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      );
  }

  async findByIds(ids: string[]): Promise<Correspondent[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(correspondentEffective)
      .where(inArray(correspondentEffective.id, ids));
  }

  /** Sums emails-with-this-correspondent per employer for quick stats. */
  async countByEmployer(employerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(correspondents)
      .where(eq(correspondents.employer_id, employerId));
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Bulk upsert on partial UNIQUE `(employer_id, email) WHERE email IS NOT NULL`.
   * Mirrors `crmIngest` correspondent upsert. Returns `{ id, email }`
   * per upserted row so callers can build an email→correspondent map.
   *
   * The `targetWhere` is required: Postgres doesn't infer a partial unique
   * index from a bare ON CONFLICT, and Drizzle 0.45 honors `targetWhere` on
   * `onConflictDoUpdate`.
   */
  async upsertBatch(
    rows: CorrespondentInsert[],
  ): Promise<Array<{ id: string; email: string | null }>> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: Array<{ id: string; email: string | null }> = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(correspondents)
        .values(chunk)
        .onConflictDoUpdate({
          target: [correspondents.employer_id, correspondents.email],
          targetWhere: sql`email IS NOT NULL`,
          // A human-added row (origin='manual') is never rewritten by the
          // ETL (RFC §3.4) — the conflict still resolves so its id comes back
          // and the ingested email links to the manual contact.
          // A real stored name is never downgraded to an address-like one
          // (same rule as `isAddressLikeName` in `@/lib/crm/contactName`).
          set: {
            name: sql`CASE WHEN ${correspondents.origin} = 'manual' THEN ${correspondents.name} WHEN ${addressLikeNameSql(sql`EXCLUDED.name`, sql`EXCLUDED.email`)} AND NOT ${addressLikeNameSql(sql`${correspondents.name}`, sql`${correspondents.email}`)} THEN ${correspondents.name} ELSE EXCLUDED.name END`,
            title: sql`CASE WHEN ${correspondents.origin} = 'manual' THEN ${correspondents.title} ELSE COALESCE(EXCLUDED.title, ${correspondents.title}) END`,
            phone: sql`CASE WHEN ${correspondents.origin} = 'manual' THEN ${correspondents.phone} ELSE COALESCE(EXCLUDED.phone, ${correspondents.phone}) END`,
            type: sql`CASE WHEN ${correspondents.origin} = 'manual' THEN ${correspondents.type} ELSE EXCLUDED.type END`,
            source: sql`CASE WHEN ${correspondents.origin} = 'manual' THEN ${correspondents.source} ELSE EXCLUDED.source END`,
            updated_at: sql`now()`,
          },
        })
        .returning({
          id: correspondents.id,
          email: correspondents.email,
        });
      out.push(...res);
    }
    return out;
  }
}
