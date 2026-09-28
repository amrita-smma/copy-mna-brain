import { describe, expect, it } from 'vitest';
import { proposeReportPlan } from './propose_report_plan';
import {
  REPORT_PLAN_APPROVAL_MARKER,
  extractApprovalPayload,
} from '@/lib/insights/approvalMarker';
import type { ReportPlanApprovalPayload } from '@/lib/reports/plan';

const BASE = { request: 'Valid request', methodology: 'Valid methodology.', questions: [] };

async function invoke(args: Record<string, unknown>): Promise<string> {
  return (await proposeReportPlan.invoke({ ...BASE, ...args } as never)) as string;
}

const payloadOf = (result: string) =>
  extractApprovalPayload<ReportPlanApprovalPayload>(result, REPORT_PLAN_APPROVAL_MARKER);

describe('propose_report_plan', () => {
  it('emits an approval marker and payload with auto-generated question ids when valid', async () => {
    const result = await invoke({
      request: 'Compare foundry margins across TSMC and Samsung',
      methodology: 'Compare gross and operating margins from 2020 to 2024, excluding non-operating items.',
      questions: [
        {
          question: 'Should packaging services be included?',
          options: [
            { label: 'Yes, include advanced packaging', recommended: true },
            { label: 'No, pure wafer fabrication only' },
          ],
        },
        {
          question: 'Which currency basis?',
          options: [{ label: 'USD (constant FX)' }, { label: 'Reported local currency', recommended: true }],
        },
      ],
    });

    expect(result).toContain('Report plan proposal: **Compare foundry margins across TSMC and Samsung**');
    const payload = payloadOf(result);
    expect(payload?.approval_id).toBeDefined();
    expect(payload?.request).toBe('Compare foundry margins across TSMC and Samsung');
    expect(payload?.methodology).toContain('Compare gross and operating margins');
    expect(payload?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(payload?.questions[0].options[0]).toEqual({
      label: 'Yes, include advanced packaging',
      recommended: true,
    });
  });

  it('accepts plans with zero questions when the request is unambiguous', async () => {
    expect(payloadOf(await invoke({}))?.questions).toEqual([]);
  });

  it.each([
    [{ request: '   ' }, 'Rejection: A request description is required.'],
    [{ methodology: '   ' }, 'Rejection: A methodology is required.'],
  ])('rejects %o', async (override, expected) => {
    expect(await invoke(override)).toBe(expected);
  });

  it.each([
    ['fewer than 2 options', [{ label: 'Only one option' }], 'between 2 and 4 options'],
    ['more than 4 options', ['1', '2', '3', '4', '5'].map((label) => ({ label })), 'between 2 and 4 options'],
    [
      'more than one recommended option',
      [{ label: 'Opt 1', recommended: true }, { label: 'Opt 2', recommended: true }],
      'At most one option per question can be marked recommended',
    ],
  ])('rejects questions with %s', async (_label, options, expected) => {
    const result = await invoke({ questions: [{ question: 'Which?', options }] });

    expect(result).toMatch(/^Rejection:/);
    expect(result).toContain(expected);
  });
});
