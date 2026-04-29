import { tool } from "@langchain/core/tools";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { InvenCacheRepository } from "@/lib/repositories";

/**
 * Parse a natural language search prompt into structured Inven API filters using Claude.
 */
export async function parseSearchPromptToInvenFilters(prompt: string): Promise<{
  prompt?: string;
  keywords?: { keyword: string; weight: number }[];
  headquarters?: { countryCode: string }[];
  headcount?: { min?: number; max?: number };
  employeeCount?: { min?: number; max?: number };
  revenueEstimateUsdMillions?: { min?: number; max?: number };
  ownership?: string[];
  foundedYear?: { min?: number; max?: number };
}> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    logger.warn("ANTHROPIC_API_KEY not set, using prompt only");
    return { prompt };
  }

  try {
    const client = new Anthropic({ apiKey: anthropicApiKey });

    const systemPrompt = `You are a filter parser for the Inven company search API.
Given a natural language search query, extract structured filters.

Available filters:
- prompt: The main search description (industry, company type, etc.)
- keywords: Array of {keyword: string, weight: 1-3} for specific terms
- headquarters: Array of {countryCode: "XX"} using ISO 3166-1 alpha-2 codes (e.g., US, KR, JP, CN, DE, GB, FR)
- headcount: {min, max} for employee range
- employeeCount: {min, max} for exact employee count
- revenueEstimateUsdMillions: {min, max} in USD millions
- ownership: Array of "corporate", "public", "private_equity", "private_unknown", "venture_capital", "other"
- foundedYear: {min, max} for founding year

Enterprise Value approximation: If EV is mentioned, estimate revenue as EV/5 to EV/10 for typical multiples.

Country codes examples: US (United States), KR (Korea), JP (Japan), CN (China), DE (Germany), GB (UK), FR (France), ID (Indonesia), TW (Taiwan), SG (Singapore), IN (India), AU (Australia)

Respond ONLY with a valid JSON object, no explanation.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Parse this search query into Inven API filters:\n\n"${prompt}"`,
        },
      ],
    });

    const textContent = response.content.find((b) => b.type === "text");
    if (!textContent || textContent.type !== "text") {
      return { prompt };
    }

    let jsonStr = textContent.text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
    }

    const filters = JSON.parse(jsonStr);
    logger.debug(`✓ Parsed filters: ${JSON.stringify(filters)}`);
    return filters;
  } catch (error) {
    logger.error(`Filter parsing error: ${(error as Error).message}`);
    return { prompt };
  }
}

/**
 * Inven Paid Data Source Search
 * Searches for companies using Inven's AI-powered search.
 * Parses natural language into structured filters, then uses cache-first approach.
 */
