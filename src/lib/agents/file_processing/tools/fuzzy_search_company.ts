import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { findBestCompanyMatch } from "@/lib/fuzzySearch";
import { logger } from "../../logger";

/**
 * Fuzzy search for a company or past acquisition by name.
 */
export const fuzzySearchCompanyTool = tool(
  async ({ name }: { name: string }) => {
    logger.debug(`🔧 TOOL CALLED: fuzzy_search_company(name='${name}')`);
    try {
      const match = await findBestCompanyMatch(name);
      if (match) {
        logger.debug(`✅ Found best match: ${match.name} (${match.type}) with similarity ${match.similarity}`);
        return JSON.stringify({
          found: true,
          match: {
            id: match.id,
            name: match.name,
            type: match.type,
            similarity: match.similarity,
          },
        });
      }
      return JSON.stringify({ found: false, message: "No close match found." });
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  {
    name: "fuzzy_search_company",
    description:
      "Search for a company or past acquisition by name using fuzzy matching. Returns the closest match if found.",
    schema: z.object({
      name: z.string().describe("The name of the company to search for"),
    }),
  }
);
