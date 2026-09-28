import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSIGHT_LAYOUT_WARNING_LEAD } from '@/lib/insights/layoutCheck';
import {
  InsightNotFoundError,
  InsightPayloadTooLargeError,
  InsightValidationError,
  StaleInsightVersionError,
} from '@/lib/services/insightService';

const {
  mockGet,
  mockPublishVersion,
  mockApplyRunDraftEdit,
  mockGetActiveWorkspaceIdOrThrow,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPublishVersion: vi.fn(),
  mockApplyRunDraftEdit: vi.fn(),
  mockGetActiveWorkspaceIdOrThrow: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: mockGetActiveWorkspaceIdOrThrow,
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    insightService: {
      get: mockGet,
      publishVersion: mockPublishVersion,
      applyRunDraftEdit: mockApplyRunDraftEdit,
    },
  })),
}));

import { editInsightSection } from './edit_insight_section';
import { makeTruncatedFragment } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';
import { sourceRefHtml, sourcesSectionHtml } from '@/lib/agents/sector/evidenceMarkers';

const INSIGHT_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_INSIGHT_ID = '99999999-8888-7777-6666-555555555555';
const REFRESH = { configurable: { run_id: 'run-456', refresh_insight_id: INSIGHT_ID } };

const BAD_MARKER = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';
const INITIAL_HTML = `<!DOCTYPE html>
<html>
<body>
  <h1>Sector Brief</h1>
  <section data-section="summary">
    <p>Old summary</p>
  </section>
  <section data-section="details">
    <p>Details content</p>
  </section>
</body>
</html>`;

const summaryEdit = (inner = '<p>New</p>') => ({
  insight_id: INSIGHT_ID,
  section: 'summary',
  html: `<section data-section="summary">${inner}</section>`,
});

