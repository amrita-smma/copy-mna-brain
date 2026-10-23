import { sql } from 'drizzle-orm';
import { emailInWorkspace, sqlList, toCount, toIso } from './crmSql';
import type { DbClient } from './types';

/** One (contact, team member) row of email interactions from the mart. */
export interface ContactEmailInteractionRow {
  correspondentId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  emailsFromUs: number;
  emailsFromThem: number;
  lastEmailAt: string | null;
}

/**
 * Distinct emails each way + last email per contact, across the whole team.
 * Not the sum of the per-member rows: an email to two colleagues is one email.
 */
export interface ContactEmailTotalRow {
  correspondentId: string;
  emailsFromUs: number;
  emailsFromThem: number;
  lastEmailAt: string | null;
}

/**
 * One team member's activity with one visible contact (MB-862): the mart's
 * all-time emails and the emails inside a recent window.
 */
export interface UserContactActivityRow {
  userId: string;
  correspondentId: string;
  contactName: string;
  firmName: string | null;
  emailsFromUs: number;
  emailsFromThem: number;
  lastEmailAt: string | null;
  /** Emails each way between the two sent in `[recentSince, now]`. */
  recentEmails: number;
}

/** A company the contact's own emails were evidence for. */
export interface ContactRelatedCompanyRow {
  correspondentId: string;
  companyId: string;
  companyName: string;
  evidenceCount: number;
  lastSeenAt: string | null;
}

/**
 * Per-person CRM interaction reads (MB-854): emails from
 * `analytics.mart_contact_interactions` (per member) and
 * `analytics.mart_contact_email_totals` (per contact), both defined in the
 * pipeline migration `*_contact_interactions.sql`, which owns the counting
 * rule. Every method is one query for the whole id list, scoped to
 * `workspaceId`.
 */
export class ContactInteractionRepository {
  constructor(private readonly db: DbClient) {}

  /** Emails each way + last email per (contact, team member). */
  async listEmailInteractions(
    workspaceId: string,
    correspondentIds: string[],
  ): Promise<ContactEmailInteractionRow[]> {
    if (correspondentIds.length === 0) return [];
    const { rows } = await this.db.execute<{
      correspondent_id: string;
      user_id: string;
      user_name: string | null;
      user_email: string | null;
      emails_from_us: unknown;
      emails_from_them: unknown;
      last_email_at: unknown;
    }>(sql`
      SELECT mci.correspondent_id, mci.user_id, u.name AS user_name,
             u.email AS user_email, mci.emails_from_us, mci.emails_from_them,
             mci.last_email_at
      FROM "analytics"."mart_contact_interactions" mci
      JOIN "public"."users" u ON u.id = mci.user_id
      WHERE mci.workspace_id = ${workspaceId}
        AND mci.correspondent_id IN (${sqlList(correspondentIds)})
      ORDER BY mci.correspondent_id, mci.user_id
    `);
    return rows.map((r) => ({
      correspondentId: r.correspondent_id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      emailsFromUs: toCount(r.emails_from_us),
      emailsFromThem: toCount(r.emails_from_them),
      lastEmailAt: toIso(r.last_email_at),
    }));
  }

  /**
   * Distinct emails each way + last email per contact, from the per-contact
   * mart. A contact with no counted email has no row.
   */
  async listEmailTotals(
    workspaceId: string,
    correspondentIds: string[],
  ): Promise<ContactEmailTotalRow[]> {
    if (correspondentIds.length === 0) return [];
    const { rows } = await this.db.execute<{
      correspondent_id: string;
      emails_from_us: unknown;
      emails_from_them: unknown;
      last_email_at: unknown;
    }>(sql`
      SELECT t.correspondent_id, t.emails_from_us, t.emails_from_them,
             t.last_email_at
      FROM "analytics"."mart_contact_email_totals" t
      WHERE t.workspace_id = ${workspaceId}
        AND t.correspondent_id IN (${sqlList(correspondentIds)})
      ORDER BY t.correspondent_id
    `);
    return rows.map((r) => ({
      correspondentId: r.correspondent_id,
      emailsFromUs: toCount(r.emails_from_us),
      emailsFromThem: toCount(r.emails_from_them),
      lastEmailAt: toIso(r.last_email_at),
    }));
  }

  /**
   * Person-level related companies: the workspace's related-company evidence
   * restricted to emails this contact took part in (any role). Same
   * visibility as `EmployerRelatedCompanyRepository.listForEmployer` —
   * non-dismissed rows that resolved to a company — plus the evidence email
   * must belong to the workspace; one row per
   * (contact, company) even when auto and manual rows both point at it.
   */
  async listRelatedCompaniesForContacts(
    workspaceId: string,
    correspondentIds: string[],
  ): Promise<ContactRelatedCompanyRow[]> {
    if (correspondentIds.length === 0) return [];
    const { rows } = await this.db.execute<{
      correspondent_id: string;
      company_id: string;
      company_name: string | null;
      evidence_count: unknown;
      last_seen_at: unknown;
    }>(sql`
      SELECT ep.correspondent_id, erc.company_id,
             max(COALESCE(NULLIF(c.target, ''), NULLIF(c.project_name, ''), erc.company_name)) AS company_name,
             count(DISTINCT ev.email_id)::int AS evidence_count,
             max(em.sent_at) AS last_seen_at
      FROM "public"."employer_related_companies" erc
      JOIN "analytics"."employer_related_company_evidence" ev
        ON ev.related_company_id = erc.id
      JOIN "analytics"."email_participants" ep
        ON ep.email_id = ev.email_id
       AND ep.correspondent_id IN (${sqlList(correspondentIds)})
      JOIN "analytics"."emails" em ON em.id = ev.email_id
      LEFT JOIN "public"."companies" c ON c.id = erc.company_id
      WHERE erc.workspace_id = ${workspaceId}
        AND erc.dismissed_at IS NULL
        AND erc.company_id IS NOT NULL
        -- The evidence email itself is attributed to this workspace (the
        -- email_workspace bridge, inlined so the check stays per-row).
        AND ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
      GROUP BY ep.correspondent_id, erc.company_id
      ORDER BY ep.correspondent_id, evidence_count DESC, last_seen_at DESC NULLS LAST
    `);
    return rows.map((r) => ({
      correspondentId: r.correspondent_id,
      companyId: r.company_id,
      companyName: r.company_name ?? '',
      evidenceCount: toCount(r.evidence_count),
      lastSeenAt: toIso(r.last_seen_at),
    }));
  }

