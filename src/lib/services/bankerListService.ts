import {
  BANKER_LIST_SORTS,
  type BankerListRepository,
  type BankerListSort,
  type ContactInteractionRepository,
  type DealContactRepository,
  type PipelineStageRepository,
  type PipelineStageRow,
} from '@/lib/repositories';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { lastContactAfter, lastContactBefore } from '@/lib/crm/lastContactRange';
import { BUILTIN_PIPELINE_STAGE_KEYS } from '@/lib/pipeline/stages';
import { isUuid } from '@/lib/uuid';
import { buildStageRanker } from './bankerScorecardService';
import { teamsByContact } from './contactInsightsService';

export const BANKER_LIST_DEFAULT_PAGE_SIZE = 25;
export const BANKER_LIST_MAX_PAGE_SIZE = 100;
/** "Active in last 30 days". */
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Team members shown per row; the rest is "+N". */
const TOP_TEAM_MEMBERS = 3;

export class InvalidBankerListSortError extends Error {
  constructor(sort: string) {
    super(`Invalid sort "${sort}". Expected one of: ${BANKER_LIST_SORTS.join(', ')}`);
    this.name = 'InvalidBankerListSortError';
  }
}

/** Raw list parameters, as the route reads them from the query string. */
export interface BankerListParams {
  q?: string | null;
  sort?: string | null;
  /** A `LastContactFilter` preset, applied to the PERSON's last contact. */
  lastContact?: string | null;
  customDate?: string | null;
  clientTodayIso?: string | null;
  teamUserIds?: string[];
  hasDeals?: boolean;
  active30?: boolean;
  page?: number | null;
  pageSize?: number | null;
}

export interface BankerTeamMember {
  userId: string;
  name: string | null;
  /** Emails both ways with this person. */
  total: number;
}

/** One person on the banker list. Counts are meaningful only when `hasSyncedData`. */
export interface BankerRow {
  correspondentId: string;
  name: string;
  email: string | null;
  title: string | null;
  firm: { employerId: string; name: string };
  lastContactAt: string | null;
  totals: { emailsFromUs: number; emailsFromThem: number };
  teamMemberCount: number;
  /** Up to three, most interactions first. */
  topTeamMembers: BankerTeamMember[];
  dealsBrought: number;
  dealsInvolved: number;
  reachedL1: number;
  /** `reachedL1 / dealsBrought`; null when nothing was brought. */
  conversion: number | null;
}

export interface BankerListResult {
  rows: BankerRow[];
  /** Bankers matching the filters, all pages. */
  total: number;
  /** Bankers visible in the workspace before filtering. */
  totalUnfiltered: number;
  /** The sort actually applied (`reached_l1` falls back to `recent` without deal links). */
  sort: BankerListSort;
  page: number;
  pageSize: number;
  /** Whether the workspace has any active deal link (greys out the L1 sort). */
  hasDealLinks: boolean;
  /** Whether any email is synced for the workspace ("—" vs 0). */
  hasSyncedData: boolean;
}

function isSort(value: string): value is BankerListSort {
  return (BANKER_LIST_SORTS as readonly string[]).includes(value);
}

