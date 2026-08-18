import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Valyu, type CountryCode, type SearchOptions, type SearchType } from "valyu-js";
import { logger } from "../../logger";

export const VALYU_COUNTRY_CODES = [
  "ALL",
  "AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI",
  "FR", "DE", "HK", "IN", "ID", "IT", "JP", "KR", "MY", "MX",
  "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA",
  "ES", "SE", "CH", "TW", "TR", "GB", "US",
] as const;

export const MAX_CONTENT_LENGTH = 3000;

export const valyuSearchSchema = z.object({
  query: z.string().describe("The search query for Valyu search"),
  search_type: z
    .enum(["all", "web", "news", "proprietary"])
    .optional()
    .default("all")
    .describe("Type of search: 'all', 'web', 'news', or 'proprietary' (default: 'all')"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Bounded list of source domains, URLs, dataset IDs, or presets to include (max 20)"),
  instructions: z
    .string()
    .max(500)
    .optional()
    .describe("Optional search guidance or context (max 500 characters)"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("End date filter in YYYY-MM-DD format"),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("ISO 3166-1 alpha-2 country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type ValyuSearchInput = z.infer<typeof valyuSearchSchema>;

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export interface ExecuteValyuSearchOptions {
  query: string;
  search_type?: SearchType;
  included_sources?: string[];
  instructions?: string;
  start_date?: string;
  end_date?: string;
  country_code?: CountryCode | "ALL";
  historical_cache?: boolean;
  headerTitle?: string;
  emptyMessage?: string;
  toolName?: string;
}

/**
 * Reusable, typed Valyu search runner shared between generic valyuSearch and VC topic research tools.
 */
export async function executeValyuSearch({
  query,
  search_type = "all",
  included_sources,
  instructions,
  start_date,
  end_date,
  country_code,
  historical_cache,
  headerTitle,
  emptyMessage,
  toolName = "valyu_search",
}: ExecuteValyuSearchOptions): Promise<string> {
  logger.debug(`🔧 TOOL CALLED: ${toolName}(query='${query}')`);

  const apiKey = process.env.VALYU_API_KEY;
  if (!apiKey) {
    logger.warn("VALYU_API_KEY not set");
    return "Valyu search is not available. VALYU_API_KEY environment variable is not set. Use web_search as a fallback.";
  }

  try {
    const valyu = new Valyu(apiKey);
    const searchOptions: SearchOptions = {
      isToolCall: true,
      maxNumResults: 8,
      relevanceThreshold: 0.55,
      responseLength: "short",
      searchType: (search_type as SearchType) || "all",
    };

    if (included_sources && included_sources.length > 0) {
      searchOptions.includedSources = included_sources;
    }
    if (instructions) {
      searchOptions.instructions = instructions;
    }
    if (start_date) {
      searchOptions.startDate = start_date;
    }
    if (end_date) {
      searchOptions.endDate = end_date;
    }
    if (country_code) {
      searchOptions.countryCode = country_code as CountryCode;
    }
    if (historical_cache !== undefined) {
      searchOptions.historicalCache = historical_cache;
    }

    const response = await valyu.search(query, searchOptions);

    if (!response.success) {
      const err = response.error || "Unknown Valyu search error";
      logger.error(`✗ Valyu search failed: ${err}`);
      return `Valyu search error: ${err}. Consider using web_search as a fallback.`;
    }

    if (!response.results?.length) {
      return emptyMessage ?? `No Valyu results found for '${query}'.`;
    }

    const header = headerTitle ? `**${headerTitle}:**` : `**Valyu Search Results for '${query}':**`;
    const outputLines = [header];

    // Response-level metadata summary
    const metaDetails: string[] = [];
    if (response.results_by_source) {
      const webCount = response.results_by_source.web;
      const propCount = response.results_by_source.proprietary;
      const breakdown: string[] = [];
      if (typeof webCount === "number") breakdown.push(`web: ${webCount}`);
      if (typeof propCount === "number") breakdown.push(`proprietary: ${propCount}`);
      if (breakdown.length > 0) {
        metaDetails.push(`Sources (${breakdown.join(", ")})`);
      }
    }
    if (typeof response.total_deduction_dollars === "number") {
      metaDetails.push(`Cost: $${response.total_deduction_dollars.toFixed(4)}`);
    }
    if (typeof response.total_characters === "number") {
      metaDetails.push(`Characters: ${response.total_characters.toLocaleString()}`);
    }
    if (metaDetails.length > 0) {
      outputLines.push(`*Metadata: ${metaDetails.join(" | ")}*`);
    }
    outputLines.push("");

    const citations: { title: string; url: string }[] = [];

    response.results.forEach((result, i) => {
      const title = result.title || result.url || `Result ${i + 1}`;
      const url = result.url || "";
      const body = formatContent(result.content ?? result.description ?? "").trim();
      const isTruncated = body.length > MAX_CONTENT_LENGTH;
      const snippet = isTruncated
        ? `${body.slice(0, MAX_CONTENT_LENGTH).trimEnd()}…\n[Content truncated: showing first ${MAX_CONTENT_LENGTH} of ${body.length} characters]`
        : body;

      outputLines.push(`### ${i + 1}. ${title}`);
      if (url) outputLines.push(`URL: ${url}`);
      if (result.source) outputLines.push(`Source: ${result.source}`);
      if (result.source_type) outputLines.push(`Source Type: ${result.source_type}`);
      const dateVal = result.publication_date || result.date;
      if (dateVal) outputLines.push(`Date: ${dateVal}`);
      if (result.relevance_score != null && typeof result.relevance_score === "number") {
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
    const msg = (error as Error).message;
    logger.error(`✗ Valyu search error: ${msg}`);
    return `Valyu search error: ${msg}. Consider using web_search as a fallback.`;
  }
}

/**
 * Search Valyu.ai across web, news, and proprietary data sources (financial filings, market data, research).
 * Available to the Funds & Investing, Combined, and VC Copilot flavors.
 */
export const valyuSearch = tool(
  async (input: ValyuSearchInput) =>
    executeValyuSearch({ ...input, query: input.query ?? "" }),
  {
    name: "valyu_search",
    description: `Search Valyu.ai across web, news, and proprietary data sources (financial filings, company data, legal/regulatory, market research) for investment diligence and research.

Prefer this tool over web_search when the question needs deep financial/market research, SEC/filings-style sources, academic or proprietary datasets, or richer cited context than a general web crawl.

IMPORTANT: Use this tool when researching:
- Fund/deal comparables, fundraising, vintage benchmarks, or private-market context
- Company financials, filings, publicly disclosed ownership/funding information, legal/regulatory records, or sector research
- Market data, industry trends, news, or diligence background for a holding/company
- Any external research where citations and proprietary sources matter

Args:
    query: A specific search query. Include relevant details like company/fund names,
           metrics (IRR, TVPI, multiples, revenue), geography, and time frame.
    search_type: Source category filter: 'all', 'web', 'news', or 'proprietary' (default: 'all').
    included_sources: Specific domains, URLs, dataset IDs (e.g., 'valyu/valyu-sec-filings'), or presets to search (max 20).
    instructions: Optional instructions to guide source retrieval and focus (max 500 chars).
    start_date: Earliest date filter in YYYY-MM-DD format.
    end_date: Latest date filter in YYYY-MM-DD format.
    country_code: Country ISO code filter (e.g. 'US', 'GB', 'ID', 'ALL').
    historical_cache: Set to true with a date range to retrieve cached historical snapshots.

Returns:
    Factual search results from Valyu with source metadata, content evidence, and citations.`,
    schema: valyuSearchSchema,
  },
);
