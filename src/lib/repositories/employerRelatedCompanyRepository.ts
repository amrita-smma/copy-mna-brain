import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  employers,
  employerRelatedCompanies,
  employerRelatedCompanyEvidence,
  userWorkspaces,
} from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type EmployerRelatedCompany = Tables<'employer_related_companies'>;
export type EmployerRelatedCompanyEvidence =
  Tables<'employer_related_company_evidence'>;

export type RelatedCompanyWithEvidence = EmployerRelatedCompany & {
  evidence: EmployerRelatedCompanyEvidence[];
};

/** One banker (employer) with a count of the distinct related companies attached
 * to it in a workspace — the row shape behind the "Banker related companies"
 * dashboard card and page. */
export interface EmployerRelatedCompanyRanking {
  employerId: string;
  employerName: string;
  /** Distinct related companies attached (auto + manual collapsed, mirroring the
   * employer card's dedupe: keyed on `company_id`, else the normalized name). */
  relatedCompanyCount: number;
  /** Of those, how many resolve to a company in Master Data (`company_id` set). */
  matchedCompanyCount: number;
  /** Most recent evidence timestamp across the attached companies, if any. */
  lastSeenAt: string | null;
}

export interface UpsertRelatedCompanyInput {
  employer_id: string;
  workspace_id: string;
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

  /**
   * A `source='manual'` link (createManual) is a durable membership — stays
   * regardless of any mailbox's sync state. Only `source='auto'` (ingest's
   * LLM-detected match) is gated on this workspace having at least one
   * currently synced member — workspace-level, matching
   * CorrespondentRepository.visibleCorrespondentIds exactly, so the same
   * un-sync action can't hide a related-company while leaving a contact from
   * the same mailbox visible on the same employer card (or vice versa).
   * Checking `!= 'auto'` rather than `= 'manual'` means a future new source
   * value defaults to visible, not silently hidden. Live, no refresh step
   * needed.
   */
  async listForEmployer(
    employerId: string,
    workspaceId: string,
  ): Promise<RelatedCompanyWithEvidence[]> {
    const rows = await this.db
      .select()
      .from(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.employer_id, employerId),
          eq(employerRelatedCompanies.workspace_id, workspaceId),
          isNull(employerRelatedCompanies.dismissed_at),
          or(
            sql`${employerRelatedCompanies.source} != 'auto'`,
            sql`EXISTS (
              SELECT 1 FROM ${userWorkspaces}
              WHERE ${userWorkspaces.workspace_id} = ${workspaceId}
                AND ${userWorkspaces.is_email_synced} = true
            )`,
          ),
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
        workspace_id: input.workspace_id,
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
        // Must match uq_erc_workspace_employer_company_source exactly — see
        // 20260705000002_employer_related_companies_workspace_id.sql.
        target: [
          employerRelatedCompanies.workspace_id,
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
    workspace_id: string;
    company_id: string;
    company_name: string;
    normalized_company_name: string;
  }): Promise<EmployerRelatedCompany> {
    const [row] = await this.db
      .insert(employerRelatedCompanies)
      .values({
        employer_id: input.employer_id,
        workspace_id: input.workspace_id,
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
  async deleteManual(
    employerId: string,
    id: string,
    workspaceId: string,
  ): Promise<void> {
    await this.db
      .delete(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.id, id),
          eq(employerRelatedCompanies.employer_id, employerId),
          eq(employerRelatedCompanies.workspace_id, workspaceId),
          eq(employerRelatedCompanies.source, 'manual'),
        ),
      );
  }

  /**
   * Rank every banker (employer) in the workspace by how many distinct related
   * companies are attached to it, most first. Uses the exact same visibility
   * rules as {@link listForEmployer} so the counts match what a user sees on the
   * employer cards: non-dismissed rows only, and `source='auto'` rows count only
   * when the workspace has at least one email-synced member.
   *
   * The distinct count collapses auto + manual rows for the same company — keyed
   * on `company_id`, falling back to the normalized name for auto rows that
   * haven't matched a Master Data company yet — mirroring `dedupeRelatedCompanies`
   * in the CRM service. Employers with no attached related companies are omitted
   * (INNER JOIN).
   */
  async rankByRelatedCompanyCount(
    workspaceId: string,
  ): Promise<EmployerRelatedCompanyRanking[]> {
    // "Same company" key: the matched company_id when present, else the
    // normalized name (namespaced so a name can't collide with a uuid).
    const dedupeKey = sql`coalesce(${employerRelatedCompanies.company_id}::text, 'name:' || ${employerRelatedCompanies.normalized_company_name})`;
    const relatedCount = sql<number>`count(distinct ${dedupeKey})`;

    const rows = await this.db
      .select({
        employerId: employers.id,
        employerName: employers.name,
        relatedCompanyCount: relatedCount,
        matchedCompanyCount: sql<number>`count(distinct ${employerRelatedCompanies.company_id})`,
        lastSeenAt: sql<string | null>`max(${employerRelatedCompanies.last_seen_at})`,
      })
      .from(employers)
      .innerJoin(
        employerRelatedCompanies,
        eq(employerRelatedCompanies.employer_id, employers.id),
      )
      .where(
        and(
          eq(employerRelatedCompanies.workspace_id, workspaceId),
          isNull(employerRelatedCompanies.dismissed_at),
          or(
            sql`${employerRelatedCompanies.source} != 'auto'`,
            sql`EXISTS (
              SELECT 1 FROM ${userWorkspaces}
              WHERE ${userWorkspaces.workspace_id} = ${workspaceId}
                AND ${userWorkspaces.is_email_synced} = true
            )`,
          ),
        ),
      )
      .groupBy(employers.id, employers.name)
      .orderBy(desc(relatedCount), employers.name);

    return rows.map((r) => ({
      employerId: String(r.employerId),
      employerName: String(r.employerName),
      relatedCompanyCount: Number(r.relatedCompanyCount),
      matchedCompanyCount: Number(r.matchedCompanyCount),
      lastSeenAt: r.lastSeenAt == null ? null : String(r.lastSeenAt),
    }));
  }

  /** Non-dismissed rows for an employer that link to a given company_id. */
  async findByCompanyId(
    employerId: string,
    companyId: string,
    workspaceId: string,
  ): Promise<EmployerRelatedCompany[]> {
    return this.db
      .select()
      .from(employerRelatedCompanies)
      .where(
        and(
          eq(employerRelatedCompanies.employer_id, employerId),
          eq(employerRelatedCompanies.company_id, companyId),
          eq(employerRelatedCompanies.workspace_id, workspaceId),
          isNull(employerRelatedCompanies.dismissed_at),
        ),
      );
  }
}
