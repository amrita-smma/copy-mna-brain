import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { formatPageContext, sanitizePageContext } from '@/lib/chat/pageContext';

/**
 * read_page_context — what the user currently has on screen in the center
 * console.
 *
 * The client sends the context with each turn and `/api/chat` puts the
 * sanitized value on the runtime config, the same way `thread_id` and
 * `userEmail` travel. The model never passes it in, so it can't fabricate a
 * page the user isn't on.
 */
export const readPageContext = tool(
  async (_args: Record<string, never>, runtime?: RunnableConfig) => {
    logger.debug('🔧 TOOL CALLED: read_page_context()');

    // Already sanitized at the route boundary; re-running it here keeps the
    // tool honest when invoked from anywhere else (tests, workforce).
    const context = sanitizePageContext(runtime?.configurable?.pageContext);
    if (!context) {
      return 'The user is in the full-screen chat and does not have a page open. Ask which page or record they mean if the question depends on it.';
    }
    return formatPageContext(context);
  },
  {
    name: 'read_page_context',
    description: `Find out which page the user is currently looking at, and what is on it.

Call this FIRST — before querying anything — whenever the request points at the screen rather than naming its subject:
  - "summarize this", "what am I looking at", "explain this page"
  - "this deal", "this company", "these results", "the ones I'm filtering"
  - Any follow-up whose subject is only resolvable from what's on screen.

Returns the page name, its path, and (when the page reports it) the specific record or filters in view — e.g. which deal is open, or which stage the pipeline is filtered to. Use that to scope your follow-up queries instead of guessing or asking the user to repeat themselves.

When a deal is open it also returns that company's \`company_id\`. Pass that id VERBATIM to every tool that accepts one (get_company_details, update_company_card_section, …) and do NOT look the company up by name — a name lookup is fuzzy and resolves to the wrong record when two companies have near-identical names.

Takes no arguments. When the user is in the full-screen chat with no page open, it says so — in that case ask what they're referring to rather than assuming.`,
    schema: z.object({}),
  },
);
