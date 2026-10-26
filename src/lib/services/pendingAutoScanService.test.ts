import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PendingAutoScanService } from './pendingAutoScanService';
import { CompanyPipelineRequirementsError } from './companyService';

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
    findActiveTrackMatchesByStage: vi.fn(),
    update: vi.fn().mockResolvedValue([]),
  };
  const thesisRepo = {
    findAll: vi.fn().mockResolvedValue([
      { id: 't1', title: 'Healthcare' },
      { id: 't2', title: '  ' },
      { id: 't3', title: 'Unused' },
    ]),
  };
  const screeningRepo = { findByCompanyIds: vi.fn() };
  const workspaceService = { getPendingAutomation: vi.fn() };
  const companyService = { promote: vi.fn(), dropDeal: vi.fn() };
  const aiScreeningService = {
    enqueue: vi.fn(),
    findInFlightCompanyIds: vi.fn().mockResolvedValue(new Set()),
    screenMatchedTracks: vi.fn().mockResolvedValue({ groups: GROUPS, screened: 3, tracks: TRACKS }),
  };
  const trackMatchingService = { runSync: vi.fn() };
  const companyAnalysisService = {
    generateNowIfMissing: vi.fn().mockResolvedValue({ status: 'exists' }),
    findCompanyIdsWithCard: vi.fn().mockResolvedValue(new Set()),
  };
  const companyRelationshipService = { linkRelatedCompanies: vi.fn().mockResolvedValue([]) };

  const service = new PendingAutoScanService(
    WS,
    companyRepo as never,
    screeningRepo as never,
    workspaceService as never,
    companyService as never,
    aiScreeningService as never,
    trackMatchingService as never,
    companyAnalysisService as never,
    companyRelationshipService as never,
    thesisRepo as never,
  );
  return {
    service,
    companyRepo,
    screeningRepo,
    workspaceService,
    companyService,
    aiScreeningService,
    trackMatchingService,
    companyAnalysisService,
    companyRelationshipService,
    thesisRepo,
  };
}

let t: ReturnType<typeof build>;

beforeEach(() => {
  t = build();
  t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany());
  t.companyRepo.findById.mockResolvedValue(pendingCompany());
  t.workspaceService.getPendingAutomation.mockResolvedValue({
    autoScan: true,
    autoPromote: true,
    autoDrop: true,
  });
});

describe('PendingAutoScanService.onCompanyEnteredPending', () => {
  it('does nothing when auto-scan is off', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoPromote: false,
      autoDrop: false,
    });

    await expect(t.service.onCompanyEnteredPending(COMPANY_ID)).resolves.toBe(false);
    expect(t.aiScreeningService.enqueue).not.toHaveBeenCalled();
  });

  it('queues a non-forced pending scan task when auto-scan is on', async () => {
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: [COMPANY_ID], alreadyQueued: [] });

    await expect(t.service.onCompanyEnteredPending(COMPANY_ID, 'user-7')).resolves.toBe(true);
    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith([COMPANY_ID], {
      mode: 'pending_scan',
      force: false,
      triggeredByUserId: 'user-7',
    });
  });
});

describe('PendingAutoScanService.onCompaniesEnteredPending', () => {
  it('returns 0 without reading settings when no company arrived', async () => {
    await expect(t.service.onCompaniesEnteredPending([])).resolves.toBe(0);
    expect(t.workspaceService.getPendingAutomation).not.toHaveBeenCalled();
    expect(t.aiScreeningService.enqueue).not.toHaveBeenCalled();
  });

  it('queues every arrival in one enqueue when auto-scan is on', async () => {
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: ['a'], alreadyQueued: ['b'] });

    await expect(t.service.onCompaniesEnteredPending(['a', 'b'])).resolves.toBe(2);
    expect(t.workspaceService.getPendingAutomation).toHaveBeenCalledTimes(1);
    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith(['a', 'b'], {
      mode: 'pending_scan',
      force: false,
      triggeredByUserId: null,
    });
  });

  it('queues nothing when auto-scan is off', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoPromote: false,
      autoDrop: false,
    });

    await expect(t.service.onCompaniesEnteredPending(['a'])).resolves.toBe(0);
    expect(t.aiScreeningService.enqueue).not.toHaveBeenCalled();
  });
});

