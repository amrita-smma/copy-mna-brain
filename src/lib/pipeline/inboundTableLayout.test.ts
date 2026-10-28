import { describe, expect, it } from 'vitest';
import { initLayout, visibleOrderedIds } from '@/lib/table/columnLayout';
import { INBOUND_DEFAULT_LAYOUT } from './inboundTableLayout';

/** The Inbound / All Sources table's managed columns, in declared order (active view). */
const COLUMNS = [
  'stage', 'pipeline_status', 'source_type', 'created', 'deal_lead', 'entered_by', 'banker',
  'advisor', 'is_live', 'nbo_date', 'sector', 'geo', 'matched_tracks', 'deal_type', 'revenue',
  'ebitda', 'valuation', 'stake', 'status', 'remarks', 'last_activity', 'ai_opinion',
];

describe('INBOUND_DEFAULT_LAYOUT', () => {
  it('opens Stage, Pipeline Status, Created At, AI Opinion, Deal Lead and Sector, in that order', () => {
    const state = initLayout(COLUMNS, INBOUND_DEFAULT_LAYOUT);
    expect(visibleOrderedIds(state)).toEqual([
      'stage', 'pipeline_status', 'created', 'ai_opinion', 'deal_lead', 'sector',
    ]);
  });

  it('collapses the financial columns into one group right after Sector', () => {
    const state = initLayout(COLUMNS, INBOUND_DEFAULT_LAYOUT);
    expect(state.groups).toEqual([
      {
        id: 'group-financials',
        collapsed: true,
        columnIds: ['revenue', 'ebitda', 'valuation', 'stake', 'deal_type', 'remarks'],
      },
    ]);
    expect(state.order.slice(6, 12)).toEqual(state.groups[0].columnIds);
  });

  it('hides every other column, and copes with columns a view lacks', () => {
    // All Sources without Source Type, dropped view: Drop Reason instead of Status.
    const dropped = COLUMNS.filter((id) => id !== 'source_type' && id !== 'status').concat('dropped_reason');
    const state = initLayout(dropped, INBOUND_DEFAULT_LAYOUT);
    expect(state.hidden).toContain('dropped_reason');
    expect(state.hidden).not.toContain('source_type');
    expect(new Set([...state.hidden, ...visibleOrderedIds(state), ...state.groups[0].columnIds]))
      .toEqual(new Set(dropped));
  });

  it('gives way to a layout the workspace saved', () => {
    const saved = { order: COLUMNS, hidden: [], groups: [] };
    expect(visibleOrderedIds(initLayout(COLUMNS, saved))).toEqual(COLUMNS);
  });
});
