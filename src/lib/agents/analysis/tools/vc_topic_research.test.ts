import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchMock = vi.fn();

vi.mock("valyu-js", () => ({
  Valyu: function Valyu() {
    return { search: searchMock };
  },
}));

vi.mock("@/lib/agents/analysis", () => ({
  getStatelessAgentGraph: vi.fn(),
  getWorkforceAgentGraphForEffort: vi.fn(),
  getAgentGraph: vi.fn(),
  createLocalAgent: vi.fn(),
  AgentGraph: vi.fn(),
}));

import {
  getCompanyProfile,
  getCompanyProfileSchema,
  getSectorContext,
  getSectorContextSchema,
  getCompetitorLandscape,
  getCompetitorLandscapeSchema,
  getRegulatoryContext,
  getRegulatoryContextSchema,
  getMarketSignals,
  getMarketSignalsSchema,
} from "./vc_topic_research";

import {
  tools as baseTools,
  chatOnlyTools,
  workforceOnlyTools,
  investmentTools,
  combinedTools,
  vcTools,
} from "./index";

function parseAndValidateCitations(output: string): Array<{ title: string; url: string }> {
  const match = output.match(/<!-- CITATIONS_JSON:(.+?) -->/);
  expect(match).not.toBeNull();
  const parsed = JSON.parse(match![1]);
  expect(Array.isArray(parsed)).toBe(true);
  for (const item of parsed) {
    expect(item).toHaveProperty("title");
    expect(typeof item.title).toBe("string");
    expect(item).toHaveProperty("url");
    expect(typeof item.url).toBe("string");
  }
  return parsed;
}

beforeEach(() => {
  process.env.VALYU_API_KEY = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.VALYU_API_KEY;
});

