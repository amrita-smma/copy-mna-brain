import type {
  AiWorkforceQueueRepository,
  CompanyRepository,
  CompanyVoteRepository,
  InsightRepository,
} from '@/lib/repositories';

/** Why a company counts as the user's own. A company can match more than one. */
export type ProfileCompanyRole = 'sponsor' | 'captain' | 'assignee';

export interface ProfileCompanyItem {
  id: string;
  /** `target` when set, falling back to the code name, then a placeholder. */
  name: string;
  projectName: string | null;
  stage: string;
  geography: string | null;
  sector: string | null;
  roles: ProfileCompanyRole[];
  lastActivityAt: string | null;
}

export interface ProfileInsightItem {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  isFeatured: boolean;
}

/**
 * `approval` — an AI Workforce run paused on a HITL intervention this user can
 * decide. `vote` — a company vote round whose ballot they still owe.
 */
export type ProfileActionItemKind = 'approval' | 'vote';

export interface ProfileActionItem {
  /** Stable per kind: the run id for an approval, the ballot id for a vote. */
  id: string;
  kind: ProfileActionItemKind;
  title: string;
  subtitle: string | null;
  /** The vote deadline; approvals have none. */
  dueAt: string | null;
  createdAt: string | null;
  /** Set on a `vote` (and on an approval whose run names a company). */
  companyId: string | null;
  /** Set on an `approval` — the AI Workforce task to open. */
  taskId: string | null;
}

export interface ProfileSection<T> {
  items: T[];
  /** Total matching rows, which can exceed `items.length` (it is capped). */
  total: number;
}

export interface ProfileItems {
  companies: ProfileSection<ProfileCompanyItem>;
  insights: ProfileSection<ProfileInsightItem>;
  actionItems: ProfileSection<ProfileActionItem>;
}

export interface ProfileItemsOptions {
  /** Cards per section. Clamped to 1..50 by the service. */
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Everything the mobile profile page shows under "<name>'s items": the
 * companies the user owns, the insights they authored, and the decisions
 * waiting on them.
 *
 * Deliberately a fixed, small number of queries — six, regardless of how many
 * companies, insights, ballots or runs come back. Each repository call is
 * either a single batched read or a count; nothing here loops over a
 * collection issuing per-row lookups. Keep it that way: this endpoint is hit
 * on every profile tab open.
 */
export class ProfileService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly insightRepo: InsightRepository,
    private readonly voteRepo: CompanyVoteRepository,
    private readonly workforceRepo: AiWorkforceQueueRepository,
    private readonly workspaceId: string,
  ) {}

  async getMyItems(
    userId: string,
    options: ProfileItemsOptions = {},
  ): Promise<ProfileItems> {
    const limit = clampLimit(options.limit);

    // All six reads are independent — fire them together rather than awaiting
    // one section before starting the next.
    const [
      companyRows,
      companyTotal,
      insightRows,
      insightTotal,
      ballotRows,
      approvalRows,
    ] = await Promise.all([
      this.companyRepo.findOwnedByUser(userId, limit),
      this.companyRepo.countOwnedByUser(userId),
      this.insightRepo.findPageWithCreator(
        this.workspaceId,
        { createdBy: userId },
        { limit, offset: 0 },
      ),
      this.insightRepo.countByFilter(this.workspaceId, { createdBy: userId }),
      this.voteRepo.listOpenBallotsByVoter(userId, limit),
      this.workforceRepo.listAwaitingDecisionByUser(userId, limit),
    ]);

    const actionItems = [
      ...ballotRows.map(toVoteActionItem),
      ...approvalRows.map(toApprovalActionItem),
    ].sort(byUrgency);

    return {
      companies: {
        items: companyRows.map(toCompanyItem),
        total: companyTotal,
      },
      insights: {
        items: insightRows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          updatedAt: row.updated_at,
          isFeatured: row.is_featured,
        })),
        total: insightTotal,
      },
      // Both action-item reads are capped at `limit` each, so the merged list
      // is capped at the same number of cards; `total` reports what actually
      // came back rather than a second pair of COUNT queries for a number the
      // page only uses as a badge.
      actionItems: {
        items: actionItems.slice(0, limit),
        total: actionItems.length,
      },
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

type CompanyRow = Awaited<ReturnType<CompanyRepository['findOwnedByUser']>>[number];
type BallotRow = Awaited<
  ReturnType<CompanyVoteRepository['listOpenBallotsByVoter']>
>[number];
type WorkforceRow = Awaited<
  ReturnType<AiWorkforceQueueRepository['listAwaitingDecisionByUser']>
>[number];

function toCompanyItem(row: CompanyRow): ProfileCompanyItem {
  const roles: ProfileCompanyRole[] = [];
  // Most specific ownership first, so the card's lead badge is the meaningful
  // one when a company matches several.
  if (row.is_captain) roles.push('captain');
  if (row.is_sponsor) roles.push('sponsor');
  if (row.is_assignee) roles.push('assignee');
  return {
    id: row.id,
    name: row.target?.trim() || row.project_name?.trim() || 'Untitled company',
    projectName: row.project_name,
    stage: row.pipeline_stage,
    geography: row.geography,
    sector: row.segment,
    roles,
    lastActivityAt: row.last_activity_at ?? row.updated_at ?? null,
  };
}

function toVoteActionItem(row: BallotRow): ProfileActionItem {
  const company =
    row.company_target?.trim() || row.company_project_name?.trim() || 'a company';
  return {
    id: row.ballot_id,
    kind: 'vote',
    title: `Cast your vote on ${company}`,
    subtitle: 'Your ballot is still a draft',
    dueAt: row.deadline_at,
    createdAt: null,
    companyId: row.company_id,
    taskId: null,
  };
}

function toApprovalActionItem(row: WorkforceRow): ProfileActionItem {
  const toolName = row.pending_intervention?.tool_name ?? null;
  return {
    id: row.id,
    kind: 'approval',
    title: row.title?.trim() || `${row.agent_name} needs your approval`,
    subtitle: toolName ? `Waiting on ${toolName}` : 'Waiting for your decision',
    dueAt: null,
    createdAt: row.created_at,
    companyId: companyIdFromRun(row),
    taskId: row.id,
  };
}

/** The company an approval run is about, when its trigger names one. */
function companyIdFromRun(row: WorkforceRow): string | null {
  const value = row.trigger_meta?.company_id;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Soonest deadline first (a vote that closes today outranks one closing next
 * week), then the undated approvals newest-first behind them.
 */
function byUrgency(a: ProfileActionItem, b: ProfileActionItem): number {
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}
