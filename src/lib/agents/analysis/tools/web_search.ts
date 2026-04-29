import { tool } from "@langchain/core/tools";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { PastAcquisitionRepository } from "@/lib/repositories";

const PROJECT_CODENAME_PATTERN = /\bProject\s+[A-Za-z0-9][A-Za-z0-9\-]*(?:\s+[A-Za-z0-9][A-Za-z0-9\-]*){0,3}\b/gi;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function resolveProjectCodenamesForWebSearch(query: string): Promise<{
  resolvedQuery: string;
  replacements: { codename: string; companyName: string }[];
  removed: string[];
}> {
  const matches = query.match(PROJECT_CODENAME_PATTERN);
  if (!matches || matches.length === 0) {
    return { resolvedQuery: query, replacements: [], removed: [] };
  }

  let pastRepo: PastAcquisitionRepository;
  try {
    pastRepo = new PastAcquisitionRepository(createDb());
  } catch (error) {
    logger.warn(`DB not configured for codename resolution: ${(error as Error).message}`);
    return { resolvedQuery: query, replacements: [], removed: [] };
  }

  const uniqueMatches = Array.from(new Set(matches.map((m) => m.trim())));
  let resolvedQuery = query;
  const replacements: { codename: string; companyName: string }[] = [];
  const removed: string[] = [];

  for (const codename of uniqueMatches) {
    let match;
    try {
      match = await pastRepo.findByCodename(codename);
    } catch (error) {
      logger.error(`Codename lookup failed for '${codename}': ${(error as Error).message}`);
      continue;
    }

    if (match?.target_co_partner && match.target_co_partner.trim().length > 0) {
      const companyName = match.target_co_partner.trim();
      resolvedQuery = resolvedQuery.replaceAll(codename, companyName);
      replacements.push({ codename, companyName });
    } else {
      resolvedQuery = resolvedQuery.replaceAll(codename, "");
      removed.push(codename);
    }
  }

  resolvedQuery = normalizeWhitespace(resolvedQuery);
  return { resolvedQuery, replacements, removed };
}

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
      const { resolvedQuery, replacements, removed } = await resolveProjectCodenamesForWebSearch(query);
      if (!resolvedQuery) {
        return "Web search skipped because the query only contained internal project codenames that could not be resolved.";
      }
      if (replacements.length > 0 || removed.length > 0) {
        const details = [
          ...replacements.map((item) => `${item.codename} → ${item.companyName}`),
          ...removed.map((item) => `${item} → removed`),
        ];
        logger.debug(`Codename translation applied before web_search: ${details.join(", ")}`);
      }

      const client = new Anthropic({ apiKey });

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
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
            content: `Search the web for: ${resolvedQuery}\n\nProvide a summary of the most relevant and recent information you find.`,
          },
        ],
      } as any);

      const outputLines = [`**Web Search Results for '${resolvedQuery}':**\n`];
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
