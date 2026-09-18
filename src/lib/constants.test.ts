import { describe, it, expect } from 'vitest';
import { PIPELINE_STAGES, stageMoveDirection } from './constants';

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
