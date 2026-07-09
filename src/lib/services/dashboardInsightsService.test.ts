import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DashboardInsightsService } from './dashboardInsightsService';
import type {
  DashboardInsightsRepository,
  DimensionStageCount,
  StaleCandidate,
} from '@/lib/repositories/dashboardInsightsRepository';
import type { AppSettingsRepository } from '@/lib/repositories/appSettingsRepository';

/** Class-based mock: every repository query is a `vi.fn()` defaulted to empty
 * so each test only stubs the source it asserts on. */
class MockRepo {
  getStageCounts = vi.fn();
  getDroppedStageCounts = vi.fn();
  getStageEntryCounts = vi.fn();
  getSegmentBreakdown = vi.fn();
  getCountryBreakdown = vi.fn();
  getBankerBreakdown = vi.fn();
  getBankerResponseProfiles = vi.fn();
  getStaleCandidates = vi.fn();
  countNewDeals = vi.fn();
  countScreenedL0 = vi.fn();
  countDecksGenerated = vi.fn();
  getCompanyCardStats = vi.fn();
  getAiOpinionStats = vi.fn();
  getScreeningStats = vi.fn();
  countWorkforceRuns = vi.fn();
  getHitlStats = vi.fn();
}

/** Mock of the generic key/value settings store. `get` defaults to null so the
 * service falls back to defaults unless a test stubs stored settings. */
class MockSettingsRepo {
  get = vi.fn();
  getRow = vi.fn();
  set = vi.fn();
}

/** Mock of the Tracks (investment thesis) repo. `findAll` backs the stale-deal
 * matched-Track PIC fallback; defaults to no tracks. */
class MockThesisRepo {
  findAll = vi.fn();
}

const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-22T00:00:00.000Z');
const NOW = new Date('2026-06-22T00:00:00.000Z');

function dim(key: string | null, stage: string, count: number): DimensionStageCount {
  return { key, stage, count };
}

function staleRow(over: Partial<StaleCandidate> & { id: string; pipeline_stage: string }): StaleCandidate {
  return {
    target: `Target ${over.id}`,
    project_name: null,
    last_activity_at: null,
    created_at: null,
    updated_at: null,
    deal_sponsor_name: null,
    deal_captain_name: null,
    segment: null,
    geography: null,
    thesis_content: null,
    matched_track_ids: null,
    ...over,
  };
}

