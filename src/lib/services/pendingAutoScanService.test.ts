import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runPendingAutoScan: vi.fn(),
}));

vi.mock('@/lib/jobs/handlers/pendingAutoScan', () => ({
  PENDING_AUTO_SCAN_TIMEOUT_SECONDS: 570,
  runPendingAutoScan: mocks.runPendingAutoScan,
}));

import { PendingAutoScanService } from './pendingAutoScanService';
import { CompanyL0RequirementsError } from './companyService';

const WS = 'ws-1';
const COMPANY_ID = 'c-1';

const pendingCompany = (overrides: Record<string, unknown> = {}) => ({
  id: COMPANY_ID,
  target: 'Acme',
  project_name: null,
  pipeline_stage: 'unreviewed',
  status: 'active',
  matched_track_ids: ['t1'],
  ...overrides,
});

const TRACKS = [{ id: 't1', title: 'Healthcare' }];
const CRITERIA = [
  { id: 'k1', prompt: 'p1', investment_thesis_id: 't1' },
  { id: 'k2', prompt: 'p2', investment_thesis_id: 't1' },
  { id: 'k3', prompt: 'p3', investment_thesis_id: 't1' },
];

const screening = (criteriaId: string, result: string | null) => ({
  id: `s-${criteriaId}`,
  company_id: COMPANY_ID,
  criteria_id: criteriaId,
  track_id: 't1',
  state: result === null ? 'pending' : 'completed',
  result,
});

function build() {
  const companyRepo = {
    findByIdOrNull: vi.fn(),
    findById: vi.fn(),
    requestAutoScan: vi.fn(),
    requestAutoScanForPending: vi.fn(),
  };
  const screeningRepo = { findByCompanyIds: vi.fn() };
  const criteriaRepo = { findAll: vi.fn().mockResolvedValue(CRITERIA) };
  const thesisRepo = { findAll: vi.fn().mockResolvedValue(TRACKS) };
  const jobRepo = { appendLog: vi.fn().mockResolvedValue(undefined) };
  const workspaceService = { getPendingAutomation: vi.fn() };
  const companyService = { promote: vi.fn(), dropDeal: vi.fn() };
  const screeningService = {
    prepare: vi.fn(async (groups: Array<{ companyId: string; trackId: string; criteriaIds: string[] }>) =>
      groups.flatMap((g) =>
        g.criteriaIds.map((c) => ({
          id: `s-${c}`,
          company_id: g.companyId,
          criteria_id: c,
          track_id: g.trackId,
        })),
      ),
    ),
  };
  const aiScreeningService = { runInline: vi.fn().mockResolvedValue({ jobId: 'j' }) };
  const trackMatchingService = { runSync: vi.fn() };
  const jobDispatcher = { dispatch: vi.fn().mockResolvedValue({ jobId: 'job-1' }) };

  const service = new PendingAutoScanService(
    WS,
    companyRepo as never,
    screeningRepo as never,
    criteriaRepo as never,
    thesisRepo as never,
    jobRepo as never,
    workspaceService as never,
    companyService as never,
    screeningService as never,
    aiScreeningService as never,
    trackMatchingService as never,
    jobDispatcher as never,
  );
  return {
    service,
    companyRepo,
    screeningRepo,
    workspaceService,
    companyService,
    screeningService,
    aiScreeningService,
    trackMatchingService,
    jobDispatcher,
    jobRepo,
  };
}

let t: ReturnType<typeof build>;

beforeEach(() => {
  mocks.runPendingAutoScan.mockReset();
  t = build();
  t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany());
  t.companyRepo.findById.mockResolvedValue(pendingCompany());
  t.workspaceService.getPendingAutomation.mockResolvedValue({
    autoScan: true,
    autoDropPromote: true,
  });
});

describe('PendingAutoScanService.onCompanyEnteredPending', () => {
  it('does nothing when auto-scan is off', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoDropPromote: false,
    });

    await expect(t.service.onCompanyEnteredPending(COMPANY_ID)).resolves.toBe(false);
    expect(t.companyRepo.requestAutoScan).not.toHaveBeenCalled();
  });

  it('queues a non-force scan when auto-scan is on', async () => {
    t.companyRepo.requestAutoScan.mockResolvedValue(1);

    await expect(t.service.onCompanyEnteredPending(COMPANY_ID)).resolves.toBe(true);
    expect(t.companyRepo.requestAutoScan).toHaveBeenCalledWith([COMPANY_ID], false);
  });
});

describe('PendingAutoScanService.scanNow', () => {
  it('scan now forces a re-screen and ignores the auto-scan toggle', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoDropPromote: false,
    });
    t.companyRepo.requestAutoScanForPending.mockResolvedValue(3);

    await expect(t.service.scanNow()).resolves.toBe(3);
    expect(t.companyRepo.requestAutoScanForPending).toHaveBeenCalledWith(true);
    expect(t.workspaceService.getPendingAutomation).not.toHaveBeenCalled();
  });
});

