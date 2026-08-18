import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contentsMock = vi.fn();

vi.mock("valyu-js", () => ({
  Valyu: function Valyu() {
    return { contents: contentsMock };
  },
}));

import {
  valyuExtractContent,
  valyuExtractContentInputSchema,
  MAX_PER_SOURCE_CHARS,
  MAX_TOTAL_CHARS,
} from "./valyu_extract_content";

beforeEach(() => {
  process.env.VALYU_API_KEY = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.VALYU_API_KEY;
});

describe("valyuExtractContentInputSchema", () => {
  it("accepts valid input with 1 URL and defaults", () => {
    const parsed = valyuExtractContentInputSchema.parse({
      urls: ["https://example.com/report.pdf"],
    });

    expect(parsed.urls).toEqual(["https://example.com/report.pdf"]);
    expect(parsed.extract_effort).toBe("normal");
    expect(parsed.extraction_goal).toBeUndefined();
  });

  it("accepts valid input with 3 URLs, goal, and high effort", () => {
    const parsed = valyuExtractContentInputSchema.parse({
      urls: [
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
      ],
      extraction_goal: "Extract Q4 ARR and net retention rate.",
      extract_effort: "high",
    });

    expect(parsed.urls).toHaveLength(3);
    expect(parsed.extract_effort).toBe("high");
    expect(parsed.extraction_goal).toBe(
      "Extract Q4 ARR and net retention rate.",
    );
  });

  it("rejects empty URLs array", () => {
    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: [],
      }),
    ).toThrow();
  });

  it("rejects more than 3 URLs", () => {
    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: [
          "https://example.com/1",
          "https://example.com/2",
          "https://example.com/3",
          "https://example.com/4",
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid URL protocols or malformed strings", () => {
    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: ["not-a-url"],
      }),
    ).toThrow();

    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: ["ftp://example.com/file"],
      }),
    ).toThrow();
  });

  it("rejects extraction_goal longer than 500 characters", () => {
    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: ["https://example.com"],
        extraction_goal: "a".repeat(501),
      }),
    ).toThrow();
  });

  it("rejects invalid extract_effort values", () => {
    expect(() =>
      valyuExtractContentInputSchema.parse({
        urls: ["https://example.com"],
        extract_effort: "extreme" as any,
      }),
    ).toThrow();
  });
});

