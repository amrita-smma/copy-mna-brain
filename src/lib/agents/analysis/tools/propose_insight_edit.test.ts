import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSIGHT_LAYOUT_WARNING_LEAD } from '@/lib/insights/layoutCheck';

const { mockGet, mockGetActiveWorkspaceId } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGetActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mockGetActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({ insightService: { get: mockGet } })),
}));

import type { RunnableConfig } from '@langchain/core/runnables';
import type { InsightEditApprovalMarker } from '@/lib/insights/types';
import {
  proposeInsightEdit,
  INSIGHT_EDIT_APPROVAL_MARKER,
} from './propose_insight_edit';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { makeTruncatedCandidate, makeTruncatedFragment, makeValidReport } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';
import { INSIGHT_EDIT_AUTHORING_RULES } from '../guides';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

const UPDATED_HTML = `<!DOCTYPE html>
<html>
<body>
  <h1>Updated Pipeline Report</h1>
  <p>Total deals closed: 45 (revised)</p>
</body>
</html>`;

const BAD_MARKER = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';
const doc = (body: string) => `<!DOCTYPE html><html><body><h1>Output</h1>${body}</body></html>`;

async function invoke(
  args: Record<string, unknown>,
  config?: RunnableConfig,
): Promise<string> {
  return (await proposeInsightEdit.invoke(args as never, config)) as string;
}

// Decoded with the shared codec rather than a local regex: the wire format is
// a contract with ChatMessageBubble.
function payloadOf(result: string): InsightEditApprovalMarker {
  const payload = extractApprovalPayload<InsightEditApprovalMarker>(result, INSIGHT_EDIT_APPROVAL_MARKER);
  if (!payload) throw new Error(`No approval payload in result:\n${result}`);
  return payload;
}

describe('proposeInsightEdit description', () => {
  it('carries the authoring rules for the document, since the tool loads on demand', () => {
    // The chat prompts keep only the routing (INSIGHT_AUTHORING_GUIDE); the
    // mechanics travel with this tool's definition, which the API appends
    // when the model finds the tool.
    const d = proposeInsightEdit.description;
    expect(d).toContain(INSIGHT_EDIT_AUTHORING_RULES);
    expect(d).toContain('## Authoring rules for the document you submit');
    for (const rule of [
      'Complete, self-contained HTML',
      'Let the page grow',
      'Numbers are frozen at authoring time',
      'Sandboxed execution',
      'Allowed scripts & styles',
      'chart.umd.min.js',
      'Key every major block',
      'Write the document — or the section — INTO the tool call',
      'When sections are selected',
      '### Sources',
      '### Data you could not obtain',
    ]) {
      expect(d, rule).toContain(rule);
    }
    expect((proposeInsightEdit as { extras?: { defer_loading?: boolean } }).extras?.defer_loading).toBe(true);
  });

  it('tells the model to prefer a section edit and describes the fragment contract', () => {
    const d = proposeInsightEdit.description;
    expect(d).toContain('PREFER A SECTION EDIT');
    expect(d).toContain('get_insight(section: "<key>")');
    expect(d).toContain("the key on the fragment's root element; a fragment that drops it is refused");
  });
});

