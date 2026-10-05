import { describe, expect, it } from 'vitest';
import {
  isInPipelineStage,
  liveStageKeys,
  screeningTargetKey,
  stageCode,
  stageKeysFrom,
  stageKeysThrough,
  stageLabel,
  stageSelectOptions,
  type PipelineStageDef,
} from './stages';

function stage(key: string, position: number, extra: Partial<PipelineStageDef> = {}): PipelineStageDef {
  return { key, code: key, name: `${key} name`, description: '', position, deleted: false, ...extra };
}

const STAGES: PipelineStageDef[] = [
  stage('L1', 1),
  stage('L0', 0),
  stage('stg-a1b2', 2, { code: 'L1b', name: 'Expert Calls' }),
  stage('L2', 3, { deleted: true }),
  stage('L3', 4),
];

describe('liveStageKeys', () => {
  it('returns live stages in position order, leaving deleted ones out', () => {
    expect(liveStageKeys(STAGES)).toEqual(['L0', 'L1', 'stg-a1b2', 'L3']);
  });
});

describe('stageLabel', () => {
  it('shows the editable code and name, not the key', () => {
    expect(stageLabel(STAGES, 'stg-a1b2')).toBe('L1b · Expert Calls');
  });

  it('still names a deleted stage so dropped deals can show it', () => {
    expect(stageLabel(STAGES, 'L2')).toBe('L2 · L2 name');
  });

  it('falls back to the raw key for an unknown stage', () => {
    expect(stageLabel(STAGES, 'unreviewed')).toBe('unreviewed');
    expect(stageCode(STAGES, 'unreviewed')).toBe('unreviewed');
  });
});

describe('stageKeysFrom / stageKeysThrough', () => {
  it('ranges by position around the anchor, live stages only', () => {
    expect(stageKeysFrom(STAGES, 'L1')).toEqual(['L1', 'stg-a1b2', 'L3']);
    expect(stageKeysThrough(STAGES, 'stg-a1b2')).toEqual(['L0', 'L1', 'stg-a1b2']);
  });

  it('keeps a deleted anchor’s position as the boundary', () => {
    expect(stageKeysFrom(STAGES, 'L2')).toEqual(['L3']);
    expect(stageKeysThrough(STAGES, 'L2')).toEqual(['L0', 'L1', 'stg-a1b2']);
  });

  it('returns [] for an unknown anchor', () => {
    expect(stageKeysFrom(STAGES, 'L9')).toEqual([]);
  });
});

describe('isInPipelineStage', () => {
  it('treats every workspace stage as in the pipeline, custom ones included', () => {
    expect(isInPipelineStage('L0')).toBe(true);
    expect(isInPipelineStage('stg-a1b2')).toBe(true);
  });

  it('treats the pre-pipeline buckets and an unset stage as outside it', () => {
    for (const stageKey of ['market_screening', 'unreviewed', 'discovered', '', null, undefined]) {
      expect(isInPipelineStage(stageKey)).toBe(false);
    }
  });
});

describe('stageSelectOptions', () => {
  it('lists the live stages, and keeps a current value that is not one of them', () => {
    expect(stageSelectOptions(['L0', 'L1'], 'L1')).toEqual(['L0', 'L1']);
    expect(stageSelectOptions(['L0', 'L1'], 'unreviewed')).toEqual(['unreviewed', 'L0', 'L1']);
    expect(stageSelectOptions(['L0', 'L1'], null)).toEqual(['L0', 'L1']);
  });
});

describe('screeningTargetKey', () => {
  it('targets L1 in the default pipeline', () => {
    expect(screeningTargetKey(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])).toBe('L1');
  });

  it('targets a stage the workspace inserted straight after L0', () => {
    expect(screeningTargetKey(['L0', 'stg-a1b2', 'L1', 'L2'])).toBe('stg-a1b2');
  });

  it('targets whatever now follows L0 when L1 is deleted', () => {
    expect(screeningTargetKey(['L0', 'L2', 'L3'])).toBe('L2');
  });

  it('returns null when L0 is the only live stage', () => {
    expect(screeningTargetKey(['L0'])).toBeNull();
  });

  it('returns null when the stage list has not loaded', () => {
    expect(screeningTargetKey([])).toBeNull();
  });
});
