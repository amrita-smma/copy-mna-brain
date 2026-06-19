import type { analysisJobStatus } from './db/schema';
import type { DealStage } from './types';

/** Clickable suggestions shown below "Search companies or sectors..." inputs */
export const SEARCH_SUGGESTION_CHIPS = ['Semiconductor', 'Petrochemical', 'Daejoo', 'Wanhua'] as const;

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
 * Stage given to companies the relationship-graph tooling auto-creates as one
 * side of an edge. They sit outside the L0–L5 pipeline and get their own
 * Master Data section.
 */
export const DISCOVERED_STAGE: DealStage = 'discovered';

export const STAGE_LABELS: Record<DealStage | 'Acquired', string> = {
  market_screening: 'Market Scanning',
  L0: 'Sourcing',
  L1: 'Screening',
  L2: 'Initial Review',
  L3: 'Due Diligence',
  L4: 'Negotiation',
  L5: 'Closing',
  discovered: 'Discovered',
  Acquired: 'Acquired',
};
