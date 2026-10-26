import type {
  CompanyLogRepository,
  DealContactRepository,
  PipelineStageRepository,
  PipelineStageRow,
} from '@/lib/repositories';
import type { DealContactRole } from '@/lib/db/schema';
import {
  BUILTIN_PIPELINE_STAGE_KEYS,
  FIRST_STAGE_KEY,
  PRE_PIPELINE_STAGES,
} from '@/lib/pipeline/stages';
import { dealStageLabeler } from './dealContactService';
import { parseStageDestination } from './stalledDealService';

/** A banker's deals in one role, by the furthest stage each one reached. */
export interface BankerStageCount {
  stageKey: string;
  /** How the stage reads in this workspace: "L1 · Screening", "Pending Confirmation". */
  label: string;
  count: number;
  /** Those deals sitting in this stage now and not dropped (`companies.pipeline_stage`). */
  currentCount: number;
}

/**
 * One banker's (one person's, never a firm's) deal scorecard (MB-857).
 * Built from active `deal_contacts` links only.
 */
export interface BankerScorecard {
  correspondentId: string;
  /** Active links with role `source`. */
  dealsBrought: number;
  /** Active links with role `involved`. */
  dealsInvolved: number;
  /** Deals brought whose furthest stage is positioned after L0 (dropped ones included). */
  reachedL1: number;
  /** `reachedL1 / dealsBrought`; `null` when nothing was brought — never 0. */
  conversion: number | null;
  /**
   * Deals brought, grouped by furthest stage, in pipeline order (pre-pipeline
   * first). Once anything was brought, every live pipeline stage is listed,
   * zero when no deal stopped there, so a funnel never skips a stage; a
   * pre-pipeline or deleted stage appears only when a deal sits on it.
   */
  stageBreakdown: BankerStageCount[];
  /**
   * The same breakdown for the deals the banker was involved in (`involved`
   * links), for the Deal funnel's Involved mode. Never feeds `reachedL1` or
   * `conversion`, which stay about deals brought.
   */
  involvedStageBreakdown: BankerStageCount[];
  /** Whether the banker has any active link (either role) in the period. */
  hasDealLinks: boolean;
}

export interface GetScorecardsOptions {
  /**
   * ISO timestamp: only deals whose company entered Brain
   * (`companies.created_at`) at or after it. All time when absent.
   */
  since?: string;
}

/** A log row as {@link CompanyLogRepository.findByCompanyIds} returns it. */
interface StageLogRow {
  company_id: string | null;
  action: string | null;
}

/**
 * Pre-pipeline buckets rank below L0, in this order (closest to L0 last):
 * graph discoveries, AI market screening, Pending Confirmation.
 */
const PRE_PIPELINE_ORDER = ['discovered', 'market_screening', 'unreviewed'] as const;

/** Orders stage keys for one workspace. */
export interface StageRanker {
  /** Higher = further along; `null` for a key that is neither a stage nor pre-pipeline. */
  rankOf(stageKey: string | null | undefined): number | null;
  /** Whether the stage is a pipeline stage positioned after L0. */
  isPastFirstStage(stageKey: string | null | undefined): boolean;
}

/**
 * Rank stage keys by `pipeline_stages.position` for the workspace, soft-deleted
 * stages included (a dropped deal may sit on a deleted stage). Pre-pipeline
 * buckets rank below every stage. Without any stage rows, the six original
 * stages in order stand in.
 */
export function buildStageRanker(rows: readonly PipelineStageRow[]): StageRanker {
  const positions = new Map<string, number>();
  if (rows.length > 0) {
    for (const r of rows) positions.set(r.key, r.position);
  } else {
    BUILTIN_PIPELINE_STAGE_KEYS.forEach((key, i) => positions.set(key, i));
  }
  const minPosition = Math.min(...positions.values());
  const preRank = new Map<string, number>(
    PRE_PIPELINE_ORDER.map((key, i) => [key, minPosition - (PRE_PIPELINE_ORDER.length - i)]),
  );
  const rankOf = (stageKey: string | null | undefined): number | null => {
    if (!stageKey) return null;
    const position = positions.get(stageKey);
    if (position !== undefined) return position;
    if (PRE_PIPELINE_STAGES.has(stageKey)) return preRank.get(stageKey) ?? minPosition - 1;
    return null;
  };
  // L0 cannot be deleted, and the built-in stages include it.
  const firstRank = positions.get(FIRST_STAGE_KEY)!;
  return {
    rankOf,
    isPastFirstStage(stageKey) {
      const position = stageKey ? positions.get(stageKey) : undefined;
      return position !== undefined && position > firstRank;
    },
  };
}

/**
 * Every stage a company's logs show it in: both ends of a stage move (a
 * demotion `PROMOTED_FROM_L2_TO_L1` proves it was at L2) and the stage a drop
 * left from.
 */
export function stagesInLogs(actions: ReadonlyArray<string | null>): string[] {
  const stages: string[] = [];
  for (const action of actions) {
    const { from, to } = parseStageDestination(action);
    if (from) stages.push(from);
    if (to) stages.push(to);
    const dropped = action?.match(/^DROPPED_FROM_(.+)$/);
    if (dropped) stages.push(dropped[1]);
  }
  return stages;
}

/**
 * The highest-ranked stage a deal has ever been in: its current stage plus
 * every stage its logs show. Keys the ranker cannot place are ignored; when
 * none can be placed, the current stage stands.
 */