function clampInt(value: number | null | undefined, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** The later of two optional ISO lower bounds: both must hold. */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Stage keys positioned after L0 for the workspace, by the same ranker the
 * banker scorecard uses (soft-deleted stages included; the built-in six stand
 * in when the workspace has no stage rows). Pre-pipeline buckets never qualify.
 */
export function pastFirstStageKeys(rows: readonly PipelineStageRow[]): string[] {
  const ranker = buildStageRanker(rows);
  const keys = rows.length > 0 ? rows.map((r) => r.key) : [...BUILTIN_PIPELINE_STAGE_KEYS];
  return [...new Set(keys)].filter((key) => ranker.isPastFirstStage(key));
}

/**
 * The person-level banker list (MB-858; Brain Bots, and the CRM Bankers view
 * behind `CRM_BANKERS_VIEW_ENABLED`): every person the workspace can see, with
 * emails, team, deals brought and reached L1, sorted / filtered /
 * paginated in SQL. A fixed number of queries per page, all reads: one stage
 * list, the page, two counts, two flags, and one bulk read of the page's
 * team rows (`mart_contact_interactions`). It never reconciles late Smart
 * Files links (a write on every read); the daily `crm-suggested-questions`
 * cron does that per workspace.
 */
export class BankerListService {
  constructor(
    private readonly bankerListRepo: BankerListRepository,
    private readonly interactionRepo: ContactInteractionRepository,
    private readonly dealContactRepo: DealContactRepository,
    private readonly stageRepo: PipelineStageRepository,
    private readonly workspaceId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listBankers(params: BankerListParams = {}): Promise<BankerListResult> {
    const requestedSort = params.sort?.trim() || 'recent';
    if (!isSort(requestedSort)) throw new InvalidBankerListSortError(requestedSort);
    const pageSize = clampInt(
      params.pageSize,
      BANKER_LIST_DEFAULT_PAGE_SIZE,
      1,
      BANKER_LIST_MAX_PAGE_SIZE,
    );
    const page = clampInt(params.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const nowMs = this.now().getTime();

    const [stageRows, hasDealLinks, hasSyncedData, totalUnfiltered] = await Promise.all([
      this.stageRepo.list(),
      this.dealContactRepo.hasActiveLinks(this.workspaceId),
      this.interactionRepo.workspaceHasSyncedData(this.workspaceId),
      this.bankerListRepo.countVisible(this.workspaceId),
    ]);
    const sort: BankerListSort =
      requestedSort === 'reached_l1' && !hasDealLinks ? 'recent' : requestedSort;

    const query = {
      search: params.q?.trim() || undefined,
      sort,
      // "Active in last 30 days" is a second lower bound on the same last contact.
      lastContactAfter: laterOf(
        lastContactAfter(
          params.lastContact ?? null,
          params.customDate ?? null,
          params.clientTodayIso ?? null,
          nowMs,
        ),
        params.active30 ? new Date(nowMs - ACTIVE_WINDOW_MS).toISOString() : undefined,
      ),
      lastContactBefore: lastContactBefore(params.lastContact ?? null, nowMs),
      teamUserIds: (params.teamUserIds ?? []).filter(isUuid),
      hasDeals: params.hasDeals === true,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      pastFirstStageKeys: pastFirstStageKeys(stageRows),
    };

    const [rows, total] = await Promise.all([
      this.bankerListRepo.list(this.workspaceId, query),
      this.bankerListRepo.count(this.workspaceId, query),
    ]);
    const teams = teamsByContact(
      await this.interactionRepo.listEmailInteractions(
        this.workspaceId,
        rows.map((r) => r.correspondentId),
      ),
    );

    return {
      rows: rows.map((r) => ({
        correspondentId: r.correspondentId,
        // Stored CRM text can carry ingest's HTML entities (`&amp;`).
        name: decodeHtmlEntities(r.name),
        email: r.email,
        title: decodeHtmlEntities(r.title),
        firm: { employerId: r.employerId, name: decodeHtmlEntities(r.employerName) },
        lastContactAt: r.lastContactAt,
        totals: {
          emailsFromUs: r.emailsFromUs,
          emailsFromThem: r.emailsFromThem,
        },
        teamMemberCount: r.teamMemberCount,
        topTeamMembers: (teams.get(r.correspondentId) ?? [])
          .slice(0, TOP_TEAM_MEMBERS)
          .map((t) => ({
            userId: t.userId,
            // Already decoded by teamsByContact.
            name: t.name ?? t.email,
            total: t.emailsFromUs + t.emailsFromThem,
          })),
        dealsBrought: r.dealsBrought,
        dealsInvolved: r.dealsInvolved,
        reachedL1: r.reachedL1,
        conversion: r.dealsBrought > 0 ? r.reachedL1 / r.dealsBrought : null,
      })),
      total,
      totalUnfiltered,
      sort,
      page,
      pageSize,
      hasDealLinks,
      hasSyncedData,
    };
  }
}
