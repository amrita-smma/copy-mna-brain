import { describe, expect, it } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { InsightEditApprovalMarker } from '@/lib/insights/types';
import {
  proposeInsightEdit,
  INSIGHT_EDIT_APPROVAL_MARKER,
} from './propose_insight_edit';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { makeTruncatedCandidate, makeValidReport } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';

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

describe('proposeInsightEdit', () => {
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
});