export function furthestStage(
  currentStage: string,
  logActions: ReadonlyArray<string | null>,
  ranker: StageRanker,
): string {
  let best = currentStage;
  let bestRank = ranker.rankOf(currentStage);
  for (const stage of stagesInLogs(logActions)) {
    const rank = ranker.rankOf(stage);
    if (rank === null) continue;
    if (bestRank === null || rank > bestRank) {
      best = stage;
      bestRank = rank;
    }
  }
  return best;
}

/** A scorecard with no links: zero counts, null conversion. */
function emptyBankerScorecard(correspondentId: string): BankerScorecard {
  return {
    correspondentId,
    dealsBrought: 0,
    dealsInvolved: 0,
    reachedL1: 0,
    conversion: null,
    stageBreakdown: [],
    involvedStageBreakdown: [],
    hasDealLinks: false,
  };
}

/** One contact's deals in one role: count by furthest stage, live count by current stage. */
interface StageTally {
  byStage: Map<string, number>;
  current: Map<string, number>;
}

/**
 * Per-banker deal scorecards (MB-857): deals brought (`source`) and involved
 * in, how far each deal got (per role), and how many brought passed
 * screening. Bulk — a fixed number of queries for any number of bankers: one
 * link read, one log read, one stage-list read. Reads only: callers that want late Smart
 * Files links counted reconcile them first.
 */
export class BankerScorecardService {
  constructor(
    private readonly dealContactRepo: DealContactRepository,
    private readonly companyLogRepo: CompanyLogRepository,
    private readonly stageRepo: PipelineStageRepository,
    private readonly workspaceId: string,
  ) {}

  /** One scorecard per requested contact (an empty one for a contact with no links). */
  async getScorecards(
    correspondentIds: string[],
    { since }: GetScorecardsOptions = {},
  ): Promise<Map<string, BankerScorecard>> {
    const ids = [...new Set(correspondentIds)];
    const scorecards = new Map<string, BankerScorecard>();
    if (ids.length === 0) return scorecards;

    const [links, stageRows] = await Promise.all([
      this.dealContactRepo.listForContacts(this.workspaceId, ids, since ? { since } : {}),
      this.stageRepo.list(),
    ]);
    const active = links.filter((l) => l.status === 'active');
    const linkedCompanyIds = [...new Set(active.map((l) => l.companyId))];
    const logs: StageLogRow[] =
      linkedCompanyIds.length > 0 ? await this.companyLogRepo.findByCompanyIds(linkedCompanyIds) : [];

    const actionsByCompany = new Map<string, Array<string | null>>();
    for (const log of logs) {
      if (!log.company_id) continue;
      const bucket = actionsByCompany.get(log.company_id);
      if (bucket) bucket.push(log.action);
      else actionsByCompany.set(log.company_id, [log.action]);
    }

    const ranker = buildStageRanker(stageRows);
    const liveStageKeys =
      stageRows.length > 0
        ? stageRows.filter((r) => !r.deleted_at).map((r) => r.key)
        : [...BUILTIN_PIPELINE_STAGE_KEYS];
    const labelOf = dealStageLabeler(stageRows);
    const furthestByCompany = new Map<string, string>();
    for (const l of active) {
      if (furthestByCompany.has(l.companyId)) continue;
      furthestByCompany.set(
        l.companyId,
        furthestStage(l.pipelineStage, actionsByCompany.get(l.companyId) ?? [], ranker),
      );
    }

    for (const id of ids) scorecards.set(id, emptyBankerScorecard(id));
    // Per role, per contact: deals by furthest stage, and live deals by where they sit now.
    const tallies: Record<DealContactRole, Map<string, StageTally>> = {
      source: new Map(),
      involved: new Map(),
    };
    for (const l of active) {
      const card = scorecards.get(l.correspondentId);
      if (!card) continue;
      card.hasDealLinks = true;
      const stage = furthestByCompany.get(l.companyId) ?? l.pipelineStage;
      if (l.role === 'source') {
        card.dealsBrought += 1;
        if (ranker.isPastFirstStage(stage)) card.reachedL1 += 1;
      } else {
        card.dealsInvolved += 1;
      }
      let tally = tallies[l.role].get(l.correspondentId);
      if (!tally) {
        tally = { byStage: new Map(), current: new Map() };
        tallies[l.role].set(l.correspondentId, tally);
      }
      tally.byStage.set(stage, (tally.byStage.get(stage) ?? 0) + 1);
      if (l.companyStatus !== 'dropped') {
        tally.current.set(l.pipelineStage, (tally.current.get(l.pipelineStage) ?? 0) + 1);
      }
    }

    const toBreakdown = (tally: StageTally | undefined): BankerStageCount[] => {
      if (!tally) return [];
      for (const key of liveStageKeys) if (!tally.byStage.has(key)) tally.byStage.set(key, 0);
      // A current stage that is no deal's furthest stage gets no row of its own.
      return [...tally.byStage.entries()]
        .map(([stageKey, count]) => ({
          stageKey,
          label: labelOf(stageKey),
          count,
          currentCount: tally.current.get(stageKey) ?? 0,
        }))
        .sort(
          (a, b) =>
            (ranker.rankOf(a.stageKey) ?? Number.NEGATIVE_INFINITY) -
              (ranker.rankOf(b.stageKey) ?? Number.NEGATIVE_INFINITY) ||
            a.stageKey.localeCompare(b.stageKey),
        );
    };
    for (const card of scorecards.values()) {
      card.conversion = card.dealsBrought > 0 ? card.reachedL1 / card.dealsBrought : null;
      card.stageBreakdown = toBreakdown(tallies.source.get(card.correspondentId));
      card.involvedStageBreakdown = toBreakdown(tallies.involved.get(card.correspondentId));
    }
    return scorecards;
  }
}
