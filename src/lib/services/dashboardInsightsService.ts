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
import type { InvestmentThesisRepository } from '@/lib/repositories/investmentThesisRepository';
import type { PipelineStageRepository } from '@/lib/repositories/pipelineStageRepository';
import {
  CAPTAIN_FROM_STAGE_KEY,
  liveStageKeys,
  stageCode,
  stageKeysFrom,
  stageKeysThrough,
  type PipelineStageDef,
} from '@/lib/pipeline/stages';
import {
  dealLeadField,
  dealLeadLabel,
  matchedTrackPics,
  type TrackLike,
} from '@/lib/tracks/matchTracks';
import { normalizeCompanyName } from '@/lib/crm/normalizeCompanyName';

// ─── Configurable settings (persisted in app_settings) ──────────────────────────

/** User-editable Insights configuration, persisted in the `app_settings` table
 * under {@link INSIGHTS_SETTINGS_KEY}. */
export interface InsightsSettings {
  /** Target headcount per funnel stage, keyed by stage key. */
  funnelTargets: Record<string, number>;
  /** Healthy L0→L1 conversion band, in percent. */
  l0l1Conversion: { min: number; max: number };
  /** Days a deal may sit in each SLA-tracked stage (L0/L1/L2/L3) before it's
   * flagged stale. */
  staleThresholds: Record<string, number>;
}

/** Audit trail for the settings row: who saved it last, and when. */
export interface InsightsSettingsMeta {
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null; email: string | null } | null;
}

/** Settings plus their audit metadata — returned by the GET/PUT settings API. */
export type InsightsSettingsWithMeta = InsightsSettings & {
  meta: InsightsSettingsMeta;
  /** The workspace's live funnel stages in order — one target input each. */
  funnelStages: string[];
  /** The SLA-tracked stages (L0 through L3 in the workspace's order) — one
   * stale-threshold input each. A stage with no threshold set is not tracked. */
  staleStages: string[];
};

/** The workspace's stage lists the Insights figures are built over. */
interface InsightsStageLists {
  stages: PipelineStageDef[];
  funnelStages: string[];
  staleStages: string[];
  captainStages: string[];
}

const INSIGHTS_SETTINGS_KEY = 'insights_dashboard';

/** Defaults applied when no row exists yet (or to fill in missing fields). */
export const DEFAULT_INSIGHTS_SETTINGS: InsightsSettings = {
  funnelTargets: { L0: 200, L1: 30, L2: 10, L3: 3, L4: 2, L5: 1 },
  l0l1Conversion: { min: 10, max: 15 },
  staleThresholds: { L0: 14, L1: 7, L2: 21, L3: 45 },
};

// ─── Business configuration (not user-editable) ─────────────────────────────────

/** The last SLA-tracked stage: stages from L0 through this one (in the
 * workspace's order, added stages included) carry a staleness threshold and can
 * be flagged stale; stages after it have no SLA. */
export const LAST_STALE_STAGE_KEY = 'L3';

/** The original SLA-tracked stages, used when no workspace stage list is to hand. */
export const STALE_STAGES: readonly string[] = ['L0', 'L1', 'L2', 'L3'];

/** Most-overdue deals to surface in the stale list. */
const MAX_STALE_ROWS = 8;

/** Maximum banker rows returned in the breakdown (top by total leads). */
const MAX_BREAKDOWN_ROWS = 6;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Base period the configurable funnel targets are expressed over. Targets are
 * annual goals, prorated down to the selected window on the dashboard. */
const TARGET_PERIOD_DAYS = 365;

// ─── DTO ────────────────────────────────────────────────────────────────────────

export interface InsightsKpis {
  /** Active companies across all funnel stages (current snapshot). */
  totalInPipeline: number;
  /** Funnel companies created within the window. */
  newDeals: number;
  /** L0→L1 conversion as a whole-number percentage. Computed the same way as the
   * main dashboard's "Pipeline Stages" card: the cumulative share of the whole
   * L0 cohort (active + dropped) that reached L1 or beyond — `l1plus /
   * cohortTotal`. */
  l0l1Conversion: number;
  /** Whether `l0l1Conversion` sits within the healthy band. */
  l0l1OnTarget: boolean;
  l0l1TargetLabel: string;
  /** Number of deals flagged stale in their current stage. */
  staleCount: number;
}