describe('proposeInsightEdit', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGetActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
  });

  it('never reads the database for a whole-document proposal', async () => {
    await invoke({ insight_id: VALID_UUID, summary: 'Whole', html: UPDATED_HTML });

    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns an approval payload carrying insight_id and summary without html', async () => {
    const payload = payloadOf(
      await invoke({ insight_id: VALID_UUID, summary: 'Updated deal count to 45', html: UPDATED_HTML }),
    );

    expect(payload.insight_id).toBe(VALID_UUID);
    expect(payload.summary).toBe('Updated deal count to 45');
    expect((payload as unknown as { html?: string }).html).toBeUndefined();
    expect(payload.approval_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('resolves insight_id from pageContext when omitted from arguments', async () => {
    const result = await invoke(
      { summary: 'Updated via page context', html: UPDATED_HTML },
      {
        configurable: {
          pageContext: { path: `/insight/${VALID_UUID}`, tabSlug: 'insight', insightId: VALID_UUID },
        },
      },
    );

    expect(payloadOf(result).insight_id).toBe(VALID_UUID);
  });

  it('rejects when no insight_id is provided and none in pageContext', async () => {
    const result = await invoke({ summary: 'Missing ID', html: UPDATED_HTML });

    expect(result).toContain('Cannot propose insight edit');
    expect(result).toContain('no insight is currently open in page context');
  });

  it('rejects an invalid UUID format for insight_id', async () => {
    const result = await invoke({ insight_id: 'not-a-valid-uuid', summary: 'Bad UUID', html: UPDATED_HTML });

    expect(result).toMatch(/^Rejection: .*is not a valid UUID/);
  });

  it('rejects an empty or whitespace-only summary', async () => {
    const result = await invoke({ insight_id: VALID_UUID, summary: '   ', html: UPDATED_HTML });

    expect(result).toBe('Rejection: An edit summary is required.');
  });

  it('checks a report edit against the report contract', async () => {
    const bad = await invoke({ insight_id: VALID_UUID, summary: 'Bad', html: '<p>no sections</p>', kind: 'report' });
    expect(bad).toContain('missing a <section data-section="summary"> section');

    const good = await invoke({ insight_id: VALID_UUID, summary: 'Good', html: makeValidReport().trim(), kind: 'report' });
    expect(payloadOf(good).insight_id).toBe(VALID_UUID);
  });

  it("refuses the general CoPilot's edit proposal with an estimate in an unavailable cell (MB-556)", async () => {
    const out = await invoke(
      {
        insight_id: VALID_UUID,
        summary: 'Add quota column',
        html: doc('<table><tr><td data-evidence="unavailable" data-reason="Quota letters not public">~12 Mt</td></tr></table>'),
      },
      { configurable: { agent_key: 'general' } },
    );

    expect(out).toContain('with no digits — never put an estimate in it');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('refuses a @dikti edit proposal with a malformed evidence marker, so no card is rendered (MB-543)', async () => {
    const out = await invoke(
      { insight_id: VALID_UUID, summary: 'Classify findings', html: doc(`<p>${BAD_MARKER} SK 123/2024.</p>`) },
      { configurable: { agent_key: 'dikti' } },
    );

    expect(out).toMatch(/^Rejection: 1 malformed evidence marker/);
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('refuses a truncated candidate, so no card is offered, with the MB-555 wording', async () => {
    const out = await invoke(
      { insight_id: VALID_UUID, summary: 'Add Wara', html: makeTruncatedCandidate() },
      { configurable: { agent_key: 'general' } },
    );

    expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
    expect(out).toContain('unclosed <html> tag');
    expect(out).toContain("the insight's current version stays the current version");
    expect(out).toContain('suggest the user rephrase the instruction or narrow the change');
    // The render check wins over the dangling [S1] the cut-off Sources left.
    expect(out).not.toContain('matches no Sources entry');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('still offers the card for a page container that traps its overflow, with the warning', async () => {
    const trapped =
      '<!DOCTYPE html><html><head><style>.deck{aspect-ratio:16/9;overflow:auto}</style></head>' +
      '<body><div class="deck"><p>Content</p></div></body></html>';
    const result = await invoke({ insight_id: VALID_UUID, summary: 'Widen deck', html: trapped });

    expect(payloadOf(result)).toMatchObject({ insight_id: VALID_UUID, summary: 'Widen deck' });
    expect(result).toContain(`${INSIGHT_LAYOUT_WARNING_LEAD}: \`.deck\``);
    expect(result).toContain('Propose a corrected version');
  });

  it('adds no layout warning for a page that grows with its content', async () => {
    const result = await invoke({ insight_id: VALID_UUID, summary: 'Updated deal count to 45', html: UPDATED_HTML });
    expect(result).not.toContain(INSIGHT_LAYOUT_WARNING_LEAD);
  });
});

describe('proposeInsightEdit with a section', () => {
  const CURRENT =
    '<!DOCTYPE html><html><body><h1>Brief</h1>' +
    '<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>' +
    '<section data-section="risks"><ul><li>FX</li></ul></section>' +
    '</body></html>';
  const FRAGMENT = '<section data-section="risks"><ul><li>FX</li><li>Rates</li></ul></section>';

  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ id: VALID_UUID, html: CURRENT, kind: 'document', version_no: 3 });
    mockGetActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
  });

  it('offers a card whose payload carries the section key and no html, after reading the current document', async () => {
    const result = await invoke({ insight_id: VALID_UUID, section: 'risks', summary: 'Add rates risk', html: FRAGMENT });

    expect(mockGet).toHaveBeenCalledWith('ws-1', VALID_UUID);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ insight_id: VALID_UUID, summary: 'Add rates risk', section: 'risks' });
    expect((payload as unknown as { html?: string }).html).toBeUndefined();
    expect(result).toContain('Insight section edit proposal');
    expect(result).toContain('Section: `risks`');
    expect(result).toContain('the rest of the document is unchanged');
  });

  it('resolves the insight from page context, like a whole-document edit', async () => {
    const result = await invoke(
      { section: 'risks', summary: 'Add rates risk', html: FRAGMENT },
      { configurable: { pageContext: { path: `/insight/${VALID_UUID}`, tabSlug: 'insight', insightId: VALID_UUID } } },
    );

    expect(payloadOf(result).section).toBe('risks');
  });

  it('rejects a key that is not in the document and lists the keys that are, without a card', async () => {
    const out = await invoke({ insight_id: VALID_UUID, section: 'outlook', summary: 'x', html: '<section data-section="outlook"><p>a</p></section>' });

    expect(out).toContain('Section "outlook" not found in document');
    expect(out).toContain('"summary", "risks"');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('rejects a fragment that drops its data-section key, so the block stays addressable', async () => {
    const out = await invoke({ insight_id: VALID_UUID, section: 'risks', summary: 'x', html: '<section><ul><li>FX</li></ul></section>' });

    expect(out).toContain('must keep data-section="risks"');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('refuses a truncated fragment with the section wording: resend the fragment, never the document', async () => {
    const out = await invoke({ insight_id: VALID_UUID, section: 'risks', summary: 'x', html: makeTruncatedFragment() });

    expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
    expect(out).toContain('(in the section fragment)');
    expect(out).toContain('never the whole document');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('checks the spliced document against the report contract when the insight is a report', async () => {
    mockGet.mockResolvedValue({ id: VALID_UUID, html: makeValidReport().trim(), kind: 'report', version_no: 1 });

    const out = await invoke({
      insight_id: VALID_UUID,
      section: 'summary',
      summary: 'Rewrite summary',
      html: '<section data-section="summary"><p>Too short a summary.</p></section>',
    });

    expect(out).toMatch(/^Rejection: /);
    expect(out).toContain('spliced into the current document for this check');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('refuses a fragment whose [S1] matches no Sources entry anywhere in the spliced document (MB-551)', async () => {
    const out = await invoke({
      insight_id: VALID_UUID,
      section: 'risks',
      summary: 'Cite',
      html: '<section data-section="risks"><p>FX<sup data-source-ref="S1">[S1]</sup></p></section>',
    });

    expect(out).toContain('S1');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it("refuses the general CoPilot's section with an estimate in an unavailable cell (MB-556)", async () => {
    const out = await invoke(
      {
        insight_id: VALID_UUID,
        section: 'risks',
        summary: 'Add quota',
        html: '<section data-section="risks"><table><tr><td data-evidence="unavailable" data-reason="Quota letters not public">~12 Mt</td></tr></table></section>',
      },
      { configurable: { agent_key: 'general' } },
    );

    expect(out).toContain('with no digits — never put an estimate in it');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('rejects a malformed section key before reading anything', async () => {
    const out = await invoke({ insight_id: VALID_UUID, section: 'not a key', summary: 'x', html: FRAGMENT });

    expect(out).toContain('is not a data-section key');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports an insight it cannot read instead of throwing', async () => {
    mockGet.mockRejectedValue(new Error('not found'));

    const out = await invoke({ insight_id: VALID_UUID, section: 'risks', summary: 'x', html: FRAGMENT });

    expect(out).toContain('could not be read in this workspace');
    expect(out).not.toContain(INSIGHT_EDIT_APPROVAL_MARKER);
  });

  it('treats a blank section as a whole-document edit', async () => {
    const result = await invoke({ insight_id: VALID_UUID, section: '  ', summary: 'Whole', html: UPDATED_HTML });

    expect(payloadOf(result).section).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