describe("get_company_profile", () => {
  it("reports missing VALYU_API_KEY and suggests web_search", async () => {
    delete process.env.VALYU_API_KEY;
    const res = (await getCompanyProfile.invoke({
      company_name: "Stripe",
    })) as string;
    expect(res).toContain("VALYU_API_KEY environment variable is not set");
    expect(res).toContain("web_search");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("constructs default profile query and instructions from company_name and produces valid citations", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Stripe Company Overview",
          url: "https://example.com/stripe",
          content: "Stripe is a financial infrastructure platform for businesses.",
          source: "web",
          source_type: "corporate_website",
          publication_date: "2024-01-15",
          relevance_score: 0.95,
        },
      ],
    });

    const res = (await getCompanyProfile.invoke({
      company_name: "Stripe",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "Stripe company profile overview business model founders team funding traction",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on company overview, founders, leadership team, business model, product traction, and disclosed funding history for Stripe.",
      },
    );

    expect(res).toContain("External Evidence (Company Profile for 'Stripe'):");
    expect(res).toContain("Stripe Company Overview");
    expect(res).toContain("URL: https://example.com/stripe");
    expect(res).toContain("Source: web");
    expect(res).toContain("Source Type: corporate_website");
    expect(res).toContain("Date: 2024-01-15");
    expect(res).toContain("Relevance: 0.95");
    expect(res).toContain("[Stripe Company Overview](https://example.com/stripe)");

    const citations = parseAndValidateCitations(res);
    expect(citations).toEqual([
      {
        title: "Stripe Company Overview",
        url: "https://example.com/stripe",
        published: "2024-01-15",
      },
    ]);
  });

  it("applies query_focus, date range, country filter, and sources", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [],
    });

    await getCompanyProfile.invoke({
      company_name: "Databricks",
      query_focus: "Series I funding valuation and revenue ARR",
      country_code: "US",
      start_date: "2023-01-01",
      end_date: "2024-12-31",
      included_sources: ["techcrunch.com", "bloomberg.com"],
      historical_cache: true,
    });

    expect(searchMock).toHaveBeenCalledWith(
      "Databricks Series I funding valuation and revenue ARR",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on company profile and overview for Databricks, specifically: Series I funding valuation and revenue ARR.",
        countryCode: "US",
        startDate: "2023-01-01",
        endDate: "2024-12-31",
        includedSources: ["techcrunch.com", "bloomberg.com"],
        historicalCache: true,
      },
    );
  });

  it("handles empty results gracefully", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [],
    });

    const res = (await getCompanyProfile.invoke({
      company_name: "Nonexistent Stealth Startup",
    })) as string;

    expect(res).toContain("No Valyu results found for");
    expect(res).toContain("web_search");
  });

  it("handles provider failure and suggests web_search", async () => {
    searchMock.mockResolvedValue({
      success: false,
      error: "Rate limit reached",
    });

    const res = (await getCompanyProfile.invoke({
      company_name: "Acme Corp",
    })) as string;

    expect(res).toContain("Valyu search error: Rate limit reached");
    expect(res).toContain("web_search");
  });

  it("handles runtime exception and suggests web_search", async () => {
    searchMock.mockRejectedValue(new Error("Connection timeout"));

    const res = (await getCompanyProfile.invoke({
      company_name: "Acme Corp",
    })) as string;

    expect(res).toContain("Valyu search error: Connection timeout");
    expect(res).toContain("web_search");
  });

  it("validates schema input constraints and trims company_name", () => {
    expect(getCompanyProfileSchema.safeParse({ company_name: "Stripe" }).success).toBe(true);
    expect(getCompanyProfileSchema.safeParse({ company_name: "  Stripe  " }).data?.company_name).toBe("Stripe");
    expect(getCompanyProfileSchema.safeParse({ company_name: "" }).success).toBe(false);
    expect(getCompanyProfileSchema.safeParse({ company_name: "   " }).success).toBe(false);
    expect(
      getCompanyProfileSchema.safeParse({
        company_name: "Stripe",
        start_date: "invalid-date",
      }).success,
    ).toBe(false);
    expect(
      getCompanyProfileSchema.safeParse({
        company_name: "Stripe",
        query_focus: "a".repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe("get_sector_context", () => {
  it("constructs sector query, instructions, and parses citations", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Southeast Asia B2B SaaS Report 2024",
          url: "https://example.com/sea-saas",
          content: "The market is growing at a 25% CAGR.",
          source: "proprietary",
          source_type: "research_report",
          date: "2024-05-10",
        },
      ],
      results_by_source: { web: 0, proprietary: 1 },
      total_deduction_dollars: 0.0025,
      total_characters: 1500,
    });

    const res = (await getSectorContext.invoke({
      sector: "B2B SaaS in Southeast Asia",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "B2B SaaS in Southeast Asia market size industry growth trends CAGR headwinds tailwinds",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on market sizing, CAGR, industry drivers, secular trends, headwinds, tailwinds, and growth dynamics for B2B SaaS in Southeast Asia.",
      },
    );

    expect(res).toContain("External Evidence (Sector Context for 'B2B SaaS in Southeast Asia'):");
    expect(res).toContain(
      "*Metadata: Sources (web: 0, proprietary: 1) | Cost: $0.0025 | Characters: 1,500*",
    );
    expect(res).toContain("The market is growing at a 25% CAGR.");
    expect(res).toContain("Date: 2024-05-10");

    const citations = parseAndValidateCitations(res);
    expect(citations).toEqual([
      {
        title: "Southeast Asia B2B SaaS Report 2024",
        url: "https://example.com/sea-saas",
        published: "2024-05-10",
      },
    ]);
  });

  it("applies query_focus when provided", async () => {
    searchMock.mockResolvedValue({ success: true, results: [] });

    await getSectorContext.invoke({
      sector: "Space Tech",
      query_focus: "Launch costs per kg trends and satellite constellations",
    });

    expect(searchMock).toHaveBeenCalledWith(
      "Space Tech Launch costs per kg trends and satellite constellations",
      expect.objectContaining({
        instructions:
          "Focus on sector context for Space Tech, specifically: Launch costs per kg trends and satellite constellations.",
      }),
    );
  });

  it("validates schema input constraints and trims sector", () => {
    expect(getSectorContextSchema.safeParse({ sector: "Fintech" }).success).toBe(true);
    expect(getSectorContextSchema.safeParse({ sector: "  Fintech  " }).data?.sector).toBe("Fintech");
    expect(getSectorContextSchema.safeParse({ sector: "" }).success).toBe(false);
    expect(getSectorContextSchema.safeParse({ sector: "   " }).success).toBe(false);
  });
});

describe("get_competitor_landscape", () => {
  it("constructs default query with only required inputs (no competitors, no focus)", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Stripe Overview & Competitors",
          url: "https://example.com/stripe-comp",
          content: "Stripe competes against Adyen and Square in payment processing.",
        },
      ],
    });

    const res = (await getCompetitorLandscape.invoke({
      company_or_sector: "Stripe",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "Stripe competitors competitive landscape market share alternatives differentiation",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on direct and indirect competitors, competitive positioning, alternatives, market share, and differentiation for Stripe.",
      },
    );

    expect(res).toContain("External Evidence (Competitor Landscape for 'Stripe'):");
    const citations = parseAndValidateCitations(res);
    expect(citations).toEqual([
      {
        title: "Stripe Overview & Competitors",
        url: "https://example.com/stripe-comp",
      },
    ]);
  });

  it("constructs query with competitor list and default terms", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Payments Market Share 2024",
          url: "https://example.com/payments-share",
          content: "Stripe and Adyen lead global enterprise merchant processing.",
        },
      ],
    });

    const res = (await getCompetitorLandscape.invoke({
      company_or_sector: "Stripe",
      competitors: ["Adyen", "Checkout.com", "Square"],
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "Stripe Adyen Checkout.com Square competitors competitive landscape market share alternatives differentiation",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on direct and indirect competitors, competitive positioning, alternatives, market share, and differentiation for Stripe compared with Adyen, Checkout.com, Square.",
      },
    );

    expect(res).toContain("External Evidence (Competitor Landscape for 'Stripe'):");
    expect(res).toContain("Stripe and Adyen lead global enterprise merchant processing.");
  });

  it("validates schema input constraints and trims company_or_sector", () => {
    expect(
      getCompetitorLandscapeSchema.safeParse({
        company_or_sector: "Stripe",
        competitors: ["Adyen"],
      }).success,
    ).toBe(true);
    expect(
      getCompetitorLandscapeSchema.safeParse({
        company_or_sector: "  Stripe  ",
      }).data?.company_or_sector,
    ).toBe("Stripe");
    expect(getCompetitorLandscapeSchema.safeParse({ company_or_sector: "" }).success).toBe(false);
    expect(getCompetitorLandscapeSchema.safeParse({ company_or_sector: "   " }).success).toBe(false);
    expect(
      getCompetitorLandscapeSchema.safeParse({
        company_or_sector: "Stripe",
        competitors: Array(11).fill("Competitor"),
      }).success,
    ).toBe(false);
  });
});

