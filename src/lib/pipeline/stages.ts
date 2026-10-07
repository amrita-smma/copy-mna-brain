/**
 * A workspace's configurable deal pipeline stages (MB-651) — the shape the
 * client and server share, plus the pure helpers that turn a stage list into
 * an order, labels and rule ranges. No server imports: views use this too.
 *
 * A stage's `key` is its permanent identity (what companies.pipeline_stage
 * stores). The six original stages keep the keys L0–L5, and the stage rules
 * stay attached to those keys whatever the workspace renames or moves them to
 * — L0 entry checks, Deal Captain from L3. Added stages get a generated key.
 *
 * The one rule tied to a position instead of a key is screening: it is the
 * gate out of L0, so it promotes into whichever stage follows L0
 * (`screeningTargetKey`), not into the stage keyed L1.
 */

/** One pipeline stage as the API returns it. */
export interface PipelineStageDef {
  key: string;
  /** Editable number shown to users, e.g. "L0" or "L6". */
  code: string;
  name: string;
  description: string;
  position: number;
  /** Soft-deleted: hidden from the pipeline, kept so old deals can name it. */
  deleted: boolean;
}

/**
 * The first stage. Deals confirmed out of Pending Confirmation enter here,
 * demoting out of it returns a deal to Pending, and its entry checks run on
 * the way in — so it cannot be deleted and always stays first.
 */
export const FIRST_STAGE_KEY = 'L0';

/** Deal Captain is shown — and inherited from the Deal Sponsor — from this stage onward. */
export const CAPTAIN_FROM_STAGE_KEY = 'L3';

/** The six original stages, in order — the fallback when a stage list is unavailable. */
export const BUILTIN_PIPELINE_STAGE_KEYS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;

export const STAGE_CODE_MAX_LENGTH = 12;
export const STAGE_NAME_MAX_LENGTH = 40;
export const STAGE_DESCRIPTION_MAX_LENGTH = 4000;

/** Prefix of the keys generated for stages a workspace adds. */
export const CUSTOM_STAGE_KEY_PREFIX = 'stg-';

/** The workspace's live stages, in pipeline order. */
export function liveStages(stages: readonly PipelineStageDef[]): PipelineStageDef[] {
  return stages.filter((s) => !s.deleted).sort((a, b) => a.position - b.position);
}

/** Keys of the live stages, in pipeline order. */
export function liveStageKeys(stages: readonly PipelineStageDef[]): string[] {
  return liveStages(stages).map((s) => s.key);
}

export function findStage(
  stages: readonly PipelineStageDef[],
  key: string | null | undefined,
): PipelineStageDef | undefined {
  if (!key) return undefined;
  return stages.find((s) => s.key === key);
}

/** A stage's code ("L3"), or the raw key when the stage is unknown. */
export function stageCode(stages: readonly PipelineStageDef[], key: string): string {
  return findStage(stages, key)?.code ?? key;
}

/** "L3 · Due Diligence", or the raw key when the stage is unknown. */
export function stageLabel(stages: readonly PipelineStageDef[], key: string): string {
  const stage = findStage(stages, key);
  if (!stage) return key;
  return stage.name ? `${stage.code} · ${stage.name}` : stage.code;
}

/**
 * The stage screening promotes passed L0 deals into: whichever live stage
 * follows L0, so it survives the workspace deleting, moving or inserting a
 * stage before L1. `null` when L0 is the only live stage.
 */
export function screeningTargetKey(liveKeys: readonly string[]): string | null {
  const index = liveKeys.indexOf(FIRST_STAGE_KEY);
  if (index < 0) return null;
  return liveKeys[index + 1] ?? null;
}

/**
 * Live stage keys at or after `anchorKey` in pipeline order — "L3 onwards".
 * The anchor's position counts even when the anchor itself was deleted, so a
 * range rule keeps meaning "from where L3 sits". Empty when the anchor is
 * unknown.
 */
export function stageKeysFrom(stages: readonly PipelineStageDef[], anchorKey: string): string[] {
  const anchor = findStage(stages, anchorKey);
  if (!anchor) return [];
  return liveStages(stages)
    .filter((s) => s.position >= anchor.position)
    .map((s) => s.key);
}

/** Live stage keys at or before `anchorKey` in pipeline order — "up to L3". */
export function stageKeysThrough(stages: readonly PipelineStageDef[], anchorKey: string): string[] {
  const anchor = findStage(stages, anchorKey);
  if (!anchor) return [];
  return liveStages(stages)
    .filter((s) => s.position <= anchor.position)
    .map((s) => s.key);
}

/**
 * Stage values that sit outside the deal pipeline: AI market scanning, the
 * Pending Confirmation bucket, and relationship-graph discoveries.
 * Fixed for every workspace; never rows in `pipeline_stages`.
 */
export const PRE_PIPELINE_STAGES: ReadonlySet<string> = new Set([
  'market_screening',
  'unreviewed',
  'discovered',
]);

/**
 * Whether a deal at `stage` is inside the active pipeline (any workspace
 * stage, L0 included) rather than pre-pipeline or unset. Moving a company
 * from outside into the pipeline is an entry that must pass the L0 checks.
 */
export function isInPipelineStage(stage: string | null | undefined): boolean {
  return !!stage && !PRE_PIPELINE_STAGES.has(stage);
}

/**
 * Options for a "Current Stage" picker: the live stages in order, plus the
 * deal's current value when it is not one of them (a pre-pipeline bucket or a
 * deleted stage), so the picker can still show what the deal is at.
 */
export function stageSelectOptions(liveKeys: readonly string[], current: string | null | undefined): string[] {
  if (!current || liveKeys.includes(current)) return [...liveKeys];
  return [current, ...liveKeys];
}
