import { UNREVIEWED_STAGE } from '@/lib/constants';
import { BUILTIN_PIPELINE_STAGE_KEYS, isInPipelineStage } from '@/lib/pipeline/stages';

/**
 * What the Pipeline page's stage filter is set to: every pipeline deal, the
 * Pending Confirmation bucket (`unreviewed` deals), or one stage key.
 * Serialised as the page's `?stage=` param.
 */
export type StageView = 'all' | 'pending' | (string & {});

/**
 * Resolve a `?stage=` param to a stage view. `unreviewed` is the stage's own
 * name for the pending bucket, so it is accepted as an alias; anything else
 * unknown — a deleted stage, or a missing param — falls back to every stage.
 */
export function parseStageView(
  raw: string | null | undefined,
  stageKeys: readonly string[] = BUILTIN_PIPELINE_STAGE_KEYS,
): StageView {
  if (raw === 'all' || raw === 'pending') return raw;
  if (raw === UNREVIEWED_STAGE) return 'pending';
  if (raw && stageKeys.includes(raw)) return raw;
  return 'all';
}

/** Whether a deal belongs in the given stage view. */
export function matchesStageView(
  company: { pipeline_stage: string | null; source: string | null },
  view: StageView,
): boolean {
  const stage = company.pipeline_stage;
  // Every pipeline stage, deleted ones included: a deal dropped at a stage
  // that has since been deleted still shows under All Stages. An `unreviewed`
  // deal of any source is awaiting triage, so it sits only in Pending
  // Confirmation.
  if (view === 'all') return isInPipelineStage(stage);
  if (view === 'pending') return stage === UNREVIEWED_STAGE;
  return stage === view;
}

/**
 * Whether a deal is in scope for a Pipeline search. A search ignores the stage
 * filter and looks through every pipeline stage plus Pending Confirmation.
 */
export function matchesSearchScope(company: {
  pipeline_stage: string | null;
  source: string | null;
}): boolean {
  return matchesStageView(company, 'all') || matchesStageView(company, 'pending');
}

/**
 * Short label for a deal's stage in a table cell: the stage's code (`L0`,
 * `L6`, …) via `code`, or `Pending`.
 */
export function stageCellLabel(
  stage: string | null | undefined,
  code: (key: string) => string = (key) => key,
): string {
  if (!stage) return '—';
  return stage === UNREVIEWED_STAGE ? 'Pending' : code(stage);
}

/** Sort rank for a deal's stage: Pending first, then the stages in pipeline order, then anything else. */
export function stageSortRank(
  stage: string | null | undefined,
  stageKeys: readonly string[] = BUILTIN_PIPELINE_STAGE_KEYS,
): number {
  if (stage === UNREVIEWED_STAGE) return 0;
  const index = stageKeys.indexOf(stage ?? '');
  return index === -1 ? stageKeys.length + 1 : index + 1;
}
