import { tool } from "@langchain/core/tools";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../logger";

/**
 * Search the web for market data, industry benchmarks, and external information.
 */
export const webSearch = tool(
  async ({ query }: { query: string }) => {
    logger.debug(`🔧 TOOL CALLED: web_search(query='${query}')`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn("ANTHROPIC_API_KEY not set");
      return "Web search is not available. ANTHROPIC_API_KEY environment variable is not set.";
    }

    try {
      const client = new Anthropic({ apiKey });

      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
          },
        ],
        messages: [
          {
            role: "user",
            content: `Search the web for: ${query}\n\nProvide a summary of the most relevant and recent information you find.`,
          },
        ],
      } as any);

      const outputLines = [`**Web Search Results for '${query}':**\n`];
      const citations: { title: string; url: string }[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          outputLines.push(block.text);

          if ((block as any).citations && Array.isArray((block as any).citations)) {
            for (const citation of (block as any).citations) {
              if (citation.url && !citations.some(c => c.url === citation.url)) {
                citations.push({
                  title: citation.title || citation.url,
                  url: citation.url,
                });
              }
            }
          }
        }

        const blockType = (block as any).type;
        if (blockType === "web_search_tool_result" || blockType === "tool_result") {
          const content = (block as any).content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "web_search_result" && item.url) {
                if (!citations.some(c => c.url === item.url)) {
                  citations.push({
                    title: item.title || item.url,
                    url: item.url,
                  });
                }
              }
            }
          }
        }
      }

      if (citations.length > 0) {
        outputLines.push("\n\n---\n**Sources:**");
        citations.forEach((c, i) => {
          outputLines.push(`${i + 1}. [${c.title}](${c.url})`);
        });

        outputLines.push(`\n\n<!-- CITATIONS_JSON:${JSON.stringify(citations)} -->`);
      }

      logger.debug(`✓ Web search completed with ${citations.length} citations`);
      return outputLines.length > 1 ? outputLines.join("\n") : "No results found.";
    } catch (error) {
      logger.error(`✗ Web search error: ${(error as Error).message}`);
      return `Web search error: ${(error as Error).message}`;
    }
  },
  {
    name: "web_search",
    description: `Search the web for market data, industry benchmarks, and external information.

IMPORTANT: Use this tool when the user asks about:
- Market comparisons or industry benchmarks (e.g., "compare to market", "industry average")
- Valuation multiples or typical deal metrics (e.g., "EBITDA multiples", "revenue multiples")
- Competitor analysis or market positioning
- Current market trends, news, or recent developments
- External validation of data (e.g., "public financials", "market cap")
- M&A activity, deal comparables, or acquisition trends in a sector
- Any question containing: "market", "industry", "benchmark", "comparable", "peers", "external"

Args:
    query: A specific search query. Include relevant details like:
           - Industry or sector name
           - Company names if relevant
           - Specific metrics (EBITDA, revenue, multiples)
           - Time frame (e.g., "2025", "recent")

Returns:
    Search results from the web with relevant market data and context.`,
    schema: z.object({
      query: z.string().describe("The search query for web search"),
    }),
  }
);
