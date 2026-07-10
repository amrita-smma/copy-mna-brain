import type {
  CompanyLogRepository,
  CompanyRepository,
} from '@/lib/repositories';
import { PIPELINE_STAGES } from '@/lib/constants';

/** One stage transition on a deal's timeline, newest-last. */
export interface StageTimelineEvent {
  /** Destination stage the deal moved into. */
  stage: string;
  /** Origin stage, when the log records it (null for from-less promotions). */
  fromStage: string | null;
  /** When the move happened (ISO-8601). */
  enteredAt: string;
  /** Raw `company_logs.action` this event was derived from. */
  action: string;
}

/** Per-company stalled analysis. */
export interface StalledDealAnalysis {
  companyId: string;
  target: string | null;
  projectName: string | null;
  segment: string | null;
  geography: string | null;
  currentStage: string | null;
  status: string | null;
  /** When the deal entered its CURRENT stage. */
  enteredStageAt: string | null;
  /** Whether `enteredStageAt` came from a stage-move log or the created_at fallback. */
  enteredStageBasis: 'log' | 'created_at';
  /** Whole days spent in the current stage as of the analysis time. */
  daysInStage: number;
  /** True when `daysInStage >= thresholdDays`. */
  isStalled: boolean;
  /** Chronological stage transitions (oldest first). */
  timeline: StageTimelineEvent[];
}

export interface StalledDealsReport {
  /** Analysis reference time (ISO-8601). */
  asOf: string;
  /** Days-in-stage cutoff used to flag a deal as stalled. */
  thresholdDays: number;
  /** Number of active deals inspected. */
  totalActive: number;
  /** Number of those flagged as stalled. */
  stalledCount: number;
  /** Every active deal, sorted by daysInStage descending. */
  deals: StalledDealAnalysis[];
}

export interface GetStalledDealsOptions {
  /** Reference "today". Defaults to now. */
  asOf?: Date;
  /** Stalled cutoff in days. Defaults to 14 (2 weeks). */
  thresholdDays?: number;
  /** Restrict to a single pipeline stage (L0–L5). */
  stage?: string;
}

/** A minimal log row shape both repo variants satisfy. */
type LogRow = {
  action: string | null;
  created_at: string | null;
  company_id?: string | null;
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DEFAULT_THRESHOLD_DAYS = 14;

/**
 * Extract the from/to pipeline stages a `company_logs.action` records. Handles
 * every action that moves a deal between stages: promotions
 * (`PROMOTED_FROM_X_TO_Y`, `PROMOTED_TO_Y`), restores (`RESTORED_TO_Y`), and
 * resurfaces (`RESURFACED_TO_Y`). Any other action (creation markers, drops,
 * slide/note events) yields `{ from: null, to: null }`.
 */
export function parseStageDestination(action: string | null): {
  from: string | null;
  to: string | null;
} {
  if (!action) return { from: null, to: null };
  const fromTo = action.match(/^PROMOTED_FROM_(.+)_TO_(.+)$/);
  if (fromTo) return { from: fromTo[1], to: fromTo[2] };
  const toOnly = action.match(/^(?:PROMOTED|RESTORED|RESURFACED)_TO_(.+)$/);
  if (toOnly) return { from: null, to: toOnly[1] };
  return { from: null, to: null };
}

/**
 * Build a chronological list of stage transitions from a company's logs. Logs
 * are expected oldest-first; only entries that actually move the deal into a
 * stage (and carry a timestamp) become timeline events.
 */
export function buildStageTimeline(logs: LogRow[]): StageTimelineEvent[] {
  const events: StageTimelineEvent[] = [];
  for (const log of logs) {
    if (!log.created_at) continue;
    const { from, to } = parseStageDestination(log.action);
    if (!to) continue;
    events.push({
      stage: to,
      fromStage: from,
      enteredAt: log.created_at,
      action: log.action as string,
    });
  }
  return events;
}

/**
 * Determine when a deal entered its CURRENT stage: the most recent stage-move
 * log whose destination equals `currentStage`. Falls back to the company's
 * `created_at` when no such log exists (e.g. a deal created directly at its
 * stage with no subsequent promotion).
 */
export function computeStageEnteredAt(
  logs: LogRow[],
  currentStage: string | null,
  createdAt: string | null,
): { enteredAt: string | null; basis: 'log' | 'created_at' } {
  if (currentStage) {
    // Logs are oldest-first; scan from the end for the latest matching move.
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (!log.created_at) continue;
      const { to } = parseStageDestination(log.action);
      if (to === currentStage) {
        return { enteredAt: log.created_at, basis: 'log' };
      }
    }
  }
  return { enteredAt: createdAt, basis: 'created_at' };
}

/** Whole days from `from` to `to` (floored, never negative). */
export function daysBetween(from: string | null, to: Date): number {
  if (!from) return 0;
  const fromMs = new Date(from).getTime();
  if (Number.isNaN(fromMs)) return 0;
  const diff = to.getTime() - fromMs;
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

/**
 * Analyses how long each active deal has sat in its current pipeline stage and
 * flags the ones that have stalled (default: 2 weeks in a stage). Pure data
 * access is delegated to the repositories; the stage-timeline reconstruction
 * and stalled classification live here.
 */
export class StalledDealService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly companyLogRepo: CompanyLogRepository,
  ) {}

  async getStalledDeals(
    opts: GetStalledDealsOptions = {},
  ): Promise<StalledDealsReport> {
    const asOf = opts.asOf ?? new Date();
    const thresholdDays = opts.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;

    const companies = await this.companyRepo.findForAgentStats({
      status: 'active',
      stage: opts.stage,
      // Absent an explicit stage, scope to the committed L0–L5 funnel.
      stageIn: opts.stage ? undefined : [...PIPELINE_STAGES],
    });

    // Bulk-fetch logs for the whole cohort, then group by company.
    const logsByCompany = new Map<string, LogRow[]>();
    if (companies.length > 0) {
      const logs = await this.companyLogRepo.findByCompanyIds(
        companies.map((c) => c.id),
      );
      for (const log of logs) {
        if (!log.company_id) continue;
        const bucket = logsByCompany.get(log.company_id);
        if (bucket) bucket.push(log);
        else logsByCompany.set(log.company_id, [log]);
      }
    }

    const deals: StalledDealAnalysis[] = companies.map((c) => {
      const logs = logsByCompany.get(c.id) ?? [];
      const { enteredAt, basis } = computeStageEnteredAt(
        logs,
        c.pipeline_stage ?? null,
        c.created_at ?? null,
      );
      const daysInStage = daysBetween(enteredAt, asOf);
      return {
        companyId: c.id,
        target: c.target ?? null,
        projectName: c.project_name ?? null,
        segment: c.segment ?? null,
        geography: c.geography ?? null,
        currentStage: c.pipeline_stage ?? null,
        status: c.status ?? null,
        enteredStageAt: enteredAt,
        enteredStageBasis: basis,
        daysInStage,
        isStalled: daysInStage >= thresholdDays,
        timeline: buildStageTimeline(logs),
      };
    });

    deals.sort((a, b) => b.daysInStage - a.daysInStage);

    return {
      asOf: asOf.toISOString(),
      thresholdDays,
      totalActive: deals.length,
      stalledCount: deals.filter((d) => d.isStalled).length,
      deals,
    };
  }
}
