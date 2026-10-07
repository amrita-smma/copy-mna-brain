import { describe, it, expect } from 'vitest';
import {
  matchesSearchScope,
  matchesStageView,
  parseStageView,
  stageCellLabel,
  stageSortRank,
} from './stageView';

const deal = (pipeline_stage: string | null, source: string | null = 'inbound') => ({
  pipeline_stage,
  source,
});

describe('parseStageView', () => {
  it('defaults to every stage when the param is missing', () => {
    expect(parseStageView(null)).toBe('all');
    expect(parseStageView(undefined)).toBe('all');
    expect(parseStageView('')).toBe('all');
  });

  it('keeps the all, pending and L0–L5 values as they are', () => {
    expect(parseStageView('all')).toBe('all');
    expect(parseStageView('pending')).toBe('pending');
    for (const stage of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      expect(parseStageView(stage)).toBe(stage);
    }
  });

  it('treats the unreviewed stage name as the pending bucket', () => {
    expect(parseStageView('unreviewed')).toBe('pending');
  });

  it('falls back to every stage for stages without a tab', () => {
    expect(parseStageView('market_screening')).toBe('all');
    expect(parseStageView('discovered')).toBe('all');
    expect(parseStageView('l2')).toBe('all');
  });
});

describe('matchesStageView', () => {
  it('shows every L0–L5 deal under all, including what L0 shows, but not pending or off-pipeline ones', () => {
    expect(matchesStageView(deal('L0'), 'all')).toBe(true);
    expect(matchesStageView(deal('L5'), 'all')).toBe(true);
    expect(matchesStageView(deal('unreviewed'), 'all')).toBe(false);
    expect(matchesStageView(deal('unreviewed', 'outbound'), 'all')).toBe(false);
    expect(matchesStageView(deal('discovered'), 'all')).toBe(false);
    expect(matchesStageView(deal(null), 'all')).toBe(false);
  });

  it('shows only unreviewed deals under pending, whatever their source', () => {
    expect(matchesStageView(deal('unreviewed'), 'pending')).toBe(true);
    expect(matchesStageView(deal('unreviewed', 'outbound'), 'pending')).toBe(true);
    expect(matchesStageView(deal('L0'), 'pending')).toBe(false);
  });

  it('shows only the selected stage for a single stage', () => {
    expect(matchesStageView(deal('L2'), 'L2')).toBe(true);
    expect(matchesStageView(deal('L3'), 'L2')).toBe(false);
  });

  it('keeps pending deals of every source out of L0', () => {
    expect(matchesStageView(deal('L0'), 'L0')).toBe(true);
    expect(matchesStageView(deal('unreviewed', 'inbound'), 'L0')).toBe(false);
    expect(matchesStageView(deal('unreviewed', 'outbound'), 'L0')).toBe(false);
  });

});

describe('matchesSearchScope', () => {
  it('covers every pipeline stage and Pending Confirmation', () => {
    expect(matchesSearchScope(deal('L0'))).toBe(true);
    expect(matchesSearchScope(deal('L5'))).toBe(true);
    expect(matchesSearchScope(deal('unreviewed', 'inbound'))).toBe(true);
    expect(matchesSearchScope(deal('unreviewed', 'outbound'))).toBe(true);
  });

  it('leaves out deals outside the pipeline', () => {
    expect(matchesSearchScope(deal('market_screening'))).toBe(false);
    expect(matchesSearchScope(deal('discovered'))).toBe(false);
    expect(matchesSearchScope(deal(null))).toBe(false);
  });
});

describe('stageCellLabel', () => {
  it('labels unreviewed deals as Pending and passes other stages through', () => {
    expect(stageCellLabel('unreviewed')).toBe('Pending');
    expect(stageCellLabel('L3')).toBe('L3');
    expect(stageCellLabel(null)).toBe('—');
  });
});

describe('stageSortRank', () => {
  it('orders Pending, then L0→L5, then unknown stages last', () => {
    const order = ['L2', 'unknown', 'L0', 'unreviewed', 'L5'].sort(
      (a, b) => stageSortRank(a) - stageSortRank(b),
    );
    expect(order).toEqual(['unreviewed', 'L0', 'L2', 'L5', 'unknown']);
  });
});

describe('stage views over a workspace’s own stages', () => {
  // L2 deleted; an "Expert Calls" stage added after L1.
  const KEYS = ['L0', 'L1', 'stg-calls', 'L3', 'L4', 'L5'];

  it('accepts an added stage as a view and rejects a deleted one', () => {
    expect(parseStageView('stg-calls', KEYS)).toBe('stg-calls');
    expect(parseStageView('L2', KEYS)).toBe('all');
  });

  it('shows an added stage’s deals under all and under its own view', () => {
    expect(matchesStageView(deal('stg-calls'), 'all')).toBe(true);
    expect(matchesStageView(deal('stg-calls'), 'stg-calls')).toBe(true);
  });

  it('keeps a deal dropped at a since-deleted stage under all', () => {
    expect(matchesStageView(deal('L2'), 'all')).toBe(true);
  });

  it('includes an added stage’s deals in a search', () => {
    expect(matchesSearchScope(deal('stg-calls'))).toBe(true);
  });

  it('sorts by the workspace order', () => {
    const order = ['L3', 'stg-calls', 'L1'].sort(
      (a, b) => stageSortRank(a, KEYS) - stageSortRank(b, KEYS),
    );
    expect(order).toEqual(['L1', 'stg-calls', 'L3']);
  });

  it('labels a cell with the stage’s code', () => {
    expect(stageCellLabel('stg-calls', (key) => (key === 'stg-calls' ? 'L1b' : key))).toBe('L1b');
  });
});
