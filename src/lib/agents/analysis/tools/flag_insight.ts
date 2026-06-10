import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
} from '@/lib/repositories';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';

/**
 * flag_insight — email the task owner an opportunity insight (MB-90,
 * criterion #5B): a company passing a key screening milestone (e.g. "NovaSpec
 * Materials passes L1 criteria, 94% confidence").
 *
 * Recipient is resolved from the run's LangGraph thread_id (== queue row id) on
 * the runtime config — never passed by the model. Workforce-only.
 */
function extractRunId(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.thread_id;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export const flagInsight = tool(
  async (
    args: {
      company_name: string;
      level: string;
      detail?: string;
      confidence_pct?: number;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug(
      `🔧 TOOL CALLED: flag_insight(company_name='${args.company_name}', level='${args.level}')`,
    );

    const runId = extractRunId(runtime);
    if (!runId) {
      return 'No run context is available; insight notification skipped.';
    }
    if (!args.company_name?.trim()) {
      return '**Error:** company_name is required.';
    }
    if (!args.level?.trim()) {
      return '**Error:** level is required (e.g. "L1").';
    }

    try {
      const db = createDb();
      const notifier = new EmailNotificationService({
        workforceRepo: new AiWorkforceQueueRepository(db),
        routinesRepo: new RoutinesRepository(db),
        userRepo: new UserRepository(db),
      });
      const sent = await notifier.notifyTaskInsight(runId, {
        companyName: args.company_name,
        level: args.level,
        detail: args.detail,
        confidencePct: args.confidence_pct,
      });
      return sent
        ? `Insight emailed to the task owner: ${args.company_name} passes ${args.level}.`
        : 'Insight not sent (notifications disabled or no recipient on file).';
    } catch (error) {
      logger.error(`flag_insight failed: ${(error as Error).message}`);
      return `**Error:** Could not send insight — ${(error as Error).message}`;
    }
  },
  {
    name: 'flag_insight',
    description: `Email the task owner an opportunity insight when a company passes a key screening milestone (e.g. clears L1). Recipient is resolved from the run — you do NOT pass an email.

Use this for genuinely notable outcomes a human would want pushed to their inbox, not routine status — for ongoing status use notify_progress.

Args:
    company_name: Required. The company that passed the milestone.
    level: Required. The screening level it cleared, e.g. "L0", "L1", "L2".
    detail: Optional one-line rationale, e.g. "Revenue $112M, EBITDA margin 24%, strong comparables".
    confidence_pct: Optional 0–100 confidence shown in the subject/body.

Returns:
    A short confirmation string, or an error string starting with **Error:**.`,
    schema: z.object({
      company_name: z
        .string()
        .min(1)
        .describe('Company that passed the screening milestone.'),
      level: z
        .string()
        .min(1)
        .describe('Screening level cleared, e.g. "L1".'),
      detail: z
        .string()
        .max(400)
        .optional()
        .describe('Optional one-line rationale shown in the email body.'),
      confidence_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Optional confidence percentage (0–100).'),
    }),
  },
);
