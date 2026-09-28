import { describe, expect, it } from 'vitest';
import {
  readInsightRunContext,
  refreshRunWriteRefusal,
  type InsightRunContext,
} from './refreshRun';

describe('readInsightRunContext', () => {
  it('reads run_id and refresh_insight_id when provided as non-empty strings', () => {
    const ctx = readInsightRunContext({
      run_id: '11111111-1111-1111-1111-111111111111',
      refresh_insight_id: '22222222-2222-2222-2222-222222222222',
      origin_routine_id: '33333333-3333-3333-3333-333333333333',
    });

    expect(ctx).toEqual({
      runId: '11111111-1111-1111-1111-111111111111',
      refreshInsightId: '22222222-2222-2222-2222-222222222222',
    });
  });

  it.each([
    ['blank and non-string values', { run_id: '   ', refresh_insight_id: 12345 }],
    ['a refresh insight id with no run id to key the draft by', { refresh_insight_id: '22222222-2222-2222-2222-222222222222' }],
    ['an empty configurable', {}],
    ['an undefined configurable', undefined],
  ])('returns all nulls for %s', (_, configurable) => {
    expect(readInsightRunContext(configurable)).toEqual({ runId: null, refreshInsightId: null });
  });
});

describe('refreshRunWriteRefusal', () => {
  const RUN_ID = '11111111-1111-1111-1111-111111111111';
  const TARGET_INSIGHT_ID = '22222222-2222-2222-2222-222222222222';
  const OTHER_INSIGHT_ID = '99999999-9999-9999-9999-999999999999';
  const refreshCtx: InsightRunContext = { runId: RUN_ID, refreshInsightId: TARGET_INSIGHT_ID };

  it('returns null outside a refresh run', () => {
    expect(refreshRunWriteRefusal({ runId: RUN_ID, refreshInsightId: null }, OTHER_INSIGHT_ID)).toBeNull();
  });

  it('returns null for the target insight during a refresh run, ignoring surrounding whitespace', () => {
    expect(refreshRunWriteRefusal(refreshCtx, TARGET_INSIGHT_ID)).toBeNull();
    expect(refreshRunWriteRefusal(refreshCtx, `  ${TARGET_INSIGHT_ID}  `)).toBeNull();
  });

  it('refuses another insight during a refresh run', () => {
    expect(refreshRunWriteRefusal(refreshCtx, OTHER_INSIGHT_ID)).toBe(
      `Rejection: This run is a scheduled refresh of insight ${TARGET_INSIGHT_ID}; it can only write to that insight.`,
    );
  });
});
