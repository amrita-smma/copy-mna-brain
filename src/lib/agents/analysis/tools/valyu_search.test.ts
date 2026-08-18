import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchMock = vi.fn();

vi.mock("valyu-js", () => ({
  Valyu: function Valyu() {
    return { search: searchMock };
  },
}));

import { valyuSearch, valyuSearchSchema, MAX_CONTENT_LENGTH } from "./valyu_search";

beforeEach(() => {
  process.env.VALYU_API_KEY = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.VALYU_API_KEY;
});

describe("valyuSearch", () => {
  it("reports that the API key is missing when env is not configured and suggests web_search", async () => {
    delete process.env.VALYU_API_KEY;

    const result = (await valyuSearch.invoke({
      query: "How is AI transforming drug discovery?",
    })) as string;

    expect(result).toContain("VALYU_API_KEY environment variable is not set");
    expect(result).toContain("web_search");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns formatted results with citations using default options when only query is provided", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "AI in Drug Discovery",
          url: "https://example.com/ai-drug",
          content: "AI is accelerating target identification.",
          source: "web",
          relevance_score: 0.91,
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "How is AI transforming drug discovery?",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "How is AI transforming drug discovery?",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
      },
    );
    expect(result).toContain(
      "Valyu Search Results for 'How is AI transforming drug discovery?'",
    );
    expect(result).toContain("AI is accelerating target identification.");
    expect(result).toContain("[AI in Drug Discovery](https://example.com/ai-drug)");
    expect(result).toContain("CITATIONS_JSON:");
  });

  it("correctly maps all optional parameters from snake_case to SDK camelCase", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Indonesian Fintech Growth 2024",
          url: "https://example.com/fintech-id",
          content: "Series B valuations in Indonesia remained robust.",
          source: "proprietary",
          source_type: "market_research",
          publication_date: "2024-06-15",
          relevance_score: 0.89,
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "Indonesian fintech series B",
      search_type: "proprietary",
      included_sources: ["valyu/valyu-sec-filings", "dealstreetasia.com"],
      instructions: "Focus on 2024 valuations and revenue multiples",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      country_code: "ID",
      historical_cache: true,
    })) as string;

    expect(searchMock).toHaveBeenCalledWith("Indonesian fintech series B", {
      isToolCall: true,
      maxNumResults: 8,
      relevanceThreshold: 0.55,
      responseLength: "short",
      searchType: "proprietary",
      includedSources: ["valyu/valyu-sec-filings", "dealstreetasia.com"],
      instructions: "Focus on 2024 valuations and revenue multiples",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      countryCode: "ID",
      historicalCache: true,
    });

    expect(result).toContain("Indonesian Fintech Growth 2024");
    expect(result).toContain("Source: proprietary");
    expect(result).toContain("Source Type: market_research");
    expect(result).toContain("Date: 2024-06-15");
    expect(result).toContain("Relevance: 0.89");
  });

  it("formats rich result metadata including source, source_type, publication_date, relevance, and response cost/breakdown", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results_by_source: { web: 2, proprietary: 3 },
      total_deduction_dollars: 0.0045,
      total_characters: 12500,
      results: [
        {
          title: "Quarterly SEC 10-Q Filing",
          url: "https://example.com/sec/10q",
          content: "Operating margins expanded to 28.5%.",
          source: "sec-filings",
          source_type: "regulatory",
          publication_date: "2024-05-10",
          relevance_score: 0.94,
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "Company 10-Q margins",
    })) as string;

    expect(result).toContain("Sources (web: 2, proprietary: 3)");
    expect(result).toContain("Cost: $0.0045");
    expect(result).toContain("Characters: 12,500");
    expect(result).toContain("Source: sec-filings");
    expect(result).toContain("Source Type: regulatory");
    expect(result).toContain("Date: 2024-05-10");
    expect(result).toContain("Relevance: 0.94");
  });

  it("handles result with date fallback when publication_date is missing and omits absent metadata", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Bare Bones Result",
          url: "https://example.com/bare",
          content: "Simple content snippet.",
          source: "web",
          date: "2023-11-20",
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "Bare bones test",
    })) as string;

    expect(result).toContain("Date: 2023-11-20");
    expect(result).not.toContain("Source Type:");
    expect(result).not.toContain("Relevance:");
    expect(result).not.toContain("*Metadata:");
  });

  it("truncates content exceeding MAX_CONTENT_LENGTH and discloses truncation", async () => {
    const longContent = "A".repeat(MAX_CONTENT_LENGTH + 500);
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Long Research Paper",
          url: "https://example.com/long-paper",
          content: longContent,
          source: "research",
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "Long paper query",
    })) as string;

    expect(result).toContain(
      `[Content truncated: showing first ${MAX_CONTENT_LENGTH} of ${longContent.length} characters]`,
    );
    expect(result).toContain("A".repeat(MAX_CONTENT_LENGTH));
    expect(result).not.toContain("A".repeat(MAX_CONTENT_LENGTH + 1));
  });

  it("formats structured object content when content is an object instead of string", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Structured Filing Data",
          url: "https://example.com/structured",
          content: { arr: 12000000, nrr: 1.15, growth_yoy: 0.42 },
          source: "financials",
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: "Structured query",
    })) as string;

    expect(result).toContain('"arr": 12000000');
    expect(result).toContain('"nrr": 1.15');
  });

  it("handles empty search results", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [],
    });

    const result = (await valyuSearch.invoke({
      query: "unknown company xyz 123",
    })) as string;

    expect(result).toBe("No Valyu results found for 'unknown company xyz 123'.");
  });

  it("surfaces Valyu API failures and suggests web_search fallback", async () => {
    searchMock.mockResolvedValue({
      success: false,
      error: "quota exceeded",
      results: [],
    });

    const result = (await valyuSearch.invoke({ query: "PE benchmarks" })) as string;

    expect(result).toContain("Valyu search error: quota exceeded");
    expect(result).toContain("web_search");
  });

  it("handles unexpected runtime exceptions and suggests web_search fallback", async () => {
    searchMock.mockRejectedValue(new Error("Network connection reset"));

    const result = (await valyuSearch.invoke({ query: "Failing query" })) as string;

    expect(result).toContain("Valyu search error: Network connection reset");
    expect(result).toContain("web_search");
  });
});

