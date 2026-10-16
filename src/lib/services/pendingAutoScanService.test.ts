import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const GROUPS = [{ trackId: 't1', criteriaIds: ['k1', 'k2', 'k3'] }];

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
    findActiveIdsByStage: vi.fn(),
  };
  const screeningRepo = { findByCompanyIds: vi.fn() };
  const workspaceService = { getPendingAutomation: vi.fn() };
  const companyService = { promote: vi.fn(), dropDeal: vi.fn() };
  const aiScreeningService = {
    enqueue: vi.fn(),
    screenMatchedTracks: vi.fn().mockResolvedValue({ groups: GROUPS, screened: 3, tracks: TRACKS }),
  };
  const trackMatchingService = { runSync: vi.fn() };

  const service = new PendingAutoScanService(
    WS,
    companyRepo as never,
    screeningRepo as never,
    workspaceService as never,
    companyService as never,
    aiScreeningService as never,
    trackMatchingService as never,
  );
  return {
    service,
    companyRepo,
    screeningRepo,
    workspaceService,
    companyService,
    aiScreeningService,
    trackMatchingService,
  };
}

let t: ReturnType<typeof build>;

beforeEach(() => {
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
    expect(t.aiScreeningService.enqueue).not.toHaveBeenCalled();
  });

  it('queues a non-forced pending scan task when auto-scan is on', async () => {
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: [COMPANY_ID], alreadyQueued: [] });

    await expect(t.service.onCompanyEnteredPending(COMPANY_ID)).resolves.toBe(true);
    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith([COMPANY_ID], {
      mode: 'pending_scan',
      force: false,
    });
  });
});

describe('PendingAutoScanService.scanNow', () => {
  it('queues a forced scan task per active pending company, ignoring the auto-scan toggle', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoDropPromote: false,
    });
    t.companyRepo.findActiveIdsByStage.mockResolvedValue(['c1', 'c2', 'c3']);
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: ['c1', 'c3'], alreadyQueued: ['c2'] });

    await expect(t.service.scanNow('user-1')).resolves.toEqual({ queued: 2, alreadyQueued: 1 });
    expect(t.companyRepo.findActiveIdsByStage).toHaveBeenCalledWith('unreviewed');
    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith(['c1', 'c2', 'c3'], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId: 'user-1',
    });
    expect(t.workspaceService.getPendingAutomation).not.toHaveBeenCalled();
  });
});

describe('PendingAutoScanService.processCompany', () => {
  it('skips a company that is no longer active in Pending Confirmation', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ status: 'dropped' }));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('skipped');
    expect(t.aiScreeningService.screenMatchedTracks).not.toHaveBeenCalled();
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
    t.aiScreeningService.screenMatchedTracks.mockResolvedValue({ groups: [], screened: 0, tracks: TRACKS });

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('no_screenable_tracks');
    expect(t.companyService.promote).not.toHaveBeenCalled();
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('passes force through to the screening and promotes on a pass', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: true });

    expect(t.aiScreeningService.screenMatchedTracks).toHaveBeenCalledWith(
      expect.objectContaining({ id: COMPANY_ID }),
      { force: true },
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
    expect(result.steps).toContain('Promoted to L0');
  });

  it('drops the company from Pending Confirmation on a fail', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'fail'),
      screening('k2', 'pass'),
      screening('k3', 'fail'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.companyService.dropDeal).toHaveBeenCalledWith(
      COMPANY_ID,
      'unreviewed',
      'Auto-dropped: failed AI screening (Healthcare)',
    );
    expect(result.outcome).toBe('dropped');
  });

  it('leaves an inconclusive company pending', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
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
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'fail'),
      screening('k2', 'fail'),
      screening('k3', 'fail'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'scanned', verdict: 'fail' });
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('judges only the current matched tracks’ criteria', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
      // A criterion no longer on the track must not count.
      { ...screening('old', 'fail'), track_id: 't1' },
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.verdict).toBe('pass');
  });

  it('leaves a passing company pending when L0 requirements are missing', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);
    t.companyService.promote.mockRejectedValue(new CompanyL0RequirementsError(['segment']));

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('promote_blocked');
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('skips drop/promote when a human moved the company while it was screening', async () => {
    t.companyRepo.findByIdOrNull
      .mockResolvedValueOnce(pendingCompany())
      .mockResolvedValueOnce(pendingCompany({ pipeline_stage: 'L0' }));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'skipped', verdict: 'pass' });
    expect(t.companyService.promote).not.toHaveBeenCalled();
  });
});
