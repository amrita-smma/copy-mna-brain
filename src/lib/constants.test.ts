import { describe, it, expect } from 'vitest';
import {
  UNREVIEWED_STAGE,
  demoteTargetForStage,
  promoteTargetForStage,
  stageMoveDirection,
  stageMoveLabel,
} from './constants';
import { BUILTIN_PIPELINE_STAGE_KEYS } from './pipeline/stages';

describe('stageMoveDirection', () => {
  it('reads a forward move along the pipeline as a promotion', () => {
    expect(stageMoveDirection('L1', 'L2')).toBe('promote');
    expect(stageMoveDirection('L0', 'L5')).toBe('promote');
  });

  it('reads a backward move along the pipeline as a demotion', () => {
    expect(stageMoveDirection('L2', 'L1')).toBe('demote');
    expect(stageMoveDirection('L5', 'L0')).toBe('demote');
  });

  it('treats entering the pipeline from a pre-L0 stage as a promotion', () => {
    expect(stageMoveDirection('market_screening', 'L0')).toBe('promote');
    expect(stageMoveDirection('unreviewed', 'L0')).toBe('promote');
    expect(stageMoveDirection('discovered', 'L0')).toBe('promote');
  });

  it('treats an absent current stage as a promotion', () => {
    expect(stageMoveDirection(undefined, 'L0')).toBe('promote');
    expect(stageMoveDirection(null, 'L3')).toBe('promote');
  });

  it('treats dropping out of the pipeline back to a pre-L0 stage as a demotion', () => {
    expect(stageMoveDirection('L2', 'unreviewed')).toBe('demote');
    // The L0 -> Pending Confirmation fallback, which has no L-minus-one to
    // step back to and so leaves the pipeline entirely.
    expect(stageMoveDirection('L0', 'unreviewed')).toBe('demote');
  });

  it('treats a no-op move as a promotion rather than a demotion', () => {
    // Only a strictly backward move counts as a demotion.
    expect(stageMoveDirection('L2', 'L2')).toBe('promote');
  });

  it('agrees with the declared pipeline order at every adjacent step', () => {
    for (let i = 1; i < BUILTIN_PIPELINE_STAGE_KEYS.length; i++) {
      expect(stageMoveDirection(BUILTIN_PIPELINE_STAGE_KEYS[i - 1], BUILTIN_PIPELINE_STAGE_KEYS[i])).toBe('promote');
      expect(stageMoveDirection(BUILTIN_PIPELINE_STAGE_KEYS[i], BUILTIN_PIPELINE_STAGE_KEYS[i - 1])).toBe('demote');
    }
  });
});

describe('promoteTargetForStage', () => {
  it('steps forward one pipeline stage', () => {
    expect(promoteTargetForStage('L0')).toBe('L1');
    expect(promoteTargetForStage('L3')).toBe('L4');
  });

  it('promotes a pending-review deal into L0, not L1', () => {
    expect(promoteTargetForStage(UNREVIEWED_STAGE)).toBe('L0');
  });

  it('returns null at the end of the pipeline', () => {
    expect(promoteTargetForStage('L5')).toBeNull();
  });

  it('returns null for stages outside the ladder', () => {
    expect(promoteTargetForStage('market_screening')).toBeNull();
    expect(promoteTargetForStage('discovered')).toBeNull();
    expect(promoteTargetForStage(undefined)).toBeNull();
    expect(promoteTargetForStage(null)).toBeNull();
  });
});

describe('demoteTargetForStage', () => {
  it('steps back one pipeline stage', () => {
    expect(demoteTargetForStage('L2')).toBe('L1');
    expect(demoteTargetForStage('L5')).toBe('L4');
  });

  it('demotes L0 back to Pending Confirmation', () => {
    expect(demoteTargetForStage('L0')).toBe(UNREVIEWED_STAGE);
  });

  it('demotes L1 to L0', () => {
    expect(demoteTargetForStage('L1')).toBe('L0');
  });

  it('returns null for stages outside the pipeline, including unreviewed itself', () => {
    expect(demoteTargetForStage(UNREVIEWED_STAGE)).toBeNull();
    expect(demoteTargetForStage('market_screening')).toBeNull();
    expect(demoteTargetForStage('discovered')).toBeNull();
    expect(demoteTargetForStage(undefined)).toBeNull();
    expect(demoteTargetForStage(null)).toBeNull();
  });

  it('reads as a demotion to stageMoveDirection at every step it produces', () => {
    for (const stage of BUILTIN_PIPELINE_STAGE_KEYS) {
      const target = demoteTargetForStage(stage);
      if (!target) continue;
      expect(stageMoveDirection(stage, target)).toBe('demote');
    }
  });
});

describe('stageMoveLabel', () => {
  it('names the unreviewed bucket as Pending Confirmation', () => {
    expect(stageMoveLabel(UNREVIEWED_STAGE)).toBe('Pending Confirmation');
  });

  it('leaves pipeline stages as their bare L-code', () => {
    for (const stage of BUILTIN_PIPELINE_STAGE_KEYS) {
      expect(stageMoveLabel(stage)).toBe(stage);
    }
  });

  it('renders an absent stage as an empty string', () => {
    expect(stageMoveLabel(undefined)).toBe('');
    expect(stageMoveLabel(null)).toBe('');
  });
});

describe('promote/demote over a workspace stage order', () => {
  const ORDER = ['L0', 'L1', 'stg-calls', 'L3'];

  it('steps through an added stage in both directions', () => {
    expect(promoteTargetForStage('L1', ORDER)).toBe('stg-calls');
    expect(promoteTargetForStage('stg-calls', ORDER)).toBe('L3');
    expect(demoteTargetForStage('L3', ORDER)).toBe('stg-calls');
  });

  it('has nowhere to promote from the last stage, and pending promotes into the first', () => {
    expect(promoteTargetForStage('L3', ORDER)).toBeNull();
    expect(promoteTargetForStage('unreviewed', ORDER)).toBe('L0');
  });

  it('reads direction from the workspace order', () => {
    expect(stageMoveDirection('L3', 'stg-calls', ORDER)).toBe('demote');
  });

  it('labels a move with the stage code', () => {
    expect(stageMoveLabel('stg-calls', () => 'L1b')).toBe('L1b');
  });
});