describe('DashboardInsightsService.getInsights', () => {
  let repo: MockRepo;
  let settingsRepo: MockSettingsRepo;
  let thesisRepo: MockThesisRepo;
  let service: DashboardInsightsService;

  beforeEach(() => {
    repo = new MockRepo();
    repo.getStageCounts.mockResolvedValue([]);
    repo.getDroppedStageCounts.mockResolvedValue([]);
    repo.getStageEntryCounts.mockResolvedValue([]);
    repo.getSegmentBreakdown.mockResolvedValue([]);
    repo.getCountryBreakdown.mockResolvedValue([]);
    repo.getBankerBreakdown.mockResolvedValue([]);
    repo.getBankerResponseProfiles.mockResolvedValue([]);
    repo.getStaleCandidates.mockResolvedValue([]);
    repo.countNewDeals.mockResolvedValue(0);
    repo.countScreenedL0.mockResolvedValue(0);
    repo.countDecksGenerated.mockResolvedValue(0);
    repo.getCompanyCardStats.mockResolvedValue({ total: 0, completed: 0, failed: 0 });
    repo.getAiOpinionStats.mockResolvedValue({ total: 0, pass: 0, fail: 0, tentative: 0 });
    repo.getScreeningStats.mockResolvedValue({
      companiesScreened: 0,
      total: 0,
      pass: 0,
      fail: 0,
      inconclusive: 0,
      error: 0,
    });
    repo.countWorkforceRuns.mockResolvedValue(0);
    repo.getHitlStats.mockResolvedValue({ resolved: 0, pending: 0 });
    settingsRepo = new MockSettingsRepo();
    settingsRepo.get.mockResolvedValue(null); // no stored settings → defaults
    thesisRepo = new MockThesisRepo();
    thesisRepo.findAll.mockResolvedValue([]); // no tracks → no Track-PIC fallback
    service = new DashboardInsightsService(
      repo as unknown as DashboardInsightsRepository,
      settingsRepo as unknown as AppSettingsRepository,
      thesisRepo as unknown as import('@/lib/repositories/investmentThesisRepository').InvestmentThesisRepository,
    );
  });

  it('builds the funnel in stage order from stage-entry counts, not the snapshot', async () => {
    // Funnel counts come from getStageEntryCounts (companies *added to* each
    // stage), independent of the current-snapshot getStageCounts.
    repo.getStageEntryCounts.mockResolvedValue([
      { stage: 'L1', count: 13 },
      { stage: 'L0', count: 138 },
      { stage: 'L3', count: 2 },
    ]);
    repo.getStageCounts.mockResolvedValue([{ stage: 'L0', count: 9999 }]);

    const { funnel } = await service.getInsights(FROM, TO, NOW);

    expect(funnel.map((f) => f.stage)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
    expect(funnel[0]).toMatchObject({ stage: 'L0', count: 138, target: 200 });
    // Fixed (non-range) per-stage targets.
    expect(funnel[1]).toMatchObject({ stage: 'L1', count: 13, target: 30, targetLabel: 'target 30' });
    // A stage with no entries falls back to a zero count, not undefined.
    expect(funnel[2]).toMatchObject({ stage: 'L2', count: 0 });
  });

  it('prorates each annual target to the window length (365-day basis)', async () => {
    // FROM→TO spans 21 days. proratedTarget = round(target × 21 / 365).
    const { funnel } = await service.getInsights(FROM, TO, NOW);
    const byStage = Object.fromEntries(funnel.map((f) => [f.stage, f]));

    expect(funnel[0].windowDays).toBe(21);
    expect(byStage.L0).toMatchObject({ target: 200, proratedTarget: 12 }); // 200×21/365 ≈ 11.5
    expect(byStage.L1).toMatchObject({ target: 30, proratedTarget: 2 }); // 30×21/365 ≈ 1.7
    expect(byStage.L3).toMatchObject({ target: 3, proratedTarget: 0 }); // 3×21/365 ≈ 0.17
  });

  it('computes total in pipeline and L0→L1 conversion with the target flag', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 100 },
      { stage: 'L1', count: 13 },
      { stage: 'L2', count: 5 },
    ]);
    // Conversion base = L1 promotions (13) + deals dropped at L0 (87) = 100.
    repo.getDroppedStageCounts.mockResolvedValue([{ stage: 'L0', count: 87 }]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.totalInPipeline).toBe(118); // sum of active stage counts
    expect(kpis.l0l1Conversion).toBe(13); // 13 / (13 + 87)
    expect(kpis.l0l1OnTarget).toBe(true); // >= 10
  });

  it('uses the pipeline-stages formula: L1 promotions over promotions plus L0 drops', async () => {
    // Matches src/views/Dashboard.tsx `stageConversions`: promoted / (promoted +
    // dropped). The raw L1/L0 snapshot ratio (13/40 ≈ 32.5%) is NOT used.
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 40 },
      { stage: 'L1', count: 13 },
    ]);
    repo.getDroppedStageCounts.mockResolvedValue([
      { stage: 'L0', count: 39 }, // 13 promoted + 39 dropped at L0 = 52 base
      { stage: 'L1', count: 5 }, // dropped past L0 — irrelevant to L0→L1
    ]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.l0l1Conversion).toBe(25); // 13 / (13 + 39) = 25%
  });

  it('flags conversion below the healthy band as off-target', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 200 },
      { stage: 'L1', count: 13 },
    ]);
    // Base = 13 promoted + 187 dropped at L0 = 200.
    repo.getDroppedStageCounts.mockResolvedValue([{ stage: 'L0', count: 187 }]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.l0l1Conversion).toBe(6.5); // 13/200 → 6.5%, one decimal
    expect(kpis.l0l1OnTarget).toBe(false);
  });

  it('returns zero conversion when nothing promoted and nothing dropped at L0 (no divide-by-zero)', async () => {
    // No L1 promotions and no L0 drops → empty denominator.
    repo.getStageCounts.mockResolvedValue([{ stage: 'L2', count: 4 }]);
    repo.getDroppedStageCounts.mockResolvedValue([]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.l0l1Conversion).toBe(0);
  });

  it('flags deals past their per-stage staleness threshold, most-overdue first', async () => {
    repo.getStaleCandidates.mockResolvedValue([
      // L0 threshold 14d — 40 days since last activity → stale
      staleRow({
        id: 'z',
        pipeline_stage: 'L0',
        target: 'Origin',
        last_activity_at: new Date('2026-05-13T00:00:00.000Z').toISOString(),
      }),
      // L1 threshold 7d — created 30 days ago, no activity logged → red (>= 2x)
      staleRow({
        id: 'a',
        pipeline_stage: 'L1',
        target: 'Nexus',
        created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
      }),
      // L2 threshold 21d — 25 days since last activity → amber (< 2x)
      staleRow({
        id: 'b',
        pipeline_stage: 'L2',
        target: 'Oriole',
        last_activity_at: new Date('2026-05-28T00:00:00.000Z').toISOString(),
      }),
      // L2 — only 5 days since activity → not stale, excluded
      staleRow({
        id: 'c',
        pipeline_stage: 'L2',
        target: 'Fresh',
        last_activity_at: new Date('2026-06-17T00:00:00.000Z').toISOString(),
      }),
      // L5 has no defined threshold → excluded regardless of age
      staleRow({ id: 'd', pipeline_stage: 'L5', target: 'Closing' }),
    ]);

    const { staleDeals, kpis } = await service.getInsights(FROM, TO, NOW);

    // L0 is now SLA-tracked too (default 14d); Origin (40d) sorts most-overdue.
    expect(staleDeals.map((d) => d.name)).toEqual(['Origin', 'Nexus', 'Oriole']);
    expect(kpis.staleCount).toBe(3);
    // All stale deals are flagged red (uniform coloring per review).
    expect(staleDeals[0]).toMatchObject({ stage: 'L0', days: 40, severity: 'red' });
    expect(staleDeals[1]).toMatchObject({
      days: 30,
      severity: 'red',
      reason: 'No activity logged',
    });
    expect(staleDeals[2]).toMatchObject({ stage: 'L2', days: 25, severity: 'red' });
  });

  it('pivots segment breakdown and converts off the L0 base', async () => {
    repo.getSegmentBreakdown.mockResolvedValue([
      dim('CMP', 'L0', 42),
      dim('CMP', 'L1', 5),
      dim('CMP', 'L2', 2),
      dim('Packaging', 'L0', 11),
      dim(null, 'L0', 9), // unlabelled segments are dropped
    ]);

    const { segments } = await service.getInsights(FROM, TO, NOW);

    expect(segments).toHaveLength(2);
    const cmp = segments.find((s) => s.key === 'CMP')!;
    expect(cmp).toMatchObject({ l0: 42, l1plus: 7, conversion: 17 }); // 7/42 ≈ 17%
    const pkg = segments.find((s) => s.key === 'Packaging')!;
    expect(pkg).toMatchObject({ l0: 11, l1plus: 0, conversion: 0 });
  });

  it('converts bankers off total leads, sorted by lead volume', async () => {
    repo.getBankerBreakdown.mockResolvedValue([
      dim('Goldman Sachs', 'L0', 6),
      dim('Goldman Sachs', 'L1', 3),
      dim('JP Morgan', 'L0', 11),
      dim('JP Morgan', 'L1', 1),
    ]);

    const { bankers } = await service.getInsights(FROM, TO, NOW);

    // JP Morgan has more total leads (12) → sorts first.
    expect(bankers.map((b) => b.key)).toEqual(['JP Morgan', 'Goldman Sachs']);
    expect(bankers[0]).toMatchObject({ total: 12, l1plus: 1, conversion: 8 }); // 1/12 ≈ 8%
    expect(bankers[1]).toMatchObject({ total: 9, l1plus: 3, conversion: 33 }); // 3/9 ≈ 33%
  });

  it('returns every segment/country row sorted descending by L0 (UI paginates)', async () => {
    // 8 segments — more than the old top-6 cap — to prove no slicing happens.
    repo.getSegmentBreakdown.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => dim(`Seg${i}`, 'L0', (i + 1) * 3)),
    );

    const { segments } = await service.getInsights(FROM, TO, NOW);

    expect(segments).toHaveLength(8);
    // Sorted by L0 desc: Seg7 (24) … Seg0 (3).
    expect(segments.map((s) => s.key)).toEqual([
      'Seg7', 'Seg6', 'Seg5', 'Seg4', 'Seg3', 'Seg2', 'Seg1', 'Seg0',
    ]);
    expect(segments[0]).toMatchObject({ key: 'Seg7', l0: 24 });
  });

  it('keeps bankers capped at the fixed top-N by lead volume', async () => {
    repo.getBankerBreakdown.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => dim(`Bank${i}`, 'L0', i + 1)),
    );

    const { bankers } = await service.getInsights(FROM, TO, NOW);

    // Still capped at 6 rows (top by total leads), unlike segments/countries.
    expect(bankers).toHaveLength(6);
    expect(bankers[0].key).toBe('Bank8');
  });

  it('attaches each banker its response p50 + distribution, matched by firm name', async () => {
    repo.getBankerBreakdown.mockResolvedValue([
      dim('Golden Sacks', 'L0', 6),
      dim('Golden Sacks', 'L1', 3),
      dim('Evercore', 'L0', 4), // no email history → unmatched
    ]);
    repo.getBankerResponseProfiles.mockResolvedValue([
      // Matched case-insensitively / normalized ("golden sacks").
      { name: 'Golden Sacks', p50Seconds: 21600, pairCount: 3, gaps: [1800, 21600, 300000] },
    ]);

    const { bankers } = await service.getInsights(FROM, TO, NOW);

    const gs = bankers.find((b) => b.key === 'Golden Sacks')!;
    expect(gs.responseP50Seconds).toBe(21600);
    const byLabel = Object.fromEntries((gs.responseBuckets ?? []).map((b) => [b.label, b.count]));
    expect(byLabel['<1h']).toBe(1); // 1800
    expect(byLabel['4–12h']).toBe(1); // 21600
    expect(byLabel['3–5d']).toBe(1); // 300000
    expect(gs.responseBuckets).toHaveLength(10);

    // A banker with no matching firm keeps a null p50 and no buckets (renders "—").
    const ev = bankers.find((b) => b.key === 'Evercore')!;
    expect(ev.responseP50Seconds).toBeNull();
    expect(ev.responseBuckets).toBeUndefined();
  });

  it('leaves banker response fields null when no profiles are returned', async () => {
    repo.getBankerBreakdown.mockResolvedValue([dim('JP Organ', 'L0', 5)]);

    const { bankers } = await service.getInsights(FROM, TO, NOW);

    expect(bankers[0].responseP50Seconds).toBeNull();
    expect(bankers[0].responseBuckets).toBeUndefined();
  });

  it('does not attach response fields to segment/country rows', async () => {
    repo.getSegmentBreakdown.mockResolvedValue([dim('CMP', 'L0', 5)]);

    const { segments } = await service.getInsights(FROM, TO, NOW);

    expect(segments[0].responseP50Seconds).toBeUndefined();
    expect(segments[0].responseBuckets).toBeUndefined();
  });

  it('resolves the stale deal lead: sponsor at L0–L2, captain (inheriting sponsor) at L3+', async () => {
    repo.getStaleCandidates.mockResolvedValue([
      // L0 (sponsor stage) → shows the deal sponsor
      staleRow({
        id: 'a',
        pipeline_stage: 'L0',
        target: 'Alpha',
        created_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
        deal_sponsor_name: 'Jane Doe',
      }),
      // L3 (captain stage) with a captain set → shows the captain
      staleRow({
        id: 'b',
        pipeline_stage: 'L3',
        target: 'Bravo',
        created_at: new Date('2026-04-01T00:00:00.000Z').toISOString(),
        deal_sponsor_name: 'Jane Doe',
        deal_captain_name: 'Max Power',
      }),
      // L3 with no captain → inherits the sponsor
      staleRow({
        id: 'c',
        pipeline_stage: 'L3',
        target: 'Charlie',
        created_at: new Date('2026-04-01T00:00:00.000Z').toISOString(),
        deal_sponsor_name: 'Jane Doe',
      }),
    ]);

    const { staleDeals } = await service.getInsights(FROM, TO, NOW);

    const byName = Object.fromEntries(staleDeals.map((d) => [d.name, d]));
    expect(byName.Alpha).toMatchObject({
      leadName: 'Jane Doe',
      leadLabel: 'Deal Sponsor',
      leadFromTrack: false,
    });
    expect(byName.Bravo).toMatchObject({
      leadName: 'Max Power',
      leadLabel: 'Deal Captain',
      leadFromTrack: false,
    });
    expect(byName.Charlie).toMatchObject({
      leadName: 'Jane Doe',
      leadLabel: 'Deal Captain',
      leadFromTrack: false,
    });
  });

  it('falls back to the matched Track PIC (flagged leadFromTrack) when no sponsor/captain is set', async () => {
    repo.getStaleCandidates.mockResolvedValue([
      // No stored sponsor; matched to a track via matched_track_ids → uses the Track PIC.
      staleRow({
        id: 'a',
        pipeline_stage: 'L0',
        target: 'Delta',
        created_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
        matched_track_ids: ['t1'],
      }),
      // No stored lead and no track match → null.
      staleRow({
        id: 'b',
        pipeline_stage: 'L0',
        target: 'Echo',
        created_at: new Date('2026-05-01T00:00:00.000Z').toISOString(),
      }),
    ]);
    thesisRepo.findAll.mockResolvedValue([
      { id: 't1', title: 'Fintech', content: 'fintech thesis', pic: 'Track Owner' },
    ]);

    const { staleDeals } = await service.getInsights(FROM, TO, NOW);

    const byName = Object.fromEntries(staleDeals.map((d) => [d.name, d]));
    expect(byName.Delta).toMatchObject({ leadName: 'Track Owner', leadFromTrack: true });
    expect(byName.Echo).toMatchObject({ leadName: null, leadFromTrack: false });
  });

  it('passes the window to period-scoped counters and surfaces AI throughput', async () => {
    repo.countNewDeals.mockResolvedValue(45);
    repo.countScreenedL0.mockResolvedValue(138);
    repo.countDecksGenerated.mockResolvedValue(34);
    repo.getCompanyCardStats.mockResolvedValue({ total: 20, completed: 18, failed: 2 });
    repo.getAiOpinionStats.mockResolvedValue({ total: 12, pass: 7, fail: 3, tentative: 2 });
    repo.getScreeningStats.mockResolvedValue({
      companiesScreened: 9,
      total: 40,
      pass: 22,
      fail: 12,
      inconclusive: 5,
      error: 1,
    });
    repo.countWorkforceRuns.mockResolvedValue(6);
    repo.getHitlStats.mockResolvedValue({ resolved: 23, pending: 2 });

    const { kpis, aiThroughput } = await service.getInsights(FROM, TO, NOW);

    expect(repo.countNewDeals).toHaveBeenCalledWith(FROM, TO);
    expect(repo.countScreenedL0).toHaveBeenCalledWith(FROM, TO);
    // Snapshot aggregates are now window-scoped too (created-in-window).
    expect(repo.getStageCounts).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getSegmentBreakdown).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getCountryBreakdown).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getBankerBreakdown).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getStaleCandidates).toHaveBeenCalledWith(FROM, TO);
    // The new AI-card / opinion / screening counters are window-scoped too.
    expect(repo.getCompanyCardStats).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getAiOpinionStats).toHaveBeenCalledWith(FROM, TO);
    expect(repo.getScreeningStats).toHaveBeenCalledWith(FROM, TO);
    expect(kpis.newDeals).toBe(45);
    expect(aiThroughput).toEqual({
      screenedL0: 138,
      decksGenerated: 34,
      companyCards: { total: 20, completed: 18, failed: 2 },
      aiOpinions: { total: 12, pass: 7, fail: 3, tentative: 2 },
      screenings: { companiesScreened: 9, total: 40, pass: 22, fail: 12, inconclusive: 5, error: 1 },
      workforceRuns: 6,
      hitlResolved: 23,
      hitlPending: 2,
    });
  });

  it('applies stored settings to funnel targets and the conversion band', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 100 },
      { stage: 'L1', count: 9 },
    ]);
    // Base = 9 promoted + 91 dropped at L0 = 100.
    repo.getDroppedStageCounts.mockResolvedValue([{ stage: 'L0', count: 91 }]);
    settingsRepo.get.mockResolvedValue({
      funnelTargets: { L1: 50 },
      l0l1Conversion: { min: 8, max: 12 },
    });

    const { funnel, kpis } = await service.getInsights(FROM, TO, NOW);

    // Stored L1 target overrides the default; unspecified stages keep defaults.
    expect(funnel.find((f) => f.stage === 'L1')).toMatchObject({ target: 50, targetLabel: 'target 50' });
    expect(funnel.find((f) => f.stage === 'L0')).toMatchObject({ target: 200 });
    // 9% conversion is >= the stored min of 8 → on target, with the stored label.
    expect(kpis.l0l1Conversion).toBe(9);
    expect(kpis.l0l1OnTarget).toBe(true);
    expect(kpis.l0l1TargetLabel).toBe('target 8–12%');
  });
});

