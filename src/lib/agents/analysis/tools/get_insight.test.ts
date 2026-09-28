import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockGetRunDraft, mockGetActiveWorkspaceId } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGetRunDraft: vi.fn(),
  mockGetActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mockGetActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    insightService: {
      get: mockGet,
      getRunDraft: mockGetRunDraft,
    },
  })),
}));

import { getInsight, MAX_INSIGHT_READ_CHARS } from './get_insight';

const INSIGHT_ID = '11111111-2222-3333-4444-555555555555';
const PAGE_CONTEXT = { pageContext: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID } };
const REFRESH = { configurable: { run_id: 'run-1', refresh_insight_id: INSIGHT_ID } };

function insight(overrides: Record<string, unknown> = {}) {
  return {
    id: INSIGHT_ID,
    name: 'Sector Brief',
    description: 'APAC semis',
    html: '<h1>Brief</h1>',
    version_no: 3,
    ...overrides,
  };
}

function invoke(args: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> {
  return getInsight.invoke(args as never, config) as Promise<string>;
}

describe('getInsight', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(insight());
    mockGetRunDraft.mockReset();
    mockGetActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
  });

  it('returns the current document for the insight in page context', async () => {
    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockGetRunDraft).not.toHaveBeenCalled();
    expect(out).toContain('<h1>Brief</h1>');
    expect(out).toContain('version 3');
    expect(out).toContain('Sector Brief');
    expect(out).not.toContain('TRUNCATED');
  });

  it("reports the document's length, so chat can tell whether it may rewrite it in one call", async () => {
    mockGet.mockResolvedValue(insight({ html: 'x'.repeat(25_000) }));

    const out = await invoke({}, { configurable: PAGE_CONTEXT });

    expect(out).toContain('Length: 25,000 characters');
  });

  it('prefers an explicit insight_id over page context', async () => {
    const other = '99999999-8888-7777-6666-555555555555';

    await invoke({ insight_id: other }, { configurable: PAGE_CONTEXT });

    expect(mockGet).toHaveBeenCalledWith('ws-1', other);
  });

  it('explains itself rather than throwing when no insight is open outside a refresh run', async () => {
    const out = await invoke({}, { configurable: { pageContext: { tabSlug: 'insight', path: '/insight' } } });

    expect(out).toContain('no insight is currently open');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects a malformed id without hitting the database', async () => {
    const out = await invoke({ insight_id: 'not-a-uuid' });

    expect(out).toContain('not a valid UUID');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports a missing insight instead of surfacing the service error', async () => {
    mockGet.mockRejectedValue(new Error('InsightNotFoundError'));

    expect(await invoke({ insight_id: INSIGHT_ID })).toContain('not found in this workspace');
  });

  it('warns against a wholesale edit when the document is truncated', async () => {
    mockGet.mockResolvedValue(insight({ html: '<p>'.repeat(MAX_INSIGHT_READ_CHARS) }));

    const out = await invoke({ insight_id: INSIGHT_ID });

    expect(out).toContain('TRUNCATED');
    expect(out).toContain('Do NOT submit an edit built from this fragment');
  });

  it.each(['report', 'document'])('states the insight kind in the returned text for a %s', async (kind) => {
    mockGet.mockResolvedValue(insight({ kind }));

    expect(await invoke({ insight_id: INSIGHT_ID })).toContain(`Kind: ${kind}`);
  });

  it('reads refresh_insight_id in a refresh run and returns the current version when there is no draft', async () => {
    mockGet.mockResolvedValue(insight({ html: '<h1>Current HTML</h1>', version_no: 2 }));
    mockGetRunDraft.mockResolvedValue(undefined);

    const out = await invoke({}, REFRESH);

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockGetRunDraft).toHaveBeenCalledWith('ws-1', 'run-1');
    expect(out).toContain(`Insight: Sector Brief (id ${INSIGHT_ID}, version 2)`);
    expect(out).toContain('<h1>Current HTML</h1>');
    expect(out).not.toContain('unpublished draft');
  });

  it('returns draft html and unpublished draft header when draft exists in a refresh run', async () => {
    mockGet.mockResolvedValue(insight({ html: '<h1>Old Live Version</h1>', version_no: 2 }));
    mockGetRunDraft.mockResolvedValue({
      run_id: 'run-1',
      workspace_id: 'ws-1',
      insight_id: INSIGHT_ID,
      base_version_no: 2,
      html: '<h1>Draft HTML from Refresh Run</h1>',
    });

    const out = await invoke({ insight_id: INSIGHT_ID }, REFRESH);

    expect(out).toContain(
      `Insight: Sector Brief (id ${INSIGHT_ID}, unpublished draft for this refresh run, based on version 2)`,
    );
    expect(out).toContain('<h1>Draft HTML from Refresh Run</h1>');
    expect(out).not.toContain('<h1>Old Live Version</h1>');
  });

  it('never calls getRunDraft in a non-refresh run', async () => {
    await invoke({ insight_id: INSIGHT_ID }, { configurable: { run_id: 'run-1' } });

    expect(mockGetRunDraft).not.toHaveBeenCalled();
  });
});
