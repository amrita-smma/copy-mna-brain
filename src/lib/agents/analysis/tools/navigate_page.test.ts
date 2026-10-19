import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveWorkspaceFeatureFlags } = vi.hoisted(() => ({
  resolveWorkspaceFeatureFlags: vi.fn(),
}));

vi.mock('@/lib/features/overrides', () => ({ resolveWorkspaceFeatureFlags }));

import { NAVIGATE_PAGE_MARKER, navigatePage } from './navigate_page';

function extractPayload(result: string) {
  const match = result.match(new RegExp(`<!--\\s*${NAVIGATE_PAGE_MARKER}:(.*?)-->`, 's'));
  expect(match).not.toBeNull();
  return JSON.parse(match![1].trim());
}

describe('navigatePage', () => {
  beforeEach(() => {
    resolveWorkspaceFeatureFlags.mockReset().mockResolvedValue({});
  });

  afterEach(() => vi.clearAllMocks());

  it('emits a marker carrying the destination path and label', async () => {
    const result = (await navigatePage.invoke({
      page: 'pipeline',
      reason: 'to review the stalled L2 deals',
    })) as string;

    expect(result).toContain('Opened **Pipeline**');

    const payload = extractPayload(result);
    expect(payload).toMatchObject({
      slug: 'pipeline',
      path: '/pipeline',
      label: 'Pipeline',
      reason: 'to review the stalled L2 deals',
    });
  });

  // The client dedupes replays by nav_id, so it has to be unique per call and
  // survive in the persisted tool output.
  it('mints a fresh uuid nav_id on every call', async () => {
    const first = extractPayload(
      (await navigatePage.invoke({ page: 'crm', reason: 'r' })) as string,
    );
    const second = extractPayload(
      (await navigatePage.invoke({ page: 'crm', reason: 'r' })) as string,
    );

    expect(first.nav_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.nav_id).not.toBe(second.nav_id);
  });

  it('trims the reason', async () => {
    const payload = extractPayload(
      (await navigatePage.invoke({ page: 'graph', reason: '  to see the owners  ' })) as string,
    );
    expect(payload.reason).toBe('to see the owners');
  });

  it('resolves the workspace label, not the slug, for the user-facing line', async () => {
    const result = (await navigatePage.invoke({
      page: 'ai-workforce',
      reason: 'to watch the queued task',
    })) as string;
    expect(result).toContain('Opened **AI Workforce**');
  });

  it('refuses (and emits no marker) when the destination is disabled for the workspace', async () => {
    resolveWorkspaceFeatureFlags.mockResolvedValue({ FUND_MANAGEMENT_ENABLED: false });

    const result = (await navigatePage.invoke({
      page: 'fund-management',
      reason: 'to check the fund NAV',
    })) as string;

    expect(result).toContain('turned off for this workspace');
    expect(result).not.toContain(NAVIGATE_PAGE_MARKER);
  });

  // Unknown keys resolve to `undefined`, not `false` — a workspace with no
  // override rows at all must still be able to navigate everywhere.
  it('navigates when the flag map has no entry for the destination', async () => {
    resolveWorkspaceFeatureFlags.mockResolvedValue({ CRM_ENABLED: true });

    const result = (await navigatePage.invoke({
      page: 'fund-management',
      reason: 'to check the fund NAV',
    })) as string;

    expect(extractPayload(result).slug).toBe('fund-management');
  });

  it('rejects a page that is not a console tab', async () => {
    await expect(
      navigatePage.invoke({ page: 'admin-portal', reason: 'r' }),
    ).rejects.toThrow();
  });

  it('rejects an empty reason', async () => {
    await expect(navigatePage.invoke({ page: 'crm', reason: '' })).rejects.toThrow();
  });
});
