import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Valyu } from "valyu-js";
import { logger } from "../../logger";

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Search Valyu.ai for web + proprietary data (filings, market data, research).
 * Available to the Funds & Investing and Combined Copilot flavors.
 */
export const valyuSearch = tool(
  async ({ query }: { query: string }) => {
    logger.debug(`🔧 TOOL CALLED: valyu_search(query='${query}')`);

    const apiKey = process.env.VALYU_API_KEY;
    if (!apiKey) {
      logger.warn("VALYU_API_KEY not set");
      return "Valyu search is not available. VALYU_API_KEY environment variable is not set.";
    }

    try {
      const valyu = new Valyu(apiKey);
      const response = await valyu.search(query, {});

      if (!response.success) {
        const err = response.error || "Unknown Valyu search error";
        logger.error(`✗ Valyu search failed: ${err}`);
        return `Valyu search error: ${err}`;
      }

      if (!response.results?.length) {
        return `No Valyu results found for '${query}'.`;
      }

      const outputLines = [`**Valyu Search Results for '${query}':**\n`];
      const citations: { title: string; url: string }[] = [];

      response.results.forEach((result, i) => {
        const title = result.title || result.url || `Result ${i + 1}`;
        const url = result.url || "";
        const body = formatContent(result.content).trim();
        const snippet =
          body.length > 1200 ? `${body.slice(0, 1200).trimEnd()}…` : body;

        outputLines.push(`### ${i + 1}. ${title}`);
        if (url) outputLines.push(`URL: ${url}`);
        if (result.source) outputLines.push(`Source: ${result.source}`);
        if (result.relevance_score != null) {
          outputLines.push(`Relevance: ${result.relevance_score.toFixed(2)}`);
        }
        if (snippet) outputLines.push(`\n${snippet}\n`);

        if (url && !citations.some((c) => c.url === url)) {
          citations.push({ title, url });
        }
      });

      if (citations.length > 0) {
        outputLines.push("\n---\n**Sources:**");
        citations.forEach((c, i) => {
          outputLines.push(`${i + 1}. [${c.title}](${c.url})`);
        });
        outputLines.push(`\n\n<!-- CITATIONS_JSON:${JSON.stringify(citations)} -->`);
      }

      logger.debug(`✓ Valyu search completed with ${citations.length} citations`);
      return outputLines.join("\n");
    } catch (error) {
      logger.error(`✗ Valyu search error: ${(error as Error).message}`);
      return `Valyu search error: ${(error as Error).message}`;
    }
  },
  {
    name: "valyu_search",
    description: `Search Valyu.ai across the web and proprietary data sources (financial filings, market data, research, news) for investment research.

Prefer this tool over web_search when the question needs deep financial/market research, SEC/filings-style sources, academic or proprietary datasets, or richer cited context than a general web crawl.

IMPORTANT: Use this tool when the user asks about:
- Fund/deal comparables, fundraising, vintage benchmarks, or private-market context
- Company financials, filings, market data, or sector research not in the workspace
- Macro conditions, industry trends, or diligence background for a holding
- Any external research where citations and proprietary sources matter

Args:
    query: A specific search query. Include relevant details like fund/sector names,
           metrics (IRR, TVPI, multiples), geography, and time frame.

Returns:
    Search results from Valyu with content snippets and source links.`,
    schema: z.object({
      query: z.string().describe("The search query for Valyu search"),
    }),
  },
);