export interface FunnelStage {
  stage: string;
  /** Companies *added to* this stage during the window (created at it or moved
   * into it), not the current snapshot. */
  count: number;
  /** Full-period (annual) target headcount for the stage. */
  target: number;
  targetLabel: string;
  /** {@link target} scaled to the selected window: `target × windowDays / 365`,
   * rounded — the fair goal to compare `count` against for a partial period. */
  proratedTarget: number;
  /** Whole days spanned by the selected window (used for the prorated label). */
  windowDays: number;
}

export interface StaleDeal {
  id: string;
  name: string;
  stage: string;
  /** Days since the last logged activity (or since creation when none). */
  days: number;
  reason: string;
  severity: 'red' | 'amber';
  /** Effective deal lead name for the stage (sponsor at L0–L2, captain at L3+,
   * captain inheriting the sponsor when unset; falling back to the matched
   * Track's PIC). Null when none can be resolved. */
  leadName: string | null;
  /** Label for the lead: "Deal Sponsor" (L0–L2) or "Deal Captain" (L3+). */
  leadLabel: string;
  /** True when `leadName` came from the matched Track's PIC rather than a stored
   * sponsor/captain — the UI appends a "(from Track)" suffix. */
  leadFromTrack: boolean;
}

/** One bar of a banker's response-time distribution sparkline. */
export interface ResponseTimeBucket {
  /** Response-time band, e.g. "1–4h" or "14d+". */
  label: string;
  /** Reply pairs whose gap falls in this band. */
  count: number;
}

