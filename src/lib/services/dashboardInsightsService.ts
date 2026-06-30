import type {
  AiOpinionStats,
  CompanyCardStats,
  DashboardInsightsRepository,
  DimensionStageCount,
  ScreeningStats,
  StaleCandidate,
} from '@/lib/repositories/dashboardInsightsRepository';
import { PIPELINE_FUNNEL_STAGES } from '@/lib/repositories/dashboardInsightsRepository';
import type { AppSettingsRepository } from '@/lib/repositories/appSettingsRepository';

// ─── Configurable settings (persisted in app_settings) ──────────────────────────

/** User-editable Insights configuration, persisted in the `app_settings` table
 * under {@link INSIGHTS_SETTINGS_KEY}. */
export interface InsightsSettings {
  /** Target headcount per funnel stage (L0–L5). */
  funnelTargets: Record<string, number>;
  /** Healthy L0→L1 conversion band, in percent. */
  l0l1Conversion: { min: number; max: number };
  /** Days a deal may sit in each SLA-tracked stage (L0/L1/L2/L3) before it's
   * flagged stale. */
  staleThresholds: Record<string, number>;
  /** Banker / banker_source names to exclude from the "Banker source quality"
   * card. Matched case-insensitively as substrings, so "Sinarmas" also drops
   * "Sinarmas Sekuritas". */
  bankerExclusions: string[];
}

/** Audit trail for the settings row: who saved it last, and when. */
export interface InsightsSettingsMeta {
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null; email: string | null } | null;
}

/** Settings plus their audit metadata — returned by the GET/PUT settings API. */
export type InsightsSettingsWithMeta = InsightsSettings & { meta: InsightsSettingsMeta };

const INSIGHTS_SETTINGS_KEY = 'insights_dashboard';

/** Defaults applied when no row exists yet (or to fill in missing fields). */
export const DEFAULT_INSIGHTS_SETTINGS: InsightsSettings = {
  funnelTargets: { L0: 200, L1: 30, L2: 10, L3: 3, L4: 2, L5: 1 },
  l0l1Conversion: { min: 10, max: 15 },
  staleThresholds: { L0: 14, L1: 7, L2: 21, L3: 45 },
  bankerExclusions: ['Starcapital', 'Sinarmas'],
};

// ─── Business configuration (not user-editable) ─────────────────────────────────

/** SLA-tracked stages, in display order. Only these stages carry a staleness
 * threshold and can be flagged stale; L4/L5 have no SLA. */
export const STALE_STAGES = ['L0', 'L1', 'L2', 'L3'] as const;

/** Most-overdue deals to surface in the stale list. */
const MAX_STALE_ROWS = 8;

/** Top rows to surface in each breakdown table. */
const MAX_BREAKDOWN_ROWS = 6;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ─── DTO ────────────────────────────────────────────────────────────────────────

export interface InsightsKpis {
  /** Active companies across all funnel stages (current snapshot). */
  totalInPipeline: number;
  /** Funnel companies created within the window. */
  newDeals: number;
  /** L0→L1 conversion as a percentage (one decimal). */
  l0l1Conversion: number;
  /** Whether `l0l1Conversion` sits within the healthy band. */
  l0l1OnTarget: boolean;
  l0l1TargetLabel: string;
  /** Number of deals flagged stale in their current stage. */
  staleCount: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  target: number;
  targetLabel: string;
}

export interface StaleDeal {
  id: string;
  name: string;
  stage: string;
  /** Days since the last logged activity (or since creation when none). */
  days: number;
  reason: string;
  severity: 'red' | 'amber';
}

export interface BreakdownRow {
  key: string;
  l0: number;
  l1plus: number;
  /** Total across all funnel stages (used as the conversion base for bankers). */
  total: number;
  /** Conversion percentage (rounded). */
  conversion: number;
}

export interface AiThroughput {
  screenedL0: number;
  decksGenerated: number;
  /** AI Company Cards generated in the window (total + status split). */
  companyCards: CompanyCardStats;
  /** AI Opinion verdicts recorded in the window (total + verdict split). */
  aiOpinions: AiOpinionStats;
  /** AI screening runs that produced a result in the window. */
  screenings: ScreeningStats;
  workforceRuns: number;
  hitlResolved: number;
  hitlPending: number;
}

