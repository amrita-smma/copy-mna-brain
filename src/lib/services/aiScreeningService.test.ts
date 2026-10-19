import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  runAIScreening: vi.fn(),
  workspaceInContext: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun: mocks.enqueueAgentRun }));
vi.mock('@/lib/jobs/handlers/aiScreening', () => ({ runAIScreening: mocks.runAIScreening }));
vi.mock('@/lib/workspace', () => ({
  runWithWorkforceWorkspaceId: (workspaceId: string, fn: () => unknown) => {
    mocks.workspaceInContext(workspaceId);
    return fn();
  },
}));

import {
  AI_SCREENING_AGENT_NAME,
  AIScreeningService,
  NotPendingConfirmationError,
} from './aiScreeningService';

const WS = 'ws-1';
const DB = { db: true };

const company = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  target: `Co ${id}`,
  project_name: null,
  matched_track_ids: ['t1'],
  ...overrides,
});
const TRACKS = [{ id: 't1', title: 'Healthcare' }, { id: 't2', title: 'Energy' }];
const CRITERIA = [
  { id: 'k1', prompt: 'p1', investment_thesis_id: 't1' },
  { id: 'k2', prompt: 'p2', investment_thesis_id: 't1' },
  { id: 'k9', prompt: 'p9', investment_thesis_id: 't9' },
];

function build() {
  const companyRepo = { findByIds: vi.fn(), findById: vi.fn(), findByIdOrNull: vi.fn() };
  const screeningRepo = {
    findByCompanyIds: vi.fn().mockResolvedValue([]),
    markPendingFailedForCompany: vi.fn().mockResolvedValue(0),
  };
  const criteriaRepo = { findAll: vi.fn().mockResolvedValue(CRITERIA) };
  const thesisRepo = { findAll: vi.fn().mockResolvedValue(TRACKS) };
  const screeningService = {
    prepare: vi.fn(async (groups: Array<{ companyId: string; trackId: string; criteriaIds: string[] }>) =>
      groups.flatMap((g) =>
        g.criteriaIds.map((c) => ({
          id: `s-${g.companyId}-${c}`,
          company_id: g.companyId,
          criteria_id: c,
          track_id: g.trackId,
        })),
      ),
    ),
  };
  const queueRepo = {
    findActiveCompanyIds: vi.fn().mockResolvedValue(new Set()),
    findLatestPerCompanyAtStages: vi.fn().mockResolvedValue([]),
  };
  const service = new AIScreeningService(
    DB as never,
    WS,
    companyRepo as never,
    screeningRepo as never,
    criteriaRepo as never,
    thesisRepo as never,
    screeningService as never,
    queueRepo as never,
  );
  return { service, companyRepo, screeningRepo, criteriaRepo, thesisRepo, screeningService, queueRepo };
}

let t: ReturnType<typeof build>;

beforeEach(() => {
  mocks.enqueueAgentRun.mockReset().mockResolvedValue({ runId: 'run-1', created: true });
  mocks.runAIScreening.mockReset().mockResolvedValue({});
  mocks.workspaceInContext.mockReset();
  t = build();
});