export const invenPaidDataSourceSearch = tool(
  async ({
    search_prompt,
    number_of_results = 10,
  }: {
    search_prompt: string;
    number_of_results?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: inven_paid_data_source_search(prompt='${search_prompt}', limit=${number_of_results})`
    );

    try {
      const invenRepo = new InvenCacheRepository(createDb());

      let cachedResults: Awaited<ReturnType<typeof invenRepo.searchByNameOrDescription>> = [];
      try {
        cachedResults = await invenRepo.searchByNameOrDescription(search_prompt, number_of_results);
      } catch (cacheError) {
        logger.warn(`Inven cache lookup failed: ${(cacheError as Error).message}`);
      }

      if (cachedResults.length > 0) {
        logger.debug(`✓ Found ${cachedResults.length} cached results`);

        const rows = cachedResults.map((c) =>
          `${c.inven_company_name || "N/A"} | ${c.domain || "-"} | ${c.website || "-"} | ${c.inven_company_id}`
        );

        let result = `**Cached Results (${cachedResults.length} companies):**\n\n`;
        result += `| Company Name | Domain | Website | Inven Company ID |\n`;
        result += `| --- | --- | --- | --- |\n`;
        result += rows.map((row) => `| ${row} |`).join("\n");
        result += `\n\n*Note: Results from cache. Use inven_paid_data_source_enrichment to get full details.*`;

        return result;
      }

      const apiKey = process.env.INVEN_API_KEY;
      if (!apiKey) {
        logger.warn("INVEN_API_KEY not set");
        return "Inven search is not available. INVEN_API_KEY environment variable is not set.";
      }

      logger.debug("Parsing search prompt into structured filters...");
      const parsedFilters = await parseSearchPromptToInvenFilters(search_prompt);

      const filters: Record<string, unknown> = {};

      if (parsedFilters.prompt) {
        filters.prompt = parsedFilters.prompt;
      }
      if (parsedFilters.keywords && parsedFilters.keywords.length > 0) {
        filters.keywords = parsedFilters.keywords;
      }
      if (parsedFilters.headquarters && parsedFilters.headquarters.length > 0) {
        filters.headquarters = parsedFilters.headquarters;
      }
      if (parsedFilters.headcount && (parsedFilters.headcount.min || parsedFilters.headcount.max)) {
        filters.headcount = parsedFilters.headcount;
      }
      if (parsedFilters.employeeCount && (parsedFilters.employeeCount.min || parsedFilters.employeeCount.max)) {
        filters.employeeCount = parsedFilters.employeeCount;
      }
      if (parsedFilters.revenueEstimateUsdMillions && (parsedFilters.revenueEstimateUsdMillions.min || parsedFilters.revenueEstimateUsdMillions.max)) {
        filters.revenueEstimateUsdMillions = parsedFilters.revenueEstimateUsdMillions;
      }
      if (parsedFilters.ownership && parsedFilters.ownership.length > 0) {
        filters.ownership = parsedFilters.ownership;
      }
      if (parsedFilters.foundedYear && (parsedFilters.foundedYear.min || parsedFilters.foundedYear.max)) {
        filters.foundedYear = parsedFilters.foundedYear;
      }

      logger.debug(`Calling Inven API with filters: ${JSON.stringify(filters)}`);

      const response = await fetch("https://api.inven.ai/public-api/v1/company-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          filters,
          numberOfResults: number_of_results,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Inven API error: ${response.status} - ${errorText}`);
        return `**Inven API Error:** ${response.status} - ${errorText}`;
      }

      const data = await response.json();
      const companies = data.companies || [];

      if (companies.length === 0) {
        return `No companies found matching: "${search_prompt}"\n\nFilters applied: ${JSON.stringify(filters, null, 2)}`;
      }

      const rows = companies.map((c: { companyName: string; domain: string; website: string; companyId: string }) =>
        `${c.companyName || "N/A"} | ${c.domain || "-"} | ${c.website || "-"} | ${c.companyId}`
      );

      let result = `**Inven Search Results (${companies.length} companies):**\n\n`;
      result += `| Company Name | Domain | Website | Inven Company ID |\n`;
      result += `| --- | --- | --- | --- |\n`;
      result += rows.map((row: string) => `| ${row} |`).join("\n");
      result += `\n\n**Filters Applied:**\n\`\`\`json\n${JSON.stringify(filters, null, 2)}\n\`\`\``;
      result += `\n\n*Use inven_paid_data_source_enrichment with the Inven Company IDs to get detailed data and save to cache.*`;

      logger.debug(`✓ Inven search returned ${companies.length} companies`);
      return result;
    } catch (error) {
      logger.error(`Inven search error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "inven_paid_data_source_search",
    description: `Search for companies using Inven's AI-powered company search.
Use this tool for Screening and Sourcing scenarios when you need to find companies.
The tool automatically parses natural language into structured filters (headquarters, revenue, headcount, etc.) before calling the API.
It first checks the local cache, then falls back to the Inven API.

Examples of search prompts:
- "Petrochemical companies in Korea with enterprise value less than USD 1 billion"
- "Technology company in the US with headcount of above 100 and revenue below USD 50 million"
- "Solar panel companies in Germany with revenue above 10 million"
- "Get me the company ID of Exxon Mobil"

Supported filters extracted from prompts:
- Industry/sector keywords
- Headquarters country (converted to ISO-2 codes)
- Revenue ranges (in USD millions)
- Employee count / headcount ranges
- Ownership type (public, private, VC-backed, etc.)
- Founded year ranges

Args:
    search_prompt: A specific natural language search prompt describing the companies you want to find
    number_of_results: Maximum number of results to return (default: 10)

Returns:
    A table of matching companies with Company ID, Domain, Name, and Website for further enrichment.`,
    schema: z.object({
      search_prompt: z.string().describe("Natural language search prompt for finding companies"),
      number_of_results: z.number().optional().default(10).describe("Maximum number of results to return"),
    }),
  }
);
