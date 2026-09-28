import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightContextPanel, type InsightContextState } from './InsightContextButton';

const context = {
  insightId: '99999999-8888-4777-8666-555555555555',
  name: 'Java universities',
  versionNo: 3,
  publishedAt: '2026-09-24 03:12:45.123+00',
  outline: 'Insight "Java universities" · version 3 · published 2026-09-24\n\n[section: cohort]\n| <b>Uni A</b> | 1,200 |',
  truncated: false,
};

function render(state: InsightContextState): string {
  return renderToStaticMarkup(createElement(InsightContextPanel, { state }));
}

describe('InsightContextPanel', () => {
  it('shows the outline verbatim with the version and publish date', () => {
    const html = render({ status: 'ready', context });

    expect(html).toContain('data-testid="copilot-context-panel"');
    expect(html).toContain('Java universities · version 3 · published 2026-09-24');
    expect(html).toContain('data-testid="copilot-context-outline"');
    // Text, never markup: the outline is escaped, not rendered as HTML.
    expect(html).toContain('| &lt;b&gt;Uni A&lt;/b&gt; | 1,200 |');
    expect(html).not.toContain('copilot-context-truncated');
  });

  it('shows the truncation notice only for a truncated outline', () => {
    const html = render({ status: 'ready', context: { ...context, truncated: true } });

    expect(html).toContain('data-testid="copilot-context-truncated"');
    expect(html).toMatch(/Table rows and\s+paragraph text go first/);
  });

  it('says no insight context is sent when the insight is gone', () => {
    const html = render({ status: 'missing' });

    expect(html).toContain('data-testid="copilot-context-panel"');
    expect(html).toContain('no insight context is sent');
    expect(html).not.toContain('copilot-context-outline');
  });

  it('shows loading and error states inside the panel', () => {
    expect(render({ status: 'loading' })).toContain('Loading the context');
    expect(render({ status: 'error', message: 'boom' })).toContain('Could not load the context: boom');
  });
});
