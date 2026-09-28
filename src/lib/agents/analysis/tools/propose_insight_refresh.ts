import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import type { InsightRefreshApprovalPayload } from '@/lib/insights/types';
import {
  INSIGHT_REFRESH_APPROVAL_MARKER,
  encodeApprovalMarker,
} from '@/lib/insights/approvalMarker';
import { resolveInsightId } from '@/lib/insights/toolValidation';

export { INSIGHT_REFRESH_APPROVAL_MARKER };

/** A reason longer than this is cut; the card shows it verbatim. */
export const MAX_REFRESH_REASON_CHARS = 500;

/**
 * Offer to refresh the open insight (MB-552 AC3). Chat-only: renders the
 * "Refresh this insight now" card and writes nothing. Accepting it calls
 * `POST /api/insights/[id]/refresh-now`, which runs the insight's refresh
 * routine now or queues a one-off refresh run.
 */
export const proposeInsightRefresh = tool(
  async (
    { insight_id, reason }: { insight_id?: string; reason: string },
    runtime?: RunnableConfig,
  ) => {
    logger.debug('🔧 TOOL CALLED: propose_insight_refresh()');

    const resolution = resolveInsightId(
      'propose insight refresh',
      insight_id,
      runtime?.configurable?.pageContext,
    );
    if ('error' in resolution) {
      return resolution.error;
    }

    const trimmedReason = (reason ?? '').replace(/\s+/g, ' ').trim();
    if (!trimmedReason) {
      return 'Rejection: A reason is required — say which figure is stale and what the newer value is.';
    }

    const payload: InsightRefreshApprovalPayload = {
      approval_id: randomUUID(),
      insight_id: resolution.id,
      reason:
        trimmedReason.length > MAX_REFRESH_REASON_CHARS
          ? `${trimmedReason.slice(0, MAX_REFRESH_REASON_CHARS - 1)}…`
          : trimmedReason,
    };

    return [
      `Insight refresh offered: **${payload.reason}**`,
      '',
      `Target insight: \`${payload.insight_id}\``,
      '',
      encodeApprovalMarker(INSIGHT_REFRESH_APPROVAL_MARKER, payload),
    ].join('\n');
  },
  {
    name: 'propose_insight_refresh',
    description: `Offer to refresh an insight now, via a "Refresh this insight now" card.

Call it after you have shown the user a figure you retrieved that differs materially from the figure the open insight shows (both values, with their dates), so the insight is stale. Calling this tool does NOT refresh anything: it renders a card, and only if the user accepts does the insight's refresh run (on its refresh routine if it has one, otherwise as a one-off refresh), publishing a new version when it finishes.

After calling it, write one short sentence pointing at the card and STOP. Do not edit the insight yourself to "fix" the figure — the refresh re-fetches every source.

Defaults to the insight open in page context.`,
    schema: z.object({
      insight_id: z
        .string()
        .optional()
        .describe('Target insight UUID. Defaults to the insight open in page context.'),
      reason: z
        .string()
        .describe(
          'One sentence: which figure is stale, the insight value and date, and the newer value, source and date.',
        ),
    }),
  },
);