describe('DashboardInsightsService settings', () => {
  let settingsRepo: MockSettingsRepo;
  let service: DashboardInsightsService;

  beforeEach(() => {
    settingsRepo = new MockSettingsRepo();
    settingsRepo.get.mockResolvedValue(null);
    // `getRow` echoes whatever `set` persisted, so saveSettings → getSettingsWithMeta
    // round-trips through the mock with a fixed audit trail.
    let stored: unknown = null;
    settingsRepo.set.mockImplementation(async (_key, value) => {
      stored = value;
    });
    settingsRepo.getRow.mockImplementation(async () => ({
      value: stored,
      updatedAt: '2026-06-23T10:00:00.000Z',
      updatedBy: { id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' },
    }));
    service = new DashboardInsightsService(
      new MockRepo() as unknown as DashboardInsightsRepository,
      settingsRepo as unknown as AppSettingsRepository,
      new MockThesisRepo() as unknown as import('@/lib/repositories/investmentThesisRepository').InvestmentThesisRepository,
    );
  });

  it('returns defaults when nothing is stored', async () => {
    const settings = await service.getSettings();
    expect(settings.funnelTargets).toMatchObject({ L0: 200, L1: 30, L5: 1 });
    expect(settings.l0l1Conversion).toEqual({ min: 10, max: 15 });
    expect(settings.staleThresholds).toEqual({ L0: 14, L1: 7, L2: 21, L3: 45 });
  });

  it('fills in missing fields of a partial stored blob from defaults', async () => {
    settingsRepo.get.mockResolvedValue({ funnelTargets: { L1: 40 } });
    const settings = await service.getSettings();
    expect(settings.funnelTargets).toMatchObject({ L0: 200, L1: 40, L2: 10 });
    expect(settings.l0l1Conversion).toEqual({ min: 10, max: 15 });
  });

  it('getSettingsWithMeta surfaces who last changed the settings', async () => {
    settingsRepo.getRow.mockResolvedValueOnce({
      value: { funnelTargets: { L1: 40 } },
      updatedAt: '2026-06-23T10:00:00.000Z',
      updatedBy: { id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' },
    });

    const result = await service.getSettingsWithMeta();

    expect(result.funnelTargets).toMatchObject({ L0: 200, L1: 40 });
    expect(result.meta).toEqual({
      updatedAt: '2026-06-23T10:00:00.000Z',
      updatedBy: { id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' },
    });
  });

  it('sanitises and persists on save, recording the editing user', async () => {
    const saved = await service.saveSettings(
      {
        funnelTargets: { L0: 150, L1: 25.7, L2: -3 } as Record<string, number>,
        l0l1Conversion: { min: 20, max: 5 },
        staleThresholds: { L1: 10.4, L2: -5 } as Record<string, number>,
      },
      'u1',
    );

    // Negatives floored to 0, decimals rounded, band re-ordered min<=max.
    expect(saved.funnelTargets).toMatchObject({ L0: 150, L1: 26, L2: 0, L3: 3 });
    expect(saved.l0l1Conversion).toEqual({ min: 5, max: 20 });
    // Stale thresholds: decimals rounded, negatives floored, missing → default.
    expect(saved.staleThresholds).toEqual({ L0: 14, L1: 10, L2: 0, L3: 45 });
    // Returned with the audit trail from getSettingsWithMeta.
    expect(saved.meta.updatedBy).toMatchObject({ id: 'u1', name: 'Jane Doe' });
    // Persisted under the insights key, with the editing user id.
    const [key, value, updatedBy] = settingsRepo.set.mock.calls[0];
    expect(key).toBe('insights_dashboard');
    expect(updatedBy).toBe('u1');
    expect(value).toMatchObject({ funnelTargets: { L1: 26, L2: 0 } });
  });
});
