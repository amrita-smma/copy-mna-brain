import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INSIGHT_BYTES } from '@/lib/insights/srcdoc';
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

import { replaceInsightDocument } from './replace_insight_document';
import { makeTruncatedCandidate } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';
import { sourceRefHtml, sourcesSectionHtml } from '@/lib/agents/sector/evidenceMarkers';

const INSIGHT_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_INSIGHT_ID = '99999999-8888-7777-6666-555555555555';
const VALID_HTML = '<!DOCTYPE html><html><body><h1>Updated Document</h1><p>Full content</p></body></html>';
const REFRESH = { configurable: { run_id: 'run-123', refresh_insight_id: INSIGHT_ID } };

const BAD_MARKER = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';
const doc = (body: string) => `<!DOCTYPE html><html><body><h1>Updated Document</h1>${body}</body></html>`;

function invoke(args: Record<string, unknown>, config?: Record<string, unknown>): Promise<string> {
  return replaceInsightDocument.invoke(args as never, config) as Promise<string>;
}

describe('replaceInsightDocument tool', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({
      id: INSIGHT_ID,
      name: 'Sector Brief',
      kind: 'document',
      version_no: 2,
      html: '<html><body>old</body></html>',
    });
    mockPublishVersion.mockReset().mockResolvedValue({ id: INSIGHT_ID, name: 'Sector Brief', version_no: 3 });
    mockApplyRunDraftEdit.mockReset();
    mockGetActiveWorkspaceIdOrThrow.mockReset().mockResolvedValue('ws-1');
  });

  it('publishes version with trigger workforce and sourceRunId in a non-refresh run', async () => {
    const out = await invoke(
      { insight_id: INSIGHT_ID, html: VALID_HTML, summary: 'Complete rewrite' },
      { configurable: { run_id: 'run-456', triggered_by_user_id: 'user-1' } },
    );

    expect(mockGet).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
    expect(mockPublishVersion).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      insightId: INSIGHT_ID,
      html: VALID_HTML,
      label: 'Complete rewrite',
      userId: 'user-1',
      baseVersionNo: 2,
      trigger: 'workforce',
      sourceRunId: 'run-456',
      agentStamp: null,
    });
    expect(out).toBe(
      `Replaced the document of insight **Sector Brief** (version 3) — [open it](/insight/${INSIGHT_ID})`,
    );
  });

  it('routes to applyRunDraftEdit in a refresh run and does not publish version', async () => {
    mockApplyRunDraftEdit.mockResolvedValue({
      insightId: INSIGHT_ID,
      insightName: 'Sector Brief',
      baseVersionNo: 3,
    });

    const out = await invoke({ insight_id: INSIGHT_ID, html: VALID_HTML }, REFRESH);

    expect(mockApplyRunDraftEdit).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      runId: 'run-123',
      insightId: INSIGHT_ID,
      edit: { kind: 'document', html: VALID_HTML },
    });
    expect(mockPublishVersion).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(out).toBe(
      'Replaced the document of insight **Sector Brief** in this refresh run\'s draft (based on version 3). Nothing is published until the run completes.',
    );
  });

  it('rejects editing a different insight in a refresh run with no service write', async () => {
    const out = await invoke({ insight_id: OTHER_INSIGHT_ID, html: VALID_HTML }, REFRESH);

    expect(out).toBe(
      `Rejection: This run is a scheduled refresh of insight ${INSIGHT_ID}; it can only write to that insight.`,
    );
    expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
    expect(mockPublishVersion).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['StaleInsightVersionError', new StaleInsightVersionError(INSIGHT_ID, 1, 2)],
    ['InsightValidationError', new InsightValidationError('Document structure is invalid')],
    ['InsightPayloadTooLargeError', new InsightPayloadTooLargeError('Too large')],
    ['InsightNotFoundError', new InsightNotFoundError(INSIGHT_ID)],
  ])('turns a %s into a Rejection message', async (_name, err) => {
    mockPublishVersion.mockRejectedValue(err);

    const out = await invoke({ insight_id: INSIGHT_ID, html: VALID_HTML });

    expect(out).toBe(`Rejection: ${err.message}`);
  });

  it.each([
    [{ insight_id: '' }, 'Rejection: An insight_id is required.'],
    [{ insight_id: 'not-a-uuid' }, 'Rejection: insight_id "not-a-uuid" is not a valid UUID.'],
    [{ html: '   ' }, 'Rejection: No HTML document provided.'],
    [{ html: 'x'.repeat(MAX_INSIGHT_BYTES + 1) }, `Rejection: HTML document exceeds maximum size of ${MAX_INSIGHT_BYTES} bytes.`],
  ])('rejects bad arguments before reading the insight', async (override, expected) => {
    expect(await invoke({ insight_id: INSIGHT_ID, html: VALID_HTML, ...override })).toBe(expected);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPublishVersion).not.toHaveBeenCalled();
  });

  it('rejects placeholder documents on the direct path', async () => {
    const out = await invoke({ insight_id: INSIGHT_ID, html: 'PLACEHOLDER' });

    expect(out).toContain('Rejection:');
    expect(mockPublishVersion).not.toHaveBeenCalled();
  });

  it("stamps the version with the thread's agent from configurable.agent_key", async () => {
    await invoke({ insight_id: INSIGHT_ID, html: VALID_HTML }, { configurable: { agent_key: 'minerba' } });

    expect(mockPublishVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentStamp: { agentKey: 'minerba' },
      }),
    );
  });

  describe('markers (MB-543, MB-551, MB-556)', () => {
    it("refuses the general CoPilot's replace with a dangling reference and writes nothing", async () => {
      const out = await invoke({
        insight_id: INSIGHT_ID,
        html: doc(
          `<p>62 Mt${sourceRefHtml('S3')}</p>${sourcesSectionHtml([
            { id: 'S1', kind: 'web', retrieved: '2026-09-01', feeds: 'FY2025 output', name: 'ESDM', locator: 'https://modi.esdm.go.id/' },
          ])}`,
        ),
      });

      expect(out).toMatch(/^Rejection: 1 malformed source or unavailable marker/);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPublishVersion).not.toHaveBeenCalled();
      expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
    });

    it('refuses a @dikti replace with a malformed evidence marker and writes nothing', async () => {
      const out = await invoke(
        { insight_id: INSIGHT_ID, html: doc(`<p>${BAD_MARKER} SK 123/2024 approved the change.</p>`) },
        { configurable: { agent_key: 'dikti' } },
      );

      expect(out).toMatch(/^Rejection: 1 malformed evidence marker/);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPublishVersion).not.toHaveBeenCalled();
    });
  });

  describe('render check (MB-555)', () => {
    it('refuses a truncated document, publishing nothing and leaving the current version current', async () => {
      const out = await invoke({ insight_id: INSIGHT_ID, html: makeTruncatedCandidate() });

      expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
      expect(out).toContain("the insight's current version stays the current version");
      expect(out).not.toContain('matches no Sources entry');
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPublishVersion).not.toHaveBeenCalled();
    });

    it("refuses a truncated document in a refresh run without touching the run's draft", async () => {
      const out = await invoke({ insight_id: INSIGHT_ID, html: makeTruncatedCandidate() }, REFRESH);

      expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
      expect(mockApplyRunDraftEdit).not.toHaveBeenCalled();
    });
  });
});
