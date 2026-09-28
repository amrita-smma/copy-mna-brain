import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CompanyVoteService,
  VoteRuleError,
  formatDeadline,
} from './companyVoteService';

const mocks = vi.hoisted(() => ({
  generateVoteSynthesis: vi.fn(),
  exportElementsToPptx: vi.fn(),
}));

vi.mock('@/lib/voting/synthesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voting/synthesis')>();
  return { ...actual, generateVoteSynthesis: mocks.generateVoteSynthesis };
});

vi.mock('@/lib/pptx/writePptx', () => ({
  exportElementsToPptx: mocks.exportElementsToPptx,
}));

// The service lazily imports the job handler when dispatching; stub it so the
// dispatch path never reaches the real container.
vi.mock('@/lib/jobs/handlers/companyVote', () => ({
  runCompanyVote: vi.fn(),
  COMPANY_VOTE_TIMEOUT_SECONDS: 300,
}));

const NOW = new Date('2026-09-03T10:00:00.000Z');
/** A deadline comfortably clear of the minimum lead time, as the picker sends it. */
const DEADLINE = '2026-09-05T14:00:00.000Z';

function makeVoteRepo() {
  return {
    findSessionById: vi.fn(),
    findActiveSessionByCompanyId: vi.fn(),
    findLatestSessionByCompanyId: vi.fn(),
    listSessionsByCompanyId: vi.fn(),
    findDueSessions: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    insertBallots: vi.fn(),
    listBallotsBySessionId: vi.fn(),
    listBallotsBySessionIds: vi.fn(),
    findBallot: vi.fn(),
    updateBallot: vi.fn(),
    updateBallotsBySessionId: vi.fn(),
    deleteSession: vi.fn(),
    findCompanyNames: vi.fn(),
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vs-1',
    company_id: 'c-1',
    workspace_id: 'ws-1',
    initiated_by: 'u-init',
    status: 'active',
    deadline_at: '2026-09-05T10:00:00.000Z',
    concluded_at: null,
    cancelled_at: null,
    ai_status: 'pending',
    ai_synthesis: null,
    ai_key_positives: null,
    ai_key_concerns: null,
    ai_opinion_verdict: null,
    ai_opinion_summary: null,
    ai_vote_choice: null,
    ai_error: null,
    created_at: '2026-09-03T10:00:00.000Z',
    updated_at: '2026-09-03T10:00:00.000Z',
    ...overrides,
  };
}

