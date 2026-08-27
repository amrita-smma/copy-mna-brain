import { afterEach, describe, expect, it } from 'vitest';
import { clearPageContext, getPageContext, setPageContext } from './pageContextStore';

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
});
