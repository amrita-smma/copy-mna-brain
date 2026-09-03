import type {
  CompanyRepository,
  CompanyVoteRepository,
  UserRepository,
  VoteBallotRow,
  VoteSessionRow,
  WorkspaceRepository,
} from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';
import type { CompanyCardSlideService } from './companyCardSlideService';
import type { AiOpinionService } from './aiOpinionService';
import { EmailService } from './emailService';
import { enqueueSendEmail } from '@/lib/queue';
import { exportElementsToPptx } from '@/lib/pptx/writePptx';
import { sanitizeBallotHtml, htmlToPlainText } from '@/lib/voting/html';
import {
  DEFAULT_UNCAST_CHOICE,
  VOTE_CHOICE_LABELS,
  aiVerdictToVoteChoice,
  computeDeadline,
  formatDuration,
  isVoteChoice,
  tallyVotes,
  type VoteChoice,
  type VoteTally,
} from '@/lib/voting/tally';
import { generateVoteSynthesis } from '@/lib/voting/synthesis';
import type { CompanyVotePayload } from '@/lib/jobs/handlers/companyVote';

/** A voting rule was broken (wrong actor, closed round, passed deadline, …). */
export class VoteRuleError extends Error {
  constructor(
    message: string,
    /** HTTP status the route should map this to. */
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'VoteRuleError';
  }
}

export class VoteNotFoundError extends VoteRuleError {
  constructor(message = 'No voting round found.') {
    super(message, 404);
    this.name = 'VoteNotFoundError';
  }
}

export type VoteVisibility = 'none' | 'in_progress' | 'results';

export interface VoteVoterState {
  userId: string;
  name: string;
  email: string | null;
  status: VoteBallotRow['status'];
  submittedAt: string | null;
  autoSubmitted: boolean;
  /** Only populated once `visibility` is `results`. */
  choice: VoteChoice | null;
  /** Only populated once `visibility` is `results`. */
  bodyHtml: string | null;
}

/**
 * The AI Opinion's seat at the table. It counts as one voter, but has no
 * ballot row and no user: its vote is derived from the company's standing AI
 * Opinion when the round closes.
 */
export interface VoteAiParticipant {
  /** Resolved only once the round has concluded. */
  choice: VoteChoice | null;
  /** `pass` / `fail` / `tentative`, as recorded on the company. */
  verdict: string | null;
  summary: string | null;
  /** Whether an opinion exists yet — `processing` means generation is running. */
  opinionStatus: string | null;
  /** True once its vote is locked in (i.e. the round concluded). */
  submitted: boolean;
}

export interface VoteAiState {
  status: VoteSessionRow['ai_status'];
  synthesis: string | null;
  keyPositives: string[];
  keyConcerns: string[];
  opinionVerdict: string | null;
  opinionSummary: string | null;
  error: string | null;
}

export interface VoteSessionState {
  id: string;
  companyId: string;
  status: VoteSessionRow['status'];
  deadlineAt: string;
  durationDays: number;
  durationHours: number;
  initiatedBy: { id: string; name: string };
  createdAt: string;
  concludedAt: string | null;
  cancelledAt: string | null;
  voters: VoteVoterState[];
  /** The AI Opinion participant — always present; it votes in every round. */
  aiParticipant: VoteAiParticipant;
  /** Human voters **plus** the AI Opinion. */
  voterCount: number;
  submittedCount: number;
  /** Only populated once `visibility` is `results`. */
  tally: VoteTally | null;
  /** Only populated once `visibility` is `results`. */
  ai: VoteAiState | null;
}

export interface VoteTabState {
  session: VoteSessionState | null;
  /**
   * Transient, per-response warning for the client to surface (e.g. the
   * invitation job could not be queued). Never persisted.
   */
  notice?: string | null;
  visibility: VoteVisibility;
  viewer: {
    userId: string;
    isInitiator: boolean;
    isVoter: boolean;
    /** True when there is no open round, so "Start Vote" is offered. */
    canStartVote: boolean;
    ballot: {
      choice: VoteChoice | null;
      bodyHtml: string | null;
      status: VoteBallotRow['status'];
      submittedAt: string | null;
    } | null;
  };
}

