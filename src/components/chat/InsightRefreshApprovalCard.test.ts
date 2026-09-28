import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The card's links are workspace-scoped (WorkspaceLink reads the slug).
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceSlug: 'combined' }),
  useRouter: () => ({ push: vi.fn() }),
}));

import { InsightRefreshApprovalCard, refreshResolutionText } from './InsightRefreshApprovalCard';

const payload = {
  approval_id: 'a1',
  insight_id: '99999999-8888-4777-8666-555555555555',
  reason: 'FY2025 output: insight v3 (2026-09-01) shows 62.1 Mt; ESDM (retrieved 2026-09-24) reports 68.4 Mt.',
};

describe('InsightRefreshApprovalCard', () => {
  it('renders the card with the reason, the accept button and opaque surfaces', () => {
    const html = renderToStaticMarkup(createElement(InsightRefreshApprovalCard, { payload }));

    expect(html).toContain('data-testid="insight-refresh-card"');
    expect(html).toContain('data-testid="insight-refresh-accept"');
    expect(html).toContain('data-testid="insight-refresh-dismiss"');
    expect(html).toContain('Refresh this insight now');
    expect(html).toContain('ESDM (retrieved 2026-09-24) reports 68.4 Mt.');
    expect(html).toContain(`href="/w/combined/insight/${payload.insight_id}"`);
    expect(html).not.toMatch(/bg-(card|muted|background)\/\d+/);
  });
});

describe('refreshResolutionText', () => {
  it('says whether a run was queued or one was already live', () => {
    expect(refreshResolutionText(true)).toMatch(/^Refresh queued/);
    expect(refreshResolutionText(false)).toMatch(/already running/);
  });
});