describe("get_regulatory_context", () => {
  it("constructs default query with only required inputs (no jurisdiction, no focus)", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Autonomous Vehicles Regulatory Framework",
          url: "https://example.com/av-reg",
          content: "Autonomous vehicle regulations vary across federal and state levels.",
        },
      ],
    });

    const res = (await getRegulatoryContext.invoke({
      topic_or_sector: "Autonomous Vehicles",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "Autonomous Vehicles regulatory framework compliance legal requirements licensing rules",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on regulatory requirements, legal frameworks, compliance obligations, licensing rules, and regulatory developments for Autonomous Vehicles.",
      },
    );

    expect(res).toContain("External Evidence (Regulatory Context for 'Autonomous Vehicles'):");
    const citations = parseAndValidateCitations(res);
    expect(citations).toEqual([
      {
        title: "Autonomous Vehicles Regulatory Framework",
        url: "https://example.com/av-reg",
      },
    ]);
  });

  it("constructs query with jurisdiction and regulatory terms", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "EU AI Act Compliance Overview",
          url: "https://example.com/eu-ai-act",
          content: "High-risk AI systems must undergo conformity assessments.",
        },
      ],
    });

    const res = (await getRegulatoryContext.invoke({
      topic_or_sector: "Autonomous AI Agents",
      jurisdiction: "European Union (EU AI Act)",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "Autonomous AI Agents European Union (EU AI Act) regulatory framework compliance legal requirements licensing rules",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on regulatory requirements, legal frameworks, compliance obligations, licensing rules, and regulatory developments for Autonomous AI Agents in European Union (EU AI Act).",
      },
    );

    expect(res).toContain("Regulatory Context for 'Autonomous AI Agents' (European Union (EU AI Act))");
  });

  it("validates schema input constraints and trims topic_or_sector", () => {
    expect(
      getRegulatoryContextSchema.safeParse({
        topic_or_sector: "Crypto Custody",
        jurisdiction: "US SEC",
      }).success,
    ).toBe(true);
    expect(
      getRegulatoryContextSchema.safeParse({
        topic_or_sector: "  Crypto Custody  ",
      }).data?.topic_or_sector,
    ).toBe("Crypto Custody");
    expect(getRegulatoryContextSchema.safeParse({ topic_or_sector: "" }).success).toBe(false);
    expect(getRegulatoryContextSchema.safeParse({ topic_or_sector: "   " }).success).toBe(false);
  });
});

