import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllInsightSections,
  clearInsightSection,
  clearOpenInsightAgent,
  clearPageContext,
  getOpenInsightAgent,
  getPageContext,
  setInsightSections,
  setOpenInsightAgent,
  setPageContext,
  subscribePageContext,
} from './pageContextStore';

afterEach(() => clearPageContext());

describe('pageContextStore', () => {
  it('starts empty', () => {
    expect(getPageContext()).toBeNull();
  });

  it('round-trips the stored context', () => {
    setPageContext({ tabSlug: 'crm', path: '/crm', detail: '3 topics' });
    expect(getPageContext()).toEqual({ tabSlug: 'crm', path: '/crm', detail: '3 topics' });
  });

  it('replaces rather than merges on a second write', () => {
    setPageContext({ tabSlug: 'crm', path: '/crm', detail: '3 topics' });
    setPageContext({ tabSlug: 'pipeline', path: '/pipeline' });
    expect(getPageContext()).toEqual({ tabSlug: 'pipeline', path: '/pipeline' });
  });

  it('clears back to null', () => {
    setPageContext({ tabSlug: 'crm', path: '/crm' });
    clearPageContext();
    expect(getPageContext()).toBeNull();
  });

  it('fires listeners on setPageContext and clearPageContext, and unsubscribe stops them', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePageContext(listener);

    setPageContext({ tabSlug: 'crm', path: '/crm' });
    clearPageContext();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPageContext({ tabSlug: 'crm', path: '/crm' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns the stored reference itself, so snapshots stay stable', () => {
    const ctx = { tabSlug: 'crm', path: '/crm', insightId: 'abc' };
    setPageContext(ctx);
    expect(getPageContext()).toBe(ctx);
  });

  it('sets sections without disturbing the rest of the context, and drops the field once emptied', () => {
    setPageContext({ tabSlug: 'insight', path: '/insight/x', insightId: 'abc' });
    setInsightSections([{ key: 'risk-summary' }, { key: 'kpi-row', path: [0, 1] }]);
    expect(getPageContext()).toEqual({
      tabSlug: 'insight',
      path: '/insight/x',
      insightId: 'abc',
      insightSections: [{ key: 'risk-summary' }, { key: 'kpi-row', path: [0, 1] }],
    });

    clearAllInsightSections();
    expect(getPageContext()).toEqual({ tabSlug: 'insight', path: '/insight/x', insightId: 'abc' });
    expect('insightSections' in (getPageContext() ?? {})).toBe(false);
  });

  it('removes exactly one ref by id and leaves the others in order', () => {
    setPageContext({ tabSlug: 'insight', path: '/insight/x' });
    setInsightSections([{ key: 'a' }, { key: 'b', path: [1] }, { key: 'b', path: [2] }, { key: 'c' }]);
    clearInsightSection('b:1');
    clearInsightSection('a');
    expect(getPageContext()?.insightSections).toEqual([{ key: 'b', path: [2] }, { key: 'c' }]);
  });

  it('does not notify when the selection is unchanged', () => {
    setPageContext({ tabSlug: 'insight', path: '/insight/x' });
    setInsightSections([{ key: 'a', path: [1] }]);
    const listener = vi.fn();
    const unsubscribe = subscribePageContext(listener);
    setInsightSections([{ key: 'a', path: [1] }]);
    expect(listener).not.toHaveBeenCalled();
    setInsightSections([{ key: 'a', path: [2] }]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('creates an insight context only for a non-empty selection when none exists', () => {
    setInsightSections([]);
    expect(getPageContext()).toBeNull();
    setInsightSections([{ key: 'intro' }]);
    expect(getPageContext()).toEqual({ tabSlug: 'insight', path: '', insightSections: [{ key: 'intro' }] });
  });
});

describe('openInsightAgent', () => {
  afterEach(() => setOpenInsightAgent(null));

  it("round-trips the binding, and clearOpenInsightAgent leaves another insight's binding alone", () => {
    setOpenInsightAgent({ insightId: 'i2', agentKey: null });
    clearOpenInsightAgent('i1');
    expect(getOpenInsightAgent()).toEqual({ insightId: 'i2', agentKey: null });

    clearOpenInsightAgent('i2');
    expect(getOpenInsightAgent()).toBeNull();
  });

  it('keeps the same object when the binding did not change', () => {
    setOpenInsightAgent({ insightId: 'i1', agentKey: 'dikti' });
    const first = getOpenInsightAgent();
    setOpenInsightAgent({ insightId: 'i1', agentKey: 'dikti' });
    expect(getOpenInsightAgent()).toBe(first);
  });
});
