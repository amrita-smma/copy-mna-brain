import type {
  DashboardInsightsRepository,
  DimensionStageCount,
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
};

// ─── Business configuration (not user-editable) ─────────────────────────────────

/** Standard days a deal should spend in each stage before it's "stale". A deal
 * with no activity older than its stage threshold surfaces in the stale list. */
const STALE_THRESHOLDS: Record<string, number> = { L1: 7, L2: 21, L3: 45 };

/** Human-readable summary of the stale thresholds, shown in the card header. */
const STALE_THRESHOLD_LABEL = 'L1: 7d · L2: 21d · L3: 45d';

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
   * Assemble the Insights dashboard for the given window. Period-scoped metrics
   * (new deals, AI throughput) honour `from`/`to`; snapshot metrics (funnel,
   * stale deals, breakdowns) reflect the current pipeline state. `now` is
   * injectable for deterministic staleness math in tests.
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
      workforceRuns,
      hitl,
    ] = await Promise.all([
      this.getSettings(),
      this.repo.getStageCounts(),
      this.repo.getSegmentBreakdown(),
      this.repo.getCountryBreakdown(),
      this.repo.getBankerBreakdown(),
      this.repo.getActiveNonL0Deals(),
      this.repo.countNewDeals(from, to),
      this.repo.countScreenedL0(from, to),
      this.repo.countDecksGenerated(from, to),
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

    const staleDeals = buildStaleDeals(staleCandidates, now);

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
      staleThresholdLabel: STALE_THRESHOLD_LABEL,
      staleDeals: staleDeals.slice(0, MAX_STALE_ROWS),
      // Segments & countries convert off their L0 base; bankers off total leads.
      segments: buildBreakdown(segmentBreakdown, 'l0'),
      countries: buildBreakdown(countryBreakdown, 'l0'),
      bankers: buildBreakdown(bankerBreakdown, 'total'),
      aiThroughput: {
        screenedL0,
        decksGenerated,
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

  return {
    funnelTargets,
    // Guarantee a sane band even if the inputs are swapped.
    l0l1Conversion: { min: Math.min(min, max), max: Math.max(min, max) },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Compute days a deal has sat without activity, classify staleness, and sort
 * the overdue deals most-overdue first. A deal with no activity reference at
 * all is treated as the most stale (red, sorted first). */
function buildStaleDeals(candidates: StaleCandidate[], now: Date): StaleDeal[] {
  const nowMs = now.getTime();

  const scored: { deal: StaleDeal; sortKey: number }[] = [];
  for (const c of candidates) {
    const threshold = STALE_THRESHOLDS[c.pipeline_stage];
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
): BreakdownRow[] {
  const byKey = new Map<string, { l0: number; l1plus: number; total: number }>();

  for (const row of rows) {
    if (row.key == null || row.key.trim() === '') continue; // skip unlabelled
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