describe('AIScreeningService.enqueue', () => {
  it('returns without a query when given no companies', async () => {
    const result = await t.service.enqueue([], { mode: 'pending_scan', force: true });
    expect(result.queued).toEqual([]);
    expect(t.queueRepo.findActiveCompanyIds).not.toHaveBeenCalled();
  });

  it('queues one ai_screening task per company, in the service’s workspace', async () => {
    t.companyRepo.findByIds.mockResolvedValue([company('c1')]);

    const result = await t.service.enqueue(['c1'], {
      mode: 'pending_scan',
      force: false,
      triggeredByUserId: 'user-1',
    });

    expect(result.queued).toEqual(['c1']);
    expect(mocks.workspaceInContext).toHaveBeenCalledWith(WS);
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({
        agentName: AI_SCREENING_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { company_id: 'c1', mode: 'pending_scan', force: false },
        triggeredByUserId: 'user-1',
        input: expect.objectContaining({ title: 'AI Screening: Co c1', company_id: 'c1' }),
      }),
    );
    const { input } = mocks.enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('run_ai_screening');
    expect(input.instruction).toContain('mode "pending_scan"');
    // A non-forced pending scan prepares nothing up front.
    expect(t.screeningService.prepare).not.toHaveBeenCalled();
  });

  it('skips companies that already have a screening task in flight, in one lookup', async () => {
    t.queueRepo.findActiveCompanyIds.mockResolvedValue(new Set(['c2']));
    t.companyRepo.findByIds.mockResolvedValue([company('c1')]);

    const result = await t.service.enqueue(['c1', 'c2', 'c1'], { mode: 'pending_scan', force: true });

    expect(t.queueRepo.findActiveCompanyIds).toHaveBeenCalledWith(AI_SCREENING_AGENT_NAME, ['c1', 'c2']);
    expect(t.companyRepo.findByIds).toHaveBeenCalledWith(['c1']);
    expect(result).toMatchObject({ queued: ['c1'], alreadyQueued: ['c2'] });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('resets a forced run’s screening rows to pending up front, in one prepare', async () => {
    t.companyRepo.findByIds.mockResolvedValue([
      company('c1'),
      company('c2', { matched_track_ids: ['t2'] }), // t2 has no criteria
    ]);

    const result = await t.service.enqueue(['c1', 'c2'], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId: 'user-1',
    });

    expect(t.screeningService.prepare).toHaveBeenCalledTimes(1);
    expect(t.screeningService.prepare).toHaveBeenCalledWith(
      [{ companyId: 'c1', trackId: 't1', criteriaIds: ['k1', 'k2'] }],
      'user-1',
    );
    expect(result.prepared.get('c1')).toEqual({ trackCount: 1, screeningCount: 2 });
    // A pending scan still runs for c2 — matching happens inside the task.
    expect(result.queued).toEqual(['c1', 'c2']);
  });

  it('does not queue a tracks-only run for a company with nothing to screen', async () => {
    t.companyRepo.findByIds.mockResolvedValue([company('c1', { matched_track_ids: ['t2'] })]);

    const result = await t.service.enqueue(['c1'], { mode: 'tracks', force: false });

    expect(result).toMatchObject({ queued: [], nothingToScreen: ['c1'] });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('keeps queuing the rest, and fails the prepared rows, when one enqueue throws', async () => {
    t.companyRepo.findByIds.mockResolvedValue([company('c1'), company('c2')]);
    mocks.enqueueAgentRun.mockRejectedValueOnce(new Error('insert failed'));

    const result = await t.service.enqueue(['c1', 'c2'], { mode: 'tracks', force: true });

    expect(result.queued).toEqual(['c2']);
    expect(t.screeningRepo.markPendingFailedForCompany).toHaveBeenCalledWith(
      'c1',
      'AI screening could not be queued',
    );
    expect(result.prepared.has('c1')).toBe(false);
  });
});

describe('AIScreeningService.enqueueForCompany', () => {
  const pending = (overrides: Record<string, unknown> = {}) =>
    company('c1', { pipeline_stage: 'unreviewed', status: 'active', ...overrides });

  it('queues the forced Pending Confirmation scan for one pending company', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pending());
    t.companyRepo.findByIds.mockResolvedValue([pending()]);

    await expect(t.service.enqueueForCompany('c1', 'user-1')).resolves.toEqual({
      alreadyQueued: false,
      trackCount: 1,
      screeningCount: 2,
    });
    expect(mocks.enqueueAgentRun.mock.calls[0][1]).toMatchObject({
      triggerMeta: { company_id: 'c1', mode: 'pending_scan', force: true },
      triggeredByUserId: 'user-1',
    });
  });

  it('still queues a pending company with no matched tracks — the task matches them', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pending({ matched_track_ids: [] }));
    t.companyRepo.findByIds.mockResolvedValue([pending({ matched_track_ids: [] })]);

    await expect(t.service.enqueueForCompany('c1', null)).resolves.toEqual({
      alreadyQueued: false,
      trackCount: 0,
      screeningCount: 0,
    });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an L0 deal', { pipeline_stage: 'L0' }],
    ['a dropped pending company', { status: 'dropped' }],
  ])('refuses %s', async (_label, overrides) => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pending(overrides));

    await expect(t.service.enqueueForCompany('c1', null)).rejects.toBeInstanceOf(
      NotPendingConfirmationError,
    );
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('refuses an unknown company', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(null);
    await expect(t.service.enqueueForCompany('nope', null)).rejects.toBeInstanceOf(
      NotPendingConfirmationError,
    );
  });
});