export interface DashboardInsights {
  kpis: InsightsKpis;
  funnel: FunnelStage[];
  staleThresholdLabel: string;
  staleDeals: StaleDeal[];
  bankers: BreakdownRow[];
  segments: BreakdownRow[];
  countries: BreakdownRow[];
  aiThroughput: AiThroughput;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class DashboardInsightsService {
  constructor(
    private repo: DashboardInsightsRepository,
    private settingsRepo: AppSettingsRepository,
  ) {}

  /** Current Insights settings, with defaults filled in for any missing field. */
  async getSettings(): Promise<InsightsSettings> {
    const stored = await this.settingsRepo.get<Partial<InsightsSettings>>(
      INSIGHTS_SETTINGS_KEY,
    );
    return mergeSettings(stored);
  }

  /** Current settings plus the audit metadata (who last changed them, when). */
  async getSettingsWithMeta(): Promise<InsightsSettingsWithMeta> {
    const row = await this.settingsRepo.getRow<Partial<InsightsSettings>>(
      INSIGHTS_SETTINGS_KEY,
    );
    return {
      ...mergeSettings(row?.value ?? null),
      meta: { updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null },
    };
  }

  /**
   * Validate, persist, and return the new Insights settings (with audit meta).
   * `updatedBy` is the id of the user making the change.
   */
  async saveSettings(
    input: InsightsSettings,
    updatedBy?: string | null,
  ): Promise<InsightsSettingsWithMeta> {
    const sanitised = sanitiseSettings(input);
    await this.settingsRepo.set(INSIGHTS_SETTINGS_KEY, sanitised, updatedBy ?? null);
    return this.getSettingsWithMeta();
  }

  /**
   * Assemble the Insights dashboard for the given window. Every metric is scoped
   * to companies created within `[from, to]` (funnel, totals, conversion, stale
   * deals, and breakdowns are grouped by current stage), alongside the
   * period-scoped activity counters (new deals, AI throughput). The sole
   * exception is `aiThroughput.hitlPending`, which is intentionally a live
   * snapshot ("work awaiting a human now"). `now` is injectable for
   * deterministic staleness math in tests.
   */
  async getInsights(from: Date, to: Date, now: Date = new Date()): Promise<DashboardInsights> {
    const [
      settings,
      stageCounts,
      segmentBreakdown,
      countryBreakdown,
      bankerBreakdown,
      staleCandidates,
      newDeals,
      screenedL0,
      decksGenerated,
      companyCards,
      aiOpinions,
      screeningStats,
      workforceRuns,
      hitl,
    ] = await Promise.all([
      this.getSettings(),
      this.repo.getStageCounts(from, to),
      this.repo.getSegmentBreakdown(from, to),
      this.repo.getCountryBreakdown(from, to),
      this.repo.getBankerBreakdown(from, to),
      this.repo.getStaleCandidates(from, to),
      this.repo.countNewDeals(from, to),
      this.repo.countScreenedL0(from, to),
      this.repo.countDecksGenerated(from, to),
      this.repo.getCompanyCardStats(from, to),
      this.repo.getAiOpinionStats(from, to),
      this.repo.getScreeningStats(from, to),
      this.repo.countWorkforceRuns(from, to),
      this.repo.getHitlStats(from, to),
    ]);

    const countByStage = new Map(stageCounts.map((s) => [s.stage, s.count]));
    const stageCount = (stage: string) => countByStage.get(stage) ?? 0;

    const funnel: FunnelStage[] = PIPELINE_FUNNEL_STAGES.map((stage) => {
      const target = settings.funnelTargets[stage] ?? 0;
      return { stage, count: stageCount(stage), target, targetLabel: `target ${target}` };
    });

    const totalInPipeline = stageCounts.reduce((s, x) => s + x.count, 0);
    const l0 = stageCount('L0');
    const l1 = stageCount('L1');
    const l0l1Conversion = l0 > 0 ? Math.round((l1 / l0) * 1000) / 10 : 0;
    const { min, max } = settings.l0l1Conversion;

    const staleDeals = buildStaleDeals(staleCandidates, now, settings.staleThresholds);

    const kpis: InsightsKpis = {
      totalInPipeline,
      newDeals,
      l0l1Conversion,
      l0l1OnTarget: l0l1Conversion >= min,
      l0l1TargetLabel: `target ${min}–${max}%`,
      staleCount: staleDeals.length,
    };

    return {
      kpis,
      funnel,
      staleThresholdLabel: formatStaleThresholdLabel(settings.staleThresholds),
      staleDeals: staleDeals.slice(0, MAX_STALE_ROWS),
      // Segments & countries convert off their L0 base; bankers off total leads.
      segments: buildBreakdown(segmentBreakdown, 'l0'),
      countries: buildBreakdown(countryBreakdown, 'l0'),
      bankers: buildBreakdown(bankerBreakdown, 'total', settings.bankerExclusions),
      aiThroughput: {
        screenedL0,
        decksGenerated,
        companyCards,
        aiOpinions,
        screenings: screeningStats,
        workforceRuns,
        hitlResolved: hitl.resolved,
        hitlPending: hitl.pending,
      },
    };
  }
}

// ─── Settings helpers ───────────────────────────────────────────────────────────

/** Overlay a (possibly partial / null) stored settings blob onto the defaults so
 * every field is always present. */
function mergeSettings(stored: Partial<InsightsSettings> | null): InsightsSettings {
  return {
    funnelTargets: { ...DEFAULT_INSIGHTS_SETTINGS.funnelTargets, ...(stored?.funnelTargets ?? {}) },
    l0l1Conversion: {
      ...DEFAULT_INSIGHTS_SETTINGS.l0l1Conversion,
      ...(stored?.l0l1Conversion ?? {}),
    },
    staleThresholds: {
      ...DEFAULT_INSIGHTS_SETTINGS.staleThresholds,
      ...(stored?.staleThresholds ?? {}),
    },
    // A stored empty array is a deliberate "exclude nothing", so only fall back
    // to defaults when the field is absent entirely.
    bankerExclusions: stored?.bankerExclusions ?? DEFAULT_INSIGHTS_SETTINGS.bankerExclusions,
  };
}

/** Coerce settings into a clean, persistable shape: non-negative integer targets
 * for each funnel stage, and a 0–100 conversion band with `min <= max`. */
function sanitiseSettings(input: InsightsSettings): InsightsSettings {
  const merged = mergeSettings(input);

  const funnelTargets: Record<string, number> = {};
  for (const stage of PIPELINE_FUNNEL_STAGES) {
    const raw = merged.funnelTargets[stage];
    funnelTargets[stage] = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  const clampPct = (n: number) =>
    Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
  const min = clampPct(merged.l0l1Conversion.min);
  const max = clampPct(merged.l0l1Conversion.max);

  const staleThresholds: Record<string, number> = {};
  for (const stage of STALE_STAGES) {
    const raw = merged.staleThresholds[stage];
    staleThresholds[stage] = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  // Trim, drop blanks, and de-dupe (case-insensitive) the exclusion names.
  const seen = new Set<string>();
  const bankerExclusions: string[] = [];
  for (const raw of merged.bankerExclusions ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bankerExclusions.push(name);
  }

  return {
    funnelTargets,
    // Guarantee a sane band even if the inputs are swapped.
    l0l1Conversion: { min: Math.min(min, max), max: Math.max(min, max) },
    staleThresholds,
    bankerExclusions,
  };
}

/** Human-readable summary of the stale thresholds, shown in the card header,
 * e.g. "L1: 7d · L2: 21d · L3: 45d". */
function formatStaleThresholdLabel(thresholds: Record<string, number>): string {
  return STALE_STAGES.map((stage) => `${stage}: ${thresholds[stage] ?? 0}d`).join(' · ');
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Compute days a deal has sat without activity, classify staleness, and sort
 * the overdue deals most-overdue first. A deal with no activity reference at
 * all is treated as the most stale (red, sorted first). */
function buildStaleDeals(
  candidates: StaleCandidate[],
  now: Date,
  thresholds: Record<string, number>,
): StaleDeal[] {
  const nowMs = now.getTime();

  const scored: { deal: StaleDeal; sortKey: number }[] = [];
  for (const c of candidates) {
    const threshold = thresholds[c.pipeline_stage];
    if (threshold == null) continue; // no SLA defined for this stage (L4/L5)

    // Fall back through the activity timestamps; created_at is effectively
    // always present, so `days` is null only for rows with no timestamps at all.
    const lastActivity = c.last_activity_at ?? c.updated_at ?? c.created_at;
    const days = lastActivity
      ? Math.floor((nowMs - new Date(lastActivity).getTime()) / MS_PER_DAY)
      : null;
    if (days != null && days < threshold) continue; // still within SLA

    scored.push({
      sortKey: days ?? Number.MAX_SAFE_INTEGER,
      deal: {
        id: c.id,
        name: c.target || c.project_name || '—',
        stage: c.pipeline_stage,
        days: days ?? 0,
        reason: c.last_activity_at ? `Last activity ${days} days ago` : 'No activity logged',
        // Any deal past its stage SLA is flagged red (uniform coloring per review).
        severity: 'red',
      },
    });
  }

  return scored.sort((a, b) => b.sortKey - a.sortKey).map((s) => s.deal);
}

/** Pivot `(key, stage)` counts into per-key rows and compute conversion.
 * `base` selects the conversion denominator: `l0` for segment/country tables
 * (L1+ as a share of L0), `total` for bankers (L1+ as a share of all leads). */
function buildBreakdown(
  rows: DimensionStageCount[],
  base: 'l0' | 'total',
  exclusions: string[] = [],
): BreakdownRow[] {
  const excludeTerms = exclusions.map((e) => e.toLowerCase());
  const isExcluded = (key: string) => {
    const k = key.toLowerCase();
    return excludeTerms.some((term) => k.includes(term));
  };

  const byKey = new Map<string, { l0: number; l1plus: number; total: number }>();

  for (const row of rows) {
    if (row.key == null || row.key.trim() === '') continue; // skip unlabelled
    if (isExcluded(row.key)) continue; // configurable source exclusions (bankers)
    const agg = byKey.get(row.key) ?? { l0: 0, l1plus: 0, total: 0 };
    agg.total += row.count;
    if (row.stage === 'L0') agg.l0 += row.count;
    else agg.l1plus += row.count;
    byKey.set(row.key, agg);
  }

  return Array.from(byKey.entries())
    .map(([key, agg]) => {
      const denom = base === 'l0' ? agg.l0 : agg.total;
      return {
        key,
        l0: agg.l0,
        l1plus: agg.l1plus,
        total: agg.total,
        conversion: denom > 0 ? Math.round((agg.l1plus / denom) * 100) : 0,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_BREAKDOWN_ROWS);
}
