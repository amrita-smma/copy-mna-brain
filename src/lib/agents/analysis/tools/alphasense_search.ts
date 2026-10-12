import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  AlphaSenseClient,
  AlphaSenseError,
  ALPHASENSE_ENV_VARS,
  readAlphaSenseCredentials,
} from "@/lib/alphasense";
import { withToolTimeout } from "../../withToolTimeout";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { getActiveWorkspaceId } from "@/lib/workspace";
import type { AlphasenseToolCallStatus } from "@/lib/services/alphasenseToolCallService";

/**
 * Poll budget for a single GenSearch run. AlphaSense answers typically land in
 * 20–90s; past this we return whatever partial markdown exists rather than
 * holding the agent turn open.
 */
export const ALPHASENSE_POLL_TIMEOUT_MS = 150_000;

/** Hard backstop above the poll budget, so a hung socket can't block the run. */
export const ALPHASENSE_TOOL_TIMEOUT_MS = 180_000;

export const alphasenseSearchSchema = z.object({
  prompt: z
    .string()
    .min(3)
    .max(2000)
    .describe(
      "The research question, written as a full natural-language question. Name the company/ticker, the metric, and the period explicitly (e.g. \"What were Apple's key Q4 2024 financial results?\").",
    ),
});

export type AlphaSenseSearchInput = z.infer<typeof alphasenseSearchSchema>;

/**
 * Persist a record of this call for historical lookback (what was asked, in
 * which chat thread, and what came back). Never allowed to fail the tool's
 * actual answer — a logging hiccup is swallowed and warned, not thrown.
 */
async function recordToolCall(input: {
  prompt: string;
  chatThreadId: string | null;
  originalQuestion: string | null;
  status: AlphasenseToolCallStatus;
  conversationId?: string | null;
  responseMarkdown?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { alphasenseToolCallService } = createContainer(db, workspaceId);
    await alphasenseToolCallService.recordCall({
      chatThreadId: input.chatThreadId,
      originalQuestion: input.originalQuestion,
      prompt: input.prompt,
      conversationId: input.conversationId,
      status: input.status,
      responseMarkdown: input.responseMarkdown,
      errorMessage: input.errorMessage,
    });
  } catch (error) {
    logger.error(`Failed to record alphasense_search tool call: ${(error as Error).message}`);
  }
}