describe('AIScreeningService.screenMatchedTracks', () => {
  it('screens every criterion of the matched tracks in parallel, without a jobs row', async () => {
    const result = await t.service.screenMatchedTracks(company('c1') as never, { force: true });

    expect(result.screened).toBe(2);
    expect(mocks.runAIScreening).toHaveBeenCalledTimes(2);
    expect(mocks.runAIScreening).toHaveBeenCalledWith(
      {
        companyId: 'c1',
        criteriaId: 'k1',
        criteriaPrompt: 'p1',
        screeningId: 's-c1-k1',
        company: { id: 'c1', name: 'Co c1' },
      },
      { db: DB, workspaceId: WS },
    );
    // Forced: no "what is already done" read.
    expect(t.screeningRepo.findByCompanyIds).not.toHaveBeenCalled();
  });

  it('leaves already-completed criteria alone unless forced', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't1', criteria_id: 'k1', state: 'completed', result: 'pass' },
      { track_id: 't1', criteria_id: 'k2', state: 'failed', result: 'error' },
    ]);

    const result = await t.service.screenMatchedTracks(company('c1') as never, { force: false });

    expect(t.screeningService.prepare).toHaveBeenCalledWith([
      { companyId: 'c1', trackId: 't1', criteriaIds: ['k2'] },
    ]);
    expect(result.screened).toBe(1);
  });

  it('screens nothing when no matched track has criteria', async () => {
    const result = await t.service.screenMatchedTracks(
      company('c1', { matched_track_ids: ['t2'] }) as never,
      { force: true },
    );
    expect(result).toMatchObject({ groups: [], screened: 0 });
    expect(mocks.runAIScreening).not.toHaveBeenCalled();
  });

  it('still settles when one criterion’s screening rejects', async () => {
    mocks.runAIScreening.mockRejectedValueOnce(new Error('agent down'));
    await expect(
      t.service.screenMatchedTracks(company('c1') as never, { force: true }),
    ).resolves.toMatchObject({ screened: 2 });
  });
});

describe('AIScreeningService.screenCompanyTracks', () => {
  it('reports each screened track’s verdict from the rows just written', async () => {
    t.companyRepo.findById.mockResolvedValue(company('c1'));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't1', criteria_id: 'k1', state: 'completed', result: 'fail' },
      { track_id: 't1', criteria_id: 'k2', state: 'completed', result: 'pass' },
    ]);

    await expect(t.service.screenCompanyTracks('c1', { force: true })).resolves.toEqual({
      screened: 2,
      tracks: [{ trackId: 't1', title: 'Healthcare', verdict: 'fail' }],
    });
  });
});

describe('AIScreeningService.screenCompanyTracks — track pass rule', () => {
  it('passes a track whose must-pass criterion passed and whose optional minimum is met', async () => {
    t.thesisRepo.findAll.mockResolvedValue([
      { id: 't1', title: 'Healthcare', min_optional_criteria_pass: 0 },
    ]);
    t.criteriaRepo.findAll.mockResolvedValue([
      { id: 'k1', prompt: 'p1', investment_thesis_id: 't1', must_pass: true },
      { id: 'k2', prompt: 'p2', investment_thesis_id: 't1', must_pass: false },
    ]);
    t.companyRepo.findById.mockResolvedValue(company('c1'));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't1', criteria_id: 'k1', state: 'completed', result: 'pass' },
      { track_id: 't1', criteria_id: 'k2', state: 'completed', result: 'fail' },
    ]);

    const result = await t.service.screenCompanyTracks('c1', { force: true });

    // The original rule (>= 3 passes) would call this a fail.
    expect(result.tracks).toEqual([{ trackId: 't1', title: 'Healthcare', verdict: 'pass' }]);
  });
});

