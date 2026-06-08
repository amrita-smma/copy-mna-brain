import { and, desc, eq, gte, isNotNull, isNull, like, lte, or } from 'drizzle-orm';
import {
  aiWorkforceQueue,
  companies,
  companyLogs,
  companySlides,
  correspondents,
  dealNotes,
  employers,
} from '@/lib/db/schema';
import type { DbClient } from './types';

export class DashboardActivityRepository {
  constructor(private db: DbClient) {}

  async getNewL0Companies(from: Date, to: Date): Promise<
    { id: string; target: string | null; project_name: string | null; source: string | null; segment: string | null; geography: string | null; remarks: string | null; thesis_content: string | null; event_at: string; reason: 'created' | 'demoted' }[]
  > {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const [created, demoted] = await Promise.all([
      // Newly created companies that started at L0
      this.db
        .select({
          id: companies.id,
          target: companies.target,
          project_name: companies.project_name,
          source: companies.source,
          segment: companies.segment,
          geography: companies.geography,
          remarks: companies.remarks,
          thesis_content: companies.thesis_content,
          event_at: companies.created_at,
        })
        .from(companies)
        .where(
          and(
            eq(companies.pipeline_stage, 'L0'),
            gte(companies.created_at, fromIso),
            lte(companies.created_at, toIso),
          ),
        ),

      // Companies moved/demoted back to L0 via a promotion log
      this.db
        .select({
          id: companies.id,
          target: companies.target,
          project_name: companies.project_name,
          source: companies.source,
          segment: companies.segment,
          geography: companies.geography,
          remarks: companies.remarks,
          thesis_content: companies.thesis_content,
          event_at: companyLogs.created_at,
        })
        .from(companyLogs)
        .innerJoin(companies, eq(companyLogs.company_id, companies.id))
        .where(
          and(
            like(companyLogs.action, '%_TO_L0'),
            logDateInRange(fromIso, toIso),
          ),
        ),
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

    return Array.from(map.values()).sort((a, b) =>
      b.event_at.localeCompare(a.event_at),
    );
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

  async getPipelineMoves(from: Date, to: Date) {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    return this.db
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
      })
      .from(companyLogs)
      .innerJoin(companies, eq(companyLogs.company_id, companies.id))
      .where(
        and(
          like(companyLogs.action, 'PROMOTED_%'),
          logDateInRange(fromIso, toIso),
        ),
      )
      .orderBy(desc(companies.updated_at));
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

  async getDroppedDeals(from: Date, to: Date) {
    return this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        pipeline_stage: companies.pipeline_stage,
        dropped_at: companies.dropped_at,
        dropped_reason: companies.dropped_reason,
        segment: companies.segment,
        geography: companies.geography,
        source: companies.source,
        thesis_content: companies.thesis_content,
      })
      .from(companies)
      .where(
        and(
          eq(companies.status, 'dropped'),
          gte(companies.dropped_at, from.toISOString()),
          lte(companies.dropped_at, to.toISOString()),
        ),
      )
      .orderBy(desc(companies.dropped_at));
  }

  async getNotesUpdated(from: Date, to: Date) {
    return this.db
      .select({
        id: dealNotes.id,
        company_id: dealNotes.deal_id,
        content: dealNotes.content,
        stage: dealNotes.stage,
        updated_at: dealNotes.updated_at,
        target: companies.target,
        project_name: companies.project_name,
        segment: companies.segment,
        geography: companies.geography,
        source: companies.source,
        remarks: companies.remarks,
        thesis_content: companies.thesis_content,
      })
      .from(dealNotes)
      .innerJoin(companies, eq(dealNotes.deal_id, companies.id))
      .where(
        and(
          gte(dealNotes.updated_at, from.toISOString()),
          lte(dealNotes.updated_at, to.toISOString()),
        ),
      )
      .orderBy(desc(dealNotes.updated_at));
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