function makeBallot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    vote_session_id: 'vs-1',
    voter_id: 'u-1',
    choice: null,
    body_html: null,
    status: 'draft',
    submitted_at: null,
    auto_submitted: false,
    created_at: '2026-09-03T10:00:00.000Z',
    updated_at: '2026-09-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('CompanyVoteService', () => {
  let voteRepo: ReturnType<typeof makeVoteRepo>;
  let userRepo: { findAllInWorkspace: ReturnType<typeof vi.fn>; findByIds: ReturnType<typeof vi.fn> };
  let companyRepo: { findByIdOrNull: ReturnType<typeof vi.fn> };
  let workspaceRepo: { findById: ReturnType<typeof vi.fn> };
  let cardService: { buildById: ReturnType<typeof vi.fn> };
  let aiOpinionService: { dispatch: ReturnType<typeof vi.fn> };
  let jobDispatcher: { dispatch: ReturnType<typeof vi.fn> };
  let emailService: {
    sendVoteInvitationEmail: ReturnType<typeof vi.fn>;
    sendVoteSubmittedEmail: ReturnType<typeof vi.fn>;
    sendVoteRecapEmail: ReturnType<typeof vi.fn>;
  };
  let enqueue: ReturnType<typeof vi.fn>;
  let service: CompanyVoteService;

  function build() {
    return new CompanyVoteService(
      voteRepo as never,
      userRepo as never,
      companyRepo as never,
      workspaceRepo as never,
      cardService as never,
      aiOpinionService as never,
      jobDispatcher as never,
      'ws-1',
      emailService as never,
      enqueue as never,
      () => NOW,
    );
  }

  beforeEach(() => {
    mocks.generateVoteSynthesis.mockReset();
    mocks.exportElementsToPptx.mockReset();
    voteRepo = makeVoteRepo();
    userRepo = {
      findAllInWorkspace: vi.fn().mockResolvedValue([
        { id: 'u-init', name: 'Nico', email: 'nico@example.com' },
        { id: 'u-1', name: 'CP Tei', email: 'cp@example.com' },
        { id: 'u-2', name: 'Dessi Sari', email: 'dessi@example.com' },
      ]),
      findByIds: vi.fn().mockResolvedValue([
        { id: 'u-init', name: 'Nico', email: 'nico@example.com' },
        { id: 'u-1', name: 'CP Tei', email: 'cp@example.com' },
        { id: 'u-2', name: 'Dessi Sari', email: 'dessi@example.com' },
      ]),
    };
    companyRepo = { findByIdOrNull: vi.fn().mockResolvedValue(null) };
    workspaceRepo = { findById: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'mna' }) };
    cardService = { buildById: vi.fn() };
    aiOpinionService = { dispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }) };
    jobDispatcher = { dispatch: vi.fn().mockResolvedValue({ jobId: 'job-1' }) };
    emailService = {
      sendVoteInvitationEmail: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
      sendVoteSubmittedEmail: vi.fn().mockResolvedValue({ messageId: 'm-2' }),
      sendVoteRecapEmail: vi.fn().mockResolvedValue({ messageId: 'm-3' }),
    };
    enqueue = vi.fn().mockResolvedValue({ messageId: 'q-1' });
    voteRepo.findCompanyNames.mockResolvedValue({
      id: 'c-1',
      target: 'Highway Materials',
      project_name: 'Project Highway',
    });
    service = build();
  });

  afterEach(() => vi.clearAllMocks());

  // -------------------------------------------------------------------------
  describe('getState', () => {
    it('offers Start Vote when the company has never been voted on', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(null);

      const state = await service.getState('c-1', 'u-1');

      expect(state.session).toBeNull();
      expect(state.visibility).toBe('none');
      expect(state.viewer.canStartVote).toBe(true);
      expect(voteRepo.listBallotsBySessionId).not.toHaveBeenCalled();
    });

    it('hides every other voter’s choice and rationale while the round is open', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', body_html: '<p>mine</p>' }),
        makeBallot({
          id: 'b-2',
          voter_id: 'u-2',
          choice: 'hard_no',
          body_html: '<p>theirs</p>',
          status: 'submitted',
        }),
      ]);

      const state = await service.getState('c-1', 'u-1');

      expect(state.visibility).toBe('in_progress');
      const own = state.session!.voters.find((v) => v.userId === 'u-1')!;
      const other = state.session!.voters.find((v) => v.userId === 'u-2')!;
      expect(own.choice).toBe('yes');
      expect(own.bodyHtml).toBe('<p>mine</p>');
      expect(other.choice).toBeNull();
      expect(other.bodyHtml).toBeNull();
      // Progress is still visible — that's how the initiator knows who to nudge.
      expect(other.status).toBe('submitted');
      expect(state.session!.submittedCount).toBe(1);
      expect(state.session!.tally).toBeNull();
      expect(state.session!.ai).toBeNull();
    });

    it('marks a non-voter as neither voter nor initiator', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([makeBallot({ voter_id: 'u-1' })]);

      const state = await service.getState('c-1', 'u-9');

      expect(state.viewer.isVoter).toBe(false);
      expect(state.viewer.isInitiator).toBe(false);
      expect(state.viewer.ballot).toBeNull();
      expect(state.visibility).toBe('in_progress');
    });

    it('reveals every ballot, the tally and the AI synthesis once concluded', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({
          status: 'completed',
          concluded_at: '2026-09-04T10:00:00.000Z',
          ai_status: 'completed',
          ai_synthesis: 'Unanimous to proceed.',
          ai_key_positives: ['Scarce asset'],
          ai_key_concerns: ['Thin EBITDA'],
          ai_opinion_verdict: 'fail',
          ai_opinion_summary: 'Sub-scale.',
        }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', status: 'submitted' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', choice: 'yes', status: 'submitted' }),
      ]);

      const state = await service.getState('c-1', 'u-9');

      expect(state.visibility).toBe('results');
      expect(state.session!.tally!.headline).toBe('2–0 FOR');
      // Two humans plus the AI Opinion.
      expect(state.session!.voterCount).toBe(3);
      expect(state.session!.ai).toEqual({
        status: 'completed',
        synthesis: 'Unanimous to proceed.',
        keyPositives: ['Scarce asset'],
        keyConcerns: ['Thin EBITDA'],
        opinionVerdict: 'fail',
        opinionSummary: 'Sub-scale.',
        error: null,
      });
      expect(state.viewer.canStartVote).toBe(true);
    });

    it('counts the AI Opinion as one more voter while the round is open', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', status: 'submitted' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', status: 'draft' }),
      ]);
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_status: 'completed',
        ai_opinion_verdict: 'pass',
      });

      const state = await service.getState('c-1', 'u-1');

      // 2 humans + the AI
      expect(state.session!.voterCount).toBe(3);
      // The AI has not voted yet — its ballot resolves at conclusion.
      expect(state.session!.submittedCount).toBe(1);
      expect(state.session!.aiParticipant.submitted).toBe(false);
      expect(state.session!.aiParticipant.opinionStatus).toBe('completed');
    });

    it('hides the AI’s verdict and vote while the round is open', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({ ai_vote_choice: 'no', ai_opinion_verdict: 'fail' }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([]);

      const state = await service.getState('c-1', 'u-1');

      expect(state.session!.aiParticipant.choice).toBeNull();
      expect(state.session!.aiParticipant.verdict).toBeNull();
      expect(state.session!.aiParticipant.summary).toBeNull();
    });

    it('surfaces the AI as a generating participant while its opinion runs', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([]);
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_status: 'processing',
      });

      const state = await service.getState('c-1', 'u-1');

      expect(state.session!.aiParticipant.opinionStatus).toBe('processing');
      expect(state.session!.aiParticipant.submitted).toBe(false);
    });

    it('folds the AI ballot into the concluded tally', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({
          status: 'completed',
          ai_vote_choice: 'no',
          ai_opinion_verdict: 'fail',
          ai_opinion_summary: 'Sub-scale.',
        }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', status: 'submitted' }),
      ]);

      const state = await service.getState('c-1', 'u-1');

      // 1 human YES vs the AI's NO — a genuine split, not a 1-0 win.
      expect(state.session!.tally!.headline).toBe('1–1 SPLIT');
      expect(state.session!.tally!.castCount).toBe(2);
      expect(state.session!.aiParticipant).toEqual({
        choice: 'no',
        verdict: 'fail',
        summary: 'Sub-scale.',
        opinionStatus: null,
        submitted: true,
      });
      expect(state.session!.submittedCount).toBe(2);
    });

    it('keeps a cancelled round’s drafts private', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({ status: 'cancelled', cancelled_at: '2026-09-04T10:00:00.000Z' }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', body_html: '<p>draft</p>' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', choice: 'no', body_html: '<p>draft</p>' }),
      ]);

      const state = await service.getState('c-1', 'u-1');

      expect(state.visibility).toBe('none');
      expect(state.session!.tally).toBeNull();
      expect(state.session!.ai).toBeNull();
      const other = state.session!.voters.find((v) => v.userId === 'u-2')!;
      expect(other.choice).toBeNull();
      expect(other.bodyHtml).toBeNull();
      expect(state.viewer.canStartVote).toBe(true);
    });

    it('does not offer Start Vote while a round is open', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([]);

      const state = await service.getState('c-1', 'u-init');

      expect(state.viewer.canStartVote).toBe(false);
      expect(state.viewer.isInitiator).toBe(true);
    });

    it('shows the initiator every ballot live while their round is open', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({
          id: 'b-1',
          voter_id: 'u-1',
          choice: 'yes',
          body_html: '<p>in favour</p>',
          status: 'submitted',
        }),
        makeBallot({
          id: 'b-2',
          voter_id: 'u-2',
          choice: 'hard_no',
          body_html: '<p>still drafting</p>',
          status: 'draft',
        }),
      ]);

      const state = await service.getState('c-1', 'u-init');

      expect(state.visibility).toBe('live_results');
      const submitted = state.session!.voters.find((v) => v.userId === 'u-1')!;
      const drafting = state.session!.voters.find((v) => v.userId === 'u-2')!;
      expect(submitted.choice).toBe('yes');
      expect(submitted.bodyHtml).toBe('<p>in favour</p>');
      // A draft is visible too — the organizer is watching the room, and the
      // UI labels it as unsettled.
      expect(drafting.choice).toBe('hard_no');
      expect(drafting.bodyHtml).toBe('<p>still drafting</p>');
      expect(drafting.status).toBe('draft');
    });

    it('counts only submitted ballots in the initiator’s running tally', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', status: 'submitted' }),
        // A draft NO must not tip the headline — it is not a vote yet.
        makeBallot({ id: 'b-2', voter_id: 'u-2', choice: 'hard_no', status: 'draft' }),
      ]);

      const state = await service.getState('c-1', 'u-init');

      expect(state.session!.tally!.headline).toBe('1–0 FOR');
      expect(state.session!.tally!.castCount).toBe(1);
    });

    it('shows the AI’s standing opinion live, flagged as not yet cast', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', status: 'submitted' }),
      ]);
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_status: 'completed',
        ai_opinion_verdict: 'fail',
        ai_opinion_summary: 'Sub-scale.',
      });

      const state = await service.getState('c-1', 'u-init');

      expect(state.session!.aiParticipant.choice).toBe('no');
      expect(state.session!.aiParticipant.verdict).toBe('fail');
      expect(state.session!.aiParticipant.summary).toBe('Sub-scale.');
      expect(state.session!.aiParticipant.submitted).toBe(false);
      // …and it is NOT folded into the running tally, because it has not voted.
      expect(state.session!.tally!.castCount).toBe(1);
      expect(state.session!.submittedCount).toBe(1);
    });

    it('withholds the synthesis from the live view — it is written at close', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({ ai_synthesis: 'leftover', ai_key_positives: ['stale'] }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([makeBallot({ voter_id: 'u-1' })]);

      const state = await service.getState('c-1', 'u-init');

      expect(state.session!.ai!.synthesis).toBeNull();
      expect(state.session!.ai!.keyPositives).toEqual([]);
      expect(state.session!.ai!.keyConcerns).toEqual([]);
    });

    it('does not leak the live view to a voter, even one who has submitted', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', status: 'submitted' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', choice: 'no', status: 'submitted' }),
      ]);

      const state = await service.getState('c-1', 'u-1');

      expect(state.visibility).toBe('in_progress');
      expect(state.session!.tally).toBeNull();
      expect(state.session!.ai).toBeNull();
      expect(state.session!.voters.find((v) => v.userId === 'u-2')!.choice).toBeNull();
    });

    it('does not give the initiator a live view of a cancelled round', async () => {
      // Nobody consented to publishing a half-written rationale, not even to
      // the person who abandoned the round.
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(
        makeSession({ status: 'cancelled', cancelled_at: '2026-09-04T10:00:00.000Z' }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1', choice: 'yes', body_html: '<p>x</p>' }),
      ]);

      const state = await service.getState('c-1', 'u-init');

      expect(state.visibility).toBe('none');
      expect(state.session!.tally).toBeNull();
      expect(state.session!.voters[0].choice).toBeNull();
    });

    it('resolves voter names in one bulk lookup, never per voter', async () => {
      voteRepo.findLatestSessionByCompanyId.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2' }),
      ]);

      await service.getState('c-1', 'u-1');

      expect(userRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(userRepo.findByIds).toHaveBeenCalledWith(['u-init', 'u-1', 'u-2']);
    });
  });

  // -------------------------------------------------------------------------
  describe('startVote', () => {
    beforeEach(() => {
      voteRepo.findActiveSessionByCompanyId.mockResolvedValue(null);
      voteRepo.createSession.mockResolvedValue(makeSession());
    });

    it('creates the session, one ballot per voter, and queues the invitations', async () => {
      await service.startVote({
        companyId: 'c-1',
        initiatorId: 'u-init',
        voterIds: ['u-1', 'u-2'],
        deadlineAt: DEADLINE,
      });

      // workspace_id is stamped by the repository, never passed in.
      expect(voteRepo.createSession).toHaveBeenCalledWith(
        expect.not.objectContaining({ workspace_id: expect.anything() }),
      );
      expect(voteRepo.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          company_id: 'c-1',
          initiated_by: 'u-init',
          status: 'active',
          deadline_at: DEADLINE,
        }),
      );
      expect(voteRepo.insertBallots).toHaveBeenCalledWith([
        { vote_session_id: 'vs-1', voter_id: 'u-1', status: 'draft' },
        { vote_session_id: 'vs-1', voter_id: 'u-2', status: 'draft' },
      ]);
      expect(jobDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'company_vote',
          payload: { kind: 'invite', sessionId: 'vs-1', workspaceId: 'ws-1' },
        }),
      );
    });

    it('dedupes a voter selected twice', async () => {
      await service.startVote({
        companyId: 'c-1',
        initiatorId: 'u-init',
        voterIds: ['u-1', 'u-1', 'u-2'],
        deadlineAt: DEADLINE,
      });

      expect(voteRepo.insertBallots).toHaveBeenCalledWith([
        { vote_session_id: 'vs-1', voter_id: 'u-1', status: 'draft' },
        { vote_session_id: 'vs-1', voter_id: 'u-2', status: 'draft' },
      ]);
    });

    it('rejects a second round while one is open', async () => {
      voteRepo.findActiveSessionByCompanyId.mockResolvedValue(makeSession());

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(voteRepo.createSession).not.toHaveBeenCalled();
    });

    it('rejects an empty voter list', async () => {
      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: [],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toThrow(/at least one voter/);
    });

    it('rejects a voter who is not a member of the workspace', async () => {
      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1', 'stranger'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toThrow(/not a member of this workspace/);
    });

    it('stores the picked instant verbatim rather than re-deriving it', async () => {
      // The initiator chose a wall-clock deadline in their own timezone; the
      // server must not round, shift or recompute it.
      await service.startVote({
        companyId: 'c-1',
        initiatorId: 'u-init',
        voterIds: ['u-1'],
        deadlineAt: '2026-09-04T23:45:00.000Z',
      });

      expect(voteRepo.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ deadline_at: '2026-09-04T23:45:00.000Z' }),
      );
    });

    it('rejects a deadline inside the minimum lead time', async () => {
      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          // 5 minutes out — the invitation email would not even land first.
          deadlineAt: '2026-09-03T10:05:00.000Z',
        }),
      ).rejects.toThrow(/at least 15 minutes/);
      expect(voteRepo.createSession).not.toHaveBeenCalled();
    });

    it('rejects a deadline in the past', async () => {
      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: '2026-09-01T10:00:00.000Z',
        }),
      ).rejects.toThrow(/at least 15 minutes/);
    });

    it('rejects an unparseable deadline as a 400, not a 500', async () => {
      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: 'sometime next week',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('404s when the company is not in this workspace', async () => {
      voteRepo.findCompanyNames.mockResolvedValue(null);

      await expect(
        service.startVote({
          companyId: 'c-9',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('kicks off an AI Opinion when the company has none — it votes as one person', async () => {
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_verdict: null,
      });

      await service.startVote({
        companyId: 'c-1',
        initiatorId: 'u-init',
        voterIds: ['u-1'],
        deadlineAt: DEADLINE,
      });

      expect(aiOpinionService.dispatch).toHaveBeenCalledWith('c-1', 'u-init');
    });

    it('does not re-run an AI Opinion that already exists', async () => {
      // AiOpinionService.dispatch clears the existing verdict, so calling it
      // here would throw away the opinion the round is about to count.
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_verdict: 'fail',
        ai_opinion_summary: 'Sub-scale.',
      });

      await service.startVote({
        companyId: 'c-1',
        initiatorId: 'u-init',
        voterIds: ['u-1'],
        deadlineAt: DEADLINE,
      });

      expect(aiOpinionService.dispatch).not.toHaveBeenCalled();
    });

    it('still opens the round when the AI Opinion cannot be started', async () => {
      aiOpinionService.dispatch.mockRejectedValue(new Error('workforce down'));

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).resolves.toMatchObject({ invitationsQueued: true });
    });

    it('reports invitationsQueued: false when the notification job is dropped', async () => {
      jobDispatcher.dispatch.mockRejectedValue(new Error('enum missing'));

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).resolves.toMatchObject({ invitationsQueued: false });
    });

    it('maps the one-active-round unique violation to a 409, not a 500', async () => {
      // Two concurrent clicks both pass the pre-check; the partial unique index
      // rejects the loser.
      voteRepo.createSession.mockRejectedValue(
        Object.assign(new Error('duplicate key value'), { code: '23505' }),
      );

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('rethrows a non-unique insert failure untouched', async () => {
      voteRepo.createSession.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toThrow('connection reset');
    });

    it('rolls the session back when the ballot insert fails', async () => {
      // A session with no ballots would block every future round on this
      // company via the partial unique index.
      voteRepo.insertBallots.mockRejectedValue(new Error('ballot insert failed'));
      voteRepo.deleteSession.mockResolvedValue(undefined);

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).rejects.toThrow('ballot insert failed');
      expect(voteRepo.deleteSession).toHaveBeenCalledWith('vs-1');
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('still persists the round when queueing the invitation job fails', async () => {
      jobDispatcher.dispatch.mockRejectedValue(new Error('queue down'));

      await expect(
        service.startVote({
          companyId: 'c-1',
          initiatorId: 'u-init',
          voterIds: ['u-1'],
          deadlineAt: DEADLINE,
        }),
      ).resolves.toMatchObject({ invitationsQueued: false });
      expect(voteRepo.createSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('saveBallot', () => {
    beforeEach(() => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.findBallot.mockResolvedValue(makeBallot());
      voteRepo.updateBallot.mockImplementation(async (_id, updates) =>
        makeBallot({ ...updates }),
      );
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ status: 'submitted' }),
      ]);
    });

    it('saves a draft without submitting it', async () => {
      await service.saveBallot({
        sessionId: 'vs-1',
        voterId: 'u-1',
        choice: 'yes',
        bodyHtml: '<p>Support the NDA</p>',
      });

      expect(voteRepo.updateBallot).toHaveBeenCalledWith(
        'b-1',
        { choice: 'yes', body_html: '<p>Support the NDA</p>' },
        { expectedStatus: 'draft' },
      );
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('sanitizes the rationale before storing it', async () => {
      await service.saveBallot({
        sessionId: 'vs-1',
        voterId: 'u-1',
        bodyHtml: '<p onclick="x()">ok</p><script>bad()</script>',
      });

      expect(voteRepo.updateBallot).toHaveBeenCalledWith(
        'b-1',
        expect.objectContaining({ body_html: '<p>ok</p>' }),
        { expectedStatus: 'draft' },
      );
    });

    it('leaves a field untouched when the caller omits it', async () => {
      voteRepo.findBallot.mockResolvedValue(
        makeBallot({ choice: 'no', body_html: '<p>kept</p>' }),
      );

      await service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', choice: 'yes' });

      expect(voteRepo.updateBallot).toHaveBeenCalledWith(
        'b-1',
        { choice: 'yes', body_html: '<p>kept</p>' },
        { expectedStatus: 'draft' },
      );
    });

    it('locks the ballot and emails a confirmation on submit', async () => {
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ status: 'submitted' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', status: 'draft' }),
      ]);

      await service.saveBallot({
        sessionId: 'vs-1',
        voterId: 'u-1',
        choice: 'hard_yes',
        submit: true,
      });

      expect(voteRepo.updateBallot).toHaveBeenCalledWith(
        'b-1',
        expect.objectContaining({
          status: 'submitted',
          submitted_at: NOW.toISOString(),
          auto_submitted: false,
        }),
        { expectedStatus: 'draft' },
      );
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'vote_submitted',
          to: 'cp@example.com',
          companyName: 'Highway Materials',
          choiceLabel: 'HARD YES',
        }),
      );
    });

    it('concludes the round when the last ballot is submitted', async () => {
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));

      await service.saveBallot({
        sessionId: 'vs-1',
        voterId: 'u-1',
        choice: 'yes',
        submit: true,
      });

      expect(voteRepo.updateSession).toHaveBeenCalledWith(
        'vs-1',
        expect.objectContaining({ status: 'completed', ai_status: 'processing' }),
        { expectedStatus: 'active' },
      );
      expect(jobDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ kind: 'conclude', reason: 'all_submitted' }),
        }),
      );
    });

    it('does not conclude while another ballot is still in draft', async () => {
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ status: 'submitted' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2', status: 'draft' }),
      ]);

      await service.saveBallot({
        sessionId: 'vs-1',
        voterId: 'u-1',
        choice: 'yes',
        submit: true,
      });

      expect(voteRepo.updateSession).not.toHaveBeenCalled();
    });

    it('refuses to submit without a choice', async () => {
      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', submit: true }),
      ).rejects.toThrow(/Pick a vote/);
    });

    it('rejects an unknown choice value', async () => {
      await expect(
        service.saveBallot({
          sessionId: 'vs-1',
          voterId: 'u-1',
          choice: 'maybe' as never,
        }),
      ).rejects.toThrow(/Unknown vote choice/);
    });

    it('refuses to edit an already-submitted ballot', async () => {
      voteRepo.findBallot.mockResolvedValue(makeBallot({ status: 'submitted' }));

      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', choice: 'no' }),
      ).rejects.toThrow(/already submitted/);
    });

    it('refuses a non-voter', async () => {
      voteRepo.findBallot.mockResolvedValue(null);

      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-9', choice: 'no' }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('409s when the compare-and-swap loses to a concurrent submit', async () => {
      // Both requests read `draft`; only the first UPDATE matches a row.
      voteRepo.updateBallot.mockResolvedValue(null);

      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', choice: 'no' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses a sessionId that belongs to a different company', async () => {
      await expect(
        service.saveBallot({
          sessionId: 'vs-1',
          voterId: 'u-1',
          companyId: 'c-other',
          choice: 'yes',
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(voteRepo.updateBallot).not.toHaveBeenCalled();
    });

    it('accepts a sessionId that does belong to the company in the URL', async () => {
      await expect(
        service.saveBallot({
          sessionId: 'vs-1',
          voterId: 'u-1',
          companyId: 'c-1',
          choice: 'yes',
        }),
      ).resolves.toBeTruthy();
    });

    it('refuses an edit after the deadline has passed', async () => {
      voteRepo.findSessionById.mockResolvedValue(
        makeSession({ deadline_at: '2026-09-01T00:00:00.000Z' }),
      );

      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', choice: 'no' }),
      ).rejects.toThrow(/deadline has passed/);
    });

    it('refuses an edit on a closed round', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession({ status: 'completed' }));

      await expect(
        service.saveBallot({ sessionId: 'vs-1', voterId: 'u-1', choice: 'no' }),
      ).rejects.toThrow(/closed/);
    });
  });

  // -------------------------------------------------------------------------
  describe('cancelVote', () => {
    it('cancels an open round for its initiator', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'cancelled' }));

      await service.cancelVote('vs-1', 'u-init');

      expect(voteRepo.updateSession).toHaveBeenCalledWith(
        'vs-1',
        { status: 'cancelled', cancelled_at: NOW.toISOString() },
        { expectedStatus: 'active' },
      );
    });

    it('refuses anyone who is not the initiator', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());

      await expect(service.cancelVote('vs-1', 'u-1')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('refuses a round that is already closed', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession({ status: 'completed' }));

      await expect(service.cancelVote('vs-1', 'u-init')).rejects.toThrow(/already closed/);
    });

    it('404s on an unknown session', async () => {
      voteRepo.findSessionById.mockResolvedValue(null);

      await expect(service.cancelVote('nope', 'u-init')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('409s when the round concluded between the read and the write', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateSession.mockResolvedValue(null);

      await expect(service.cancelVote('vs-1', 'u-init')).rejects.toMatchObject({
        status: 409,
      });
    });

    it('refuses a sessionId that belongs to a different company', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());

      await expect(
        service.cancelVote('vs-1', 'u-init', 'c-other'),
      ).rejects.toMatchObject({ status: 404 });
      expect(voteRepo.updateSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('sendBackSubmissions', () => {
    it('flips only submitted ballots back to draft, in one statement', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateBallotsBySessionId.mockResolvedValue([
        makeBallot(),
        makeBallot({ id: 'b-2' }),
      ]);

      await expect(service.sendBackSubmissions('vs-1', 'u-init')).resolves.toEqual({
        reopened: 2,
      });
      expect(voteRepo.updateBallotsBySessionId).toHaveBeenCalledWith(
        'vs-1',
        { status: 'draft', submitted_at: null, auto_submitted: false },
        { onlyStatus: 'submitted' },
      );
    });

    it('refuses a non-initiator', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());

      await expect(service.sendBackSubmissions('vs-1', 'u-1')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('refuses once the round is closed', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession({ status: 'completed' }));

      await expect(service.sendBackSubmissions('vs-1', 'u-init')).rejects.toThrow(
        /closed/,
      );
    });

    it('refuses a sessionId that belongs to a different company', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());

      await expect(
        service.sendBackSubmissions('vs-1', 'u-init', 'c-other'),
      ).rejects.toMatchObject({ status: 404 });
      expect(voteRepo.updateBallotsBySessionId).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('concludeSession', () => {
    it('submits a picked-but-unsubmitted draft as picked, and an untouched one as inconclusive', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateBallotsBySessionId.mockResolvedValue([]);
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));

      await service.concludeSession('vs-1', 'deadline');

      // Draft WITH a choice: keep it — the voter made the call, they just
      // never pressed Submit.
      expect(voteRepo.updateBallotsBySessionId).toHaveBeenNthCalledWith(
        1,
        'vs-1',
        {
          status: 'submitted',
          submitted_at: NOW.toISOString(),
          auto_submitted: true,
        },
        { onlyStatus: 'draft', choiceIsNull: false },
      );
      // Draft WITHOUT a choice: inconclusive, never an invented direction.
      expect(voteRepo.updateBallotsBySessionId).toHaveBeenNthCalledWith(
        2,
        'vs-1',
        {
          status: 'submitted',
          submitted_at: NOW.toISOString(),
          auto_submitted: true,
          choice: 'inconclusive',
        },
        { onlyStatus: 'draft', choiceIsNull: true },
      );
    });

    it('records the AI as INCONCLUSIVE when no opinion made it in time', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateBallotsBySessionId.mockResolvedValue([]);
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_verdict: null,
      });

      await service.concludeSession('vs-1', 'deadline');

      expect(voteRepo.updateSession).toHaveBeenCalledWith(
        'vs-1',
        expect.objectContaining({ ai_vote_choice: 'inconclusive' }),
        { expectedStatus: 'active' },
      );
    });

    it('snapshots the company AI Opinion onto the round', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.updateBallotsBySessionId.mockResolvedValue([]);
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));
      companyRepo.findByIdOrNull.mockResolvedValue({
        id: 'c-1',
        ai_opinion_verdict: 'fail',
        ai_opinion_summary: 'Sub-scale.',
      });

      await service.concludeSession('vs-1', 'deadline');

      expect(voteRepo.updateSession).toHaveBeenCalledWith(
        'vs-1',
        {
          status: 'completed',
          concluded_at: NOW.toISOString(),
          ai_status: 'processing',
          ai_opinion_verdict: 'fail',
          ai_opinion_summary: 'Sub-scale.',
          // fail -> NO, so the AI casts a real against vote.
          ai_vote_choice: 'no',
        },
        { expectedStatus: 'active' },
      );
    });

    it('is a no-op on a round that is no longer active', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession({ status: 'completed' }));

      await service.concludeSession('vs-1', 'deadline');

      expect(voteRepo.updateSession).not.toHaveBeenCalled();
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('claims the round before any side effect, and skips them all when it loses', async () => {
      // The last submit racing the deadline cron: both read `active`, only one
      // UPDATE … WHERE status = 'active' matches.
      voteRepo.findSessionById
        .mockResolvedValueOnce(makeSession())
        .mockResolvedValue(makeSession({ status: 'completed' }));
      voteRepo.updateSession.mockResolvedValue(null);

      await service.concludeSession('vs-1', 'deadline');

      expect(voteRepo.updateBallotsBySessionId).not.toHaveBeenCalled();
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('is a no-op on an unknown session', async () => {
      voteRepo.findSessionById.mockResolvedValue(null);

      await expect(service.concludeSession('nope', 'deadline')).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('processDueSessions', () => {
    it('concludes every overdue round', async () => {
      voteRepo.findDueSessions.mockResolvedValue([
        makeSession({ id: 'vs-1' }),
        makeSession({ id: 'vs-2' }),
      ]);
      voteRepo.findSessionById.mockImplementation(async (id: string) =>
        makeSession({ id }),
      );
      voteRepo.updateBallotsBySessionId.mockResolvedValue([]);
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));

      await expect(service.processDueSessions()).resolves.toEqual({ concluded: 2 });
      expect(voteRepo.findDueSessions).toHaveBeenCalledWith(NOW.toISOString());
    });

    it('keeps sweeping after one round fails', async () => {
      voteRepo.findDueSessions.mockResolvedValue([
        makeSession({ id: 'vs-1' }),
        makeSession({ id: 'vs-2' }),
      ]);
      voteRepo.findSessionById
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation(async (id: string) => makeSession({ id }));
      voteRepo.updateBallotsBySessionId.mockResolvedValue([]);
      voteRepo.updateSession.mockResolvedValue(makeSession({ status: 'completed' }));

      await expect(service.processDueSessions()).resolves.toEqual({ concluded: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe('deliverInvitations', () => {
    beforeEach(() => {
      voteRepo.findSessionById.mockResolvedValue(makeSession());
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-1' }),
        makeBallot({ id: 'b-2', voter_id: 'u-2' }),
      ]);
      cardService.buildById.mockResolvedValue({
        companyId: 'c-1',
        title: 'Highway',
        slides: [{ elements: [] }],
      });
      mocks.exportElementsToPptx.mockResolvedValue(Buffer.from('pptx'));
    });

    it('builds the deck once and attaches it to every invitation', async () => {
      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 2,
        failed: 0,
      });

      expect(cardService.buildById).toHaveBeenCalledTimes(1);
      expect(mocks.exportElementsToPptx).toHaveBeenCalledTimes(1);
      expect(emailService.sendVoteInvitationEmail).toHaveBeenCalledTimes(2);
      expect(emailService.sendVoteInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'cp@example.com',
          companyName: 'Highway Materials',
          initiatorName: 'Nico',
          deadlineLabel: '10:00 AM UTC on September 5, 2026',
          companyCardPptx: expect.any(Buffer),
          voteUrl: 'http://localhost:3000/w/mna/companies/c-1?tab=voting',
          companyCardUrl: 'http://localhost:3000/w/mna/companies/c-1?tab=overview',
        }),
      );
    });

    it('still invites everyone when the deck cannot be built', async () => {
      cardService.buildById.mockRejectedValue(new Error('no card'));

      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 2,
        failed: 0,
      });
      expect(emailService.sendVoteInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ companyCardPptx: undefined }),
      );
    });

    it('counts a voter with no email address as failed and keeps going', async () => {
      userRepo.findByIds.mockResolvedValue([
        { id: 'u-init', name: 'Nico', email: 'nico@example.com' },
        { id: 'u-1', name: 'CP Tei', email: null },
        { id: 'u-2', name: 'Dessi Sari', email: 'dessi@example.com' },
      ]);

      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 1,
        failed: 1,
      });
    });

    it('counts a send failure without aborting the fan-out', async () => {
      emailService.sendVoteInvitationEmail
        .mockRejectedValueOnce(new Error('SES down'))
        .mockResolvedValue({ messageId: 'm-1' });

      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 1,
        failed: 1,
      });
    });

    it('does not invite anyone to a round that was cancelled before the job ran', async () => {
      voteRepo.findSessionById.mockResolvedValue(makeSession({ status: 'cancelled' }));

      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 0,
        failed: 0,
      });
      expect(cardService.buildById).not.toHaveBeenCalled();
      expect(emailService.sendVoteInvitationEmail).not.toHaveBeenCalled();
    });

    it('does nothing when the round has no voters', async () => {
      voteRepo.listBallotsBySessionId.mockResolvedValue([]);

      await expect(service.deliverInvitations('vs-1')).resolves.toEqual({
        sent: 0,
        failed: 0,
      });
      expect(cardService.buildById).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('finalizeConcludedSession', () => {
    beforeEach(() => {
      voteRepo.findSessionById.mockResolvedValue(
        makeSession({ status: 'completed', ai_status: 'processing' }),
      );
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({
          id: 'b-1',
          voter_id: 'u-1',
          choice: 'yes',
          status: 'submitted',
          body_html: '<p>Support the NDA</p>',
        }),
        makeBallot({
          id: 'b-2',
          voter_id: 'u-2',
          choice: 'yes',
          status: 'submitted',
        }),
      ]);
      mocks.generateVoteSynthesis.mockResolvedValue({
        synthesis: 'Unanimous to proceed.',
        key_positives: ['Scarce asset'],
        key_concerns: ['Thin EBITDA'],
      });
    });

    it('stores the synthesis and recaps the initiator plus every voter once', async () => {
      await service.finalizeConcludedSession('vs-1', 'all_submitted');

      expect(voteRepo.updateSession).toHaveBeenCalledWith('vs-1', {
        ai_status: 'completed',
        ai_synthesis: 'Unanimous to proceed.',
        ai_key_positives: ['Scarce asset'],
        ai_key_concerns: ['Thin EBITDA'],
        ai_error: null,
      });
      const recipients = enqueue.mock.calls.map(([payload]) => payload.to);
      expect(new Set(recipients)).toEqual(
        new Set(['nico@example.com', 'cp@example.com', 'dessi@example.com']),
      );
      expect(recipients).toHaveLength(3);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'vote_recap',
          headline: '2–0 FOR',
          outcomeLabel: '2 Proceed',
          closedReason: 'all_submitted',
        }),
      );
    });

    it('flattens each ballot body to plain text for the recap', async () => {
      await service.finalizeConcludedSession('vs-1', 'deadline');

      const [payload] = enqueue.mock.calls[0];
      expect(payload.ballots).toEqual([
        { voterName: 'CP Tei', choiceLabel: 'YES', rationale: 'Support the NDA' },
        { voterName: 'Dessi Sari', choiceLabel: 'YES', rationale: undefined },
        // The AI Opinion voted too, so the recap lists it like any reviewer.
        { voterName: 'AI Opinion', choiceLabel: 'NO VOTE RECORDED', rationale: undefined },
      ]);
    });

    it('passes the AI Opinion to the synthesis as a participating ballot', async () => {
      voteRepo.findSessionById.mockResolvedValue(
        makeSession({
          status: 'completed',
          ai_vote_choice: 'no',
          ai_opinion_summary: 'Sub-scale with thin EBITDA.',
        }),
      );

      await service.finalizeConcludedSession('vs-1', 'all_submitted');

      const [args] = mocks.generateVoteSynthesis.mock.calls[0];
      expect(args.ballots).toEqual(
        expect.arrayContaining([
          {
            voterName: 'AI Opinion',
            choice: 'no',
            bodyHtml: 'Sub-scale with thin EBITDA.',
          },
        ]),
      );
      // 2 human YES vs the AI's NO
      expect(args.tally.headline).toBe('2–1 FOR');
    });

    it('records a synthesis failure but still sends the recap', async () => {
      mocks.generateVoteSynthesis.mockRejectedValue(new Error('model down'));

      await service.finalizeConcludedSession('vs-1', 'deadline');

      expect(voteRepo.updateSession).toHaveBeenCalledWith('vs-1', {
        ai_status: 'failed',
        ai_error: 'model down',
      });
      expect(enqueue).toHaveBeenCalled();
    });

    it('does not let one failed recap block the others', async () => {
      enqueue.mockRejectedValueOnce(new Error('queue down'));

      await expect(
        service.finalizeConcludedSession('vs-1', 'deadline'),
      ).resolves.toBeUndefined();
      expect(enqueue).toHaveBeenCalledTimes(3);
    });

    it('dedupes the initiator who also voted', async () => {
      voteRepo.listBallotsBySessionId.mockResolvedValue([
        makeBallot({ id: 'b-1', voter_id: 'u-init', choice: 'yes', status: 'submitted' }),
      ]);

      await service.finalizeConcludedSession('vs-1', 'deadline');

      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });
});

describe('formatDeadline', () => {
  it('renders a readable UTC instant', () => {
    expect(formatDeadline('2026-09-05T17:00:00.000Z')).toBe(
      '5:00 PM UTC on September 5, 2026',
    );
  });

  it('passes an unparseable value straight through', () => {
    expect(formatDeadline('not-a-date')).toBe('not-a-date');
  });
});

describe('VoteRuleError', () => {
  it('defaults to a 400', () => {
    expect(new VoteRuleError('nope').status).toBe(400);
  });
});