describe("get_market_signals", () => {
  it("constructs default query with only required inputs (signal_type='all', no focus)", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "OpenAI Latest Developments",
          url: "https://example.com/openai-latest",
          content: "OpenAI announced new model architectures and partnerships.",
        },
      ],
    });

    const res = (await getMarketSignals.invoke({
      entity_or_topic: "OpenAI",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "OpenAI recent news announcements funding hiring leadership partnerships product launches",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "all",
        instructions:
          "Focus on recent external market signals, news events, leadership changes, funding announcements, partnerships, and traction for OpenAI.",
      },
    );

    expect(res).toContain("External Evidence (Market Signals for 'OpenAI'):");
    const citations = parseAndValidateCitations(res);
    expect(citations).toEqual([
      {
        title: "OpenAI Latest Developments",
        url: "https://example.com/openai-latest",
      },
    ]);
  });

  it("constructs query with signal type 'news' and maps searchType to 'news'", async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "OpenAI Announces Enterprise Partnership with Apple",
          url: "https://example.com/openai-apple",
          content: "Apple integrates ChatGPT across iOS 18.",
          source: "news",
          publication_date: "2024-06-10",
        },
      ],
    });

    const res = (await getMarketSignals.invoke({
      entity_or_topic: "OpenAI",
      signal_type: "news",
      query_focus: "Apple partnership integration",
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      "OpenAI news Apple partnership integration",
      {
        isToolCall: true,
        maxNumResults: 8,
        relevanceThreshold: 0.55,
        responseLength: "short",
        searchType: "news",
        instructions:
          "Focus on market signals for OpenAI (news), specifically: Apple partnership integration.",
      },
    );

    expect(res).toContain("Market Signals for 'OpenAI' [news]");
    expect(res).toContain("Apple integrates ChatGPT across iOS 18.");
  });

  it("truncates content exceeding MAX_CONTENT_LENGTH and handles object content", async () => {
    const longText = "x".repeat(3500);
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: "Long Article",
          url: "https://example.com/long",
          content: longText,
        },
        {
          title: "Structured Data",
          url: "https://example.com/data",
          content: { valuation: "$10B", round: "Series C" },
        },
      ],
    });

    const res = (await getMarketSignals.invoke({
      entity_or_topic: "Tech Unicorn",
    })) as string;

    expect(res).toContain("[Content truncated: showing first 3000 of 3500 characters]");
    expect(res).toContain('"valuation": "$10B"');
  });

  it("validates schema input constraints and trims entity_or_topic", () => {
    expect(
      getMarketSignalsSchema.safeParse({
        entity_or_topic: "Anthropic",
        signal_type: "funding",
      }).success,
    ).toBe(true);
    expect(
      getMarketSignalsSchema.safeParse({
        entity_or_topic: "  Anthropic  ",
      }).data?.entity_or_topic,
    ).toBe("Anthropic");
    expect(getMarketSignalsSchema.safeParse({ entity_or_topic: "" }).success).toBe(false);
    expect(getMarketSignalsSchema.safeParse({ entity_or_topic: "   " }).success).toBe(false);
    expect(
      getMarketSignalsSchema.safeParse({
        entity_or_topic: "Anthropic",
        signal_type: "invalid_type",
      }).success,
    ).toBe(false);
  });
});

describe("Tool Registry & Isolation", () => {
  const topicToolNames = [
    "get_company_profile",
    "get_sector_context",
    "get_competitor_landscape",
    "get_regulatory_context",
    "get_market_signals",
  ];

  it("includes all five topic research tools in vcTools", () => {
    const vcNames = vcTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(vcNames).toContain(name);
    }
  });

  it("does not include any topic research tools in base tools", () => {
    const baseNames = baseTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(baseNames).not.toContain(name);
    }
  });

  it("does not include any topic research tools in chatOnlyTools", () => {
    const chatNames = chatOnlyTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(chatNames).not.toContain(name);
    }
  });

  it("does not include any topic research tools in workforceOnlyTools", () => {
    const workforceNames = workforceOnlyTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(workforceNames).not.toContain(name);
    }
  });

  it("does not include any topic research tools in investmentTools", () => {
    const invNames = investmentTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(invNames).not.toContain(name);
    }
  });

  it("does not include any topic research tools in combinedTools", () => {
    const combNames = combinedTools.map((t) => t.name);
    for (const name of topicToolNames) {
      expect(combNames).not.toContain(name);
    }
  });
});