async function runAlphaSenseSearch(
  { prompt }: AlphaSenseSearchInput,
  config?: RunnableConfig,
): Promise<string> {
  logger.debug(`🔧 TOOL CALLED: alphasense_search(prompt='${prompt}')`);

  // Both travel via the runtime config, set once at the route boundary — the
  // model never passes them in, so it can't fabricate the thread or question
  // this call is attributed to (same pattern as read_page_context's pageContext).
  const chatThreadId = (config?.configurable?.thread_id as string | undefined) ?? null;
  const originalQuestion =
    (config?.configurable?.originalUserQuestion as string | undefined) ?? null;

  const { credentials, missing } = readAlphaSenseCredentials();
  if (!credentials) {
    logger.warn(`AlphaSense not configured — missing ${missing.join(", ")}`);
    const result = `AlphaSense search is not available: ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } not set (expected ${ALPHASENSE_ENV_VARS.join(", ")}). Use valyu_search or web_search as a fallback.`;
    await recordToolCall({
      prompt,
      chatThreadId,
      originalQuestion,
      status: "not_configured",
      responseMarkdown: result,
    });
    return result;
  }

  try {
    const client = new AlphaSenseClient({ credentials });
    const answer = await client.runGenSearch(prompt, { timeoutMs: ALPHASENSE_POLL_TIMEOUT_MS });

    let result: string;
    if (!answer.markdown.trim()) {
      result = answer.timedOut
        ? `AlphaSense did not finish answering '${prompt}' within ${Math.round(
            ALPHASENSE_POLL_TIMEOUT_MS / 1000,
          )}s and returned no content yet (conversation ${answer.conversationId}). Try a narrower prompt, or fall back to valyu_search / web_search.`
        : `AlphaSense returned no content for '${prompt}'. Try rephrasing the question, or fall back to valyu_search / web_search.`;
    } else {
      const lines = [`**AlphaSense Research — '${prompt}':**`];
      if (answer.timedOut) {
        lines.push(
          `*Partial answer: generation was still at ${Math.round(
            answer.progress * 100,
          )}% when the ${Math.round(ALPHASENSE_POLL_TIMEOUT_MS / 1000)}s budget elapsed.*`,
        );
      }
      lines.push("", answer.markdown.trim());
      lines.push(
        "",
        "---",
        "*Source: AlphaSense GenSearch (broker research, filings, transcripts, expert calls, news). Inline `[[n • Source]]` markers are AlphaSense citations.*",
      );
      result = lines.join("\n");
      logger.debug(`✓ AlphaSense search completed (conversation ${answer.conversationId})`);
    }

    await recordToolCall({
      prompt,
      chatThreadId,
      originalQuestion,
      status: answer.timedOut ? "timed_out" : "success",
      conversationId: answer.conversationId,
      responseMarkdown: result,
    });
    return result;
  } catch (error) {
    const message = error instanceof AlphaSenseError ? error.message : (error as Error).message;
    logger.error(`✗ AlphaSense search error: ${message}`);
    const result = `AlphaSense search error: ${message}. Consider using valyu_search or web_search as a fallback.`;
    await recordToolCall({
      prompt,
      chatThreadId,
      originalQuestion,
      status: "error",
      errorMessage: message,
      responseMarkdown: result,
    });
    return result;
  }
}

/**
 * Search AlphaSense's premium research corpus (broker research, SEC/global
 * filings, earnings-call transcripts, expert-call transcripts, news) via the
 * Agent API's GenSearch.
 *
 * RETIRED — registered with no agent. The subscription is no longer in use, so
 * this tool was removed from every tool list in `./index.ts` and from every
 * system prompt; nothing can call it. It is kept here, exported and
 * unit-tested, so it can be put back in a tool list if the subscription ever
 * returns. The description below (and its tool-selection guidance) therefore
 * reaches no model today.
 */
export const alphasenseSearch = tool(
  withToolTimeout("alphasense_search", ALPHASENSE_TOOL_TIMEOUT_MS, runAlphaSenseSearch),
  {
    name: "alphasense_search",
    description: `Ask AlphaSense a research question and get back a cited, synthesized answer from its premium financial-research corpus: sell-side/broker research, SEC and global regulatory filings, earnings-call and expert-call transcripts, company presentations, and licensed news.

Use this tool when the question needs institutional-grade, citation-backed evidence on a public company, a sector, or a market:
- Company fundamentals and results (revenue, margins, EBITDA, guidance, segment detail) sourced from filings and transcripts
- What management or analysts actually said — earnings-call commentary, broker views, price-target/estimate context
- Sector and competitive dynamics, market sizing, pricing trends, and regulatory developments
- Diligence background and comparables for a target, holding, or fund investment

Tool selection: prefer alphasense_search when the answer should rest on filings, transcripts, or broker research; prefer valyu_search for broad multi-source/proprietary dataset research; use web_search for quick general web lookups.

Notes:
- Answers are generated asynchronously and can take up to ~2 minutes; call it once per question rather than retrying.
- Write ONE complete question per call and include the company/ticker, metric, and period. Do not pass bare keywords.
- Coverage is strongest for public companies and covered sectors; if it comes back empty, fall back to valyu_search or web_search.

Args:
    prompt: The full research question in natural language.

Returns:
    A markdown answer with AlphaSense inline citations (\`[[n • Source]]\`), or an explanatory message when AlphaSense is unavailable.`,
    schema: alphasenseSearchSchema,
  },
);
