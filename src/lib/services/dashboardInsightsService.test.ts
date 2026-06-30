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
  getSegmentBreakdown = vi.fn();
  getCountryBreakdown = vi.fn();
  getBankerBreakdown = vi.fn();
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
    ...over,
  };
}

describe('DashboardInsightsService.getInsights', () => {
  let repo: MockRepo;
  let settingsRepo: MockSettingsRepo;
  let service: DashboardInsightsService;

  beforeEach(() => {
    repo = new MockRepo();
    repo.getStageCounts.mockResolvedValue([]);
    repo.getSegmentBreakdown.mockResolvedValue([]);
    repo.getCountryBreakdown.mockResolvedValue([]);
    repo.getBankerBreakdown.mockResolvedValue([]);
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
    service = new DashboardInsightsService(
      repo as unknown as DashboardInsightsRepository,
      settingsRepo as unknown as AppSettingsRepository,
    );
  });

  it('builds the funnel in stage order with targets and current counts', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L1', count: 13 },
      { stage: 'L0', count: 138 },
      { stage: 'L3', count: 2 },
    ]);

    const { funnel } = await service.getInsights(FROM, TO, NOW);

    expect(funnel.map((f) => f.stage)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
    expect(funnel[0]).toMatchObject({ stage: 'L0', count: 138, target: 200 });
    // Fixed (non-range) per-stage targets.
    expect(funnel[1]).toMatchObject({ stage: 'L1', count: 13, target: 30, targetLabel: 'target 30' });
    // A stage with no rows falls back to a zero count, not undefined.
    expect(funnel[2]).toMatchObject({ stage: 'L2', count: 0 });
  });

  it('computes total in pipeline and L0→L1 conversion with the target flag', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 100 },
      { stage: 'L1', count: 13 },
      { stage: 'L2', count: 5 },
    ]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.totalInPipeline).toBe(118);
    expect(kpis.l0l1Conversion).toBe(13); // 13/100
    expect(kpis.l0l1OnTarget).toBe(true); // >= 10
  });

  it('flags conversion below the healthy band as off-target', async () => {
    repo.getStageCounts.mockResolvedValue([
      { stage: 'L0', count: 200 },
      { stage: 'L1', count: 13 },
    ]);

    const { kpis } = await service.getInsights(FROM, TO, NOW);

    expect(kpis.l0l1Conversion).toBe(6.5); // 13/200 → 6.5%, one decimal
    expect(kpis.l0l1OnTarget).toBe(false);
  });

  it('returns zero conversion when there are no L0 deals (no divide-by-zero)', async () => {
    repo.getStageCounts.mockResolvedValue([{ stage: 'L1', count: 4 }]);

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