  /**
   * Per (team member, contact) activity for these members, in one query
   * (MB-862 "Ask Brain"). Only the listed users' own pairs are read — never
   * another member's — and only contacts visible in the CRM (the banker list
   * visibility: in `workspace_correspondents`, published employer), with
   * names from the effective (curated) views.
   *
   * All-time emails come from `mart_contact_interactions`. The recent
   * email count is read live from `analytics.emails` because the mart has no
   * per-period counts: its pair rule is the mart's verbatim (one sender, the
   * other a to/cc recipient, never two cc's) — change both together — and the
   * workspace attribution is the `email_workspace` custodian bridge, inlined.
   */
  async listUserContactActivity(
    workspaceId: string,
    userIds: string[],
    now: Date,
    recentSince: Date,
  ): Promise<UserContactActivityRow[]> {
    if (userIds.length === 0) return [];
    const users = sqlList(userIds);
    const nowIso = now.toISOString();
    const sinceIso = recentSince.toISOString();
    const { rows } = await this.db.execute<{
      user_id: string;
      correspondent_id: string;
      contact_name: string | null;
      firm_name: string | null;
      emails_from_us: unknown;
      emails_from_them: unknown;
      last_email_at: unknown;
      recent_emails: unknown;
    }>(sql`
      WITH mart AS (
        SELECT mci.user_id, mci.correspondent_id, mci.emails_from_us,
               mci.emails_from_them, mci.last_email_at
        FROM "analytics"."mart_contact_interactions" mci
        WHERE mci.workspace_id = ${workspaceId}
          AND mci.user_id IN (${users})
      ),
      recent AS (
        SELECT up.user_id, cp.correspondent_id,
               count(DISTINCT em.id)::int AS recent_emails
        FROM "analytics"."emails" em
        JOIN "analytics"."email_participants" up
          ON up.email_id = em.id
         AND up.user_id IN (${users})
        JOIN "public"."user_workspaces" uw
          ON uw.user_id = up.user_id
         AND uw.workspace_id = ${workspaceId}
        JOIN "analytics"."email_participants" cp
          ON cp.email_id = em.id
         AND cp.correspondent_id IS NOT NULL
         AND cp.user_id IS NULL
         AND cp.address <> up.address
        WHERE em.sent_at >= ${sinceIso}
          AND em.sent_at <= ${nowIso}
          AND ((up.role = 'from' AND cp.role IN ('to', 'cc'))
            OR (cp.role = 'from' AND up.role IN ('to', 'cc')))
          AND ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
        GROUP BY up.user_id, cp.correspondent_id
      ),
      pairs AS (
        SELECT user_id, correspondent_id FROM mart
        UNION
        SELECT user_id, correspondent_id FROM recent
      )
      SELECT pr.user_id, pr.correspondent_id, ce.name AS contact_name,
             ee.name AS firm_name,
             COALESCE(mart.emails_from_us, 0) AS emails_from_us,
             COALESCE(mart.emails_from_them, 0) AS emails_from_them,
             mart.last_email_at,
             COALESCE(recent.recent_emails, 0) AS recent_emails
      FROM pairs pr
      JOIN "public"."correspondent_workspace_effective" ce
        ON ce.id = pr.correspondent_id
       AND ce.workspace_id = ${workspaceId}
      JOIN "public"."employer_workspace_effective" ee
        ON ee.id = ce.employer_id
       AND ee.workspace_id = ce.workspace_id
       AND ee.curation_status = 'published'
      LEFT JOIN mart
        ON mart.user_id = pr.user_id AND mart.correspondent_id = pr.correspondent_id
      LEFT JOIN recent
        ON recent.user_id = pr.user_id AND recent.correspondent_id = pr.correspondent_id
      ORDER BY pr.user_id, pr.correspondent_id
    `);
    return rows.map((r) => ({
      userId: r.user_id,
      correspondentId: r.correspondent_id,
      contactName: r.contact_name ?? '',
      firmName: r.firm_name,
      emailsFromUs: toCount(r.emails_from_us),
      emailsFromThem: toCount(r.emails_from_them),
      lastEmailAt: toIso(r.last_email_at),
      recentEmails: toCount(r.recent_emails),
    }));
  }

  /**
   * Whether any email is attributed to the workspace — lets the UI tell "no
   * interactions with this person" from "nothing synced yet". Walks the same
   * custodian bridge as `email_workspace` directly, so the EXISTS stops at the
   * first indexed hit instead of evaluating the DISTINCT view.
   */
  async workspaceHasSyncedData(workspaceId: string): Promise<boolean> {
    const { rows } = await this.db.execute<{ has_data: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "public"."user_workspaces" uw
        JOIN "public"."users" u ON u.id = uw.user_id
        JOIN "analytics"."emails" em ON em.custodian_email = u.email
        WHERE uw.workspace_id = ${workspaceId}
      ) AS has_data
    `);
    return rows[0]?.has_data === true;
  }
}
