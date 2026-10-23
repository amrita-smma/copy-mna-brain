import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  contactRelationshipOverviews,
  emails,
  emailNotes,
  emailParticipants,
  users,
  userWorkspaces,
} from '@/lib/db/schema';
import type { ContactRelationshipOverview } from '@/lib/db/schema';
import type { DbClient } from './types';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { emailInWorkspace, sqlList, toCount, toIso, viewerCanSeeEmail } from './crmSql';

export type RoleLabel =
  | 'funding'
  | 'lending'
  | 'finance'
  | 'tax'
  | 'advisory'
  | 'legal'
  | 'due_diligence'
  | 'principal'
  | 'other';
export type RoleConfidence = 'high' | 'medium' | 'low';

export interface ContactRoleInference {
  label: RoleLabel;
  /** Highest confidence seen for this label across the contact's emails. */
  confidence: RoleConfidence;
  /** Distinct emails carrying this label for this contact. */
  emailCount: number;
}

export interface ContactRoleSummary {
  /** Ordered by confidence (high > medium > low), then emailCount desc. */
  roles: ContactRoleInference[];
  /** Distinct emails with any role signal for this contact. */
  emailCount: number;
  /** Most recent evidence sentence at the highest confidence present; null when no roles. */
  evidence: string | null;
}

export interface ConversationNoteMember {
  userId: string;
  name: string;
}

export interface ConversationNote {
  emailId: string;
  sentAt: string;
  direction: 'inbound' | 'outbound';
  /** Workspace team members on the email; the sender first when it is one of us. */
  teamMembers: ConversationNoteMember[];
  summary: string;
  keyPoints: string[];
  nextStep: string | null;
  nextStepStatus: 'action' | 'done' | 'none';
  sentiment: 'positive' | 'neutral' | 'negative';
}

export interface ListNotesFilters {
  cursor?: string;
  limit?: number;
}

export interface ListNotesResult {
  notes: ConversationNote[];
  nextCursor: string | null;
}

export interface NoteInputHash {
  noteCount: number;
  latestEmailId: string | null;
  /** Companies the contact has an active deal link to in the workspace. */
  dealCompanyIds: string[];
}

/** A contact whose notes changed since `since`, with what its overview is built from. */
export interface OverviewRefreshCandidate {
  correspondentId: string;
  noteCount: number;
  latestEmailId: string | null;
  dealCompanyIds: string[];
  /** The overview row; null fields when the contact has none. */
  status: 'pending' | 'ready' | 'failed' | null;
  inputHash: string | null;
  hasText: boolean;
  updatedAt: string | null;
}

/** One line per linked deal on what the contact did on it. */
export interface OverviewDealNote {
  companyId: string;
  note: string;
}

/** Past this age a 'pending' overview row no longer blocks a new claim. */
export const OVERVIEW_PENDING_ABANDONED_MINUTES = 5;

/** The email has related-company evidence for this deal and the contact is on it. */
export interface DealEvidenceEmail {
  companyId: string;
  emailId: string;
}

