import { describe, expect, it } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { InsightRefreshApprovalPayload } from '@/lib/insights/types';
import {
  INSIGHT_REFRESH_APPROVAL_MARKER,
  MAX_REFRESH_REASON_CHARS,
  proposeInsightRefresh,
} from './propose_insight_refresh';
import {
  INSIGHT_APPROVAL_MARKERS,
  extractApprovalPayload,
  stripApprovalMarkers,
} from '@/lib/insights/approvalMarker';

const INSIGHT_ID = '11111111-2222-4333-8444-555555555555';
const PAGE_INSIGHT_ID = '66666666-7777-4888-9999-000000000000';

async function invoke(args: Record<string, unknown>, config?: RunnableConfig): Promise<string> {
  return (await proposeInsightRefresh.invoke(args as never, config)) as string;
}

function payloadOf(result: string): InsightRefreshApprovalPayload {
  const payload = extractApprovalPayload<InsightRefreshApprovalPayload>(result, INSIGHT_REFRESH_APPROVAL_MARKER);
  if (!payload) throw new Error(`No approval payload in result:\n${result}`);
  return payload;
}

describe('proposeInsightRefresh', () => {
  it('returns a card payload with the insight id and the reason, and writes nothing', async () => {
    const out = await invoke({
      insight_id: INSIGHT_ID,
      reason: 'FY2025 output: insight v3 (2026-09-01) shows 62.1 Mt; ESDM (retrieved 2026-09-24) reports 68.4 Mt.',
    });

    const payload = payloadOf(out);
    expect(payload.insight_id).toBe(INSIGHT_ID);
    expect(payload.reason).toBe(
      'FY2025 output: insight v3 (2026-09-01) shows 62.1 Mt; ESDM (retrieved 2026-09-24) reports 68.4 Mt.',
    );
    expect(payload.approval_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).toMatch(/^Insight refresh offered: \*\*FY2025 output/);
  });

  it('defaults to the insight open in page context', async () => {
    const out = await invoke(
      { reason: 'Quota changed' },
      { configurable: { pageContext: { tab: 'insights', path: `/insight/${PAGE_INSIGHT_ID}`, insightId: PAGE_INSIGHT_ID } } },
    );
    expect(payloadOf(out).insight_id).toBe(PAGE_INSIGHT_ID);
  });

  it('refuses without an insight, with a non-UUID id, or without a reason', async () => {
    expect(await invoke({ reason: 'x' })).toContain('Cannot propose insight refresh: no insight is currently open');
    expect(await invoke({ insight_id: 'abc', reason: 'x' })).toBe('Rejection: insight_id "abc" is not a valid UUID.');
    const noReason = await invoke({ insight_id: INSIGHT_ID, reason: '  \n ' });
    expect(noReason).toMatch(/^Rejection: A reason is required/);
    expect(noReason).not.toContain(INSIGHT_REFRESH_APPROVAL_MARKER);
  });

  it('collapses whitespace and caps a long reason', async () => {
    const out = await invoke({ insight_id: INSIGHT_ID, reason: `a\n\n${'b'.repeat(MAX_REFRESH_REASON_CHARS * 2)}` });
    const { reason } = payloadOf(out);
    expect(reason.startsWith('a b')).toBe(true);
    expect(reason).toHaveLength(MAX_REFRESH_REASON_CHARS);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('uses a marker the chat strips from prose', async () => {
    expect(INSIGHT_APPROVAL_MARKERS).toContain(INSIGHT_REFRESH_APPROVAL_MARKER);
    const out = await invoke({ insight_id: INSIGHT_ID, reason: 'Stale' });
    expect(stripApprovalMarkers(out)).not.toContain(INSIGHT_REFRESH_APPROVAL_MARKER);
  });
});
