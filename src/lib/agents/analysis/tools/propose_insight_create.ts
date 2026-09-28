import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import type { InsightCreateApprovalMarker, InsightKind } from '@/lib/insights/types';
import {
  INSIGHT_CREATE_APPROVAL_MARKER,
  encodeApprovalMarker,
} from '@/lib/insights/approvalMarker';
import {
  insightCreateSchema,
  validateInsightCreate,
} from '@/lib/insights/toolValidation';
import { insightMarkerRefusal } from '@/lib/agents/sector/evidenceMarkers';
import { isUuid } from '@/lib/uuid';

export { INSIGHT_CREATE_APPROVAL_MARKER };

export const proposeInsightCreate = tool(
  async (
    {
      name,
      description,
      html,
      kind = 'document',
      template_id,
    }: {
      name: string;
      description?: string;
      html: string;
      kind?: InsightKind;
      template_id?: string;
    },
    runtime?: RunnableConfig,
  ) => {
    logger.debug('🔧 TOOL CALLED: propose_insight_create()');

    // The render check (MB-555) runs first, so a truncated candidate is never
    // offered and the refusal tells the agent to report it to the user.
    const validation = validateInsightCreate(name, html, kind, 'create-proposal');
    if ('error' in validation) {
      return validation.error;
    }
    const { name: trimmedName, html: trimmedHtml } = validation;

    // Every write must carry well-formed source and unavailable markers
    // (MB-551/556), a @dikti write also evidence markers (MB-543). The
    // approval card writes this HTML as-is, so check it here, where the agent
    // can still fix it.
    const markerRefusal = insightMarkerRefusal(trimmedHtml, runtime?.configurable?.agent_key);
    if (markerRefusal) {
      return markerRefusal;
    }

    const payload: InsightCreateApprovalMarker = {
      approval_id: randomUUID(),
      name: trimmedName,
      description: description?.trim() ?? '',
      kind,
      // The approval card sends it on to the create, which records it as the
      // insight's source template. A malformed id is dropped, not refused.
      ...(template_id && isUuid(template_id) ? { template_id } : {}),
    };

    const lines = [
      `New insight proposal: **${payload.name}**`,
      '',
      payload.description ? `${payload.description}\n` : '',
      encodeApprovalMarker(INSIGHT_CREATE_APPROVAL_MARKER, payload),
    ];

    return lines.filter((l) => l !== undefined).join('\n');
  },
  {
    name: 'propose_insight_create',
    description: `Propose a NEW insight from a description, via an approval card.

Calling this tool does NOT write anything. It renders a proposal the user can
preview and approve; approving creates the insight and opens it.

Use this when the user asks for a new insight, report, visual dashboard, or
interactive tool ("build me a dashboard showing…", "create an insight for…").
To change an insight that already exists, use propose_insight_edit instead.

Write the WHOLE document: a complete, self-contained HTML document (including
<style>, <script>, inline SVG, whatever the page needs). Query the data tools
first and bake the numbers into the HTML as literal text.

Give every major block a data-section="kebab-key" attribute — e.g.
<section data-section="valuation-bridge">. The reader can click these to point
you at one part of the insight in a follow-up question, and the keys they pick
arrive in your page context. Keys must match [A-Za-z0-9_-]+, be unique in the
document, and name what the block IS ("risk-summary", not "section-3"). Nothing
enforces this and the document renders fine without it — a document with no
keys simply cannot be pointed at.

When the document is built on an insight template, pass its template_id so the
new insight records which template it came from.`,
    schema: insightCreateSchema,
  },
);