function encodeCursor(sentAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ sentAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): { sentAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.sentAt === 'string' && typeof parsed?.id === 'string') {
      return { sentAt: parsed.sentAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function confFromRank(rank: number): RoleConfidence {
  if (rank >= 3) return 'high';
  if (rank === 2) return 'medium';
  return 'low';
}

/**
 * The contact's active deal links in the workspace, sorted — one of the
 * overview hash inputs. `getNoteInputHash` and `listOverviewRefreshCandidates`
 * must read the same set, so both use this.
 */
function dealCompanyIdsSql(workspaceId: string, correspondentId: string | SQL): SQL {
  return sql`(
    SELECT coalesce(array_agg(dc.company_id::text ORDER BY dc.company_id), '{}')
    FROM "public"."deal_contacts" dc
    JOIN "public"."companies" c
      ON c.id = dc.company_id AND c.workspace_id = ${workspaceId}
    WHERE dc.workspace_id = ${workspaceId}
      AND dc.correspondent_id = ${correspondentId}
      AND dc.status = 'active'
  )`;
}

export class ContactConversationRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Notes for emails where the contact is a participant and the email is
   * visible in the workspace, joined to email_notes with summary IS NOT NULL,
   * newest first, keyset pagination on (sent_at, email_id).
   */
  async listNotes(
    workspaceId: string,
    correspondentId: string,
    viewerUserId: string,
    opts: ListNotesFilters = {},
  ): Promise<ListNotesResult> {
    return this.queryNotes(workspaceId, correspondentId, viewerUserId, opts);
  }

  /**
   * SYSTEM ONLY — every note, whoever was on the email. For the shared
   * relationship overview job, and for AI Workforce runs, which may use the
   * full context but whose trace never shows it (the tool outputs are
   * redacted; only the run's report is shared). Never from a route.
   */
  async listNotesForSystem(
    workspaceId: string,
    correspondentId: string,
    opts: ListNotesFilters = {},
  ): Promise<ListNotesResult> {
    return this.queryNotes(workspaceId, correspondentId, null, opts);
  }

  /**
   * Email notes are private to the people on the email: From/To/Cc, or the
   * mailbox it was synced from (Bcc and list mail reach a custodian who is not
   * on the header). `viewerUserId` null is a SYSTEM read (the shared
   * relationship overview) and must never come from a route.
   */
  private async queryNotes(
    workspaceId: string,
    correspondentId: string,
    viewerUserId: string | null,
    opts: ListNotesFilters,
  ): Promise<ListNotesResult> {
    if (!workspaceId || !correspondentId) {
      return { notes: [], nextCursor: null };
    }
    if (viewerUserId !== null && !viewerUserId) {
      return { notes: [], nextCursor: null };
    }

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const decodedCursor = opts.cursor ? decodeCursor(opts.cursor) : null;

    const conditions: SQL[] = [
      isNotNull(emailNotes.summary),
      sql`EXISTS (
        SELECT 1
        FROM "analytics"."email_participants" cp
        WHERE cp.email_id = ${emails.id}
          AND cp.correspondent_id = ${correspondentId}
      )`,
      emailInWorkspace(emails.custodian_email, workspaceId),
    ];

    if (viewerUserId !== null) {
      conditions.push(viewerCanSeeEmail(emails.id, emails.custodian_email, viewerUserId));
    }

    if (decodedCursor) {
      conditions.push(
        sql`(${emails.sent_at}, ${emails.id}) < (${decodedCursor.sentAt}::timestamptz, ${decodedCursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select({
        emailId: emails.id,
        sentAt: emails.sent_at,
        direction: emails.direction,
        summary: emailNotes.summary,
        keyPoints: emailNotes.key_points,
        nextStep: emailNotes.next_step,
        nextStepStatus: emailNotes.next_step_status,
        sentiment: emailNotes.sentiment,
      })
      .from(emails)
      .innerJoin(emailNotes, eq(emailNotes.email_id, emails.id))
      .where(and(...conditions))
      .orderBy(desc(emails.sent_at), desc(emails.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    if (pageRows.length === 0) {
      return { notes: [], nextCursor: null };
    }

    const pageEmailIds = pageRows.map((r) => r.emailId);

    // ONE batched query for team members across all notes on the page
    const memberRows = await this.db
      .select({
        emailId: emailParticipants.email_id,
        userId: emailParticipants.user_id,
        name: users.name,
        role: emailParticipants.role,
      })
      .from(emailParticipants)
      .innerJoin(
        userWorkspaces,
        and(
          eq(userWorkspaces.user_id, emailParticipants.user_id),
          eq(userWorkspaces.workspace_id, workspaceId),
        ),
      )
      .innerJoin(users, eq(users.id, emailParticipants.user_id))
      .where(
        and(
          inArray(emailParticipants.email_id, pageEmailIds),
          isNotNull(emailParticipants.user_id),
        ),
      )
      .orderBy(
        asc(emailParticipants.email_id),
        sql`CASE WHEN ${emailParticipants.role} = 'from' THEN 0 ELSE 1 END`,
        asc(users.name),
      );

    const membersByEmail = new Map<string, ConversationNoteMember[]>();
    const seenUserByEmail = new Map<string, Set<string>>();

    for (const m of memberRows) {
      if (!m.userId) continue;
      let members = membersByEmail.get(m.emailId);
      let seen = seenUserByEmail.get(m.emailId);
      if (!members) {
        members = [];
        membersByEmail.set(m.emailId, members);
        seen = new Set<string>();
        seenUserByEmail.set(m.emailId, seen);
      }
      if (!seen!.has(m.userId)) {
        seen!.add(m.userId);
        members.push({
          userId: m.userId,
          name: decodeHtmlEntities(m.name ?? ''),
        });
      }
    }

    const notes: ConversationNote[] = pageRows.map((r) => ({
      emailId: r.emailId,
      sentAt: toIso(r.sentAt) ?? r.sentAt,
      // emails.direction is untyped text; the pipeline writes only these two.
      direction: r.direction as 'inbound' | 'outbound',
      teamMembers: membersByEmail.get(r.emailId) ?? [],
      summary: r.summary ?? '',
      keyPoints: r.keyPoints,
      nextStep: r.nextStep,
      nextStepStatus: r.nextStepStatus,
      sentiment: r.sentiment,
    }));

    const lastItem = pageRows[pageRows.length - 1];
    const nextCursor = hasMore
      ? encodeCursor(toIso(lastItem.sentAt) ?? lastItem.sentAt, lastItem.emailId)
      : null;

    return { notes, nextCursor };
  }

  /**
   * One query: per label, the max confidence and count of distinct emails;
   * plus the total distinct emails and the most recent evidence at the highest
   * confidence present. The labels and counts cover every email (they only
   * say what kind of banker this is); the evidence sentence comes only from
   * an email the viewer is on or that is in their mailbox, because it
   * paraphrases that email.
   */
  async getRoleRollup(
    workspaceId: string,
    correspondentId: string,
    viewerUserId: string,
  ): Promise<ContactRoleSummary> {
    return this.queryRoleRollup(
      workspaceId,
      correspondentId,
      viewerUserId
        ? viewerCanSeeEmail(sql`signals.email_id`, sql`signals.custodian_email`, viewerUserId)
        : sql`FALSE`,
    );
  }

  /** SYSTEM ONLY — evidence from any email, for the shared relationship overview job. */
  async getRoleRollupForSystem(
    workspaceId: string,
    correspondentId: string,
  ): Promise<ContactRoleSummary> {
    return this.queryRoleRollup(workspaceId, correspondentId, sql`TRUE`);
  }

  /** `evidenceFilter` picks which signals the evidence sentence may come from. */
  private async queryRoleRollup(
    workspaceId: string,
    correspondentId: string,
    evidenceFilter: SQL,
  ): Promise<ContactRoleSummary> {
    if (!workspaceId || !correspondentId) {
      return { roles: [], emailCount: 0, evidence: null };
    }

    const { rows } = await this.db.execute<{
      label: RoleLabel;
      max_conf_rank: number;
      email_count: number;
      total_email_count: number;
      evidence: string | null;
    }>(sql`
      WITH signals AS (
        SELECT
          ers.label,
          ers.confidence,
          CASE ers.confidence
            WHEN 'high' THEN 3
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 1
            ELSE 0
          END AS conf_rank,
          ers.evidence,
          ers.email_id,
          em.sent_at,
          em.custodian_email,
          ers.created_at
        FROM "analytics"."email_role_signals" ers
        JOIN "analytics"."emails" em ON em.id = ers.email_id
        JOIN "analytics"."email_participants" ep
          ON ep.email_id = ers.email_id
         AND lower(ep.address) = lower(ers.address)
         AND ep.correspondent_id = ${correspondentId}
        WHERE ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
      )
      SELECT
        pl.label,
        pl.max_conf_rank,
        pl.email_count,
        (SELECT count(DISTINCT email_id)::int FROM signals) AS total_email_count,
        (SELECT evidence FROM signals WHERE ${evidenceFilter}
         ORDER BY conf_rank DESC, sent_at DESC, created_at DESC LIMIT 1) AS evidence
      FROM (
        SELECT
          label,
          max(conf_rank) AS max_conf_rank,
          count(DISTINCT email_id)::int AS email_count
        FROM signals
        GROUP BY label
      ) pl
      ORDER BY pl.max_conf_rank DESC, pl.email_count DESC
    `);

    if (rows.length === 0) {
      return { roles: [], emailCount: 0, evidence: null };
    }
    return {
      roles: rows.map((r) => ({
        label: r.label,
        confidence: confFromRank(toCount(r.max_conf_rank)),
        emailCount: toCount(r.email_count),
      })),
      emailCount: toCount(rows[0].total_email_count),
      evidence: rows[0].evidence,
    };
  }

  /**
   * The overview hash inputs: note count and newest noted email, in one scan,
   * plus the active deal links.
   */
  async getNoteInputHash(
    workspaceId: string,
    correspondentId: string,
  ): Promise<NoteInputHash> {
    if (!workspaceId || !correspondentId) {
      return { noteCount: 0, latestEmailId: null, dealCompanyIds: [] };
    }

    const {
      rows: [row],
    } = await this.db.execute<{
      note_count: number;
      latest_email_id: string | null;
      deal_company_ids: string[];
    }>(sql`
      SELECT
        count(*)::int AS note_count,
        (array_agg(em.id::text ORDER BY em.sent_at DESC, em.id DESC))[1] AS latest_email_id,
        ${dealCompanyIdsSql(workspaceId, correspondentId)} AS deal_company_ids
      FROM "analytics"."emails" em
      JOIN "analytics"."email_notes" en ON en.email_id = em.id
      JOIN "analytics"."email_participants" cp
        ON cp.email_id = em.id
       AND cp.correspondent_id = ${correspondentId}
      WHERE en.summary IS NOT NULL
        AND ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
    `);
    return {
      noteCount: toCount(row.note_count),
      latestEmailId: row.latest_email_id,
      dealCompanyIds: row.deal_company_ids,
    };
  }

  /**
   * Contacts on an email whose note was written at or after `since`, visible
   * in the workspace, with the same inputs `getNoteInputHash` reads (one row
   * per contact, newest activity first) and their overview row. One query for
   * any number of contacts — the post-ingest refresh's candidate list.
   */
  async listOverviewRefreshCandidates(
    workspaceId: string,
    since: string,
  ): Promise<OverviewRefreshCandidate[]> {
    if (!workspaceId) return [];
    const { rows } = await this.db.execute<{
      correspondent_id: string;
      note_count: number;
      latest_email_id: string | null;
      deal_company_ids: string[];
      status: OverviewRefreshCandidate['status'];
      input_hash: string | null;
      has_text: boolean;
      updated_at: string | null;
    }>(sql`
      WITH touched AS (
        SELECT DISTINCT tp.correspondent_id
        FROM "analytics"."email_notes" tn
        JOIN "analytics"."emails" te ON te.id = tn.email_id
        JOIN "analytics"."email_participants" tp
          ON tp.email_id = tn.email_id
         AND tp.correspondent_id IS NOT NULL
        WHERE tn.created_at >= ${since}
          AND tn.summary IS NOT NULL
          AND ${emailInWorkspace(sql`te.custodian_email`, workspaceId)}
          AND EXISTS (
            SELECT 1 FROM "public"."workspace_correspondents" wc
            WHERE wc.workspace_id = ${workspaceId}
              AND wc.correspondent_id = tp.correspondent_id
          )
      ),
      noted AS (
        SELECT cp.correspondent_id, em.id, em.sent_at
        FROM touched t
        JOIN "analytics"."email_participants" cp ON cp.correspondent_id = t.correspondent_id
        JOIN "analytics"."emails" em ON em.id = cp.email_id
        JOIN "analytics"."email_notes" en ON en.email_id = em.id AND en.summary IS NOT NULL
        WHERE ${emailInWorkspace(sql`em.custodian_email`, workspaceId)}
      )
      SELECT
        n.correspondent_id,
        count(*)::int AS note_count,
        (array_agg(n.id::text ORDER BY n.sent_at DESC, n.id DESC))[1] AS latest_email_id,
        max(n.sent_at) AS latest_sent_at,
        ${dealCompanyIdsSql(workspaceId, sql`n.correspondent_id`)} AS deal_company_ids,
        o.status,
        o.input_hash,
        (o.overview IS NOT NULL) AS has_text,
        o.updated_at
      FROM noted n
      LEFT JOIN "public"."contact_relationship_overviews" o
        ON o.workspace_id = ${workspaceId}
       AND o.correspondent_id = n.correspondent_id
      GROUP BY n.correspondent_id, o.status, o.input_hash, o.overview, o.updated_at
      ORDER BY latest_sent_at DESC, n.correspondent_id
    `);
    return rows.map((r) => ({
      correspondentId: r.correspondent_id,
      noteCount: toCount(r.note_count),
      latestEmailId: r.latest_email_id,
      dealCompanyIds: r.deal_company_ids,
      status: r.status,
      inputHash: r.input_hash,
      hasText: r.has_text,
      updatedAt: toIso(r.updated_at),
    }));
  }

  /**
   * For each of these deals, the contact's emails that carry related-company
   * evidence for it, plus the email a Smart Files link came from. Lets the
   * overview job say which notes are about which deal.
   */
  async listDealEvidenceEmails(
    workspaceId: string,
    correspondentId: string,
    companyIds: string[],
  ): Promise<DealEvidenceEmail[]> {
    if (!workspaceId || !correspondentId || companyIds.length === 0) return [];
    const { rows } = await this.db.execute<{ company_id: string; email_id: string }>(sql`
      SELECT erc.company_id, ev.email_id
      FROM "public"."employer_related_companies" erc
      JOIN "analytics"."employer_related_company_evidence" ev
        ON ev.related_company_id = erc.id
      JOIN "analytics"."email_participants" ep
        ON ep.email_id = ev.email_id
       AND ep.correspondent_id = ${correspondentId}
      WHERE erc.workspace_id = ${workspaceId}
        AND erc.dismissed_at IS NULL
        AND erc.company_id IN (${sqlList(companyIds)})
      UNION
      SELECT dc.company_id, em.id AS email_id
      FROM "public"."deal_contacts" dc
      JOIN "analytics"."emails" em ON em.message_id = dc.evidence_message_id
      WHERE dc.workspace_id = ${workspaceId}
        AND dc.correspondent_id = ${correspondentId}
        AND dc.company_id IN (${sqlList(companyIds)})
      ORDER BY 1, 2
    `);
    return rows.map((r) => ({ companyId: r.company_id, emailId: r.email_id }));
  }

  /**
   * Reads the overview row for (workspace, contact).
   */
  async getOverview(
    workspaceId: string,
    correspondentId: string,
  ): Promise<ContactRelationshipOverview | null> {
    if (!workspaceId || !correspondentId) return null;
    const rows = await this.db
      .select()
      .from(contactRelationshipOverviews)
      .where(
        and(
          eq(contactRelationshipOverviews.workspace_id, workspaceId),
          eq(contactRelationshipOverviews.correspondent_id, correspondentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Atomically marks the overview 'pending', keeping any existing text.
   * Returns false when another request already holds it — a 'pending' row
   * younger than OVERVIEW_PENDING_ABANDONED_MINUTES — so two workers never
   * generate the same overview at once.
   */
  async claimOverviewPending(
    workspaceId: string,
    correspondentId: string,
  ): Promise<boolean> {
    if (!correspondentId) return false;
    return (await this.claimOverviewsPending(workspaceId, [correspondentId])).length > 0;
  }

  /**
   * `claimOverviewPending` for many contacts in one statement. Returns the
   * ids it claimed; one another request holds is left out.
   */
  async claimOverviewsPending(
    workspaceId: string,
    correspondentIds: string[],
  ): Promise<string[]> {
    // One INSERT … ON CONFLICT cannot touch the same row twice; a fixed order
    // keeps two concurrent claims from deadlocking on each other's rows.
    const ids = [...new Set(correspondentIds)].sort();
    if (!workspaceId || ids.length === 0) return [];
    const rows = await this.db
      .insert(contactRelationshipOverviews)
      .values(
        ids.map((id) => ({
          workspace_id: workspaceId,
          correspondent_id: id,
          status: 'pending' as const,
        })),
      )
      .onConflictDoUpdate({
        target: [
          contactRelationshipOverviews.workspace_id,
          contactRelationshipOverviews.correspondent_id,
        ],
        set: {
          status: 'pending',
          job_id: null,
          updated_at: sql`now()`,
        },
        setWhere: sql`${contactRelationshipOverviews.status} <> 'pending'
          OR ${contactRelationshipOverviews.updated_at} < now() - make_interval(mins => ${OVERVIEW_PENDING_ABANDONED_MINUTES})`,
      })
      .returning({ correspondentId: contactRelationshipOverviews.correspondent_id });
    return rows.map((r) => r.correspondentId);
  }

  /** Records the job generating these claimed overviews. */
  async setOverviewJobId(
    workspaceId: string,
    correspondentIds: string[],
    jobId: string,
  ): Promise<void> {
    if (!workspaceId || correspondentIds.length === 0) return;
    await this.db
      .update(contactRelationshipOverviews)
      .set({ job_id: jobId })
      .where(
        and(
          eq(contactRelationshipOverviews.workspace_id, workspaceId),
          inArray(contactRelationshipOverviews.correspondent_id, correspondentIds),
        ),
      );
  }

  /**
   * Sets overview status to 'ready' and saves the text, the per-deal lines,
   * the role summary and the input hash.
   */
  async saveOverviewReady(
    workspaceId: string,
    correspondentId: string,
    ready: {
      text: string;
      inputHash: string;
      dealNotes: OverviewDealNote[];
      roleSummary: string | null;
    },
  ): Promise<void> {
    if (!workspaceId || !correspondentId) return;
    await this.db
      .update(contactRelationshipOverviews)
      .set({
        status: 'ready',
        overview: ready.text,
        deal_notes: ready.dealNotes,
        role_summary: ready.roleSummary,
        input_hash: ready.inputHash,
        generated_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(contactRelationshipOverviews.workspace_id, workspaceId),
          eq(contactRelationshipOverviews.correspondent_id, correspondentId),
        ),
      );
  }

  /**
   * Marks overview as 'failed' while preserving any existing overview text.
   */
  async markOverviewFailed(
    workspaceId: string,
    correspondentId: string,
  ): Promise<void> {
    if (!workspaceId || !correspondentId) return;
    await this.db
      .update(contactRelationshipOverviews)
      .set({
        status: 'failed',
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(contactRelationshipOverviews.workspace_id, workspaceId),
          eq(contactRelationshipOverviews.correspondent_id, correspondentId),
        ),
      );
  }
}