describe('PendingAutoScanService.scanNow', () => {
  it('queues a forced scan task per active pending company, ignoring the auto-scan toggle', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: false,
      autoPromote: false,
      autoDrop: false,
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

describe('PendingAutoScanService.scanNow with a track selection', () => {
  it('queues only the companies matched to a selected track, plus unmatched ones when included', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: ['t1'] },
      { id: 'b', matched_track_ids: ['t2'] },
      { id: 'c', matched_track_ids: [] },
      { id: 'd', matched_track_ids: ['deleted'] },
    ]);
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: ['a', 'c', 'd'], alreadyQueued: [] });

    await expect(
      t.service.scanNow('user-1', { trackIds: ['t1'], includeUnmatched: true }),
    ).resolves.toEqual({ queued: 3, alreadyQueued: 0 });
    expect(t.companyRepo.findActiveTrackMatchesByStage).toHaveBeenCalledWith('unreviewed');
    expect(t.companyRepo.findActiveIdsByStage).not.toHaveBeenCalled();
    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith(['a', 'c', 'd'], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId: 'user-1',
      // Unmatched c and d are matched during the scan, so carry no track list.
      trackIdsByCompany: new Map([['a', ['t1']]]),
    });
  });

  it('screens a company matched to several tracks against only the selected ones', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: ['t1', 't2', 't3'] },
      { id: 'b', matched_track_ids: ['t2'] },
    ]);
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: ['a', 'b'], alreadyQueued: [] });

    await t.service.scanNow('user-1', { trackIds: ['t1', 't2'], includeUnmatched: false });

    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith(['a', 'b'], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId: 'user-1',
      trackIdsByCompany: new Map([
        ['a', ['t1', 't2']],
        ['b', ['t2']],
      ]),
    });
  });

  it('picks a company with no saved match by its keyword-matched tracks, as the Pipeline filter does', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: [], segment: 'Healthcare services', target: 'Acme' },
      { id: 'b', matched_track_ids: [], segment: 'Mining' },
    ]);
    t.aiScreeningService.enqueue.mockResolvedValue({ queued: ['a'], alreadyQueued: [] });

    await t.service.scanNow('user-1', { trackIds: ['t1'], includeUnmatched: false });

    expect(t.aiScreeningService.enqueue).toHaveBeenCalledWith(['a'], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId: 'user-1',
      trackIdsByCompany: new Map([['a', ['t1']]]),
    });
  });

  it('queues nothing when no pending company is in the selection', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: ['t1'] },
    ]);

    await expect(
      t.service.scanNow('user-1', { trackIds: ['t2'], includeUnmatched: false }),
    ).resolves.toEqual({ queued: 0, alreadyQueued: 0 });
    expect(t.aiScreeningService.enqueue).not.toHaveBeenCalled();
  });
});