export interface BreakdownRow {
  key: string;
  l0: number;
  l1plus: number;
  /** Total across all funnel stages (used as the conversion base for bankers). */
  total: number;
  /** Conversion percentage (rounded). */
  conversion: number;
  /** Bankers only: our median reply time to this firm (seconds), matched by
   * firm name. Null when no email history matches. */
  responseP50Seconds?: number | null;
  /** Bankers only: distribution of our reply times, for the row's sparkline.
   * Undefined for non-banker rows and unmatched bankers. */
  responseBuckets?: ResponseTimeBucket[];
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
    private thesisRepo: InvestmentThesisRepository,
    // Optional: the workspace's pipeline stages. Without it the funnel covers
    // the six original stages.
    private stageRepo?: PipelineStageRepository,
  ) {}

  private async stageLists(): Promise<InsightsStageLists> {
    if (!this.stageRepo) {
      return {
        stages: [],
        funnelStages: [...PIPELINE_FUNNEL_STAGES],
        staleStages: [...STALE_STAGES],
        captainStages: ['L3', 'L4', 'L5'],
      };
    }
    const stages: PipelineStageDef[] = (await this.stageRepo.list()).map((r) => ({
      key: r.key,
      code: r.code,
      name: r.name,
      description: r.description,
      position: r.position,
      deleted: r.deleted_at !== null,
    }));
    return {
      stages,
      funnelStages: liveStageKeys(stages),
      staleStages: stageKeysThrough(stages, LAST_STALE_STAGE_KEY),
      captainStages: stageKeysFrom(stages, CAPTAIN_FROM_STAGE_KEY),
    };
  }

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
    const { funnelStages, staleStages } = await this.stageLists();
    return {
      ...mergeSettings(row?.value ?? null),
      meta: { updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null },
      funnelStages,
      staleStages,
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
    const [lists, stored] = await Promise.all([
      this.stageLists(),
      this.settingsRepo.get<Partial<InsightsSettings>>(INSIGHTS_SETTINGS_KEY),
    ]);
    const sanitised = sanitiseSettings(input, lists);
    // The settings row is shared by every workspace, but each workspace edits
    // only its own stages. Overwrite those keys and keep the rest, so a save
    // here never drops another workspace's added-stage targets or thresholds.
    const merged: InsightsSettings = {
      ...sanitised,
      funnelTargets: { ...(stored?.funnelTargets ?? {}), ...sanitised.funnelTargets },
      staleThresholds: { ...(stored?.staleThresholds ?? {}), ...sanitised.staleThresholds },
    };
    await this.settingsRepo.set(INSIGHTS_SETTINGS_KEY, merged, updatedBy ?? null);
    return this.getSettingsWithMeta();
  }

  /**
   * Assemble the Insights dashboard for the given window. The current-snapshot
   * KPIs (`totalInPipeline`, `l0l1Conversion`) count active companies created
   * within `[from, to]` by their current stage, alongside the period-scoped
   * activity counters (new deals, AI throughput). The `funnel` and the segment
   * / country / banker breakdowns instead reflect companies *added to* each
   * stage during the window (created there or moved in) — covering **all**
   * companies that passed through a stage in the period, dropped ones included,
   * and counting each company at most once per stage. The funnel compares those
   * counts against each stage's annual target prorated to the window length. The
   * sole exception is `aiThroughput.hitlPending`, which is intentionally a live
   * snapshot ("work awaiting a human now"). `now` is injectable for
   * deterministic staleness math in tests.
   */
  async getInsights(from: Date, to: Date, now: Date = new Date()): Promise<DashboardInsights> {
    const lists = await this.stageLists();
    const { funnelStages } = lists;
    const [
      settings,
      stageCounts,
      droppedStageCounts,
      stageEntryCounts,
      segmentBreakdown,
      countryBreakdown,
      bankerBreakdown,
      bankerResponseProfiles,
      staleCandidates,
      tracks,
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
      this.repo.getStageCounts(from, to, funnelStages),
      this.repo.getDroppedStageCounts(from, to, funnelStages),
      this.repo.getStageEntryCounts(from, to, funnelStages),
      this.repo.getSegmentBreakdown(from, to, funnelStages),
      this.repo.getCountryBreakdown(from, to, funnelStages),
      this.repo.getBankerBreakdown(from, to, funnelStages),
      this.repo.getBankerResponseProfiles(),
      this.repo.getStaleCandidates(from, to, funnelStages),
      // All Tracks (investment theses) — the matched-Track PIC fallback for the
      // stale-deal lead uses the same full set the pipeline UI does.
      this.thesisRepo.findAll(),
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

    const entriesByStage = new Map(stageEntryCounts.map((s) => [s.stage, s.count]));

    // Whole days in the window — the numerator when prorating annual targets.
    const windowDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / MS_PER_DAY));

    const funnel: FunnelStage[] = funnelStages.map((stage) => {
      const target = settings.funnelTargets[stage] ?? 0;
      const proratedTarget = Math.round((target * windowDays) / TARGET_PERIOD_DAYS);
      return {
        stage,
        count: entriesByStage.get(stage) ?? 0,
        target,
        targetLabel: `target ${target}`,
        proratedTarget,
        windowDays,
      };
    });

    const totalInPipeline = stageCounts.reduce((s, x) => s + x.count, 0);
    const droppedByStage = new Map(droppedStageCounts.map((s) => [s.stage, s.count]));

    // L0→L1 conversion mirrors the main dashboard's "Pipeline Stages" card
    // (`Dashboard.tsx` `conversionPercentStage`): the cumulative share of the
    // whole L0 cohort — every company created in the window, active and dropped
    // alike — that reached L1 or beyond. A company at L2/L3/… today also passed
    // through L1, so the numerator rolls up the cohort from L1 onward
    // (`l1plus / cohortTotal`). The cohort per stage is active + dropped, so this
    // reconciles with the Dashboard funnel and the segment/country breakdown
    // tables below, which use the same cumulative base.
    const cohortByStage = (stage: string) =>
      stageCount(stage) + (droppedByStage.get(stage) ?? 0);
    const cohortTotal = funnelStages.reduce(
      (s, stage) => s + cohortByStage(stage),
      0,
    );
    const l0l1Promoted = funnelStages.filter((stage) => stage !== 'L0').reduce(
      (s, stage) => s + cohortByStage(stage),
      0,
    );
    const l0l1Conversion =
      cohortTotal > 0 ? Math.round((l0l1Promoted / cohortTotal) * 100) : 0;
    const { min, max } = settings.l0l1Conversion;

    const staleDeals = buildStaleDeals(
      staleCandidates,
      now,
      staleThresholdsFor(settings.staleThresholds, lists.staleStages),
      tracks,
      lists.captainStages,
    );

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
      staleThresholdLabel: formatStaleThresholdLabel(settings.staleThresholds, lists),
      staleDeals: staleDeals.slice(0, MAX_STALE_ROWS),
      // All three count the same cohort as the "New Deals" tally: companies
      // created in the window that are currently a pipeline deal (a live stage), dropped
      // included, each counted once by its current stage — so the per-key totals
      // sum back to New Deals (blank keys aside). Every row sorts and displays by
      // that total. Segments/countries return every row (the UI paginates);
      // bankers stay capped at a fixed top-N and carry our response-time profile.
      segments: buildBreakdown(segmentBreakdown, 'total'),
      countries: buildBreakdown(countryBreakdown, 'total'),
      bankers: attachResponseProfiles(
        buildBreakdown(bankerBreakdown, 'total', MAX_BREAKDOWN_ROWS),
        bankerResponseProfiles,
      ),
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
  };
}

