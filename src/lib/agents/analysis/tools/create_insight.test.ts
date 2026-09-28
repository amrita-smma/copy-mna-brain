import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSIGHT_LAYOUT_WARNING_LEAD } from '@/lib/insights/layoutCheck';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/toolValidation';

const { mockCreateFromDocument, mockGetActiveWorkspaceIdOrThrow } = vi.hoisted(() => ({
  mockCreateFromDocument: vi.fn(),
  mockGetActiveWorkspaceIdOrThrow: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: mockGetActiveWorkspaceIdOrThrow,
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    insightService: { createFromDocument: mockCreateFromDocument },
  })),
}));

import { createInsight } from './create_insight';
import { makeTruncatedCandidate } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';
import { sourceRefHtml, sourcesSectionHtml } from '@/lib/agents/sector/evidenceMarkers';

const INSIGHT_ID = '11111111-2222-3333-4444-555555555555';
const TEMPLATE_ID = '66666666-7777-4888-9999-000000000000';
const VALID_HTML = '<!DOCTYPE html><html><body><h1>Title</h1><p>Real content</p></body></html>';
const BAD_MARKER = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';
const withBody = (body: string) => `<!DOCTYPE html><html><body><h1>Title</h1>${body}</body></html>`;

function invoke(args: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> {
  return createInsight.invoke(args as never, config) as Promise<string>;
}

describe('createInsight tool', () => {
  beforeEach(() => {
    mockCreateFromDocument.mockReset().mockResolvedValue({ id: INSIGHT_ID, name: 'Sector Brief' });
    mockGetActiveWorkspaceIdOrThrow.mockReset().mockResolvedValue('ws-1');
  });

  it('persists a new document and returns a markdown link to it', async () => {
    const out = await invoke(
      {
        name: 'Sector Brief',
        description: 'APAC semiconductor equipment',
        html: VALID_HTML,
        kind: 'document',
      },
      { configurable: { triggered_by_user_id: 'user-42' } },
    );

    expect(mockCreateFromDocument).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: 'Sector Brief',
      description: 'APAC semiconductor equipment',
      html: VALID_HTML,
      userId: 'user-42',
      kind: 'document',
      agentStamp: null,
      templateId: null,
    });
    expect(out).toBe(`Created insight **Sector Brief** — [open it](/insight/${INSIGHT_ID})`);
  });

  it('passes the template_id through as the insight\'s source template', async () => {
    await invoke({ name: 'Sector Brief', html: VALID_HTML, template_id: TEMPLATE_ID });

    expect(mockCreateFromDocument).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: TEMPLATE_ID }),
    );
  });

  it('still creates for a template_id that is not a uuid, leaving the service to drop it', async () => {
    const out = await invoke({ name: 'Sector Brief', html: VALID_HTML, template_id: 'sector-brief' });

    expect(out).toContain('Created insight **Sector Brief**');
    expect(mockCreateFromDocument).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'sector-brief' }),
    );
  });

  it('passes null as userId and stamps the agent from configurable.agent_key', async () => {
    await invoke({ name: 'Report', html: VALID_HTML }, { configurable: { agent_key: 'dikti' } });

    expect(mockCreateFromDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        agentStamp: { agentKey: 'dikti' },
      }),
    );
  });

  it.each([
    [{ name: '   ' }, 'Rejection: An insight name is required.'],
    [
      { name: 'A'.repeat(MAX_INSIGHT_NAME_LENGTH + 1) },
      `Rejection: Insight name is longer than ${MAX_INSIGHT_NAME_LENGTH} characters.`,
    ],
    [{ html: '   ' }, 'Rejection: No HTML document provided.'],
  ])('rejects bad arguments without writing', async (override, expected) => {
    expect(await invoke({ name: 'Valid Name', html: VALID_HTML, ...override })).toBe(expected);
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('validates report structure when kind is report', async () => {
    const out = await invoke({
      name: 'Report Name',
      html: '<html><body><h1>Report without required sections</h1></body></html>',
      kind: 'report',
    });

    expect(out).toContain('Rejection:');
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('rejects in a refresh run without writing to the database', async () => {
    const out = await invoke(
      { name: 'New Insight', html: VALID_HTML },
      { configurable: { run_id: 'run-123', refresh_insight_id: INSIGHT_ID } },
    );

    expect(out).toBe(
      `Rejection: This run is a scheduled refresh of insight ${INSIGHT_ID}; it cannot create new insights. Edit that insight with edit_insight_section or replace_insight_document.`,
    );
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('catches and formats service errors with **Error:** prefix', async () => {
    mockCreateFromDocument.mockRejectedValue(new Error('Database write failure'));

    const out = await invoke({ name: 'Failed Document', html: VALID_HTML });

    expect(out).toBe('**Error:** Failed to create insight: Database write failure');
  });

  it('refuses a create with a dangling source reference for any agent (MB-551)', async () => {
    const sources = sourcesSectionHtml([
      { id: 'S1', kind: 'web', retrieved: '2026-09-01', feeds: 'FY2025 output', name: 'ESDM', locator: 'https://modi.esdm.go.id/' },
    ]);
    const out = await invoke(
      { name: 'Report', html: withBody(`<p>62 Mt${sourceRefHtml('S2')}</p>${sources}`) },
      { configurable: { agent_key: 'minerba' } },
    );

    expect(out).toMatch(/^Rejection: 1 malformed source or unavailable marker — nothing was written\./);
    expect(out).toContain('reference S2 matches no Sources entry');
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('refuses a @dikti create with a malformed evidence marker and returns the correction (MB-543)', async () => {
    const out = await invoke(
      { name: 'Report', html: withBody(`<p>${BAD_MARKER} SK 123/2024 approved the change.</p>`) },
      { configurable: { agent_key: 'dikti' } },
    );

    expect(out).toMatch(/^Rejection: 1 malformed evidence marker — nothing was written\./);
    expect(out).toContain('decree, pddikti, newspaper, ahu');
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('refuses a truncated document and writes nothing (MB-555)', async () => {
    const out = await invoke(
      { name: 'Output', html: makeTruncatedCandidate() },
      { configurable: { agent_key: 'minerba' } },
    );

    expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
    expect(out).toContain('no insight was created');
    expect(out).toContain('report the failure and its reason in your final report');
    expect(out).not.toContain('matches no Sources entry');
    expect(mockCreateFromDocument).not.toHaveBeenCalled();
  });

  it('still creates an insight whose page container traps its overflow, and appends the warning', async () => {
    const trapped =
      '<!DOCTYPE html><html><head><style>.deck{aspect-ratio:16/9;overflow:auto}</style></head>' +
      '<body><div class="deck"><p>Content</p></div></body></html>';
    const out = await invoke({ name: 'Sector Brief', html: trapped });

    expect(mockCreateFromDocument).toHaveBeenCalled();
    expect(out).toContain('Created insight **Sector Brief**');
    expect(out).toContain(`${INSIGHT_LAYOUT_WARNING_LEAD}: \`.deck\``);
    expect(out).toContain('replace_insight_document');
  });
});