describe("valyuExtractContent tool execution", () => {
  it("reports that API key is missing when VALYU_API_KEY is not set", async () => {
    delete process.env.VALYU_API_KEY;

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/article"],
    })) as string;

    expect(result).toContain(
      "VALYU_API_KEY environment variable is not set",
    );
    expect(contentsMock).not.toHaveBeenCalled();
  });

  it("passes default options (summary: false, normal effort, async: false) when no goal is specified", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Q4 Shareholder Letter",
          url: "https://example.com/q4",
          content: "Total revenue grew 42% YoY to $120M.",
          source: "sec_filings",
          source_type: "filing",
          publication_date: "2024-02-15",
          length: 500,
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/q4"],
    })) as string;

    expect(contentsMock).toHaveBeenCalledWith(
      ["https://example.com/q4"],
      {
        async: false,
        extractEffort: "normal",
        responseLength: MAX_PER_SOURCE_CHARS,
        summary: false,
      },
    );

    expect(result).toContain("**Valyu Extracted Content:**");
    expect(result).toContain("### 1. Q4 Shareholder Letter");
    expect(result).toContain("**URL:** https://example.com/q4");
    expect(result).toContain("**Source:** sec_filings");
    expect(result).toContain("**Source Type:** filing");
    expect(result).toContain("**Publication Date:** 2024-02-15");
    expect(result).toContain("Total revenue grew 42% YoY to $120M.");
    expect(result).toContain(
      "1. [Q4 Shareholder Letter](https://example.com/q4)",
    );
    expect(result).toContain("<!-- CITATIONS_JSON:");
    expect(result).toContain(
      JSON.stringify([
        {
          title: "Q4 Shareholder Letter",
          url: "https://example.com/q4",
        },
      ]),
    );
  });

  it("passes extraction_goal as summary instruction and handles high effort", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Series B Announcement",
          url: "https://example.com/series-b",
          summary: "Raised $30M Series B led by Benchmark at $200M valuation.",
          source: "web",
          length: 200,
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/series-b"],
      extraction_goal: "Extract funding round details and lead investors.",
      extract_effort: "high",
    })) as string;

    expect(contentsMock).toHaveBeenCalledWith(
      ["https://example.com/series-b"],
      {
        async: false,
        extractEffort: "high",
        responseLength: MAX_PER_SOURCE_CHARS,
        summary: "Extract funding round details and lead investors.",
      },
    );

    expect(result).toContain(
      '**Valyu Extracted Content (Goal: "Extract funding round details and lead investors."):**',
    );
    expect(result).toContain("Raised $30M Series B led by Benchmark");
  });

  it("handles partial failure: retains successful content and identifies failed URL", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Valid Document",
          url: "https://example.com/valid",
          content: "Key metric is 85% gross margin.",
          source: "company_site",
          length: 300,
        },
        {
          status: "failed",
          url: "https://example.com/broken",
          error: "HTTP 404 Not Found",
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/valid", "https://example.com/broken"],
    })) as string;

    expect(result).toContain("### 1. Valid Document");
    expect(result).toContain("Key metric is 85% gross margin.");
    expect(result).toContain("### 2. Extraction Failed: https://example.com/broken");
    expect(result).toContain("**Status:** Failed");
    expect(result).toContain("**Error:** HTTP 404 Not Found");

    // Citations must include only the successful URL
    expect(result).toContain("1. [Valid Document](https://example.com/valid)");
    expect(result).not.toContain("[https://example.com/broken]");
  });

  it("handles complete failure where all URLs fail", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "failed",
          url: "https://example.com/paywall",
          error: "Paywall access denied",
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/paywall"],
    })) as string;

    expect(result).toContain("### 1. Extraction Failed: https://example.com/paywall");
    expect(result).toContain("**Error:** Paywall access denied");
    expect(result).not.toContain("**Sources:**");
    expect(result).not.toContain("CITATIONS_JSON");
  });

  it("surfaces Valyu API errors when response.success is false", async () => {
    contentsMock.mockResolvedValue({
      success: false,
      error: "Monthly quota exceeded",
      results: [],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/doc"],
    })) as string;

    expect(result).toContain("Valyu content extraction error: Monthly quota exceeded");
  });

  it("catches and reports unexpected SDK exceptions", async () => {
    contentsMock.mockRejectedValue(new Error("Network timeout"));

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/doc"],
    })) as string;

    expect(result).toContain("Valyu content extraction error: Network timeout");
  });

  it("handles unexpected async job response instead of sync results", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      jobId: "job-abc-123",
      status: "pending",
      urlsTotal: 1,
      txId: "tx-xyz",
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/doc"],
    })) as string;

    expect(result).toContain(
      "Valyu content extraction returned an unexpected asynchronous job response instead of synchronous content.",
    );
  });

  it("handles empty results gracefully", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/doc"],
    })) as string;

    expect(result).toContain("No content could be extracted from the provided URLs.");
  });

  it("bounds per-source output and discloses truncation when length exceeds limit", async () => {
    const longContent = "A".repeat(MAX_PER_SOURCE_CHARS + 500);

    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Long Document",
          url: "https://example.com/long",
          content: longContent,
          source: "research",
          length: longContent.length,
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/long"],
    })) as string;

    expect(result).toContain(
      `*(Content truncated: exceeded per-source limit of ${MAX_PER_SOURCE_CHARS} characters)*`,
    );
    expect(result.length).toBeLessThan(longContent.length);
  });

  it("never synthesizes investment fit, risk scores, or a verdict", async () => {
    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Company Profile",
          url: "https://example.com/co",
          content: "Company founded in 2021, headquartered in Austin, TX.",
          source: "web",
          length: 50,
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: ["https://example.com/co"],
    })) as string;

    expect(result).not.toContain("Investment Fit");
    expect(result).not.toContain("Risk Score");
    expect(result).not.toContain("Verdict");
  });

  it("discloses total output truncation while preserving intact CITATIONS_JSON and all three citations for 3 maximum-sized sources", async () => {
    const maxContent1 = "A".repeat(MAX_PER_SOURCE_CHARS);
    const maxContent2 = "B".repeat(MAX_PER_SOURCE_CHARS);
    const maxContent3 = "C".repeat(MAX_PER_SOURCE_CHARS);

    contentsMock.mockResolvedValue({
      success: true,
      results: [
        {
          status: "success",
          title: "Source Document 1",
          url: "https://example.com/source-1",
          content: maxContent1,
          source: "source1",
          length: maxContent1.length,
        },
        {
          status: "success",
          title: "Source Document 2",
          url: "https://example.com/source-2",
          content: maxContent2,
          source: "source2",
          length: maxContent2.length,
        },
        {
          status: "success",
          title: "Source Document 3",
          url: "https://example.com/source-3",
          content: maxContent3,
          source: "source3",
          length: maxContent3.length,
        },
      ],
    });

    const result = (await valyuExtractContent.invoke({
      urls: [
        "https://example.com/source-1",
        "https://example.com/source-2",
        "https://example.com/source-3",
      ],
    })) as string;

    // 1. Total truncation is disclosed
    expect(result).toContain(
      `*(Total output truncated: exceeded limit of ${MAX_TOTAL_CHARS} characters)*`,
    );

    // 2. CITATIONS_JSON is present and its captured payload parses via JSON.parse
    const match = result.match(/<!-- CITATIONS_JSON:(.*?) -->/);
    expect(match).not.toBeNull();
    const citationsJson = match![1];
    const parsed = JSON.parse(citationsJson);

    // 3. All three citations survive
    expect(parsed).toHaveLength(3);
    expect(parsed).toEqual([
      { title: "Source Document 1", url: "https://example.com/source-1" },
      { title: "Source Document 2", url: "https://example.com/source-2" },
      { title: "Source Document 3", url: "https://example.com/source-3" },
    ]);
  });
});