describe('PendingAutoScanService.previewScanNow', () => {
  it('returns an empty preview without further reads when nothing is pending', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([]);

    await expect(t.service.previewScanNow()).resolves.toEqual({ tracks: [], companies: [] });
    expect(t.aiScreeningService.findInFlightCompanyIds).not.toHaveBeenCalled();
    expect(t.companyAnalysisService.findCompanyIdsWithCard).not.toHaveBeenCalled();
  });

  it('lists each company Scan now could queue with its existing tracks and card status', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: ['t1'] },
      { id: 'b', matched_track_ids: ['t1', 't2', 't1'] },
      { id: 'c', matched_track_ids: ['deleted'] },
      { id: 'd', matched_track_ids: ['t3'] },
    ]);
    t.aiScreeningService.findInFlightCompanyIds.mockResolvedValue(new Set(['d']));
    t.companyAnalysisService.findCompanyIdsWithCard.mockResolvedValue(new Set(['a']));

    await expect(t.service.previewScanNow()).resolves.toEqual({
      tracks: [
        { id: 't1', title: 'Healthcare' },
        { id: 't2', title: 'Untitled track' },
      ],
      companies: [
        { trackIds: ['t1'], hasCard: true },
        { trackIds: ['t1', 't2'], hasCard: false },
        { trackIds: [], hasCard: false },
      ],
    });
    expect(t.companyRepo.findActiveTrackMatchesByStage).toHaveBeenCalledWith('unreviewed');
    expect(t.aiScreeningService.findInFlightCompanyIds).toHaveBeenCalledWith(['a', 'b', 'c', 'd']);
    expect(t.companyAnalysisService.findCompanyIdsWithCard).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('lists a company with no saved match under its keyword-matched tracks', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: [], segment: 'Healthcare clinics' },
    ]);

    await expect(t.service.previewScanNow()).resolves.toEqual({
      tracks: [{ id: 't1', title: 'Healthcare' }],
      companies: [{ trackIds: ['t1'], hasCard: false }],
    });
  });

  it('skips the card lookup when every pending company is already queued', async () => {
    t.companyRepo.findActiveTrackMatchesByStage.mockResolvedValue([
      { id: 'a', matched_track_ids: [] },
      { id: 'b', matched_track_ids: ['t1'] },
    ]);
    t.aiScreeningService.findInFlightCompanyIds.mockResolvedValue(new Set(['a', 'b']));

    await expect(t.service.previewScanNow()).resolves.toEqual({ tracks: [], companies: [] });
    expect(t.companyAnalysisService.findCompanyIdsWithCard).not.toHaveBeenCalled();
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

  it('screens only the selected tracks, without re-matching, when given trackIds', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ matched_track_ids: ['t1', 't3'] }));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    await t.service.processCompany(COMPANY_ID, { force: true, trackIds: ['t1'] });

    expect(t.trackMatchingService.runSync).not.toHaveBeenCalled();
    expect(t.companyRepo.update).not.toHaveBeenCalled();
    expect(t.aiScreeningService.screenMatchedTracks).toHaveBeenCalledWith(
      expect.objectContaining({ id: COMPANY_ID }),
      { force: true, trackIds: ['t1'] },
    );
  });

  it('saves the keyword-matched tracks of a company Scan now picked by them before screening', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(
      pendingCompany({ matched_track_ids: [], segment: 'Healthcare clinics' }),
    );
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    const result = await t.service.processCompany(COMPANY_ID, { force: true, trackIds: ['t1'] });

    expect(t.trackMatchingService.runSync).not.toHaveBeenCalled();
    expect(t.companyRepo.update).toHaveBeenCalledWith(COMPANY_ID, { matched_track_ids: ['t1'] });
    expect(t.aiScreeningService.screenMatchedTracks).toHaveBeenCalledWith(
      expect.objectContaining({ matched_track_ids: ['t1'] }),
      { force: true, trackIds: ['t1'] },
    );
    expect(result.steps).toContain("Saved 1 keyword-matched track(s) as the company's match");
  });

  it('promotes when any one of several screened tracks passes', async () => {
    t.aiScreeningService.screenMatchedTracks.mockResolvedValue({
      groups: [
        { trackId: 't1', criteriaIds: ['k1', 'k2', 'k3'] },
        { trackId: 't2', criteriaIds: ['k4', 'k5', 'k6'] },
      ],
      screened: 6,
      tracks: [
        { id: 't1', title: 'Healthcare' },
        { id: 't2', title: 'Energy' },
      ],
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'fail'),
      screening('k2', 'fail'),
      screening('k3', 'fail'),
      { ...screening('k4', 'pass'), track_id: 't2' },
      { ...screening('k5', 'pass'), track_id: 't2' },
      { ...screening('k6', 'pass'), track_id: 't2' },
    ]);

    const result = await t.service.processCompany(COMPANY_ID, {
      force: true,
      trackIds: ['t1', 't2'],
    });

    expect(result).toMatchObject({ outcome: 'promoted', verdict: 'pass' });
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
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

    const result = await t.service.processCompany(COMPANY_ID, {
      force: true,
      triggeredByUserId: 'user-7',
    });

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
      // The task's user fills a blank Entered By, so the required-fields gate doesn't block it.
      { triggeredByUserId: 'user-7' },
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

  it('leaves a failing company pending when auto drop is off, even with auto promote on', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: true,
      autoPromote: true,
      autoDrop: false,
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'fail'),
      screening('k2', 'fail'),
      screening('k3', 'fail'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'scanned', verdict: 'fail' });
    expect(result.steps).toContain('Failed; auto drop is off, left pending');
    expect(t.companyService.dropDeal).not.toHaveBeenCalled();
  });

  it('leaves a passing company pending when auto promote is off, even with auto drop on', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: true,
      autoPromote: false,
      autoDrop: true,
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'scanned', verdict: 'pass' });
    expect(result.steps).toContain('Passed; auto promote is off, left pending');
    expect(t.companyService.promote).not.toHaveBeenCalled();
  });

  it('drops a failing company with only auto drop on', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: true,
      autoPromote: false,
      autoDrop: true,
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'fail'),
      screening('k2', 'fail'),
      screening('k3', 'fail'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('dropped');
    expect(t.companyService.dropDeal).toHaveBeenCalled();
  });

  it('promotes a passing company with only auto promote on', async () => {
    t.workspaceService.getPendingAutomation.mockResolvedValue({
      autoScan: true,
      autoPromote: true,
      autoDrop: false,
    });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('promoted');
    expect(t.companyService.promote).toHaveBeenCalled();
  });

  it('generates a missing Company Card before matching and screening', async () => {
    const related = [{ name: 'Beta', relation_type: 'SUPPLIER' }];
    t.companyAnalysisService.generateNowIfMissing.mockResolvedValue({
      status: 'generated',
      companyName: 'Acme',
      relatedCompanies: related,
    });
    t.companyRelationshipService.linkRelatedCompanies.mockResolvedValue(['"Beta" (SUPPLIER)']);
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ matched_track_ids: [] }));
    t.trackMatchingService.runSync.mockResolvedValue({ matchedTrackIds: ['t1'], via: 'llm' });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    const result = await t.service.processCompany(COMPANY_ID, { force: true });

    expect(t.companyAnalysisService.generateNowIfMissing).toHaveBeenCalledWith(COMPANY_ID, {
      source: 'pending_scan',
    });
    const cardOrder = t.companyAnalysisService.generateNowIfMissing.mock.invocationCallOrder[0];
    expect(cardOrder).toBeLessThan(t.trackMatchingService.runSync.mock.invocationCallOrder[0]);
    expect(cardOrder).toBeLessThan(
      t.aiScreeningService.screenMatchedTracks.mock.invocationCallOrder[0],
    );
    expect(t.companyRelationshipService.linkRelatedCompanies).toHaveBeenCalledWith('Acme', related);
    expect(result.steps[0]).toBe('Company Card was missing; generated it before screening');
    expect(result.steps).toContain('Linked related companies: "Beta" (SUPPLIER)');
  });

  it('adds no card step when the company already has a Company Card', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.companyAnalysisService.generateNowIfMissing).toHaveBeenCalledTimes(1);
    expect(t.companyRelationshipService.linkRelatedCompanies).not.toHaveBeenCalled();
    expect(result.steps.some((s) => s.includes('Company Card'))).toBe(false);
  });

  it('notes a card run that is already executing and still screens', async () => {
    t.companyAnalysisService.generateNowIfMissing.mockResolvedValue({ status: 'already_running' });
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.steps).toContain('Company Card generation already in progress');
    expect(t.aiScreeningService.screenMatchedTracks).toHaveBeenCalled();
  });

  it('still screens when generating the Company Card fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.companyAnalysisService.generateNowIfMissing.mockRejectedValue(new Error('agent down'));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.outcome).toBe('promoted');
    expect(result.steps).toContain('Could not generate the Company Card: agent down');
    errSpy.mockRestore();
  });

  it('still screens when linking related companies fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.companyAnalysisService.generateNowIfMissing.mockResolvedValue({
      status: 'generated',
      companyName: 'Acme',
      relatedCompanies: [],
    });
    t.companyRelationshipService.linkRelatedCompanies.mockRejectedValue(new Error('neo4j down'));
    t.screeningRepo.findByCompanyIds.mockResolvedValue([]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result.steps).toContain('Company Card was missing; generated it before screening');
    expect(t.aiScreeningService.screenMatchedTracks).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does not generate a Company Card for a company no longer pending', async () => {
    t.companyRepo.findByIdOrNull.mockResolvedValue(pendingCompany({ status: 'dropped' }));

    await t.service.processCompany(COMPANY_ID, { force: false });

    expect(t.companyAnalysisService.generateNowIfMissing).not.toHaveBeenCalled();
  });

  it('judges each track by its pass rule from the scan', async () => {
    t.aiScreeningService.screenMatchedTracks.mockResolvedValue({
      groups: GROUPS,
      screened: 3,
      tracks: TRACKS,
      rules: new Map([['t1', { mustPassCriteriaIds: new Set(['k1']), minOptionalPass: 1 }]]),
    });
    // 2 passes / 1 fail is inconclusive under the original rule; here the
    // must-pass k1 passed and 1 of 2 optional passed, so the track passes.
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'fail'),
    ]);

    const result = await t.service.processCompany(COMPANY_ID, { force: false });

    expect(result).toMatchObject({ outcome: 'promoted', verdict: 'pass' });
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

  it('leaves a passing company pending when required fields are missing', async () => {
    t.screeningRepo.findByCompanyIds.mockResolvedValue([
      screening('k1', 'pass'),
      screening('k2', 'pass'),
      screening('k3', 'pass'),
    ]);
    t.companyService.promote.mockRejectedValue(new CompanyPipelineRequirementsError(['segment']));

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
