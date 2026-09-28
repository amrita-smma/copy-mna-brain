import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightEditReview, type InsightEditReviewProps } from './InsightEditReview';
import { diffInsightVersions } from '@/lib/insights/versionDiff';

const doc = (body: string) => `<!DOCTYPE html><html><body>${body}</body></html>`;
const BEFORE = doc(
  '<section data-section="summary"><h2>Summary</h2><p>Revenue grew to $5.2bn.</p></section>' +
    '<section data-section="risks"><h2>Risks</h2><p>FX.</p></section>' +
    '<section data-section="peers"><h2>Peers</h2><table><tr><th>Co</th><th>Margin</th></tr><tr><td>Adaro</td><td>32%</td></tr></table></section>',
);
const AFTER = doc(
  '<section data-section="summary"><h2>Summary</h2><p>Revenue grew to $5.4bn.</p></section>' +
    '<section data-section="peers"><h2>Peers</h2><table><tr><th>Co</th><th>Margin</th></tr><tr><td>Adaro</td><td>34%</td></tr></table></section>' +
    '<section data-section="outlook"><h2>Outlook</h2><p>Stable.</p></section>',
);

function render(overrides: Partial<InsightEditReviewProps> = {}): string {
  const props: InsightEditReviewProps = {
    activeTab: 'changes',
    onTabChange: () => {},
    diff: diffInsightVersions(BEFORE, AFTER),
    loadingCurrent: false,
    baseMovedNotice: null,
    caption: 'Current version (v3)',
    beforePane: createElement('div', { 'data-testid': 'before-pane' }),
    afterPane: createElement('div', { 'data-testid': 'after-pane' }),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(InsightEditReview, props));
}

describe('InsightEditReview', () => {
  it('shows the Changes tab with the summary, section statuses and figure rows', () => {
    const html = render();

    expect(html).toMatch(/data-testid="insight-diff-tab"[^>]*>Changes</);
    expect(html).toContain('2 sections changed, 1 added, 1 removed · 2 figures changed');
    expect(html).toContain('data-testid="insight-diff-section-changed"');
    expect(html).toContain('data-testid="insight-diff-section-added"');
    expect(html).toContain('data-testid="insight-diff-section-removed"');
    expect((html.match(/data-testid="insight-diff-figure-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('$5.4bn');
    expect(html).toContain('Adaro · Margin');
    expect(html).not.toContain('before-pane');
    expect(html).not.toContain('after-pane');
    expect(html).not.toContain('insight-diff-base-moved');
  });

  it('shows the base-moved notice above the tabs whichever tab is open', () => {
    const notice = 'This insight moved to v5 (published by a scheduled refresh) since this edit was proposed.';
    for (const tab of ['changes', 'before', 'after'] as const) {
      const html = render({ activeTab: tab, baseMovedNotice: notice });
      expect(html).toContain('data-testid="insight-diff-base-moved"');
      expect(html).toContain(notice);
    }
  });

  it('shows the Before and After panes on their tabs', () => {
    expect(render({ activeTab: 'before' })).toContain('data-testid="before-pane"');
    expect(render({ activeTab: 'after' })).toContain('data-testid="after-pane"');
  });

  it('lists unchanged sections too, and says when nothing but styling changed', () => {
    const html = render({ diff: diffInsightVersions(BEFORE, BEFORE.replace('<h2>', '<h2 style="color:red">')) });
    expect(html).toContain('data-testid="insight-diff-section-unchanged"');
    expect(html).toContain('No content changes — only styling or markup differs');
    expect(html).not.toContain('insight-diff-figure-row');
  });

  it('says it is comparing while the current version loads, and when there is none', () => {
    expect(render({ diff: null, loadingCurrent: true })).toContain('Comparing with the current version');
    expect(render({ diff: null })).toContain('No published version exists yet to compare against.');
  });

  it('paints only opaque surfaces', () => {
    const html = render({ baseMovedNotice: 'moved' });
    expect(html).not.toMatch(/bg-(card|muted|background|amber-\d+|emerald-\d+|rose-\d+)\/\d+/);
  });
});
