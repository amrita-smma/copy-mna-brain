import { describe, expect, it } from 'vitest';
import type { InsightCreateApprovalMarker } from '@/lib/insights/types';
import {
  proposeInsightCreate,
  INSIGHT_CREATE_APPROVAL_MARKER,
} from './propose_insight_create';
import { makeTruncatedCandidate, makeValidReport } from '@/lib/insights/testFixtures';
import { RENDER_CHECK_REFUSAL_LEAD } from '@/lib/insights/structuralCheck';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { sourceRefHtml } from '@/lib/agents/sector/evidenceMarkers';

const VALID_HTML = `<!DOCTYPE html>
<html>
<body>
  <h1>Quarterly Pipeline Report</h1>
  <p>Total deals closed: 42</p>
  <script>console.log("insight loaded");</script>
</body>
</html>`;

const BAD_MARKER = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';

async function invoke(args: Record<string, unknown>, agentKey?: string): Promise<string> {
  const config = agentKey ? { configurable: { agent_key: agentKey } } : undefined;
  return (await proposeInsightCreate.invoke(args as never, config)) as string;
}

// Decoded with the shared codec rather than a local regex: the wire format is
// a contract with ChatMessageBubble.
function payloadOf(result: string): InsightCreateApprovalMarker {
  const payload = extractApprovalPayload<InsightCreateApprovalMarker>(result, INSIGHT_CREATE_APPROVAL_MARKER);
  if (!payload) throw new Error(`No approval payload in result:\n${result}`);
  return payload;
}

describe('proposeInsightCreate', () => {
  it('returns an approval payload carrying the name and description without html', async () => {
    const payload = payloadOf(
      await invoke({
        name: 'Quarterly Pipeline Report',
        description: 'Overview of Q3 deals and metrics.',
        html: VALID_HTML,
      }),
    );

    expect(payload.name).toBe('Quarterly Pipeline Report');
    expect(payload.description).toBe('Overview of Q3 deals and metrics.');
    expect((payload as unknown as { html?: string }).html).toBeUndefined();
    expect(payload.kind).toBe('document');
    expect(payload.approval_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('carries the template_id on the approval payload for the card to send on', async () => {
    const templateId = '66666666-7777-4888-9999-000000000000';
    const payload = payloadOf(
      await invoke({ name: 'Sector Brief', html: VALID_HTML, template_id: templateId }),
    );

    expect(payload.template_id).toBe(templateId);
  });

  it('leaves template_id off the payload when none is given', async () => {
    const payload = payloadOf(await invoke({ name: 'Sector Brief', html: VALID_HTML }));

    expect(payload).not.toHaveProperty('template_id');
  });

  it('drops a template_id that is not a uuid and still proposes', async () => {
    const payload = payloadOf(
      await invoke({ name: 'Sector Brief', html: VALID_HTML, template_id: 'sector-brief' }),
    );

    expect(payload.name).toBe('Sector Brief');
    expect(payload).not.toHaveProperty('template_id');
  });

  it('defaults the description to an empty string', async () => {
    expect(payloadOf(await invoke({ name: 'Pipeline Report', html: VALID_HTML })).description).toBe('');
  });

  it('rejects a blank name', async () => {
    const result = await invoke({ name: '   ', html: VALID_HTML });

    expect(result).toMatch(/^Rejection: .*name is required/i);
    expect(result).not.toContain(INSIGHT_CREATE_APPROVAL_MARKER);
  });

  it('checks a report against the report contract and carries its kind', async () => {
    const bad = await invoke({ name: 'Bad Report', html: '<p>no sections</p>', kind: 'report' });
    expect(bad).toContain('missing a <section data-section="summary"> section');

    const good = payloadOf(await invoke({ name: 'Valid Report', html: makeValidReport().trim(), kind: 'report' }));
    expect(good.kind).toBe('report');
  });

  it("refuses any agent's proposal with a dangling source reference, so no card is rendered (MB-551)", async () => {
    const out = await invoke({
      name: 'Output',
      html: `<!DOCTYPE html><html><body><p>62 Mt${sourceRefHtml('S2')}</p></body></html>`,
    });

    expect(out).toMatch(/^Rejection: 1 malformed source or unavailable marker/);
    expect(out).not.toContain(INSIGHT_CREATE_APPROVAL_MARKER);
  });

  it('refuses a @dikti proposal with a malformed evidence marker, so no card is rendered (MB-543)', async () => {
    const out = await invoke(
      { name: 'Campus control', html: `<!DOCTYPE html><html><body><p>${BAD_MARKER} SK 123/2024.</p></body></html>` },
      'dikti',
    );

    expect(out).toMatch(/^Rejection: 1 malformed evidence marker/);
    expect(out).not.toContain(INSIGHT_CREATE_APPROVAL_MARKER);
  });

  it('refuses a truncated candidate, so no card is offered, with the MB-555 wording', async () => {
    const out = await invoke({ name: 'Output', html: makeTruncatedCandidate() }, 'minerba');

    expect(out.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
    expect(out).toContain('unclosed <html> tag');
    expect(out).toContain('no insight was created');
    expect(out).toContain('suggest the user rephrase the request or narrow it');
    expect(out).not.toContain('matches no Sources entry');
    expect(out).not.toContain(INSIGHT_CREATE_APPROVAL_MARKER);
  });
});
