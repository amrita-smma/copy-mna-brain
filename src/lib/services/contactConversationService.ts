import type {
  ContactConversationRepository,
  ContactInteractionRepository,
  ContactRoleInference,
  ContactRoleSummary,
  ConversationNote,
  ConversationNoteMember,
  CorrespondentRepository,
  ListNotesFilters,
  OverviewDealNote,
  OverviewRefreshCandidate,
  RoleConfidence,
  RoleLabel,
} from '@/lib/repositories';
import { OVERVIEW_PENDING_ABANDONED_MINUTES } from '@/lib/repositories';
import type { ContactRelationshipOverview } from '@/lib/db/schema';
import { overviewInputHash } from '@/lib/crm/overviewInputHash';
import type { JobDispatcher } from './jobDispatcher';
import { ContactNotFoundError } from './crmContactEnrichmentService';

export type {
  RoleLabel,
  RoleConfidence,
  ContactRoleInference,
  ContactRoleSummary,
  ConversationNoteMember,
  ConversationNote,
  OverviewDealNote,
};

export type RelationshipOverviewStatus = 'none' | 'pending' | 'ready' | 'failed';

export interface RelationshipOverview {
  /** 'none' = never generated (no row). */
  status: RelationshipOverviewStatus;
  /** Last successful overview text; may be present while status is pending/failed. */
  text: string | null;
  generatedAt: string | null;
  /** True when notes or deal links changed since `text` was generated (or no text yet and notes exist). */
  stale: boolean;
  /** One line per linked deal on the contact's part in it, written with `text`. */
  dealNotes: OverviewDealNote[];
  /**
   * One sentence on the contact's role in investment across all their emails,
   * written with `text` — shared, like the overview. Null until generated.
   */
  roleSummary: string | null;
}

/** Result of one post-ingest overview refresh for a workspace. */
export interface OverviewRefreshResult {
  /** Contacts whose notes changed since `since`. */
  candidates: number;
  /** Stale overviews claimed and handed to the job (at most OVERVIEW_REFRESH_LIMIT). */
  claimed: number;
  jobId: string | null;
}

