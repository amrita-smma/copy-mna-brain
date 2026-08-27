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

  // The route sanitizes before this point, but the tool must not trust its
  // input either — a garbage payload degrades to "no page open".
  it('ignores a malformed context', async () => {
    const result = (await readPageContext.invoke(
      {},
      { configurable: { pageContext: { tabSlug: 'pipeline' } } },
    )) as string;
    expect(result).toContain('full-screen chat');
  });
});
