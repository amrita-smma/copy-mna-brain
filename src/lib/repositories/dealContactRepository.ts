import { and, asc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import {
  companies,
  dealContacts,
  type DealContactOrigin,
  type DealContactRole,
  type DealContactStatus,
} from '@/lib/db/schema';
import { DISCOVERED_STAGE } from '@/lib/constants';
import { emailInWorkspace, sqlList } from './crmSql';
import type { DbClient } from './types';

/** A deal_contacts row joined to its company. */
export interface DealContactRow {
  id: string;
  workspaceId: string;
  companyId: string;
  correspondentId: string;
  role: DealContactRole;
  origin: DealContactOrigin;
  status: DealContactStatus;
  evidenceMessageId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  companyName: string;
  pipelineStage: string;
  companyStatus: 'active' | 'dropped';
  droppedAt: string | null;
  /** When the deal entered Brain (`companies.created_at`). */
  companyCreatedAt: string | null;
  geography: string | null;
  segment: string | null;
}

export interface ListForContactsOptions {
  /** Only links whose company was created at or after this ISO timestamp. */
  since?: string;
}

/** A plain deal_contacts row, without the company. */
export type DealContactRecord = typeof dealContacts.$inferSelect;

export interface UpsertDealContactInput {
  workspaceId: string;
  companyId: string;
  correspondentId: string;
  role: DealContactRole;
  origin: DealContactOrigin;
  status: DealContactStatus;
  evidenceMessageId?: string | null;
  createdBy?: string | null;
}

export interface FileSourceLinkScope {
  /** Only these files. */
  fileIds?: string[];
  /** Only files sent by these contacts (matched by address). */
  correspondentIds?: string[];
  /** Sender domains that never get a link (our own domains). */
  excludedSenderDomains: string[];
  /** Upper bound on links written by one call. */
  limit: number;
}

/** One link written by {@link DealContactRepository.insertFileSourceLinks}. */
export interface InsertedFileSourceLink {
  companyId: string;
  correspondentId: string;
  role: DealContactRole;
}

export interface EmailMentionLinkScope {
  /** Only these contacts. */
  correspondentIds?: string[];
  /** Only evidence rows written at or after this ISO timestamp. */
  since?: string;
  /** Participant domains that never get a link (our own domains). */
  excludedDomains: string[];
  /** Upper bound on links written by one call. */
  limit: number;
}

/** One link written by {@link DealContactRepository.insertEmailMentionLinks}. */
export interface InsertedEmailMentionLink {
  companyId: string;
  correspondentId: string;
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const companyName = sql<string>`COALESCE(NULLIF(${companies.target}, ''), NULLIF(${companies.project_name}, ''), '')`;

const linkColumns = {
  id: dealContacts.id,
  workspaceId: dealContacts.workspace_id,
  companyId: dealContacts.company_id,
  correspondentId: dealContacts.correspondent_id,
  role: dealContacts.role,
  origin: dealContacts.origin,
  status: dealContacts.status,
  evidenceMessageId: dealContacts.evidence_message_id,
  createdBy: dealContacts.created_by,
  createdAt: dealContacts.created_at,
  updatedAt: dealContacts.updated_at,
  companyName,
  pipelineStage: companies.pipeline_stage,
  companyStatus: companies.status,
  droppedAt: companies.dropped_at,
  companyCreatedAt: companies.created_at,
  geography: companies.geography,
  segment: companies.segment,
};

/**
 * Deal ↔ banker links (`deal_contacts`, MB-856). Every method is scoped to a
 * workspace and, for lists, one query for the whole id list. Links join only
 * companies of the same workspace, so a link can never surface across
 * workspaces even if a row were written wrongly.
 */
export class DealContactRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Active and dismissed links of these contacts, with their companies.
   * `since` keeps only companies created at or after it.
   */
  async listForContacts(
    workspaceId: string,
    correspondentIds: string[],
    opts: ListForContactsOptions = {},
  ): Promise<DealContactRow[]> {
    if (correspondentIds.length === 0) return [];
    return this.db
      .select(linkColumns)
      .from(dealContacts)
      .innerJoin(
        companies,
        and(eq(companies.id, dealContacts.company_id), eq(companies.workspace_id, workspaceId)),
      )
      .where(
        and(
          eq(dealContacts.workspace_id, workspaceId),
          inArray(dealContacts.correspondent_id, correspondentIds),
          opts.since ? gte(companies.created_at, opts.since) : undefined,
        ),
      )
      .orderBy(asc(dealContacts.correspondent_id), asc(dealContacts.created_at), asc(dealContacts.id));
  }

  /** Active links of these companies — who brought or is involved in each. */
  async listActiveForCompanies(
    workspaceId: string,
    companyIds: string[],
  ): Promise<Array<Pick<DealContactRow, 'companyId' | 'correspondentId' | 'role'>>> {
    if (companyIds.length === 0) return [];
    return this.db
      .select({
        companyId: dealContacts.company_id,
        correspondentId: dealContacts.correspondent_id,
        role: dealContacts.role,
      })
      .from(dealContacts)
      .where(
        and(
          eq(dealContacts.workspace_id, workspaceId),
          inArray(dealContacts.company_id, companyIds),
          eq(dealContacts.status, 'active'),
        ),
      )
      .orderBy(asc(dealContacts.company_id), asc(dealContacts.correspondent_id));
  }

  /** Whether the workspace has any active link at all. */
  async hasActiveLinks(workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: dealContacts.id })
      .from(dealContacts)
      .where(and(eq(dealContacts.workspace_id, workspaceId), eq(dealContacts.status, 'active')))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Insert the link, or overwrite role / origin / status on the existing row
   * for the pair. Keeps an existing evidence message and creator when the
   * input has none.
   */
  async upsertLink(input: UpsertDealContactInput): Promise<DealContactRecord> {
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(dealContacts)
      .values({
        workspace_id: input.workspaceId,
        company_id: input.companyId,
        correspondent_id: input.correspondentId,
        role: input.role,
        origin: input.origin,
        status: input.status,
        evidence_message_id: input.evidenceMessageId ?? null,
        created_by: input.createdBy ?? null,
      })
      .onConflictDoUpdate({
        // Must match uq_deal_contacts_workspace_company_correspondent.
        target: [dealContacts.workspace_id, dealContacts.company_id, dealContacts.correspondent_id],
        set: {
          role: input.role,
          origin: input.origin,
          status: input.status,
          evidence_message_id: sql`COALESCE(excluded.evidence_message_id, ${dealContacts.evidence_message_id})`,
          created_by: sql`COALESCE(excluded.created_by, ${dealContacts.created_by})`,
          updated_at: now,
        },
      })
      .returning();
    return row;
  }

  /** Set the status of an existing link; undefined when there is no such link. */
  async setStatus(
    workspaceId: string,
    companyId: string,
    correspondentId: string,
    status: DealContactStatus,
  ): Promise<DealContactRecord | undefined> {
    const [row] = await this.db
      .update(dealContacts)
      .set({ status, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(dealContacts.workspace_id, workspaceId),
          eq(dealContacts.company_id, companyId),
          eq(dealContacts.correspondent_id, correspondentId),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Deal links from email mentions, set-based: for every company of the
   * workspace that related-company evidence
   * (`analytics.employer_related_company_evidence`) ties to an email, and
   * every contact on that email as an external participant (any role), write
   * an active `involved` link with origin `auto_email` when the pair has no
   * deal_contacts row at all. Conditions:
   *
   * - the related company is not dismissed and resolves to a company of this
   *   workspace that is not in the `discovered` stage (dropped included);
   * - the email is attributed to this workspace (custodian bridge);
   * - the contact is visible in the workspace, is not an app user and is not
   *   at an excluded domain.
   *
   * Existing rows (any status) are never touched — `ON CONFLICT DO NOTHING` —
   * so the call is idempotent and a removed link stays removed. Never writes
   * `source`. `correspondentIds` narrows to those contacts; `since` to
   * evidence written at or after it.
   */
  async insertEmailMentionLinks(
    workspaceId: string,
    scope: EmailMentionLinkScope,
  ): Promise<InsertedEmailMentionLink[]> {
    if (scope.correspondentIds && scope.correspondentIds.length === 0) return [];
    const domains = scope.excludedDomains.map((d) => d.toLowerCase());
    const filters: SQL[] = [];
    if (scope.correspondentIds) {
      filters.push(sql`AND ep.correspondent_id IN (${sqlList(scope.correspondentIds)})`);
    }
    if (scope.since) filters.push(sql`AND ev.created_at >= ${scope.since}::timestamptz`);
    if (domains.length > 0) {
      filters.push(
        sql`AND lower(substring(ep.address from '@([^@]*)$')) NOT IN (${sqlList(domains)})`,
      );
    }
    const { rows } = await this.db.execute<{
      company_id: string;
      correspondent_id: string;
    }>(sql`
      INSERT INTO "public"."deal_contacts"
        (workspace_id, company_id, correspondent_id, role, origin, status)
      SELECT ${workspaceId}::uuid, cand.company_id, cand.correspondent_id,
             'involved', 'auto_email', 'active'
      FROM (
        SELECT DISTINCT erc.company_id, ep.correspondent_id
        FROM "public"."employer_related_companies" erc
        JOIN "public"."companies" c
          ON c.id = erc.company_id
         AND c.workspace_id = ${workspaceId}
         AND c.pipeline_stage <> ${DISCOVERED_STAGE}
        JOIN "analytics"."employer_related_company_evidence" ev
          ON ev.related_company_id = erc.id
        JOIN "analytics"."email_participants" ep
          ON ep.email_id = ev.email_id
         AND ep.user_id IS NULL
         AND ep.correspondent_id IS NOT NULL
        JOIN "analytics"."emails" em ON em.id = ev.email_id
        WHERE erc.workspace_id = ${workspaceId}
          AND erc.dismissed_at IS NULL
          AND erc.company_id IS NOT NULL
          -- The contact is visible in this workspace.
          AND EXISTS (
            SELECT 1 FROM "public"."workspace_correspondents" wc
            WHERE wc.workspace_id = ${workspaceId}
              AND wc.correspondent_id = ep.correspondent_id
          )
          -- The evidence email is attributed to this workspace (the
          -- email_workspace custodian bridge, inlined per row).
          AND ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
          -- Never a colleague: no app user at the participant's address.
          AND NOT EXISTS (
            SELECT 1 FROM "public"."users" u
            WHERE lower(u.email) = lower(ep.address)
          )
          -- Any existing link, active or dismissed, settles the pair.
          AND NOT EXISTS (
            SELECT 1 FROM "public"."deal_contacts" dc
            WHERE dc.workspace_id = ${workspaceId}
              AND dc.company_id = erc.company_id
              AND dc.correspondent_id = ep.correspondent_id
          )
          ${sql.join(filters, sql` `)}
        -- One lock order for concurrent callers (panel, overview job, ingest).
        ORDER BY erc.company_id, ep.correspondent_id
      ) cand
      LIMIT ${scope.limit}
      ON CONFLICT (workspace_id, company_id, correspondent_id) DO NOTHING
      RETURNING company_id, correspondent_id
    `);
    return rows.map((r) => ({ companyId: r.company_id, correspondentId: r.correspondent_id }));
  }

  /**
   * Smart Files source links, set-based: for every file of the workspace that
   * came from an email (`files.source_sender_email`), every company of the
   * workspace in its `matched_companies`, and every contact visible in the
   * workspace at the sender's address, write a link when the pair has none.
   * Role is `source` when the company was created from that file — its
   * `auto_created_from_file:<file id>` company log (Smart Files auto-create),
   * or `created_from_file:<file id>` (created from the file's review) — else
   * `involved`; a pair
   * seen on several files takes `source` if any file created the company,
   * then the earliest file's message id.
   *
   * Senders that are app users or at an excluded domain are skipped. Existing
   * rows (any status) are never touched — `ON CONFLICT DO NOTHING` — so the
   * call is idempotent and a dismissed link stays dismissed. A file whose
   * sender has no contact yet simply writes nothing until one exists.
   */
  async insertFileSourceLinks(
    workspaceId: string,
    scope: FileSourceLinkScope,
  ): Promise<InsertedFileSourceLink[]> {
    if (scope.fileIds && scope.fileIds.length === 0) return [];
    if (scope.correspondentIds && scope.correspondentIds.length === 0) return [];
    const domains = scope.excludedSenderDomains.map((d) => d.toLowerCase());
    const filters: SQL[] = [];
    if (scope.fileIds) filters.push(sql`AND f.id IN (${sqlList(scope.fileIds)})`);
    if (scope.correspondentIds) {
      filters.push(sql`AND co.id IN (${sqlList(scope.correspondentIds)})`);
      // Lets the planner reach files through idx_files_workspace_source_sender.
      filters.push(sql`AND lower(f.source_sender_email) IN (
        SELECT lower(sc.email) FROM "public"."correspondents" sc
        WHERE sc.id IN (${sqlList(scope.correspondentIds)}) AND sc.email IS NOT NULL
      )`);
    }
    if (domains.length > 0) {
      filters.push(
        sql`AND lower(substring(f.source_sender_email from '@([^@]*)$')) NOT IN (${sqlList(domains)})`,
      );
    }
    const { rows } = await this.db.execute<{
      company_id: string;
      correspondent_id: string;
      role: DealContactRole;
    }>(sql`
      INSERT INTO "public"."deal_contacts"
        (workspace_id, company_id, correspondent_id, role, origin, status, evidence_message_id)
      SELECT ${workspaceId}::uuid, cand.company_id, cand.correspondent_id,
             CASE WHEN cand.created_by_file THEN 'source' ELSE 'involved' END,
             'email_attachment', 'active', cand.source_message_id
      FROM (
        SELECT DISTINCT ON (c.id, co.id)
               c.id AS company_id, co.id AS correspondent_id,
               f.source_message_id,
               EXISTS (
                 SELECT 1 FROM "public"."company_logs" cl
                 WHERE cl.company_id = c.id
                   AND cl.action IN ('auto_created_from_file:' || f.id::text,
                                     'created_from_file:' || f.id::text)
               ) AS created_by_file
        FROM "public"."files" f
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(f.matched_companies) = 'array'
               THEN f.matched_companies ELSE '[]'::jsonb END
        ) AS mc(elem)
        JOIN "public"."companies" c
          -- AI suggestion chips carry a null or non-uuid id; never cast those.
          ON c.id = CASE WHEN mc.elem->>'id' ~ ${UUID_PATTERN}
                         THEN (mc.elem->>'id')::uuid END
         AND c.workspace_id = f.workspace_id
        JOIN "public"."correspondents" co
          ON lower(co.email) = lower(f.source_sender_email)
        JOIN "public"."workspace_correspondents" wc
          ON wc.correspondent_id = co.id
         AND wc.workspace_id = f.workspace_id
        WHERE f.workspace_id = ${workspaceId}
          AND f.source_sender_email IS NOT NULL
          AND btrim(f.source_sender_email) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM "public"."users" u
            WHERE lower(u.email) = lower(f.source_sender_email)
          )
          AND NOT EXISTS (
            SELECT 1 FROM "public"."deal_contacts" dc
            WHERE dc.workspace_id = f.workspace_id
              AND dc.company_id = c.id
              AND dc.correspondent_id = co.id
          )
          ${sql.join(filters, sql` `)}
        ORDER BY c.id, co.id, created_by_file DESC, f.created_at ASC NULLS LAST, f.id
      ) cand
      LIMIT ${scope.limit}
      ON CONFLICT (workspace_id, company_id, correspondent_id) DO NOTHING
      RETURNING company_id, correspondent_id, role
    `);
    return rows.map((r) => ({
      companyId: r.company_id,
      correspondentId: r.correspondent_id,
      role: r.role,
    }));
  }
}
