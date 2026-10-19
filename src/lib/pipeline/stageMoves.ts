/**
 * The stage ladder an agent walks when it moves a company: Pending
 * Confirmation, then the workspace's live pipeline stages in order. Shared by
 * the workforce `lookup_pipeline_stage` and `move_stage` tools so the stage the
 * lookup calls "next" is exactly the one the move accepts.
 *
 * Pure and dependency-free (like ./stages) so it can be unit tested without a
 * database and reused client-side if a view ever needs it.
 *
 * Rules:
 *   - A move is one rung at a time — to the previous or the next rung — so an
 *     agent can never skip review stages.
 *   - A company in an intake bucket (`market_screening`, `discovered`) or with
 *     no stage may enter at Pending Confirmation or directly at L0.
 *   - A company sitting in a deleted stage is placed by that stage's position:
 *     it may move to the live rung on either side of where the stage stood.
 *   - A move into or out of any stage after L0 needs a human's approval; moves
 *     among the intake buckets, Pending Confirmation and L0 do not.
 */
import {
  FIRST_STAGE_KEY,
  PRE_PIPELINE_STAGES,
  findStage,
  isInPipelineStage,
  liveStages,
  type PipelineStageDef,
} from './stages';

/** Pending Confirmation — the triage bucket in front of L0. */
export const PENDING_CONFIRMATION_KEY = 'unreviewed';
export const PENDING_CONFIRMATION_LABEL = 'Pending Confirmation';

export interface StageRung {
  key: string;
  /** Code users see ("L3"); empty for Pending Confirmation, which has none. */
  code: string;
  name: string;
}

export interface StageNeighbors {
  previous: StageRung | null;
  next: StageRung | null;
  /** Every stage a single move may target from here, in ladder order. */
  targets: StageRung[];
}

const PENDING_RUNG: StageRung = {
  key: PENDING_CONFIRMATION_KEY,
  code: '',
  name: PENDING_CONFIRMATION_LABEL,
};

/** Pending Confirmation followed by the live pipeline stages, in order. */
export function stageLadder(stages: readonly PipelineStageDef[]): StageRung[] {
  return [
    PENDING_RUNG,
    ...liveStages(stages).map((s) => ({ key: s.key, code: s.code, name: s.name })),
  ];
}

/** "L3 · Due Diligence", "Pending Confirmation", or the raw key when unknown. */
export function rungLabel(stages: readonly PipelineStageDef[], key: string | null | undefined): string {
  if (!key) return 'no stage';
  if (key === PENDING_CONFIRMATION_KEY) return PENDING_CONFIRMATION_LABEL;
  if (key === 'market_screening') return 'AI Screened Companies (market_screening)';
  if (key === 'discovered') return 'Discovered (relationship graph)';
  const stage = findStage(stages, key);
  if (!stage) return key;
  const label = stage.name ? `${stage.code} · ${stage.name}` : stage.code;
  return stage.deleted ? `${label} (deleted stage)` : label;
}

/**
 * The previous / next rung for a company currently at `currentKey`, and every
 * stage one move may take it to.
 */
export function stageNeighbors(
  stages: readonly PipelineStageDef[],
  currentKey: string | null | undefined,
): StageNeighbors {
  const ladder = stageLadder(stages);

  // Intake buckets and unset: enter at Pending Confirmation or straight at L0.
  if (!currentKey || (PRE_PIPELINE_STAGES.has(currentKey) && currentKey !== PENDING_CONFIRMATION_KEY)) {
    const first = ladder.find((r) => r.key === FIRST_STAGE_KEY) ?? null;
    return {
      previous: null,
      next: PENDING_RUNG,
      targets: first ? [PENDING_RUNG, first] : [PENDING_RUNG],
    };
  }

  const index = ladder.findIndex((r) => r.key === currentKey);
  if (index >= 0) {
    const previous = ladder[index - 1] ?? null;
    const next = ladder[index + 1] ?? null;
    return { previous, next, targets: [previous, next].filter((r): r is StageRung => r !== null) };
  }

  // A deleted stage: neighbours are the live rungs around where it stood.
  const stage = findStage(stages, currentKey);
  if (!stage) return { previous: null, next: null, targets: [] };
  const live = liveStages(stages);
  const before = live.filter((s) => s.position < stage.position);
  const after = live.find((s) => s.position > stage.position);
  const lastBefore = before[before.length - 1];
  const previous = lastBefore
    ? { key: lastBefore.key, code: lastBefore.code, name: lastBefore.name }
    : PENDING_RUNG;
  const next = after ? { key: after.key, code: after.code, name: after.name } : null;
  return { previous, next, targets: [previous, next].filter((r): r is StageRung => r !== null) };
}

/** Whether moving from `fromKey` to `toKey` is a single permitted step. */
export function isAllowedStageMove(
  stages: readonly PipelineStageDef[],
  fromKey: string | null | undefined,
  toKey: string,
): boolean {
  return stageNeighbors(stages, fromKey).targets.some((r) => r.key === toKey);
}

/**
 * Whether a move needs a human's approval: anything that enters or leaves a
 * stage after L0 (a committed pipeline stage). Intake ↔ Pending ↔ L0 moves
 * run without one.
 */
export function stageMoveRequiresApproval(
  fromKey: string | null | undefined,
  toKey: string,
): boolean {
  const isCommitted = (key: string | null | undefined) =>
    isInPipelineStage(key) && key !== FIRST_STAGE_KEY;
  return isCommitted(fromKey) || isCommitted(toKey);
}

/** Whether `toKey` sits further along the ladder than `fromKey`. */
export function isForwardStageMove(
  stages: readonly PipelineStageDef[],
  fromKey: string | null | undefined,
  toKey: string,
): boolean {
  const neighbors = stageNeighbors(stages, fromKey);
  if (neighbors.previous?.key === toKey) return false;
  return neighbors.targets.some((r) => r.key === toKey);
}
