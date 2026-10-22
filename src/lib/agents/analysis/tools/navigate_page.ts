import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import {
  CONSOLE_TAB_SLUGS,
  describeConsoleTabs,
  findTabBySlug,
} from '@/lib/navigation/consoleTabs';
import { resolveWorkspaceFeatureFlags } from '@/lib/features/overrides';
import {
  NAVIGATE_PAGE_MARKER,
  type NavigatePagePayload,
} from '@/lib/navigation/navigateAction';

// The marker format lives in `@/lib/navigation/navigateAction` so the chat UI
// can parse it without importing this module (and with it, LangChain and the DB
// container) into the browser bundle.
export { NAVIGATE_PAGE_MARKER };
export type { NavigatePagePayload };

export const navigatePage = tool(
  async ({ page, reason }: { page: string; reason: string }) => {
    logger.debug(`🔧 TOOL CALLED: navigate_page(page='${page}')`);

    const tab = findTabBySlug(page);
    if (!tab) {
      // Unreachable through the schema's enum, but a defensive branch beats a
      // crash if the registry and the enum ever drift.
      return `**Error:** "${page}" is not a page in this app. Valid pages: ${CONSOLE_TAB_SLUGS.join(', ')}.`;
    }

    // A workspace can switch any destination off from the admin portal. Sending
    // the user to a page their workspace has disabled would land them on an
    // section that isn't in their tab strip, so refuse and say so instead.
    const flags = await resolveWorkspaceFeatureFlags();
    if (tab.flag && flags[tab.flag] === false) {
      logger.debug(`✗ navigate_page blocked: ${tab.flag} disabled`);
      return `Cannot open **${tab.label}** — it is turned off for this workspace. Tell the user it isn't available and answer their question in chat instead.`;
    }

    const payload: NavigatePagePayload = {
      nav_id: randomUUID(),
      slug: tab.slug,
      path: tab.path,
      label: tab.label,
      reason: reason.trim(),
    };

    return [
      `Opened **${tab.label}** in the center console.`,
      ``,
      `<!-- ${NAVIGATE_PAGE_MARKER}:${JSON.stringify(payload)} -->`,
    ].join('\n');
  },
  {
    name: 'navigate_page',
    description: `Move the center console to another page in the app. The user stays in the same conversation — only the page next to the chat changes.

Use this when:
  - The user asks to go somewhere ("open the pipeline", "take me to the CRM", "show me the funds").
  - Showing a page IS the answer ("where can I see stalled deals?" → open the pipeline, "show me the CRM view" → open CRM). Do NOT navigate for "how/where do I add a company?" — there is no add-company form; answer in chat.
  - You are about to describe data the user would rather see laid out on its page.

Do NOT use this to answer a data question — query the data and answer in chat. Navigating is not a substitute for doing the work. Do not call it more than once in a turn; the last call would just override the earlier ones.

Available pages:
${describeConsoleTabs()}

Calling this navigates immediately — it is not a proposal the user confirms. After calling it, write one short sentence saying where you took them and why, then stop.

The tool REFUSES (returning a message instead of navigating) when the destination is disabled for the workspace. Surface that to the user rather than retrying another page.

Args:
    page: Required. The destination's slug, from the list above.
    reason: Required. One short clause on why this page answers the request, e.g. "to review the stalled L2 deals". Shown to the user.

Returns:
    A confirmation line, or a refusal string when the page is unavailable.`,
    schema: z.object({
      page: z
        .enum(CONSOLE_TAB_SLUGS as [string, ...string[]])
        .describe('Destination page slug.'),
      reason: z
        .string()
        .min(1)
        .max(200)
        .describe('One short clause explaining why this page answers the request.'),
    }),
  },
);
