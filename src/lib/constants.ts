import type { analysisJobStatus } from './db/schema';
import type { DealStage } from './types';

export const ANALYSIS_JOB_STATUS = ['pending', 'processing', 'completed', 'failed'] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUS)[number];

// Compile-time guard: fails to typecheck if ANALYSIS_JOB_STATUS drifts from the
// Drizzle pgEnum in db/schema.ts. Type-only import keeps drizzle out of the client bundle.
type _AssertAnalysisJobStatusMatchesSchema =
  (typeof analysisJobStatus.enumValues)[number] extends AnalysisJobStatus
    ? AnalysisJobStatus extends (typeof analysisJobStatus.enumValues)[number]
      ? true
      : never
    : never;
const _analysisJobStatusCheck: _AssertAnalysisJobStatusMatchesSchema = true;
void _analysisJobStatusCheck;

export const ANALYSIS_IN_PROGRESS_STATUSES: readonly AnalysisJobStatus[] = ['pending', 'processing'];
export const isAnalysisInProgress = (status: AnalysisJobStatus | null | undefined): boolean =>
  status != null && ANALYSIS_IN_PROGRESS_STATUSES.includes(status);

/** Ordered pipeline stages (excludes market_screening). Source of truth for promote/demote navigation. */
export const PIPELINE_STAGES: DealStage[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/**
 * Which way a stage move travels along the pipeline.
 *
 * One code path (`CompanyService.promote`) serves both directions, so the
 * telemetry it emits has to work the direction out from the stages themselves.
 * Stages outside `PIPELINE_STAGES` (`market_screening`, `unreviewed`,
 * `discovered`, or an absent current stage) rank below L0, so entering the
 * pipeline always reads as a promotion.
 */
export function stageMoveDirection(
  currentStage: string | undefined | null,
  nextStage: string,
): 'promote' | 'demote' {
  const rank = (stage: string | undefined | null) =>
    stage ? PIPELINE_STAGES.indexOf(stage as DealStage) : -1;
  return rank(nextStage) < rank(currentStage) ? 'demote' : 'promote';
}

/**
 * The pre-pipeline bucket a deal sits in before anyone has triaged it — the
 * Pipeline's "Inbound Pending Review" sub-tab. Demoting out of L0 sends a deal
 * back here rather than nowhere (L0 is the first committed pipeline stage, so
 * there is no L-minus-one to step back to).
 */
export const UNREVIEWED_STAGE: DealStage = 'unreviewed';

/**
 * Stage a deal moves to when promoted one step, or `null` when there is
 * nowhere further to go (L5, or a stage outside the promote/demote ladder).
 *
 * `unreviewed` sits one rung below L0, so a pending-review deal promotes into
 * L0 — not into L1, which is what reading the *table's* stage instead of the
 * *row's* stage would suggest.
 */
export function promoteTargetForStage(
  stage: string | undefined | null,
): DealStage | null {
  if (stage === UNREVIEWED_STAGE) return PIPELINE_STAGES[0];
  const index = stage ? PIPELINE_STAGES.indexOf(stage as DealStage) : -1;
  if (index < 0 || index >= PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[index + 1];
}

/**
 * Stage a deal moves to when demoted one step, or `null` when there is nowhere
 * to fall back to.
 *
 * L0 demotes out of the committed pipeline and back to `unreviewed` ("Inbound
 * Pending Review"). That only makes sense for inbound-sourced deals — the
 * Pending Review section is inbound-only, so an outbound deal demoted out of
 * L0 would have no visible home. Outbound callers pass
 * `demoteL0ToReview: false` and get `null` at L0, i.e. no demote action.
 */
export function demoteTargetForStage(
  stage: string | undefined | null,
  opts?: { demoteL0ToReview?: boolean },
): DealStage | null {
  const index = stage ? PIPELINE_STAGES.indexOf(stage as DealStage) : -1;
  if (index < 0) return null;
  if (index === 0) {
    return opts?.demoteL0ToReview ? UNREVIEWED_STAGE : null;
  }
  return PIPELINE_STAGES[index - 1];
}

/**
 * How a stage is named in promote/demote copy ("Demote to ..."). Pipeline
 * stages are referred to by their bare L-code everywhere in that flow; only
 * `unreviewed` needs spelling out, since "Demote to unreviewed" doesn't point
 * at the section the deal actually lands in.
 */
export function stageMoveLabel(stage: string | undefined | null): string {
  if (!stage) return '';
  return stage === UNREVIEWED_STAGE ? 'Inbound Pending Review' : stage;
}

/**
 * Stage given to companies the relationship-graph tooling auto-creates as one
 * side of an edge. They sit outside the L0–L5 pipeline and get their own
 * Master Data section.
 */
export const DISCOVERED_STAGE: DealStage = 'discovered';

/**
 * Possible "Origin" values for a deal — i.e. the document/source the company
 * was sourced from. Stored on `companies.doc_type` (plain text, constrained in
 * the UI only). Used by the Pipeline "Origin" filter and elsewhere.
 */
export const DOC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'teaser', label: 'Teaser' },
  { value: 'im', label: 'Information Memorandum' },
  { value: 'prospectus', label: 'Prospectus' },
  { value: 'mom', label: 'MOM' },
  { value: 'financial_model', label: 'Financial Model' },
  { value: 'financial_statement', label: 'Financial Statement' },
  { value: 'shopping_list', label: 'Shopping List' },
  { value: 'market_study', label: 'Market Study' },
  { value: 'market_research', label: 'Market Research' },
  { value: 'ai_screening', label: 'AI Screening' },
];

/**
 * Ownership / shareholding structures a target can have. Stored on
 * `companies.ownership` (plain text, constrained in the UI only). Shared by the
 * Company Information cards and the Overview slide's Shareholding line so the
 * three surfaces can't drift apart.
 */
export const OWNERSHIP_OPTIONS = [
  'Public',
  'Private',
  'Private Equity',
  'Venture Capital',
  'Family Owned',
  'Subsidiary',
] as const;

/**
 * Fixed IDs for the tenancy seed data. Hardcoded (not `defaultRandom()`) so
 * staging, prod, and dev always agree on the same workspace/role rows across
 * independently-applied migrations. See `drizzle/migrations/*_add_workspace_tables.sql`.
 */
export const MNA_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
export const ROLE_ADMIN_ID = '00000000-0000-0000-0000-000000000101';
export const ROLE_EDITOR_ID = '00000000-0000-0000-0000-000000000102';
export const ROLE_VIEWER_ID = '00000000-0000-0000-0000-000000000103';

/**
 * The nil UUID — deliberately guaranteed to never match a real `workspaces.id`
 * row (every real workspace id is `gen_random_uuid()`). Returned by
 * `getActiveWorkspaceId()` for a logged-in user with no active workspace
 * (unassigned new user, or a superadmin with no membership), so
 * workspace-scoped reads come back empty and workspace-scoped writes fail the
 * `workspace_id` foreign key — instead of silently falling back to another
 * tenant's data. Distinct from `MNA_WORKSPACE_ID`, which is reserved for
 * non-request code paths (jobs, cron, dispatcher) that have no session at all.
 */
export const NO_ACTIVE_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

export const STAGE_LABELS: Record<DealStage | 'Acquired', string> = {
  market_screening: 'Market Scanning',
  unreviewed: 'Unreviewed',
  L0: 'Sourcing',
  L1: 'Screening',
  L2: 'Initial Review',
  L3: 'Due Diligence',
  L4: 'Negotiation',
  L5: 'Closing',
  discovered: 'Discovered',
  Acquired: 'Acquired',
};