describe("valyuSearchSchema validation", () => {
  it("accepts valid minimal and complete parameters", () => {
    const minParsed = valyuSearchSchema.safeParse({ query: "tech companies" });
    expect(minParsed.success).toBe(true);

    const fullParsed = valyuSearchSchema.safeParse({
      query: "Southeast Asian EV market",
      search_type: "news",
      included_sources: ["techinasia.com", "bloomberg.com"],
      instructions: "Focus on battery supply chain and subsidies",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      country_code: "ID",
      historical_cache: false,
    });
    expect(fullParsed.success).toBe(true);
  });

  it("rejects invalid date format", () => {
    const slashDate = valyuSearchSchema.safeParse({
      query: "test",
      start_date: "2024/01/01",
    });
    expect(slashDate.success).toBe(false);

    const invalidMonth = valyuSearchSchema.safeParse({
      query: "test",
      end_date: "2024-1-1",
    });
    expect(invalidMonth.success).toBe(false);

    const textDate = valyuSearchSchema.safeParse({
      query: "test",
      start_date: "yesterday",
    });
    expect(textDate.success).toBe(false);
  });

  it("rejects instructions exceeding 500 characters", () => {
    const longInstructions = valyuSearchSchema.safeParse({
      query: "test",
      instructions: "A".repeat(501),
    });
    expect(longInstructions.success).toBe(false);

    const maxInstructions = valyuSearchSchema.safeParse({
      query: "test",
      instructions: "A".repeat(500),
    });
    expect(maxInstructions.success).toBe(true);
  });

  it("rejects included_sources exceeding 20 items", () => {
    const tooManySources = valyuSearchSchema.safeParse({
      query: "test",
      included_sources: Array(21).fill("https://example.com"),
    });
    expect(tooManySources.success).toBe(false);

    const okSources = valyuSearchSchema.safeParse({
      query: "test",
      included_sources: Array(20).fill("https://example.com"),
    });
    expect(okSources.success).toBe(true);
  });

  it("validates supported ISO country codes and ALL", () => {
    expect(
      valyuSearchSchema.safeParse({ query: "test", country_code: "ALL" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", country_code: "ID" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", country_code: "US" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", country_code: "GB" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", country_code: "XYZ" }).success,
    ).toBe(false);
  });

  it("validates supported search_type options", () => {
    expect(
      valyuSearchSchema.safeParse({ query: "test", search_type: "all" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", search_type: "web" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", search_type: "news" }).success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", search_type: "proprietary" })
        .success,
    ).toBe(true);
    expect(
      valyuSearchSchema.safeParse({ query: "test", search_type: "invalid_type" })
        .success,
    ).toBe(false);
  });
});