/** Coerce settings into a clean, persistable shape: non-negative integer targets
 * for each funnel stage, and a 0–100 conversion band with `min <= max`. */
function sanitiseSettings(input: InsightsSettings, lists: InsightsStageLists): InsightsSettings {
  const merged = mergeSettings(input);

  const funnelTargets: Record<string, number> = {};
  for (const stage of lists.funnelStages) {
    const raw = merged.funnelTargets[stage];
    funnelTargets[stage] = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  const clampPct = (n: number) =>
    Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
  const min = clampPct(merged.l0l1Conversion.min);
  const max = clampPct(merged.l0l1Conversion.max);

  // A stage left blank (an added stage nobody has set a threshold for yet)
  // stays untracked rather than being saved as 0 days — which would flag every
  // deal in it stale at once.
  const staleThresholds: Record<string, number> = {};
  for (const stage of lists.staleStages) {
    const raw = merged.staleThresholds[stage];
    if (raw == null) continue;
    staleThresholds[stage] = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  return {
    funnelTargets,
    // Guarantee a sane band even if the inputs are swapped.
    l0l1Conversion: { min: Math.min(min, max), max: Math.max(min, max) },
    staleThresholds,
  };
}

/** Human-readable summary of the stale thresholds, shown in the card header,
 * e.g. "L1: 7d · L2: 21d · L3: 45d". */
function formatStaleThresholdLabel(
  thresholds: Record<string, number>,
  lists: InsightsStageLists,
): string {
  return lists.staleStages
    .filter((stage) => thresholds[stage] != null)
    .map((stage) => `${stageCode(lists.stages, stage)}: ${thresholds[stage]}d`)
    .join(' · ');
}

/** The thresholds for the SLA-tracked stages only: a stage moved after L3 (or
 * deleted) keeps its stored threshold but stops being flagged stale. */
function staleThresholdsFor(
  thresholds: Record<string, number>,
  staleStages: readonly string[],
): Record<string, number> {
  const tracked: Record<string, number> = {};
  for (const stage of staleStages) {
    if (thresholds[stage] != null) tracked[stage] = thresholds[stage];
  }
  return tracked;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Compute days a deal has sat without activity, classify staleness, and sort
 * the overdue deals most-overdue first. A deal with no activity reference at
 * all is treated as the most stale (red, sorted first). */
function buildStaleDeals(
  candidates: StaleCandidate[],
  now: Date,
  thresholds: Record<string, number>,
  tracks: TrackLike[],
  captainStages: readonly string[],
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
        ...resolveLead(c, tracks, captainStages),
        leadLabel: dealLeadLabel(c.pipeline_stage, captainStages),
      },
    });
  }

  return scored.sort((a, b) => b.sortKey - a.sortKey).map((s) => s.deal);
}

/** Effective deal-lead for a stale candidate, mirroring `effectiveDealLead`:
 * the stored deal sponsor at L0–L2 / deal captain at L3+ (captain inheriting the
 * sponsor when unset), falling back to the matched Track's PIC(s). When the name
 * comes from the Track, `leadFromTrack` is set so the UI can suffix "(from
 * Track)". `leadName` is null when nothing resolves. */
