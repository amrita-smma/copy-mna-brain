import { describe, expect, it } from 'vitest';
import type { PipelineStageDef } from './stages';
import {
  PENDING_CONFIRMATION_KEY,
  isAllowedStageMove,
  isForwardStageMove,
  rungLabel,
  stageLadder,
  stageMoveRequiresApproval,
  stageNeighbors,
} from './stageMoves';

function stage(key: string, position: number, extra: Partial<PipelineStageDef> = {}): PipelineStageDef {
  return { key, code: key, name: `${key} name`, description: '', position, deleted: false, ...extra };
}

const STAGES = ['L0', 'L1', 'L2', 'L3'].map((key, i) => stage(key, i));

describe('stageLadder', () => {
  it('puts Pending Confirmation before the live stages, in position order', () => {
    const shuffled = [stage('L2', 2), stage('L0', 0), stage('L1', 1)];
    expect(stageLadder(shuffled).map((r) => r.key)).toEqual([PENDING_CONFIRMATION_KEY, 'L0', 'L1', 'L2']);
  });

  it('leaves deleted stages out', () => {
    const stages = [stage('L0', 0), stage('L1', 1, { deleted: true }), stage('L2', 2)];
    expect(stageLadder(stages).map((r) => r.key)).toEqual([PENDING_CONFIRMATION_KEY, 'L0', 'L2']);
  });
});

describe('stageNeighbors', () => {
  it('gives Pending Confirmation no previous stage and L0 as next', () => {
    const n = stageNeighbors(STAGES, PENDING_CONFIRMATION_KEY);
    expect(n.previous).toBeNull();
    expect(n.next?.key).toBe('L0');
    expect(n.targets.map((r) => r.key)).toEqual(['L0']);
  });

  it('gives L0 Pending Confirmation as previous and the following stage as next', () => {
    const n = stageNeighbors(STAGES, 'L0');
    expect(n.previous?.key).toBe(PENDING_CONFIRMATION_KEY);
    expect(n.next?.key).toBe('L1');
  });

  it('follows a workspace that reordered its stages', () => {
    const reordered = [stage('L0', 0), stage('stg-new', 1), stage('L1', 2)];
    expect(stageNeighbors(reordered, 'L0').next?.key).toBe('stg-new');
    expect(stageNeighbors(reordered, 'L1').previous?.key).toBe('stg-new');
  });

  it('has no next stage at the end of the pipeline', () => {
    const n = stageNeighbors(STAGES, 'L3');
    expect(n.next).toBeNull();
    expect(n.targets.map((r) => r.key)).toEqual(['L2']);
  });

  it('lets an intake company enter at Pending Confirmation or L0', () => {
    for (const intake of ['market_screening', 'discovered', null]) {
      const n = stageNeighbors(STAGES, intake);
      expect(n.targets.map((r) => r.key)).toEqual([PENDING_CONFIRMATION_KEY, 'L0']);
    }
  });

  it('places a company in a deleted stage between the live stages around it', () => {
    const stages = [stage('L0', 0), stage('L1', 1, { deleted: true }), stage('L2', 2)];
    const n = stageNeighbors(stages, 'L1');
    expect(n.previous?.key).toBe('L0');
    expect(n.next?.key).toBe('L2');
  });

  it('returns no targets for an unknown stage', () => {
    expect(stageNeighbors(STAGES, 'nope').targets).toEqual([]);
  });
});

describe('isAllowedStageMove', () => {
  it('allows one step either way and refuses a skip', () => {
    expect(isAllowedStageMove(STAGES, 'L1', 'L2')).toBe(true);
    expect(isAllowedStageMove(STAGES, 'L1', 'L0')).toBe(true);
    expect(isAllowedStageMove(STAGES, 'L1', 'L3')).toBe(false);
    expect(isAllowedStageMove(STAGES, PENDING_CONFIRMATION_KEY, 'L1')).toBe(false);
  });
});

describe('stageMoveRequiresApproval', () => {
  it('lets intake, Pending Confirmation and L0 moves run unattended', () => {
    expect(stageMoveRequiresApproval('market_screening', 'L0')).toBe(false);
    expect(stageMoveRequiresApproval(PENDING_CONFIRMATION_KEY, 'L0')).toBe(false);
    expect(stageMoveRequiresApproval('L0', PENDING_CONFIRMATION_KEY)).toBe(false);
    expect(stageMoveRequiresApproval(null, PENDING_CONFIRMATION_KEY)).toBe(false);
  });

  it('gates any move into or out of a stage after L0', () => {
    expect(stageMoveRequiresApproval('L0', 'L1')).toBe(true);
    expect(stageMoveRequiresApproval('L1', 'L0')).toBe(true);
    expect(stageMoveRequiresApproval('L2', 'L3')).toBe(true);
  });
});

describe('isForwardStageMove', () => {
  it('distinguishes a step forward from a step back', () => {
    expect(isForwardStageMove(STAGES, 'L0', 'L1')).toBe(true);
    expect(isForwardStageMove(STAGES, 'L1', 'L0')).toBe(false);
    expect(isForwardStageMove(STAGES, 'market_screening', 'L0')).toBe(true);
  });
});

describe('rungLabel', () => {
  it('labels Pending Confirmation, live, deleted and unknown stages', () => {
    const stages = [stage('L0', 0), stage('L1', 1, { deleted: true })];
    expect(rungLabel(stages, PENDING_CONFIRMATION_KEY)).toBe('Pending Confirmation');
    expect(rungLabel(stages, 'L0')).toBe('L0 · L0 name');
    expect(rungLabel(stages, 'L1')).toBe('L1 · L1 name (deleted stage)');
    expect(rungLabel(stages, 'zzz')).toBe('zzz');
    expect(rungLabel(stages, null)).toBe('no stage');
  });
});