describe('PendingAutoScanService.dispatchScan', () => {
  it('dispatches one pending_auto_scan job carrying the workspace and force flag', async () => {
    await t.service.dispatchScan(COMPANY_ID, true);

    expect(t.jobDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pending_auto_scan',
        payload: { companyId: COMPANY_ID, force: true, workspaceId: WS },
        timeoutSeconds: 570,
      }),
    );
  });
});

describe('PendingAutoScanService.processCompany', () => {
  it('skips a company that is no longer active in Pending Confirmation', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ status: 'dropped' }));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('skipped');
    expect(t.screeningService.prepare).not.toHaveBeenCalled();
  });

  it('runs track matching only when the company has no matched tracks', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValueOnce(pendingCompany({ matched_track_ids: [] }));
    t.trackMatchingService.runSync.mockResolvedValue({
      companyId: COMPANY_ID,
      matchedTrackIds: ['t1'],
      via: 'agent',
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.trackMatchingService.runSync).toHaveBeenCalledWith({ companyId: COMPANY_ID });
    expect(t.companyRepo.findById).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('leaves the company pending when no matched track has criteria', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ matched_track_ids: ['t9'] }));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('no_screenable_tracks');
    expect(t.companyService.promote).not.toHaveBeenCalled();
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('screens every criterion of the matched track and promotes on a pass', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([]) // before: nothing screened yet
      .mockResolvedValueOnce([screening('k1', 'pass'), screening('k2', 'pass'), screening('k3', 'pass')]);
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany());

    const result = await t.service.processCompany(COMPANY_ID, { force: false, jobId: 'job-1' });

    expect(t.aiScreeningService.runInline).toHaveBeenCalledTimes(3);
    expect(t.aiScreeningService.runInline).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        criteriaId: 'k1',
        criteriaPrompt: 'p1',
        screeningId: 's-k1',
        company: { id: COMPANY_ID, name: 'Acme' },
      }),
    );
    expect(t.companyService.promote).toHaveBeenCalledWith(
      COMPANY_ID,
      'unreviewed',
      'L0',
      undefined,
      undefined,
      undefined,
      undefined,
      'Auto-promoted: passed AI screening (Healthcare)',
    );
    expect(result).toMatchObject({ outcome: 'promoted', verdict: 'pass', screened: 3 });
    expect(t.jobRepo.appendLog).toHaveBeenCalledWith('job-1', expect.objectContaining({ message: 'Promoted to L0' }));
  });

  it('drops the company from Pending Confirmation on a fail', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([screening('k1', 'fail'), screening('k2', 'pass'), screening('k3', 'fail')]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.companyService.dropDeal).toHaveBeenCalledWith(
      COMPANY_ID,
      'unreviewed',
      'Auto-dropped: failed AI screening (Healthcare)',
    );
    expect(result.outcome).toBe('dropped');
  });

  it('leaves an inconclusive company pending', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        screening('k1', 'inconclusive'),
        screening('k2', 'pass'),
        screening('k3', 'inconclusive'),
      ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'scanned', verdict: 'inconclusive' });
    expect(t.companyService.promote).not.toHaveBeenCalled();
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('only scans when auto drop/promote is off', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: true,
      autoDropPromote: false,
    });
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([screening('k1', 'fail'), screening('k2', 'fail'), screening('k3', 'fail')]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'scanned', verdict: 'fail' });
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('keeps already-completed criteria unless forced', async () => {
    const done = [screening('k1', 'pass'), screening('k2', 'pass')];
    t.screeningRepo.findByCompanyIds.mockResolvedValue(done);

    await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.screeningService.prepare).toHaveBeenCalledWith([
      { companyId: COMPANY_ID, trackId: 't1', criteriaIds: ['k3'] },
    ]);
  });

  it('re-screens every criterion when forced', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    await t.service.processCompany(COMPANY_ID, { force: true });

    expect(t.screeningService.prepare).toHaveBeenCalledWith([
      { companyId: COMPANY_ID, trackId: 't1', criteriaIds: ['k1', 'k2', 'k3'] },
    ]);
    // Only the post-scan verdict read; no pre-scan "what's done" read.
    expect(t.screeningRepo.findByCompanyIds).toHaveBeenCalledTimes(1);
  });

  it('does not drop or promote a company a human moved while it was screening', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([screening('k1', 'fail'), screening('k2', 'fail'), screening('k3', 'fail')]);
    t.companyRepo.findByIdOrNull
      .mockResolvedValueOnce(pendingCompany())
      .mockResolvedValueOnce(pendingCompany({ pipeline_stage: 'L0' }));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('skipped');
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('leaves a passing company pending when L0 requirements are missing', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([screening('k1', 'pass'), screening('k2', 'pass'), screening('k3', 'pass')]);
    t.companyService.promote.mockRejectedValue(new CompanyL0RequirementsError(['source']));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('promote_blocked');
  });

  it('ignores screenings for tracks the company is no longer matched to', async () => {
    t.screeningRepo.findByCompanyIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        screening('k1', 'pass'),
        screening('k2', 'pass'),
        screening('k3', 'pass'),
        { ...screening('k1', 'fail'), id: 'old', track_id: 'retired-track' },
      ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.verdict).toBe('pass');
  });
});
