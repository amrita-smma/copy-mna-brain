import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AlphaSenseClient,
  AlphaSenseError,
  ALPHASENSE_ENV_VARS,
  readAlphaSenseCredentials,
} from "@/lib/alphasense";
import { withToolTimeout } from "../../withToolTimeout";
import { logger } from "../../logger";

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

async function runAlphaSenseSearch({ prompt }: AlphaSenseSearchInput): Promise<string> {
  logger.debug(`🔧 TOOL CALLED: alphasense_search(prompt='${prompt}')`);

  const { credentials, missing } = readAlphaSenseCredentials();
  if (!credentials) {
    logger.warn(`AlphaSense not configured — missing ${missing.join(", ")}`);
    return `AlphaSense search is not available: ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } not set (expected ${ALPHASENSE_ENV_VARS.join(", ")}). Use valyu_search or web_search as a fallback.`;
  }

  try {
    const client = new AlphaSenseClient({ credentials });
    const answer = await client.runGenSearch(prompt, { timeoutMs: ALPHASENSE_POLL_TIMEOUT_MS });

    if (!answer.markdown.trim()) {
      return answer.timedOut
        ? `AlphaSense did not finish answering '${prompt}' within ${Math.round(
            ALPHASENSE_POLL_TIMEOUT_MS / 1000,
          )}s and returned no content yet (conversation ${answer.conversationId}). Try a narrower prompt, or fall back to valyu_search / web_search.`
        : `AlphaSense returned no content for '${prompt}'. Try rephrasing the question, or fall back to valyu_search / web_search.`;
    }

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

    logger.debug(`✓ AlphaSense search completed (conversation ${answer.conversationId})`);
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof AlphaSenseError ? error.message : (error as Error).message;
    logger.error(`✗ AlphaSense search error: ${message}`);
    return `AlphaSense search error: ${message}. Consider using valyu_search or web_search as a fallback.`;
  }
}

/**
 * Search AlphaSense's premium research corpus (broker research, SEC/global
 * filings, earnings-call transcripts, expert-call transcripts, news) via the
 * Agent API's GenSearch. Registered for every agent flavor: M&A chat,
 * workforce, investment, combined, and VC.
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

Tool selection: prefer alphasense_search when the answer should rest on filings, transcripts, or broker research; prefer valyu_search for broad multi-source/proprietary dataset research; use web_search for quick general web lookups. Use search_news first for recent market news that the internal news lake may already cover.

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
