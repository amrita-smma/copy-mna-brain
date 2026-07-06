import { and, desc, eq, gte, isNotNull, isNull, like, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  aiWorkforceQueue,
  companies,
  companyFinancials,
  companyLogs,
  companySlides,
  correspondents,
  dealNotes,
  employers,
  users,
} from '@/lib/db/schema';
import type { DbClient } from './types';

/**
 * Aliased copy of `company_financials` used only inside the correlated
 * subquery that finds each company's most recent fiscal year. It must be a
 * distinct alias so it doesn't collide with the outer `companyFinancials`
 * join in the same statement.
 */
const latestFinancials = alias(companyFinancials, 'cf_latest');

/**
 * Aliased copy of `users` for resolving `companies.deal_sponsor` (a uuid FK)
 * to a display name. Must be distinct from the plain `users` join, which is
 * already bound to `companies.entered_by` in the same statements.
 */
const sponsorUsers = alias(users, 'sponsor_users');

/**
 * Financial columns selected from `company_financials` for feed rows.
 * `financial_year` is the fiscal year the figures belong to (null when the
 * left join finds no matching row), so the UI can label them without
 * hardcoding the year on its side.
 */
type FeedFinancials = {
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
  ev_usd_mn: number | null;
  financial_year: number | null;
};

export class DashboardActivityRepository {
  constructor(private db: DbClient) {}

  /**
   * Join condition that attaches the company's MOST RECENT financials row
   * (highest `fiscal_year`) rather than a hardcoded year. Used as the ON clause
   * for the `companyFinancials` left join across every feed query, so the
   * Rev / EBITDA / EV summary always reflects the latest data on file and the
   * reported year is carried through to the UI via `financial_year`.
   *
   * Built with the query builder (not a raw `sql` string) so the correlated
   * subquery's FROM renders as `"company_financials" "cf_latest"` — a raw
   * template would emit only the bare alias and reference a missing relation.
   */
  private latestFinancialsOn() {
    return and(
      eq(companyFinancials.company_id, companies.id),
      eq(
        companyFinancials.fiscal_year,
        this.db
          .select({ year: sql<number>`max(${latestFinancials.fiscal_year})` })
          .from(latestFinancials)
          .where(eq(latestFinancials.company_id, companies.id)),
      ),
    );
  }

  /**
   * Correlated subquery selecting the company's most recent analysis logo
   * (highest `updated_at`, skipping null logos). Rendered as a scalar column on
   * feed rows so the activity feed can show a company logo when one exists,
   * without a join that would fan out rows across multiple analyses.
   *
   * Built as a plain `sql` template (not the query builder) so it never issues
   * its own `.select()` call — feed queries expose a single top-level select.
   */
  private latestLogoUrl() {
    return sql<string | null>`(
      SELECT "company_analyses"."logo_url"
      FROM "company_analyses"
      WHERE "company_analyses"."company_id" = "companies"."id"
        AND "company_analyses"."logo_url" IS NOT NULL
      ORDER BY "company_analyses"."updated_at" DESC NULLS LAST
      LIMIT 1
    )`;
  }

