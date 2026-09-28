import { describe, expect, it } from 'vitest';
import { readPageContext } from './read_page_context';

describe('readPageContext', () => {
  it('reports the open page and the view-supplied detail', async () => {
    const result = (await readPageContext.invoke(
      {},
      {
        configurable: {
          pageContext: {
            tabSlug: 'pipeline',
            path: '/pipeline',
            detail: 'Stage filter: L2. 7 deals visible.',
          },
        },
      },
    )) as string;

    expect(result).toContain('**Pipeline**');
    expect(result).toContain('/pipeline');
    expect(result).toContain('Stage filter: L2. 7 deals visible.');
  });

  it('reports a sub-route path even when the tab is the parent', async () => {
    const result = (await readPageContext.invoke(
      {},
      {
        configurable: {
          pageContext: {
            tabSlug: 'pipeline',
            path: '/pipeline/8f2c-abc',
            detail: 'Deal open: Acme Corp',
          },
        },
      },
    )) as string;

    expect(result).toContain('/pipeline/8f2c-abc');
    expect(result).toContain('Deal open: Acme Corp');
  });

  it('says the user has no page open when there is no context', async () => {
    const result = (await readPageContext.invoke({}, { configurable: {} })) as string;
    expect(result).toContain('full-screen chat');
  });

  it('says the same when invoked with no runtime config at all', async () => {
    const result = (await readPageContext.invoke({})) as string;
    expect(result).toContain('full-screen chat');
  });

  it('hands over the open deal\'s company_id so tools skip the fuzzy name lookup', async () => {
    const result = (await readPageContext.invoke(
      {},
      {
        configurable: {
          pageContext: {
            tabSlug: 'pipeline',
            path: '/pipeline/8f2c-abc',
            detail: 'Deal open: 杭州华友新材料',
            companyId: '11111111-2222-3333-4444-555555555555',
          },
        },
      },
    )) as string;

    expect(result).toContain('company_id 11111111-2222-3333-4444-555555555555');
    expect(result).toContain('Do NOT re-resolve this company by name');
  });

  // Re-sanitized here, so a non-UUID id never reaches the model as an id it
  // would then pass to a write tool.
  it('drops a companyId that is not a UUID', async () => {
    const result = (await readPageContext.invoke(
      {},
      {
        configurable: {
          pageContext: {
            tabSlug: 'pipeline',
            path: '/pipeline',
            companyId: 'the-one-i-want',
          },
        },
      },
    )) as string;

    expect(result).not.toContain('company_id');
  });

  it('tells the model to prefer the supplied id over a name lookup', () => {
    expect(readPageContext.description).toContain('Pass that id VERBATIM');
    expect(readPageContext.description).toContain('near-identical names');
  });

  // The route sanitizes before this point, but the tool must not trust its
  // input either — a garbage payload degrades to "no page open".
  it('ignores a malformed context', async () => {
    const result = (await readPageContext.invoke(
      {},
      { configurable: { pageContext: { tabSlug: 'pipeline' } } },
    )) as string;
    expect(result).toContain('full-screen chat');
  });

  it('surfaces the open insight_id when an insight is open', async () => {
    const result = (await readPageContext.invoke(
      {},
      {
        configurable: {
          pageContext: {
            tabSlug: 'insight',
            path: '/insight/22222222-3333-4444-5555-666666666666',
            insightId: '22222222-3333-4444-5555-666666666666',
          },
        },
      },
    )) as string;

    expect(result).toContain('insight_id 22222222-3333-4444-5555-666666666666');
  });
});