function invoke(args: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> {
  return editInsightSection.invoke(args as never, config) as Promise<string>;
}

describe('editInsightSection tool', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({
      id: INSIGHT_ID,
      name: 'Sector Brief',
      kind: 'document',
      version_no: 2,
      html: INITIAL_HTML,
    });
    mockPublishVersion.mockReset().mockResolvedValue({ id: INSIGHT_ID, name: 'Sector Brief', version_no: 3 });
    mockApplyRunDraftEdit.mockReset();
    mockGetActiveWorkspaceIdOrThrow.mockReset().mockResolvedValue('ws-1');
  });

  it('splices a section, publishes version with baseVersionNo, and returns markdown link', async () => {
    const out = await invoke(
      { ...summaryEdit('<p>New summary with data</p>'), summary: 'Updated summary section' },
      { configurable: { triggered_by_user_id: 'user-99' } },
    );

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockPublishVersion).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      insightId: INSIGHT_ID,
      html: expect.stringContaining('<p>New summary with data</p>'),
      label: 'Updated summary section',
      userId: 'user-99',
      baseVersionNo: 2,
      trigger: 'workforce',
      sourceRunId: null,
      agentStamp: null,
    });

    const publishedHtml = mockPublishVersion.mock.calls[0][0].html;
    expect(publishedHtml).toContain('Details content');
    expect(publishedHtml).not.toContain('<p>Old summary</p>');

    expect(out).toBe(
      `Updated section "summary" of insight **Sector Brief** (version 3) — [open it](/insight/${INSIGHT_ID})`,
    );
  });

  it('passes a null userId and the run_id as sourceRunId in a non-refresh workforce run', async () => {
    await invoke(summaryEdit(), { configurable: { run_id: 'run-abc-123' } });

    expect(mockPublishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, trigger: 'workforce', sourceRunId: 'run-abc-123' }),
    );
  });

  it('routes to applyRunDraftEdit in a refresh run and does not publish version', async () => {
    mockApplyRunDraftEdit.mockResolvedValue({
      insightId: INSIGHT_ID,
      insightName: 'Sector Brief',
      baseVersionNo: 4,
    });

    const out = await invoke(summaryEdit('<p>Draft summary</p>'), REFRESH);

    expect(mockApplyRunDraftEdit).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      runId: 'run-456',
      insightId: INSIGHT_ID,
      edit: {
        kind: 'section',
        section: 'summary',
        html: '<section data-section="summary"><p>Draft summary</p></section>',
      },
    });
    expect(mockPublishVersion).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(out).toBe(
      'Updated section "summary" of insight **Sector Brief** in this refresh run\'s draft (based on version 4). Nothing is published until the run completes.',
    );
  });

  it('rejects editing a different insight in a refresh run with no service write', async () => {
    const out = await invoke({ ...summaryEdit(), insight_id: OTHER_INSIGHT_ID }, REFRESH);

    expect(out).toBe(
      `Rejection: This run is a scheduled refresh of insight ${INSIGHT_ID}; it can only write to that insight.`,
    );
    expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
    expect(mockPublishVersion).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['StaleInsightVersionError', new StaleInsightVersionError(INSIGHT_ID, 1, 2)],
    ['InsightValidationError', new InsightValidationError('Section does not match schema')],
    ['InsightPayloadTooLargeError', new InsightPayloadTooLargeError('Payload exceeds size limit')],
    ['InsightNotFoundError', new InsightNotFoundError(INSIGHT_ID)],
  ])('turns a %s into a Rejection message', async (_name, err) => {
    mockApplyRunDraftEdit.mockRejectedValue(err);

    const out = await invoke(summaryEdit(), REFRESH);

    expect(out).toBe(`Rejection: ${err.message}`);
  });

  it('handles get failure with **Error:** prefix', async () => {
    mockGet.mockRejectedValue(new Error('Insight not found in database'));

    const out = await invoke(summaryEdit());

    expect(out).toBe('**Error:** Failed to edit insight section: Insight not found in database');
  });

  it.each([
    [{ insight_id: '' }, 'Rejection: An insight_id is required.'],
    [{ insight_id: 'not-a-uuid' }, 'Rejection: insight_id "not-a-uuid" is not a valid UUID.'],
    [{ section: '   ' }, 'Rejection: A section key is required.'],
    [{ html: '   ' }, 'Rejection: No HTML fragment provided.'],
  ])('rejects bad arguments %o', async (override, expected) => {
    expect(await invoke({ ...summaryEdit(), ...override })).toBe(expected);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects if section is not found in the current document', async () => {
    const out = await invoke({ ...summaryEdit(), section: 'nonexistent-section' });

    expect(out).toBe('Rejection: Section "nonexistent-section" not found in document.');
    expect(mockPublishVersion).not.toHaveBeenCalled();
  });

  it("validates the spliced document against the insight's kind", async () => {
    mockGet.mockResolvedValue({
      id: INSIGHT_ID,
      name: 'Analytical Report',
      kind: 'report',
      version_no: 1,
      html: '<html><body><section data-section="sec1"><p>text</p></section></body></html>',
    });

    const out = await invoke({
      insight_id: INSIGHT_ID,
      section: 'sec1',
      html: '<section data-section="sec1"><p>still invalid report</p></section>',
    });

    expect(out).toContain('Rejection:');
    expect(mockPublishVersion).not.toHaveBeenCalled();
  });

  it("stamps the version with the thread's agent from configurable.agent_key", async () => {
    await invoke(summaryEdit(), { configurable: { agent_key: 'bangun' } });

    expect(mockPublishVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentStamp: { agentKey: 'bangun' },
      }),
    );
  });

  describe('markers (MB-543, MB-551, MB-556)', () => {
    it("leaves a fragment's references to the service's whole-document check", async () => {
      await invoke(summaryEdit(`<p>62 Mt${sourceRefHtml('S4')}</p>`), {
        configurable: { agent_key: 'general' },
      });

      expect(mockPublishVersion).toHaveBeenCalledTimes(1);
    });

    it('refuses a fragment with a malformed Sources entry before reading or writing, for any agent', async () => {
      const out = await invoke(
        {
          insight_id: INSIGHT_ID,
          section: 'sources',
          html: sourcesSectionHtml([
            { id: 'S1', kind: 'web', retrieved: 'last week', feeds: 'FY2025 output', name: 'ESDM', locator: 'https://modi.esdm.go.id/' },
          ]),
        },
        { configurable: { agent_key: 'bangun' } },
      );

      expect(out).toMatch(/^Rejection: 1 malformed source or unavailable marker/);
      expect(out).toContain('data-retrieved must be the date the source was retrieved');
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPublishVersion).not.toHaveBeenCalled();
    });

    it("refuses a @dikti malformed evidence marker in a refresh run, before touching the run's draft", async () => {
      const out = await invoke(summaryEdit(`<p>${BAD_MARKER} SK 123/2024 approved the change.</p>`), {
        configurable: { ...REFRESH.configurable, agent_key: 'dikti' },
      });

      expect(out).toMatch(/^Rejection: 1 malformed evidence marker/);
      expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
    });
  });

  it('refuses a fragment cut off inside its script, splicing and publishing nothing (MB-555)', async () => {
    const out = await invoke({ insight_id: INSIGHT_ID, section: 'chart', html: makeTruncatedFragment() });

    expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
    expect(out).toContain('unclosed <script> tag');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPublishVersion).not.toHaveBeenCalled();
    expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
  });

  describe('layout warning', () => {
    const TRAP_STYLE = '<style>.deck{height:100vh;overflow:auto}</style>';
    const withDeck = (style: string) =>
      `<!DOCTYPE html><html><head>${style}</head><body><div class="deck">` +
      '<section data-section="summary"><p>Old summary</p></section>' +
      '<section data-section="details"><p>Details content</p></section>' +
      '</div></body></html>';

    it('warns, and still publishes, when the edit introduces the pattern', async () => {
      mockGet.mockResolvedValue({ id: INSIGHT_ID, name: 'Sector Brief', kind: 'document', version_no: 2, html: withDeck('') });
      const out = await invoke(summaryEdit(`${TRAP_STYLE}<p>New</p>`));

      expect(mockPublishVersion).toHaveBeenCalled();
      expect(out).toContain(`${INSIGHT_LAYOUT_WARNING_LEAD}: \`.deck\``);
      expect(out).toContain('outside this section');
    });

    it('stays quiet when the pattern was already in the document before the edit', async () => {
      mockGet.mockResolvedValue({
        id: INSIGHT_ID, name: 'Sector Brief', kind: 'document', version_no: 2, html: withDeck(TRAP_STYLE),
      });
      const out = await invoke(summaryEdit('<p>New</p>'));

      expect(mockPublishVersion).toHaveBeenCalled();
      expect(out).not.toContain(INSIGHT_LAYOUT_WARNING_LEAD);
    });
  });
});