  async getNewL0Companies(from: Date, to: Date, limit?: number, companyId?: string): Promise<
    ({ id: string; target: string | null; project_name: string | null; source: string | null; segment: string | null; geography: string | null; remarks: string | null; thesis_content: string | null; logo_url: string | null; deal_sponsor_name: string | null; entered_by: string | null; entered_by_name: string | null; event_at: string; reason: 'created' | 'demoted' } & FeedFinancials)[]
  > {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // Cap each sub-query at `limit`: the merged result is sorted desc and sliced
    // by the caller, so no individual source needs more than `limit` rows.
    const createdQuery = this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        source: companies.source,
        segment: companies.segment,
        geography: companies.geography,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        deal_sponsor_name: sponsorUsers.name,
        entered_by: companies.entered_by,
        entered_by_name: users.name,
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
        event_at: companies.created_at,
      })
      .from(companies)
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .leftJoin(users, eq(users.id, companies.entered_by))
      .leftJoin(sponsorUsers, eq(sponsorUsers.id, companies.deal_sponsor))
      .where(
        and(
          eq(companies.pipeline_stage, 'L0'),
          gte(companies.created_at, fromIso),
          lte(companies.created_at, toIso),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(desc(companies.created_at));

    const demotedQuery = this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        source: companies.source,
        segment: companies.segment,
        geography: companies.geography,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        deal_sponsor_name: sponsorUsers.name,
        entered_by: companies.entered_by,
        entered_by_name: users.name,
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
        event_at: companyLogs.created_at,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companyLogs.company_id, companies.id))
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .leftJoin(users, eq(users.id, companies.entered_by))
      .leftJoin(sponsorUsers, eq(sponsorUsers.id, companies.deal_sponsor))
      .where(
        and(
          like(companyLogs.action, '%_TO_L0'),
          logDateInRange(fromIso, toIso),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(sql`${companyLogs.created_at} desc nulls last`);

    const [created, demoted] = await Promise.all([
      limit != null ? createdQuery.limit(limit) : createdQuery,
      limit != null ? demotedQuery.limit(limit) : demotedQuery,
    ]);

    // Merge, deduplicate by id keeping the most recent event, then sort desc
    const map = new Map<string, (typeof created[number] | typeof demoted[number]) & { event_at: string; reason: 'created' | 'demoted' }>();
    for (const row of created) {
      if (row.event_at == null) continue;
      map.set(row.id, { ...row, event_at: row.event_at, reason: 'created' });
    }
    for (const row of demoted) {
      const eventAt = row.event_at ?? null;
      if (eventAt == null) continue;
      const existing = map.get(row.id);
      if (!existing || eventAt > existing.event_at) {
        map.set(row.id, { ...row, event_at: eventAt, reason: 'demoted' });
      }
    }

    const merged = Array.from(map.values()).sort((a, b) =>
      b.event_at.localeCompare(a.event_at),
    );
    return limit != null ? merged.slice(0, limit) : merged;
  }

  /**
   * Companies the AI added to the `market_screening` stage (the "AI Discovered"
   * activity), created within the window. Mirrors the `created` half of
   * `getNewL0Companies` but keyed on the `market_screening` pipeline stage so the
   * activity feed can show an event whenever one is added. Relationship-graph
   * auto-created `discovered` companies are intentionally excluded.
   */
  async getDiscoveredCompanies(from: Date, to: Date, limit?: number, companyId?: string) {
    const query = this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        source: companies.source,
        segment: companies.segment,
        geography: companies.geography,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
        event_at: companies.created_at,
      })
      .from(companies)
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .where(
        and(
          eq(companies.pipeline_stage, 'market_screening'),
          gte(companies.created_at, from.toISOString()),
          lte(companies.created_at, to.toISOString()),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(desc(companies.created_at));
    return limit != null ? query.limit(limit) : query;
  }

  async getAiSourcedCompanies(from: Date, to: Date) {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    return this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        log_created_at: companyLogs.created_at,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companyLogs.company_id, companies.id))
      .where(
        and(
          eq(companyLogs.action, 'CREATED_AS_L0'),
          logDateInRange(fromIso, toIso),
        ),
      )
      .orderBy(desc(companies.updated_at));
  }

  async getPipelineMoves(from: Date, to: Date, limit?: number, companyId?: string) {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const query = this.db
      .select({
        id: companyLogs.id,
        company_id: companyLogs.company_id,
        action: companyLogs.action,
        created_at: companyLogs.created_at,
        target: companies.target,
        project_name: companies.project_name,
        segment: companies.segment,
        geography: companies.geography,
        source: companies.source,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        promoted_reasons: companies.promoted_reasons,
        deal_sponsor_name: sponsorUsers.name,
        entered_by: companies.entered_by,
        entered_by_name: users.name,
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companyLogs.company_id, companies.id))
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .leftJoin(users, eq(users.id, companies.entered_by))
      .leftJoin(sponsorUsers, eq(sponsorUsers.id, companies.deal_sponsor))
      .where(
        and(
          like(companyLogs.action, 'PROMOTED_%'),
          logDateInRange(fromIso, toIso),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(sql`${companyLogs.created_at} desc nulls last`);
    return limit != null ? query.limit(limit) : query;
  }

  async getSlidesGenerated(from: Date, to: Date) {
    return this.db
      .select({
        id: companySlides.id,
        company_id: companySlides.company_id,
        title: companySlides.title,
        created_at: companySlides.created_at,
        target: companies.target,
        project_name: companies.project_name,
      })
      .from(companySlides)
      .innerJoin(companies, eq(companySlides.company_id, companies.id))
      .where(
        and(
          gte(companySlides.created_at, from.toISOString()),
          lte(companySlides.created_at, to.toISOString()),
        ),
      )
      .orderBy(desc(companySlides.created_at));
  }

  async getDroppedDeals(from: Date, to: Date, limit?: number, companyId?: string) {
    const query = this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        dropped_at: companies.dropped_at,
        dropped_reason: companies.dropped_reason,
        remarks: companies.remarks,
        segment: companies.segment,
        geography: companies.geography,
        source: companies.source,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        deal_sponsor_name: sponsorUsers.name,
        entered_by: companies.entered_by,
        entered_by_name: users.name,
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
      })
      .from(companies)
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .leftJoin(users, eq(users.id, companies.entered_by))
      .leftJoin(sponsorUsers, eq(sponsorUsers.id, companies.deal_sponsor))
      .where(
        and(
          eq(companies.status, 'dropped'),
          gte(companies.dropped_at, from.toISOString()),
          lte(companies.dropped_at, to.toISOString()),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(desc(companies.dropped_at));
    return limit != null ? query.limit(limit) : query;
  }

  async getNotesUpdated(from: Date, to: Date, limit?: number, companyId?: string) {
    const query = this.db
      .select({
        id: dealNotes.id,
        company_id: dealNotes.deal_id,
        content: dealNotes.content,
        stage: dealNotes.stage,
        created_at: dealNotes.created_at,
        target: companies.target,
        project_name: companies.project_name,
        segment: companies.segment,
        geography: companies.geography,
        source: companies.source,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
        logo_url: this.latestLogoUrl(),
        revenue_usd_mn: companyFinancials.revenue_usd_mn,
        ebitda_usd_mn: companyFinancials.ebitda_usd_mn,
        ev_usd_mn: companyFinancials.ev_usd_mn,
        financial_year: companyFinancials.fiscal_year,
      })
      .from(dealNotes)
      .innerJoin(companies, eq(dealNotes.deal_id, companies.id))
      .leftJoin(companyFinancials, this.latestFinancialsOn())
      .where(
        and(
          gte(dealNotes.created_at, from.toISOString()),
          lte(dealNotes.created_at, to.toISOString()),
          companyId ? eq(companies.id, companyId) : undefined,
        ),
      )
      .orderBy(desc(dealNotes.created_at));
    return limit != null ? query.limit(limit) : query;
  }

  async getWorkforceJobs(from: Date, to: Date) {
    return this.db
      .select({
        id: aiWorkforceQueue.id,
        agent_name: aiWorkforceQueue.agent_name,
        status: aiWorkforceQueue.status,
        title: aiWorkforceQueue.title,
        created_at: aiWorkforceQueue.created_at,
      })
      .from(aiWorkforceQueue)
      .where(
        and(
          isNull(aiWorkforceQueue.parent_run_id),
          gte(aiWorkforceQueue.created_at, from.toISOString()),
          lte(aiWorkforceQueue.created_at, to.toISOString()),
        ),
      )
      .orderBy(desc(aiWorkforceQueue.created_at));
  }

  async getNewContacts(from: Date, to: Date) {
    return this.db
      .select({
        id: correspondents.id,
        name: correspondents.name,
        title: correspondents.title,
        email: correspondents.email,
        created_at: correspondents.created_at,
        employer_id: correspondents.employer_id,
        employer_name: employers.name,
      })
      .from(correspondents)
      .innerJoin(employers, eq(correspondents.employer_id, employers.id))
      .where(
        and(
          gte(correspondents.created_at, from.toISOString()),
          lte(correspondents.created_at, to.toISOString()),
        ),
      )
      .orderBy(desc(correspondents.created_at));
  }
}

/**
 * Date filter for company_logs rows.
 *
 * company_logs.created_at is nullable — if a log entry was inserted without
 * triggering the DB default (e.g. direct inserts or migrations), the column
 * will be NULL and gte/lte comparisons evaluate to NULL, silently dropping
 * the row. The fallback uses companies.updated_at (always non-null) so that
 * a promotion that has no log timestamp is still matched when the company
 * itself was recently updated.
 */
function logDateInRange(fromIso: string, toIso: string) {
  return or(
    and(
      isNotNull(companyLogs.created_at),
      gte(companyLogs.created_at, fromIso),
      lte(companyLogs.created_at, toIso),
    ),
    and(
      isNull(companyLogs.created_at),
      gte(companies.updated_at, fromIso),
      lte(companies.updated_at, toIso),
    ),
  );
}
