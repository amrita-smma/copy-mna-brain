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