describe('AIScreeningService.summarizeForOpinion', () => {
  beforeEach(() => {
    t.thesisRepo.findAll.mockResolvedValue([
      { id: 't1', title: 'Healthcare', min_optional_criteria_pass: 1 },
      { id: 't2', title: 'Energy', min_optional_criteria_pass: null },
    ]);
    t.criteriaRepo.findAll.mockResolvedValue([
      { id: 'k1', name: 'Asia revenue', prompt: 'p1', investment_thesis_id: 't1', must_pass: true },
      { id: 'k2', name: 'EBITDA margin', prompt: 'p2', investment_thesis_id: 't1', must_pass: false },
      { id: 'k3', name: 'Founder-led', prompt: 'p3', investment_thesis_id: 't1', must_pass: false },
    ]);
  });

  it('returns null without screening results', async () => {
    await expect(t.service.summarizeForOpinion(company('c1') as never)).resolves.toBeNull();
  });

  it('describes each track under its rule, naming must-pass and optional results', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't1', criteria_id: 'k1', state: 'completed', result: 'pass' },
      { track_id: 't1', criteria_id: 'k2', state: 'completed', result: 'fail' },
      { track_id: 't1', criteria_id: 'k3', state: 'completed', result: 'pass' },
    ]);

    const summary = await t.service.summarizeForOpinion(company('c1') as never);

    expect(summary).toContain('Overall AI Screening verdict: PASS');
    expect(summary).toContain('Track "Healthcare": PASS');
    expect(summary).toContain('Must-pass (every one is required): Asia revenue (✓ pass)');
    expect(summary).toContain('Optional: 1 of 2 passed; at least 1 required (50%)');
    // One read each for tracks, criteria and screenings — whatever the counts.
    expect(t.screeningRepo.findByCompanyIds).toHaveBeenCalledTimes(1);
    expect(t.screeningRepo.findByCompanyIds).toHaveBeenCalledWith(['c1']);
  });

  it('reports a failed must-pass criterion as a failed track', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't1', criteria_id: 'k1', state: 'completed', result: 'fail' },
      { track_id: 't1', criteria_id: 'k2', state: 'completed', result: 'pass' },
      { track_id: 't1', criteria_id: 'k3', state: 'completed', result: 'pass' },
    ]);

    const summary = await t.service.summarizeForOpinion(company('c1') as never);

    expect(summary).toContain('Overall AI Screening verdict: FAIL');
    expect(summary).toContain('Asia revenue (✗ fail)');
  });

  it('describes the default rule for a track without one', async () => {
    t.criteriaRepo.findAll.mockResolvedValue([
      { id: 'k1', name: 'Asia revenue', prompt: 'p1', investment_thesis_id: 't2', must_pass: false },
    ]);
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      { track_id: 't2', criteria_id: 'k1', state: 'completed', result: 'pass' },
    ]);

    const summary = await t.service.summarizeForOpinion(
      company('c1', { matched_track_ids: ['t2'] }) as never,
    );

    expect(summary).toContain('Track "Energy": INCONCLUSIVE');
    expect(summary).toContain('Rule: at least 3 criteria pass and at most 1 fails');
  });
});

describe('AIScreeningService.listCompanyTasks', () => {
  it('maps each Pending Confirmation / L0 company’s newest task for the panel', async () => {
    t.queueRepo.findLatestPerCompanyAtStages.mockResolvedValue([
      {
        run: {
          id: 'run-1',
          status: 'running',
          created_at: '2026-10-15T10:00:00Z',
          started_at: '2026-10-15T10:00:05Z',
          ended_at: null,
        },
        company: { id: 'c1', target: null, project_name: ' Project X ', pipeline_stage: 'unreviewed' },
      },
    ]);

    await expect(t.service.listCompanyTasks()).resolves.toEqual([
      {
        companyId: 'c1',
        companyName: 'Project X',
        pipelineStage: 'unreviewed',
        runId: 'run-1',
        status: 'running',
        createdAt: '2026-10-15T10:00:00Z',
        startedAt: '2026-10-15T10:00:05Z',
        endedAt: null,
      },
    ]);
    expect(t.queueRepo.findLatestPerCompanyAtStages).toHaveBeenCalledWith(AI_SCREENING_AGENT_NAME, [
      'unreviewed',
      'L0',
    ]);
  });
});