function resolveLead(
  c: StaleCandidate,
  tracks: TrackLike[],
  captainStages: readonly string[],
): { leadName: string | null; leadFromTrack: boolean } {
  const field = dealLeadField(c.pipeline_stage, captainStages);
  const stored =
    field === 'deal_captain'
      ? c.deal_captain_name?.trim() || c.deal_sponsor_name?.trim()
      : c.deal_sponsor_name?.trim();
  if (stored) return { leadName: stored, leadFromTrack: false };

  const pics = matchedTrackPics(c, tracks);
  return pics.length > 0
    ? { leadName: pics.join(', '), leadFromTrack: true }
    : { leadName: null, leadFromTrack: false };
}

/** Response-time histogram bands, ascending. Each firm's median falls in the
 * first band whose exclusive upper bound (seconds) it is under. Log-ish spacing
 * so the typically log-normal response times form a bell-ish shape. */
const RESPONSE_TIME_BUCKETS: { label: string; maxSeconds: number }[] = [
  { label: '<1h', maxSeconds: 3600 },
  { label: '1–4h', maxSeconds: 4 * 3600 },
  { label: '4–12h', maxSeconds: 12 * 3600 },
  { label: '12–24h', maxSeconds: 86400 },
  { label: '1–2d', maxSeconds: 2 * 86400 },
  { label: '2–3d', maxSeconds: 3 * 86400 },
  { label: '3–5d', maxSeconds: 5 * 86400 },
  { label: '5–7d', maxSeconds: 7 * 86400 },
  { label: '7–14d', maxSeconds: 14 * 86400 },
  { label: '14d+', maxSeconds: Number.POSITIVE_INFINITY },
];

/** Bucket a firm's reply-gap seconds into the histogram bands for its sparkline.
 * Empty bands are kept so the shape reads correctly (a gap means "no replies
 * this fast/slow", not a missing band). */
function bucketResponseGaps(seconds: number[]): ResponseTimeBucket[] {
  const buckets = RESPONSE_TIME_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const s of seconds) {
    const idx = RESPONSE_TIME_BUCKETS.findIndex((b) => s < b.maxSeconds);
    buckets[idx === -1 ? buckets.length - 1 : idx].count += 1;
  }
  return buckets;
}

/** Attach each banker's response-time profile (median + distribution) to its
 * breakdown row, matching the free-text banker name to a firm by normalized
 * name. Rows with no matching email history keep a null median (rendered "—").
 * Non-banker breakdowns never call this, so their rows stay response-free. */
function attachResponseProfiles(
  rows: BreakdownRow[],
  profiles: { name: string; p50Seconds: number; pairCount: number; gaps: number[] }[],
): BreakdownRow[] {
  const byFirm = new Map(
    profiles.map((p) => [
      normalizeCompanyName(p.name),
      { p50Seconds: p.p50Seconds, buckets: bucketResponseGaps(p.gaps) },
    ]),
  );
  return rows.map((row) => {
    const match = byFirm.get(normalizeCompanyName(row.key));
    return match
      ? { ...row, responseP50Seconds: match.p50Seconds, responseBuckets: match.buckets }
      : { ...row, responseP50Seconds: null };
  });
}

/** Pivot `(key, stage)` counts into per-key rows and compute conversion.
 * `base` selects both the conversion denominator and the sort/display metric:
 * `l0` for segment/country tables (L1+ as a share of L0, sorted by L0 volume),
 * `total` for bankers (L1+ as a share of all leads, sorted by lead volume).
 * `limit` caps the returned rows (bankers keep a fixed top-N); omit it to
 * return every row (segment/country, which paginate client-side). */
function buildBreakdown(
  rows: DimensionStageCount[],
  base: 'l0' | 'total',
  limit?: number,
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

  const built = Array.from(byKey.entries())
    .map(([key, agg]) => ({
      key,
      l0: agg.l0,
      l1plus: agg.l1plus,
      total: agg.total,
      conversion: agg.total > 0 ? Math.round((agg.l1plus / agg.total) * 100) : 0,
    }))
    // Descending by the primary displayed metric so the visible lead column
    // reads biggest-first (L0 for segment/country, total leads for bankers).
    .sort((a, b) => (base === 'l0' ? b.l0 - a.l0 : b.total - a.total));

  return limit == null ? built : built.slice(0, limit);
}
