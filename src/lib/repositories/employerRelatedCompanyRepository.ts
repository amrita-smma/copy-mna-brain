import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  employerRelatedCompanies,
  employerRelatedCompanyEvidence,
} from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type EmployerRelatedCompany = Tables<'employer_related_companies'>;
export type EmployerRelatedCompanyEvidence =
  Tables<'employer_related_company_evidence'>;

export type RelatedCompanyWithEvidence = EmployerRelatedCompany & {
  evidence: EmployerRelatedCompanyEvidence[];
};

export interface UpsertRelatedCompanyInput {
  employer_id: string;
  company_id: string | null;
  company_name: string;
  normalized_company_name: string;
  source: string;
  reason: string;
  reason_summary: string | null;
}

export interface InsertEvidenceInput {
  related_company_id: string;
  email_id: string | null;
  raw_email_id: string | null;
  matched_text: string | null;
  reason: string;
  reason_summary: string | null;
  keywords: string[];
  confidence: string;
}

export class EmployerRelatedCompanyRepository {
  constructor(private readonly db: DbClient) {}

  async listForEmployer(employerId: string): Promise<RelatedCompanyWithEvidence[]> {
    const rows = await this.db
      .select()
      .from(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.employer_id, employerId),
          isNull(employerRelatedCompanies.dismissed_at),
        ),
      );

    if (rows.length === 0) return [];

    const evidenceRows = await this.db
      .select()
      .from(employerRelatedCompanyEvidence)
      .where(
        inArray(
          employerRelatedCompanyEvidence.related_company_id,
          rows.map((r) => r.id),
        ),
      );

    const evidenceByRelatedId = new Map<string, EmployerRelatedCompanyEvidence[]>();
    for (const e of evidenceRows) {
      const arr = evidenceByRelatedId.get(e.related_company_id) ?? [];
      arr.push(e);
      evidenceByRelatedId.set(e.related_company_id, arr);
    }

    return rows.map((r) => ({
      ...r,
      evidence: evidenceByRelatedId.get(r.id) ?? [],
    }));
  }

  /**
   * Insert-or-backfill the auto aggregate row. Returns the row id.
   *
   * On conflict we update `company_id` only when the existing value is NULL
   * — so re-ingest fills in a link once the matching company is added to
   * Master Data, without overwriting a link that was already resolved.
   * All other columns are left untouched on conflict.
   */
  async upsertAuto(input: UpsertRelatedCompanyInput): Promise<string> {
    const [row] = await this.db
      .insert(employerRelatedCompanies)
      .values({
        employer_id: input.employer_id,
        company_id: input.company_id,
        company_name: input.company_name,
        normalized_company_name: input.normalized_company_name,
        source: input.source,
        reason: input.reason,
        reason_summary: input.reason_summary,
        confidence: 'medium',
        evidence_count: 0,
      } satisfies TablesInsert<'employer_related_companies'>)
      .onConflictDoUpdate({
        target: [
          employerRelatedCompanies.employer_id,
          employerRelatedCompanies.normalized_company_name,
          employerRelatedCompanies.source,
        ],
        set: {
          company_id: sql`CASE WHEN ${employerRelatedCompanies.company_id} IS NULL THEN EXCLUDED.company_id ELSE ${employerRelatedCompanies.company_id} END`,
        },
      })
      .returning({ id: employerRelatedCompanies.id });
    return row.id;
  }

  /** Insert evidence row, ignoring duplicates (safe to re-run). */
  async insertEvidence(input: InsertEvidenceInput): Promise<void> {
    await this.db
      .insert(employerRelatedCompanyEvidence)
      .values({
        related_company_id: input.related_company_id,
        email_id: input.email_id,
        raw_email_id: input.raw_email_id,
        matched_text: input.matched_text,
        reason: input.reason,
        reason_summary: input.reason_summary,
        keywords: input.keywords,
        confidence: input.confidence,
      } satisfies TablesInsert<'employer_related_company_evidence'>)
      .onConflictDoNothing();
  }

  /**
   * Derive aggregate fields from evidence — count, first/last seen, max confidence.
   * Called after inserting evidence rows. Safe to call multiple times (idempotent).
   */
  async refreshAggregates(relatedCompanyId: string): Promise<void> {
    const CONFIDENCE_ORDER = sql`CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;
    await this.db
      .update(employerRelatedCompanies)
      .set({
        evidence_count: sql`(
          SELECT COUNT(*) FROM analytics.employer_related_company_evidence
          WHERE related_company_id = ${relatedCompanyId}
        )`,
        first_seen_at: sql`(
          SELECT MIN(created_at) FROM analytics.employer_related_company_evidence
          WHERE related_company_id = ${relatedCompanyId}
        )`,
        last_seen_at: sql`(
          SELECT MAX(created_at) FROM analytics.employer_related_company_evidence
          WHERE related_company_id = ${relatedCompanyId}
        )`,
        confidence: sql`(
          SELECT CASE MAX(${CONFIDENCE_ORDER})
            WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low'
          END
          FROM analytics.employer_related_company_evidence
          WHERE related_company_id = ${relatedCompanyId}
        )`,
        updated_at: new Date().toISOString(),
      })
      .where(eq(employerRelatedCompanies.id, relatedCompanyId));
  }

  async dismiss(id: string): Promise<void> {
    await this.db
      .update(employerRelatedCompanies)
      .set({ dismissed_at: new Date().toISOString() })
      .where(eq(employerRelatedCompanies.id, id));
  }

  /**
   * Insert a user-added (source='manual') related company. Returns the new row.
   * `reason`/`confidence` are NOT NULL columns with no LLM meaning here, so we
   * store sentinel values. Manual rows carry no evidence.
   */
  async createManual(input: {
    employer_id: string;
    company_id: string;
    company_name: string;
    normalized_company_name: string;
  }): Promise<EmployerRelatedCompany> {
    const [row] = await this.db
      .insert(employerRelatedCompanies)
      .values({
        employer_id: input.employer_id,
        company_id: input.company_id,
        company_name: input.company_name,
        normalized_company_name: input.normalized_company_name,
        source: 'manual',
        reason: 'manual',
        reason_summary: 'Added manually',
        confidence: 'high',
        evidence_count: 0,
      } satisfies TablesInsert<'employer_related_companies'>)
      .returning();
    return row;
  }

  /**
   * Hard-delete a manual related company. Guarded to source='manual' so an auto
   * suggestion can never be destroyed here (use `dismiss` for those). Hard delete
   * — not dismiss — so the user can re-add the same company later without the
   * UNIQUE(employer_id, normalized_company_name, source) slot staying occupied by
   * a soft-dismissed row. Evidence (none for manual) cascades.
   */
  async deleteManual(employerId: string, id: string): Promise<void> {
    await this.db
      .delete(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.id, id),
          eq(employerRelatedCompanies.employer_id, employerId),
          eq(employerRelatedCompanies.source, 'manual'),
        ),
      );
  }

  /** Non-dismissed rows for an employer that link to a given company_id. */
  async findByCompanyId(
    employerId: string,
    companyId: string,
  ): Promise<EmployerRelatedCompany[]> {
    return this.db
      .select()
      .from(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.employer_id, employerId),
          eq(employerRelatedCompanies.company_id, companyId),
          isNull(employerRelatedCompanies.dismissed_at),
        ),
      );
  }
}