export interface StartVoteInput {
  companyId: string;
  initiatorId: string;
  voterIds: string[];
  durationDays: number;
  durationHours: number;
}

export interface SaveBallotInput {
  sessionId: string;
  voterId: string;
  /**
   * The company whose Voting tab the request came from. Checked against the
   * session so a body-supplied `sessionId` can't reach another company's round.
   */
  companyId?: string;
  choice?: VoteChoice | null;
  bodyHtml?: string | null;
  /** Submit (locking the ballot) instead of saving a draft. */
  submit?: boolean;
}

const VOTE_JOB_TIMEOUT_SECONDS = 300;

/**
 * The company voting system: one round ("session") per company at a time, one
 * ballot per selected voter.
 *
 * Rules enforced here (and summarised for users in the Voting tab):
 *  - Only a workspace member can be a voter; a round needs at least one.
 *  - The company's AI Opinion counts as one more voter. Starting a round kicks
 *    off its generation when the company has no opinion yet, and its ballot is
 *    derived from the verdict when the round closes.
 *  - A voter may save and revise a draft freely until they submit; submitting
 *    locks the ballot.
 *  - Only the initiator can cancel a round or send submissions back to draft.
 *  - While a round is open nobody sees anyone else's choice or rationale —
 *    only who has submitted.
 *  - A round closes when every ballot is submitted, or at the deadline (which
 *    auto-submits the remaining drafts as INCONCLUSIVE).
 *  - Closing kicks off the AI synthesis and the recap email; results become
 *    visible to everyone in the workspace at that point.
 *
 * Slow work (building the Company Card .pptx, the synthesis model call,
 * fan-out email) never runs inline — it goes through the `company_vote` job.
 */
