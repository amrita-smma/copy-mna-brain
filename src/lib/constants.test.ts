import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGES,
  UNREVIEWED_STAGE,
  demoteTargetForStage,
  promoteTargetForStage,
  stageMoveDirection,
  stageMoveLabel,
} from './constants';

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
    // The L0 -> Inbound Pending Review fallback, which has no L-minus-one to
    // step back to and so leaves the pipeline entirely.
    expect(stageMoveDirection('L0', 'unreviewed')).toBe('demote');
  });

  it('treats a no-op move as a promotion rather than a demotion', () => {
    // Only a strictly backward move counts as a demotion.
    expect(stageMoveDirection('L2', 'L2')).toBe('promote');
  });

  it('agrees with the declared pipeline order at every adjacent step', () => {
    for (let i = 1; i < PIPELINE_STAGES.length; i++) {
      expect(stageMoveDirection(PIPELINE_STAGES[i - 1], PIPELINE_STAGES[i])).toBe('promote');
      expect(stageMoveDirection(PIPELINE_STAGES[i], PIPELINE_STAGES[i - 1])).toBe('demote');
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

  it('demotes L0 back to Inbound Pending Review when that bucket is available', () => {
    expect(demoteTargetForStage('L0', { demoteL0ToReview: true })).toBe(UNREVIEWED_STAGE);
  });

  it('gives L0 no demote target when the pending-review bucket does not apply', () => {
    // Outbound tables: there is no outbound Pending Review section to land in.
    expect(demoteTargetForStage('L0')).toBeNull();
    expect(demoteTargetForStage('L0', { demoteL0ToReview: false })).toBeNull();
  });

  it('leaves the option irrelevant above L0', () => {
    expect(demoteTargetForStage('L1', { demoteL0ToReview: true })).toBe('L0');
    expect(demoteTargetForStage('L1')).toBe('L0');
  });

  it('returns null for stages outside the pipeline, including unreviewed itself', () => {
    expect(demoteTargetForStage(UNREVIEWED_STAGE, { demoteL0ToReview: true })).toBeNull();
    expect(demoteTargetForStage('market_screening')).toBeNull();
    expect(demoteTargetForStage('discovered')).toBeNull();
    expect(demoteTargetForStage(undefined)).toBeNull();
    expect(demoteTargetForStage(null)).toBeNull();
  });

  it('reads as a demotion to stageMoveDirection at every step it produces', () => {
    for (const stage of PIPELINE_STAGES) {
      const target = demoteTargetForStage(stage, { demoteL0ToReview: true });
      if (!target) continue;
      expect(stageMoveDirection(stage, target)).toBe('demote');
    }
  });
});

describe('stageMoveLabel', () => {
  it('spells out the pending-review bucket', () => {
    expect(stageMoveLabel(UNREVIEWED_STAGE)).toBe('Inbound Pending Review');
  });

  it('leaves pipeline stages as their bare L-code', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stageMoveLabel(stage)).toBe(stage);
    }
  });

  it('renders an absent stage as an empty string', () => {
    expect(stageMoveLabel(undefined)).toBe('');
    expect(stageMoveLabel(null)).toBe('');
  });
});