export interface ContactConversation {
  contactId: string;
  /** False when the workspace has no synced email for this contact at all. */
  hasSyncedData: boolean;
  roles: ContactRoleSummary;
  overview: RelationshipOverview;
  /** Newest first; notes with a null summary are never returned. */
  notes: ConversationNote[];
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface GetConversationOptions extends ListNotesFilters {
  /**
   * `CRM_EMAIL_NOTES_ENABLED`, resolved by the caller: false returns no notes
   * (and reads none). Roles, the overview and synced status are unaffected.
   * Defaults to true for agent callers.
   */
  includeNotes?: boolean;
}

const PENDING_ABANDONED_MS = OVERVIEW_PENDING_ABANDONED_MINUTES * 60 * 1000;
/** A failed overview is retried by the post-ingest refresh at most this often. */
const FAILED_RETRY_MS = 60 * 60 * 1000;
/** Overviews one refresh generates per workspace; the rest wait for the next run. */
const OVERVIEW_REFRESH_LIMIT = 10;
/** Overviews generated at once inside one refresh job. */
const OVERVIEW_REFRESH_CONCURRENCY = 2;
/** Refresh job budget, inside the admin route's maxDuration. */
const OVERVIEW_REFRESH_TIMEOUT_SECONDS = 270;

export class InvalidOverviewRefreshSinceError extends Error {
  constructor(value: unknown) {
    super(`Invalid overview refresh since: ${String(value)}`);
    this.name = 'InvalidOverviewRefreshSinceError';
  }
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dealNotesOf(row: ContactRelationshipOverview): OverviewDealNote[] {
  const raw = row.deal_notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (d): d is OverviewDealNote =>
      typeof d?.companyId === 'string' && typeof d?.note === 'string' && d.note.length > 0,
  );
}

function overviewOf(
  row: ContactRelationshipOverview | null,
  noteCount: number,
  currentHash: string,
): RelationshipOverview {
  if (!row) {
    return {
      status: 'none',
      text: null,
      generatedAt: null,
      stale: noteCount > 0,
      dealNotes: [],
      roleSummary: null,
    };
  }
  return {
    status: row.status,
    text: row.overview ?? null,
    generatedAt: row.generated_at ? toIso(row.generated_at) ?? String(row.generated_at) : null,
    stale: row.overview ? row.input_hash !== currentHash : noteCount > 0,
    dealNotes: dealNotesOf(row),
    roleSummary: row.role_summary,
  };
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function forEachPooled<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class ContactConversationService {
  constructor(
    private readonly contactConversationRepo: ContactConversationRepository,
    private readonly correspondentRepo: CorrespondentRepository,
    private readonly contactInteractionRepo: ContactInteractionRepository,
    private readonly jobDispatcher: JobDispatcher,
    private readonly workspaceId: string,
  ) {}

  /**
   * Reads conversation notes, role signals, overview and synced status for one contact.
   * Throws ContactNotFoundError when contact is not visible in the workspace.
   *
   * Notes are private to the people on each email (From/To/Cc, or its
   * mailbox), so `viewerUserId` — always the signed-in user, never a request
   * parameter — decides which notes and which role evidence come back. The
   * role labels and the overview are shared.
   */
  async getConversation(
    correspondentId: string,
    viewerUserId: string,
    opts: GetConversationOptions = {},
  ): Promise<ContactConversation> {
    return this.readConversation(correspondentId, viewerUserId, opts);
  }

  /**
   * SYSTEM ONLY — every note and role evidence, for an AI Workforce run: the
   * run may use the full context, but its trace redacts what these tools
   * return and only its report is shared. Never call this from a route or a
   * chat tool.
   */
  async getConversationForWorkforce(
    correspondentId: string,
    opts: GetConversationOptions = {},
  ): Promise<ContactConversation> {
    return this.readConversation(correspondentId, null, opts);
  }

  private async readConversation(
    correspondentId: string,
    viewerUserId: string | null,
    opts: GetConversationOptions,
  ): Promise<ContactConversation> {
    const contact = await this.correspondentRepo.findById(
      correspondentId,
      this.workspaceId,
    );
    if (!contact) {
      throw new ContactNotFoundError(correspondentId);
    }

    const { includeNotes = true, ...noteFilters } = opts;
    const [notesResult, roles, hash, overviewRow, hasSyncedData] =
      await Promise.all([
        !includeNotes
          ? Promise.resolve({ notes: [], nextCursor: null })
          : viewerUserId === null
          ? this.contactConversationRepo.listNotesForSystem(this.workspaceId, correspondentId, noteFilters)
          : this.contactConversationRepo.listNotes(
              this.workspaceId,
              correspondentId,
              viewerUserId,
              noteFilters,
            ),
        viewerUserId === null
          ? this.contactConversationRepo.getRoleRollupForSystem(this.workspaceId, correspondentId)
          : this.contactConversationRepo.getRoleRollup(
              this.workspaceId,
              correspondentId,
              viewerUserId,
            ),
        this.contactConversationRepo.getNoteInputHash(
          this.workspaceId,
          correspondentId,
        ),
        this.contactConversationRepo.getOverview(
          this.workspaceId,
          correspondentId,
        ),
        this.contactInteractionRepo.workspaceHasSyncedData(this.workspaceId),
      ]);

    const overview = overviewOf(overviewRow, hash.noteCount, overviewInputHash(hash));

    return {
      contactId: correspondentId,
      hasSyncedData,
      roles,
      overview,
      notes: notesResult.notes,
      nextCursor: notesResult.nextCursor,
    };
  }

  /**
   * Requests a relationship overview generation.
   * Dispatches a contact_relationship_overview job when:
   *   noteCount > 0 AND (no row OR stale OR failed) AND status !== 'pending'.
   * Otherwise returns current overview state without dispatching.
   */
  async requestOverview(correspondentId: string): Promise<RelationshipOverview> {
    const contact = await this.correspondentRepo.findById(
      correspondentId,
      this.workspaceId,
    );
    if (!contact) {
      throw new ContactNotFoundError(correspondentId);
    }

    const [hash, overviewRow] = await Promise.all([
      this.contactConversationRepo.getNoteInputHash(
        this.workspaceId,
        correspondentId,
      ),
      this.contactConversationRepo.getOverview(
        this.workspaceId,
        correspondentId,
      ),
    ]);

    const current = overviewOf(overviewRow, hash.noteCount, overviewInputHash(hash));

    // A job that times out or dies with its function instance never reaches
    // its catch, so the row would stay 'pending' forever. Past this age a
    // pending row no longer blocks a new request.
    const pendingAbandoned =
      overviewRow?.status === 'pending' &&
      Date.now() - new Date(overviewRow.updated_at).getTime() > PENDING_ABANDONED_MS;
    const shouldDispatch =
      hash.noteCount > 0 &&
      (!overviewRow || current.stale || overviewRow.status === 'failed' || pendingAbandoned) &&
      (overviewRow?.status !== 'pending' || pendingAbandoned);

    // The claim is atomic, so the panel and the post-ingest refresh never
    // both generate the same overview.
    if (
      shouldDispatch &&
      (await this.contactConversationRepo.claimOverviewPending(this.workspaceId, correspondentId))
    ) {
      await this.dispatchOverviewJob([correspondentId]);
      return { ...current, status: 'pending' };
    }

    return current;
  }

  /**
   * After a CRM ingest run: regenerate the overview (and its per-deal lines)
   * of every contact whose notes were written at or after `since` and whose
   * overview is missing or stale. Failed overviews are retried at most hourly;
   * one held by a live job is skipped. At most OVERVIEW_REFRESH_LIMIT per
   * call, newest activity first — the next run picks up the rest. One job
   * generates them, a few at a time.
   */
  async refreshTouchedOverviews(since: string): Promise<OverviewRefreshResult> {
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) throw new InvalidOverviewRefreshSinceError(since);

    const candidates = await this.contactConversationRepo.listOverviewRefreshCandidates(
      this.workspaceId,
      new Date(sinceMs).toISOString(),
    );
    const now = Date.now();
    const due = candidates
      .filter((c) => this.overviewDue(c, now))
      .slice(0, OVERVIEW_REFRESH_LIMIT)
      .map((c) => c.correspondentId);

    // The claim is atomic per row, so a contact another request holds is
    // left out. Keep the newest-first order.
    const won = new Set(
      await this.contactConversationRepo.claimOverviewsPending(this.workspaceId, due),
    );
    const claimed = due.filter((id) => won.has(id));
    const jobId = claimed.length > 0 ? await this.dispatchOverviewJob(claimed) : null;
    return { candidates: candidates.length, claimed: claimed.length, jobId };
  }

  private overviewDue(c: OverviewRefreshCandidate, now: number): boolean {
    if (c.noteCount === 0) return false;
    const age = c.updatedAt ? now - new Date(c.updatedAt).getTime() : Infinity;
    if (c.status === 'pending') return age > PENDING_ABANDONED_MS;
    if (c.status === 'failed') return age > FAILED_RETRY_MS;
    if (c.status === null || !c.hasText) return true;
    return c.inputHash !== overviewInputHash(c);
  }

  /**
   * One job for already-claimed overviews. Each contact's failure is logged
   * on the job and marks only that overview failed; the job fails when none
   * succeeded.
   */
  private async dispatchOverviewJob(correspondentIds: string[]): Promise<string> {
    const { runContactRelationshipOverview } = await import(
      '@/lib/jobs/handlers/contactRelationshipOverview'
    );
    const workspaceId = this.workspaceId;
    const single = correspondentIds.length === 1;
    const { jobId } = await this.jobDispatcher.dispatch({
      type: 'contact_relationship_overview',
      payload: { correspondentIds, workspaceId },
      timeoutSeconds: single ? 120 : OVERVIEW_REFRESH_TIMEOUT_SECONDS,
      work: async ({ job, db }) => {
        let ready = 0;
        let failed = 0;
        await forEachPooled(correspondentIds, OVERVIEW_REFRESH_CONCURRENCY, async (correspondentId) => {
          try {
            await runContactRelationshipOverview({ correspondentId, workspaceId, jobId: job.id }, { db });
            ready += 1;
          } catch (err) {
            // The handler already marked this overview failed and logged it.
            failed += 1;
            if (single) throw err;
          }
        });
        if (ready === 0 && failed > 0) throw new Error(`All ${failed} overviews failed`);
        return { ready, failed };
      },
    });
    await this.contactConversationRepo.setOverviewJobId(workspaceId, correspondentIds, jobId);
    return jobId;
  }
}