export class CompanyVoteService {
  constructor(
    private readonly voteRepo: CompanyVoteRepository,
    private readonly userRepo: UserRepository,
    private readonly companyRepo: CompanyRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly companyCardSlideService: CompanyCardSlideService,
    private readonly aiOpinionService: AiOpinionService,
    private readonly jobDispatcher: JobDispatcher,
    private readonly workspaceId: string,
    private readonly emailService: EmailService = new EmailService(),
    private readonly enqueue: typeof enqueueSendEmail = enqueueSendEmail,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The Voting tab's whole payload for one viewer: the latest round, what that
   * viewer is allowed to see of it, and their own ballot.
   *
   * Deliberately one call. The ballots and the voter directory are each fetched
   * once in bulk — never one lookup per voter.
   */
  async getState(companyId: string, viewerId: string): Promise<VoteTabState> {
    const session = await this.voteRepo.findLatestSessionByCompanyId(companyId);
    if (!session) {
      return {
        session: null,
        visibility: 'none',
        viewer: {
          userId: viewerId,
          isInitiator: false,
          isVoter: false,
          canStartVote: true,
          ballot: null,
        },
      };
    }

    const [ballots, company] = await Promise.all([
      this.voteRepo.listBallotsBySessionId(session.id),
      // Needed for the AI participant's live generation status while the round
      // is open; the concluded round reads its snapshot off the session.
      this.companyRepo.findByIdOrNull(session.company_id),
    ]);
    const namesById = await this.resolveUserNames([
      session.initiated_by,
      ...ballots.map((b) => b.voter_id),
    ]);

    const ownBallot = ballots.find((b) => b.voter_id === viewerId) ?? null;
    const isInitiator = session.initiated_by === viewerId;
    const isVoter = ownBallot != null;
    // Results are published only for a round that actually concluded. A
    // CANCELLED round's drafts stay private — nobody consented to publishing a
    // half-written rationale.
    const visibility: VoteVisibility =
      session.status === 'active'
        ? 'in_progress'
        : session.status === 'completed'
          ? 'results'
          : 'none';
    const showContents = visibility === 'results';

    const voters: VoteVoterState[] = ballots.map((ballot) => ({
      userId: ballot.voter_id,
      name: namesById.get(ballot.voter_id)?.name ?? 'Unknown user',
      email: namesById.get(ballot.voter_id)?.email ?? null,
      status: ballot.status,
      submittedAt: ballot.submitted_at ?? null,
      autoSubmitted: ballot.auto_submitted,
      // A voter's own ballot is always their own to see, even mid-round.
      choice:
        showContents || ballot.voter_id === viewerId
          ? ((ballot.choice as VoteChoice | null) ?? null)
          : null,
      bodyHtml:
        showContents || ballot.voter_id === viewerId ? (ballot.body_html ?? null) : null,
    }));

    const concluded = session.status === 'completed';
    const aiParticipant: VoteAiParticipant = {
      // Hidden mid-round like everyone else's ballot, and not resolved until
      // the round closes anyway.
      choice: showContents ? ((session.ai_vote_choice as VoteChoice | null) ?? null) : null,
      verdict: showContents
        ? (session.ai_opinion_verdict ?? null)
        : null,
      summary: showContents ? (session.ai_opinion_summary ?? null) : null,
      opinionStatus: concluded
        ? null
        : (company?.ai_opinion_status ?? null),
      submitted: concluded,
    };

    return {
      session: {
        id: session.id,
        companyId: session.company_id,
        status: session.status,
        deadlineAt: session.deadline_at,
        durationDays: session.duration_days,
        durationHours: session.duration_hours,
        initiatedBy: {
          id: session.initiated_by,
          name: namesById.get(session.initiated_by)?.name ?? 'Unknown user',
        },
        createdAt: session.created_at,
        concludedAt: session.concluded_at ?? null,
        cancelledAt: session.cancelled_at ?? null,
        voters,
        aiParticipant,
        // The AI Opinion is one of the voters, so it counts in both totals.
        voterCount: ballots.length + 1,
        submittedCount:
          ballots.filter((b) => b.status === 'submitted').length +
          (aiParticipant.submitted ? 1 : 0),
        tally: showContents
          ? tallyVotes([
              ...ballots.map((b) => b.choice as VoteChoice | null),
              session.ai_vote_choice as VoteChoice | null,
            ])
          : null,
        ai: showContents
          ? {
              status: session.ai_status,
              synthesis: session.ai_synthesis ?? null,
              keyPositives: session.ai_key_positives ?? [],
              keyConcerns: session.ai_key_concerns ?? [],
              opinionVerdict: session.ai_opinion_verdict ?? null,
              opinionSummary: session.ai_opinion_summary ?? null,
              error: session.ai_error ?? null,
            }
          : null,
      },
      visibility,
      viewer: {
        userId: viewerId,
        isInitiator,
        isVoter,
        canStartVote: session.status !== 'active',
        ballot: ownBallot
          ? {
              choice: (ownBallot.choice as VoteChoice | null) ?? null,
              bodyHtml: ownBallot.body_html ?? null,
              status: ownBallot.status,
              submittedAt: ownBallot.submitted_at ?? null,
            }
          : null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Open a new round. Fails when one is already open for the company.
   *
   * `invitationsQueued` is false when the notification job could not be
   * dispatched. The round still stands — but the caller MUST surface that,
   * otherwise "I never got the email" is undiagnosable from the UI.
   */
  async startVote(
    input: StartVoteInput,
  ): Promise<{ session: VoteSessionRow; invitationsQueued: boolean }> {
    const companyId = input.companyId?.trim();
    if (!companyId) throw new VoteRuleError('companyId is required.');

    const company = await this.voteRepo.findCompanyNames(companyId);
    if (!company) throw new VoteNotFoundError('Company not found in this workspace.');

    const existing = await this.voteRepo.findActiveSessionByCompanyId(companyId);
    if (existing) {
      throw new VoteRuleError('A vote is already in progress for this company.', 409);
    }

    // Dedupe while preserving the picker's order, then validate membership: a
    // non-member has no ballot to cast and no in-app link to open.
    const voterIds = [
      ...new Set(
        (input.voterIds ?? [])
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (voterIds.length === 0) {
      throw new VoteRuleError('Select at least one voter.');
    }
    const members = await this.userRepo.findAllInWorkspace(this.workspaceId);
    const memberIds = new Set(members.map((m) => m.id));
    const strangers = voterIds.filter((id) => !memberIds.has(id));
    if (strangers.length > 0) {
      throw new VoteRuleError(
        `${strangers.length} selected ${strangers.length === 1 ? 'voter is' : 'voters are'} not a member of this workspace.`,
      );
    }
    if (!memberIds.has(input.initiatorId)) {
      throw new VoteRuleError('Only a workspace member can start a vote.', 403);
    }

    let deadline: Date;
    try {
      deadline = computeDeadline(this.now(), input.durationDays, input.durationHours);
    } catch (err) {
      throw new VoteRuleError((err as Error).message);
    }

    let session: VoteSessionRow;
    try {
      session = await this.voteRepo.createSession({
        company_id: companyId,
        initiated_by: input.initiatorId,
        status: 'active',
        deadline_at: deadline.toISOString(),
        duration_days: Math.trunc(input.durationDays),
        duration_hours: Math.trunc(input.durationHours),
        ai_status: 'pending',
      });
    } catch (err) {
      // `uq_company_vote_sessions_one_active` is the real guard against two
      // concurrent "Start Vote" clicks — the pre-check above only catches the
      // sequential case. The loser must read as a conflict, not a 500.
      if (isUniqueViolation(err)) {
        throw new VoteRuleError('A vote is already in progress for this company.', 409);
      }
      throw err;
    }

    try {
      await this.voteRepo.insertBallots(
        voterIds.map((voterId) => ({
          vote_session_id: session.id,
          voter_id: voterId,
          status: 'draft' as const,
        })),
      );
    } catch (err) {
      // A session with no ballots is worse than no session: the partial unique
      // index would block every future round on this company, and nobody could
      // vote in this one. Roll it back by hand — the two writes are not in one
      // transaction, so this is the compensating action.
      await this.voteRepo.deleteSession(session.id).catch((cleanupErr) => {
        console.error(
          `[CompanyVoteService] failed to roll back empty session ${session.id}:`,
          cleanupErr,
        );
      });
      throw err;
    }

    // The AI Opinion is one of the voters, so it needs an opinion to cast.
    // Only when there is none: AiOpinionService.dispatch treats every call as a
    // re-evaluation and clears the existing verdict.
    await this.ensureAiOpinion(companyId, input.initiatorId);

    // Building the Company Card deck and mailing every voter is multi-second
    // work — it must not block the click.
    const invitationsQueued = await this.dispatchVoteJob({
      kind: 'invite',
      sessionId: session.id,
    });

    return { session, invitationsQueued };
  }

  /**
   * Make sure the company has an AI Opinion for the round to count.
   *
   * Best-effort: a failure here must never cost the user their vote — the AI
   * simply abstains as INCONCLUSIVE when the round closes without one.
   */
  private async ensureAiOpinion(
    companyId: string,
    initiatorId: string,
  ): Promise<void> {
    try {
      const company = await this.companyRepo.findByIdOrNull(companyId);
      if (company?.ai_opinion_verdict) return; // already on record
      await this.aiOpinionService.dispatch(companyId, initiatorId);
    } catch (err) {
      console.error(
        `[CompanyVoteService] could not start an AI Opinion for ${companyId}:`,
        err,
      );
    }
  }

  /** Save a draft, or submit and lock the ballot. */
  async saveBallot(input: SaveBallotInput): Promise<VoteBallotRow> {
    const session = await this.requireSession(input.sessionId, input.companyId);
    if (session.status !== 'active') {
      throw new VoteRuleError('This voting round is closed.', 409);
    }
    if (new Date(session.deadline_at).getTime() <= this.now().getTime()) {
      throw new VoteRuleError('The voting deadline has passed.', 409);
    }

    const ballot = await this.voteRepo.findBallot(session.id, input.voterId);
    if (!ballot) {
      throw new VoteRuleError('You are not a voter on this round.', 403);
    }
    if (ballot.status === 'submitted') {
      throw new VoteRuleError(
        'Your vote is already submitted and can no longer be changed.',
        409,
      );
    }

    if (input.choice != null && !isVoteChoice(input.choice)) {
      throw new VoteRuleError(`Unknown vote choice "${String(input.choice)}".`);
    }
    if (input.submit && !isVoteChoice(input.choice)) {
      throw new VoteRuleError('Pick a vote before submitting.');
    }

    // Compare-and-swap on `status = 'draft'`. The check above is necessary but
    // NOT sufficient: an autosave and a submit fired milliseconds apart both
    // read `draft`, and without this predicate the autosave would overwrite an
    // already-submitted ballot.
    const updated = await this.voteRepo.updateBallot(
      ballot.id,
      {
        choice: input.choice === undefined ? ballot.choice : (input.choice ?? null),
        body_html:
          input.bodyHtml === undefined
            ? ballot.body_html
            : sanitizeBallotHtml(input.bodyHtml),
        ...(input.submit
          ? {
              status: 'submitted' as const,
              submitted_at: this.now().toISOString(),
              auto_submitted: false,
            }
          : {}),
      },
      { expectedStatus: 'draft' },
    );
    if (!updated) {
      throw new VoteRuleError(
        'Your vote was submitted while you were editing and can no longer be changed.',
        409,
      );
    }

    if (input.submit) {
      await this.notifyBallotSubmitted(session, updated);
      // The round ends the moment the last ballot lands — no waiting for the
      // deadline when everyone has already spoken.
      const ballots = await this.voteRepo.listBallotsBySessionId(session.id);
      if (ballots.length > 0 && ballots.every((b) => b.status === 'submitted')) {
        await this.concludeSession(session.id, 'all_submitted');
      }
    }

    return updated;
  }

  /** Initiator only: abandon the round. Ballots are kept for the record. */
  async cancelVote(
    sessionId: string,
    actorId: string,
    companyId?: string,
  ): Promise<VoteSessionRow> {
    const session = await this.requireSession(sessionId, companyId);
    this.requireInitiator(session, actorId);
    if (session.status !== 'active') {
      throw new VoteRuleError('This voting round is already closed.', 409);
    }
    // CAS on `active`: a cancel racing the deadline sweep (or the last submit)
    // must not un-publish a round that already concluded and mailed its recap.
    const updated = await this.voteRepo.updateSession(
      session.id,
      { status: 'cancelled', cancelled_at: this.now().toISOString() },
      { expectedStatus: 'active' },
    );
    if (!updated) {
      throw new VoteRuleError('This voting round just closed and cannot be cancelled.', 409);
    }
    return updated;
  }

  /**
   * Initiator only: reopen every submitted ballot for revision. Used when the
   * round needs another pass before it closes.
   */
  async sendBackSubmissions(
    sessionId: string,
    actorId: string,
    companyId?: string,
  ): Promise<{ reopened: number }> {
    const session = await this.requireSession(sessionId, companyId);
    this.requireInitiator(session, actorId);
    if (session.status !== 'active') {
      throw new VoteRuleError(
        'This voting round is closed — submissions can no longer be sent back.',
        409,
      );
    }
    const reopened = await this.voteRepo.updateBallotsBySessionId(
      session.id,
      { status: 'draft', submitted_at: null, auto_submitted: false },
      { onlyStatus: 'submitted' },
    );
    return { reopened: reopened.length };
  }

  /**
   * Close a round: auto-submit whatever is still in draft, mark it completed,
   * snapshot the company's standing AI Opinion, and queue the synthesis + recap.
   *
   * Idempotent — a round that is no longer `active` is returned untouched, so a
   * cron sweep racing the last submission cannot conclude it twice.
   */
  async concludeSession(
    sessionId: string,
    reason: 'all_submitted' | 'deadline',
  ): Promise<VoteSessionRow | null> {
    const session = await this.voteRepo.findSessionById(sessionId);
    if (!session || session.status !== 'active') return session;

    const nowIso = this.now().toISOString();
    const company = await this.companyRepo.findByIdOrNull(session.company_id);

    // Claim the round FIRST, as a compare-and-swap on `active`. Everything
    // after this point has side effects that must happen exactly once (ballots
    // auto-submitted, synthesis written, recap emails sent), and the last
    // submission can race the deadline cron. Whoever loses the CAS gets `null`
    // and returns without repeating any of it.
    const updated = await this.voteRepo.updateSession(
      session.id,
      {
        status: 'completed',
        concluded_at: nowIso,
        ai_status: 'processing',
        ai_opinion_verdict: company?.ai_opinion_verdict ?? null,
        ai_opinion_summary: company?.ai_opinion_summary ?? null,
        // Snapshot the AI's ballot now. The company row can be re-evaluated
        // later; a recorded tally must never change under us. A round that
        // closes while generation is still running gets INCONCLUSIVE.
        ai_vote_choice: aiVerdictToVoteChoice(company?.ai_opinion_verdict),
      },
      { expectedStatus: 'active' },
    );
    if (!updated) {
      // Another request (or the cron) closed or cancelled it first.
      return this.voteRepo.findSessionById(sessionId);
    }

    // Two set-based UPDATEs, never one per ballot:
    //  - a draft the voter already picked a choice on is submitted AS PICKED —
    //    they made the call, they just never pressed Submit;
    //  - a draft with no choice becomes INCONCLUSIVE, because we must not
    //    invent a directional vote nobody cast.
    await this.voteRepo.updateBallotsBySessionId(
      session.id,
      { status: 'submitted', submitted_at: nowIso, auto_submitted: true },
      { onlyStatus: 'draft', choiceIsNull: false },
    );
    await this.voteRepo.updateBallotsBySessionId(
      session.id,
      {
        status: 'submitted',
        submitted_at: nowIso,
        auto_submitted: true,
        choice: DEFAULT_UNCAST_CHOICE,
      },
      { onlyStatus: 'draft', choiceIsNull: true },
    );

    await this.dispatchVoteJob({ kind: 'conclude', sessionId: session.id, reason });

    return updated;
  }

  /**
   * Deadline sweep. Concludes every open round whose deadline has passed —
   * called by the `close-votes` cron.
   */
  async processDueSessions(): Promise<{ concluded: number }> {
    const due = await this.voteRepo.findDueSessions(this.now().toISOString());
    let concluded = 0;
    for (const session of due) {
      try {
        await this.concludeSession(session.id, 'deadline');
        concluded += 1;
      } catch (err) {
        // One bad round must not stall the sweep for the others.
        console.error(
          `[CompanyVoteService] failed to conclude session ${session.id}:`,
          err,
        );
      }
    }
    return { concluded };
  }

  // -------------------------------------------------------------------------
  // Background work (driven by the `company_vote` job)
  // -------------------------------------------------------------------------

  /**
   * Email every voter their invitation, with the Company Card attached as a
   * .pptx. The deck is built ONCE and reused for all recipients.
   *
   * A failed card build downgrades to an attachment-less invitation rather than
   * dropping the email — being told you have a vote matters more than the deck.
   */
  async deliverInvitations(sessionId: string): Promise<{ sent: number; failed: number }> {
    const session = await this.requireSession(sessionId);
    // The job is queued after the round is persisted, so the initiator can
    // cancel between the two. Don't invite people to a round that is gone.
    if (session.status !== 'active') return { sent: 0, failed: 0 };

    const ballots = await this.voteRepo.listBallotsBySessionId(sessionId);
    if (ballots.length === 0) return { sent: 0, failed: 0 };

    const namesById = await this.resolveUserNames([
      session.initiated_by,
      ...ballots.map((b) => b.voter_id),
    ]);
    const company = await this.voteRepo.findCompanyNames(session.company_id);
    const companyName = this.companyLabel(company);
    const voteUrl = await this.voteUrl(session.company_id);

    let pptx: Buffer | undefined;
    try {
      const deck = await this.companyCardSlideService.buildById(session.company_id);
      pptx = await exportElementsToPptx(deck.slides);
    } catch (err) {
      console.error(
        `[CompanyVoteService] company card deck failed for ${session.company_id}:`,
        err,
      );
    }

    const companyCardUrl = await this.companyUrl(session.company_id, 'overview');
    const deadlineLabel = formatDeadline(session.deadline_at);
    const durationLabel = formatDuration(session.duration_days, session.duration_hours);
    const initiatorName = namesById.get(session.initiated_by)?.name ?? 'A colleague';

    let sent = 0;
    let failed = 0;
    for (const ballot of ballots) {
      const voter = namesById.get(ballot.voter_id);
      if (!voter?.email) {
        failed += 1;
        continue;
      }
      try {
        await this.emailService.sendVoteInvitationEmail({
          email: voter.email,
          recipientName: voter.name || 'there',
          companyName,
          initiatorName,
          deadlineLabel,
          durationLabel,
          voteUrl,
          companyCardUrl,
          companyCardPptx: pptx,
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[CompanyVoteService] invitation to ${voter.email} failed for session ${sessionId}:`,
          err,
        );
      }
    }

    return { sent, failed };
  }

  /**
   * Post-conclusion work: run the AI synthesis over the ballots, then recap the
   * round to the initiator and every voter.
   *
   * A synthesis failure is recorded on the session (`ai_status = 'failed'`) and
   * does NOT stop the recap — the verbatim feedback is the point of the email.
   */
  async finalizeConcludedSession(
    sessionId: string,
    reason: 'all_submitted' | 'deadline',
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    const ballots = await this.voteRepo.listBallotsBySessionId(sessionId);
    const namesById = await this.resolveUserNames([
      session.initiated_by,
      ...ballots.map((b) => b.voter_id),
    ]);
    const company = await this.voteRepo.findCompanyNames(session.company_id);
    const companyName = this.companyLabel(company);
    const aiChoice = (session.ai_vote_choice as VoteChoice | null) ?? null;
    const tally = tallyVotes([
      ...ballots.map((b) => b.choice as VoteChoice | null),
      aiChoice,
    ]);

    try {
      const synthesis = await generateVoteSynthesis({
        companyName,
        tally,
        ballots: [
          ...ballots.map((b) => ({
            voterName: namesById.get(b.voter_id)?.name ?? 'Unknown user',
            choice: (b.choice as VoteChoice | null) ?? null,
            bodyHtml: b.body_html ?? null,
          })),
          // The AI's own ballot, so the synthesis weighs it as a participant
          // rather than as external context.
          {
            voterName: 'AI Opinion',
            choice: aiChoice,
            bodyHtml: session.ai_opinion_summary ?? null,
          },
        ],
        aiOpinionVerdict: session.ai_opinion_verdict,
        aiOpinionSummary: session.ai_opinion_summary,
      });
      await this.voteRepo.updateSession(sessionId, {
        ai_status: 'completed',
        ai_synthesis: synthesis.synthesis,
        ai_key_positives: synthesis.key_positives,
        ai_key_concerns: synthesis.key_concerns,
        ai_error: null,
      });
    } catch (err) {
      console.error(`[CompanyVoteService] synthesis failed for session ${sessionId}:`, err);
      await this.voteRepo.updateSession(sessionId, {
        ai_status: 'failed',
        ai_error: (err as Error).message,
      });
    }

    const voteUrl = await this.voteUrl(session.company_id);
    const recapBallots = [
      ...ballots.map((b) => ({
        voterName: namesById.get(b.voter_id)?.name ?? 'Unknown user',
        choiceLabel: b.choice
          ? VOTE_CHOICE_LABELS[b.choice as VoteChoice]
          : 'NO VOTE RECORDED',
        rationale: htmlToPlainText(b.body_html) || undefined,
      })),
      // The AI Opinion voted too, so the recap lists it like any other reviewer.
      {
        voterName: 'AI Opinion',
        choiceLabel: aiChoice ? VOTE_CHOICE_LABELS[aiChoice] : 'NO VOTE RECORDED',
        rationale: session.ai_opinion_summary?.trim() || undefined,
      },
    ];

    // Initiator + every voter, deduped: the initiator is often a voter too.
    const recipients = new Set<string>();
    for (const id of [session.initiated_by, ...ballots.map((b) => b.voter_id)]) {
      const email = namesById.get(id)?.email;
      if (email) recipients.add(email);
    }

    for (const email of recipients) {
      try {
        await this.enqueue({
          kind: 'vote_recap',
          to: email,
          companyName,
          headline: tally.headline,
          outcomeLabel: tally.outcomeLabel,
          closedReason: reason,
          ballots: recapBallots,
          voteUrl,
        });
      } catch (err) {
        console.error(`[CompanyVoteService] recap to ${email} failed:`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Load a session, optionally asserting it belongs to `companyId`.
   *
   * Every route that mutates a round takes the company from the URL and the
   * session id from the body. Without this check a member could aim one
   * company's URL at another company's session id and mutate that round
   * instead — same workspace, so the plain lookup would happily return it.
   */
  private async requireSession(
    sessionId: string,
    companyId?: string,
  ): Promise<VoteSessionRow> {
    const session = await this.voteRepo.findSessionById(sessionId?.trim());
    if (!session) throw new VoteNotFoundError();
    if (companyId && session.company_id !== companyId.trim()) {
      throw new VoteNotFoundError('That voting round does not belong to this company.');
    }
    return session;
  }

  private requireInitiator(session: VoteSessionRow, actorId: string): void {
    if (session.initiated_by !== actorId) {
      throw new VoteRuleError('Only the vote initiator can do that.', 403);
    }
  }

  /** Bulk id → name/email map. Deduped so a repeated id costs nothing. */
  private async resolveUserNames(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, { name: string; email: string | null }>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const rows = await this.userRepo.findByIds(unique);
    return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email ?? null }]));
  }

  private companyLabel(
    company: { target?: string | null; project_name?: string | null } | null,
  ): string {
    return company?.target?.trim() || company?.project_name?.trim() || 'this company';
  }

  /**
   * Deep link to one tab of a company's detail page, workspace-scoped when the
   * slug resolves. `overview` is the Company Card; `voting` is this feature.
   */
  private async companyUrl(
    companyId: string,
    tab: 'voting' | 'overview',
  ): Promise<string> {
    const base = resolveAppUrl();
    try {
      const workspace = await this.workspaceRepo.findById(this.workspaceId);
      if (workspace?.slug) {
        return `${base}/w/${workspace.slug}/companies/${companyId}?tab=${tab}`;
      }
    } catch (err) {
      console.error('[CompanyVoteService] workspace slug lookup failed:', err);
    }
    return `${base}/companies/${companyId}?tab=${tab}`;
  }

  /** Deep link straight to the company's Voting tab. */
  private voteUrl(companyId: string): Promise<string> {
    return this.companyUrl(companyId, 'voting');
  }

  private async notifyBallotSubmitted(
    session: VoteSessionRow,
    ballot: VoteBallotRow,
  ): Promise<void> {
    const namesById = await this.resolveUserNames([ballot.voter_id]);
    const voter = namesById.get(ballot.voter_id);
    if (!voter?.email) return;
    const company = await this.voteRepo.findCompanyNames(session.company_id);
    try {
      await this.enqueue({
        kind: 'vote_submitted',
        to: voter.email,
        recipientName: voter.name || 'there',
        companyName: this.companyLabel(company),
        choiceLabel: ballot.choice
          ? VOTE_CHOICE_LABELS[ballot.choice as VoteChoice]
          : 'NO VOTE RECORDED',
        deadlineLabel: formatDeadline(session.deadline_at),
        voteUrl: await this.voteUrl(session.company_id),
      });
    } catch (err) {
      // A missed confirmation must never roll back a submitted vote.
      console.error(`[CompanyVoteService] submit confirmation to ${voter.email} failed:`, err);
    }
  }

  /**
   * Queue the background half of a vote transition. Imported lazily so the job
   * handler — which reaches back into the service container — cannot close an
   * import cycle onto this module.
   */
  private async dispatchVoteJob(payload: CompanyVotePayload): Promise<boolean> {
    try {
      const { runCompanyVote } = await import('@/lib/jobs/handlers/companyVote');
      await this.jobDispatcher.dispatch({
        type: 'company_vote',
        payload: { ...payload, workspaceId: this.workspaceId },
        timeoutSeconds: VOTE_JOB_TIMEOUT_SECONDS,
        work: async ({ db }) =>
          runCompanyVote({ ...payload, workspaceId: this.workspaceId }, { db }),
      });
      return true;
    } catch (err) {
      // The vote itself is already persisted; a dropped notification job must
      // not fail the user's action. But it MUST be visible — the usual cause is
      // the `company_vote` job_type enum value missing because the migration
      // has not been applied to this environment, which otherwise looks
      // exactly like "the email never arrived" with no error anywhere.
      console.error(
        `[CompanyVoteService] failed to dispatch company_vote job (${payload.kind}) — ` +
          'notifications for this round were NOT sent:',
        err,
      );
      return false;
    }
  }
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505). Used to map
 * the `one active round per company` index onto a 409 instead of a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '23505';
}

function resolveAppUrl(): string {
  const explicit =
    process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL;
  return (explicit ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** e.g. "5:00 PM on September 5, 2026" (UTC — the runtime has no user tz). */
export function formatDeadline(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
  return `${time.replace(/[\u202f\u2009\u00a0]/g, ' ')} UTC on ${day}`;
}
