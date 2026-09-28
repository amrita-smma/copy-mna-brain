import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import {
  type ReportPlanApprovalPayload,
  type ReportPlanQuestion,
  validateReportPlan,
} from '@/lib/reports/plan';
import {
  REPORT_PLAN_APPROVAL_MARKER,
  encodeApprovalMarker,
} from '@/lib/insights/approvalMarker';

export { REPORT_PLAN_APPROVAL_MARKER };

export const proposeReportPlan = tool(
  async ({
    request,
    methodology,
    questions,
  }: {
    request: string;
    methodology: string;
    questions?: Array<{
      question: string;
      options: Array<{
        label: string;
        recommended?: boolean;
      }>;
    }>;
  }) => {
    logger.debug('🔧 TOOL CALLED: propose_report_plan()');

    const trimmedRequest = request?.trim() ?? '';
    if (!trimmedRequest) {
      return 'Rejection: A request description is required.';
    }

    const trimmedMethodology = methodology?.trim() ?? '';
    if (!trimmedMethodology) {
      return 'Rejection: A methodology is required.';
    }

    const rawQuestions = questions ?? [];
    const mappedQuestions: ReportPlanQuestion[] = rawQuestions.map((q, idx) => ({
      id: `q${idx + 1}`,
      question: q.question?.trim() ?? '',
      options: (q.options ?? []).map((opt) => ({
        label: opt.label?.trim() ?? '',
        ...(opt.recommended !== undefined ? { recommended: Boolean(opt.recommended) } : {}),
      })),
    }));

    const problem = validateReportPlan({
      request: trimmedRequest,
      methodology: trimmedMethodology,
      questions: mappedQuestions,
    });

    if (problem) {
      return `Rejection: ${problem}`;
    }

    const payload: ReportPlanApprovalPayload = {
      approval_id: randomUUID(),
      request: trimmedRequest,
      methodology: trimmedMethodology,
      questions: mappedQuestions,
    };

    const lines = [
      `Report plan proposal: **${payload.request}**`,
      '',
      payload.methodology,
      '',
      encodeApprovalMarker(REPORT_PLAN_APPROVAL_MARKER, payload),
    ];

    return lines.filter((l) => l !== undefined).join('\n');
  },
  {
    name: 'propose_report_plan',
    description: `Propose a methodology and clarifying questions for a report before researching or building it, via an approval card.

Calling this tool does NOT generate the report or perform data queries. It renders a proposal the user can review, answer questions on, and confirm.

Use this tool FIRST whenever the user asks for a report (as opposed to a dashboard or an interactive tool), before doing research or calling data tools.

State the methodology plainly: what will be compared, against what, over what period, and what is deliberately excluded.
Ask at most three clarifying questions with 2-4 selectable options where different answers would genuinely change the analysis. Mark the sensible default as recommended. If the request is already unambiguous, pass an empty questions array.

Once the plan is confirmed, decide WHERE the report gets built before you start. If it spans many sections or scores more entities than you can finish in one turn, call propose_workforce_handoff and pass the confirmed methodology as the instruction — the plan you just agreed is exactly the brief the Workforce needs. Build it inline only when it genuinely fits one turn.`,
    schema: z.object({
      request: z
        .string()
        .describe('One line restating what the user asked for'),
      methodology: z
        .string()
        .describe('The approach the agent intends to take'),
      questions: z
        .array(
          z.object({
            question: z.string().describe('The clarifying question'),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Option label'),
                  recommended: z
                    .boolean()
                    .optional()
                    .describe('Whether this option is recommended'),
                }),
              )
              .describe('Selectable options for this question'),
          }),
        )
        .max(3)
        .optional()
        .describe('Up to 3 clarifying questions with selectable options'),
    }),
  },
);
