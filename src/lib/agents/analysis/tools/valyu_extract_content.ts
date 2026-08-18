import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Valyu, type ContentsOptions, type ContentResult } from "valyu-js";
import { logger } from "../../logger";

export const MAX_PER_SOURCE_CHARS = 4000;
export const MAX_TOTAL_CHARS = 12000;

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export const valyuExtractContentInputSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .url("Each URL must be a valid URL")
        .refine(
          (url) => /^https?:\/\//i.test(url),
          "Each URL must start with http:// or https://",
        ),
    )
    .min(1, "At least 1 URL must be provided")
    .max(3, "At most 3 URLs can be processed at once")
    .describe("1 to 3 valid HTTP(S) URLs to extract content from"),
  extraction_goal: z
    .string()
    .max(500, "extraction_goal cannot exceed 500 characters")
    .optional()
    .describe(
      "Optional fact-extraction instruction (max 500 characters) to focus extraction on specific facts or metrics",
    ),
  extract_effort: z
    .enum(["normal", "high"])
    .default("normal")
    .describe("Extraction effort level: 'normal' or 'high' (default 'normal')"),
});

export type ValyuExtractContentInput = z.infer<
  typeof valyuExtractContentInputSchema
>;

/**
 * Fact-only tool that extracts source-separated content from 1 to 3 authoritative URLs.
 * Available to the VC Copilot flavor.
 */
export const valyuExtractContent = tool(
  async ({
    urls,
    extraction_goal,
    extract_effort = "normal",
  }: ValyuExtractContentInput) => {
    logger.debug(
      `🔧 TOOL CALLED: valyu_extract_content(urls=${JSON.stringify(urls)}, extract_effort='${extract_effort}', goal='${extraction_goal ?? ""}')`,
    );

    const apiKey = process.env.VALYU_API_KEY;
    if (!apiKey) {
      logger.warn("VALYU_API_KEY not set");
      return "Valyu content extraction is not available. VALYU_API_KEY environment variable is not set.";
    }

    try {
      const valyu = new Valyu(apiKey);
      const options: ContentsOptions = {
        async: false,
        extractEffort: extract_effort,
        responseLength: MAX_PER_SOURCE_CHARS,
        summary:
          extraction_goal && extraction_goal.trim().length > 0
            ? extraction_goal.trim()
            : false,
      };

      const response = await valyu.contents(urls, options);

      // Handle unexpected async job response
      if ("jobId" in response) {
        logger.warn(
          `Unexpected async job response for valyu_extract_content: ${response.jobId}`,
        );
        return "Valyu content extraction returned an unexpected asynchronous job response instead of synchronous content.";
      }

      if (!response.success) {
        const err = response.error || "Unknown Valyu content extraction error";
        logger.error(`✗ Valyu content extraction failed: ${err}`);
        return `Valyu content extraction error: ${err}`;
      }

      const results: ContentResult[] = response.results ?? [];
      if (results.length === 0) {
        return "No content could be extracted from the provided URLs.";
      }

      const header = extraction_goal && extraction_goal.trim().length > 0
        ? `**Valyu Extracted Content (Goal: "${extraction_goal.trim()}"):**\n`
        : `**Valyu Extracted Content:**\n`;

      const outputLines: string[] = [header];
      const citations: { title: string; url: string }[] = [];

      results.forEach((result, i) => {
        const fallbackUrl = urls[i] || "";

        if (result.status === "failed") {
          const failedUrl = result.url || fallbackUrl || `URL ${i + 1}`;
          const errorMsg = result.error || "Extraction failed for this URL";
          outputLines.push(`### ${i + 1}. Extraction Failed: ${failedUrl}`);
          outputLines.push(`**Status:** Failed`);
          outputLines.push(`**URL:** ${failedUrl}`);
          outputLines.push(`**Error:** ${errorMsg}\n`);
          return;
        }

        const url = result.url || fallbackUrl;
        const title = result.title || url || `Extracted Document ${i + 1}`;
        const source = result.source;
        const sourceType = result.source_type;
        const pubDate = result.publication_date;

        let rawText = "";
        if (
          result.summary != null &&
          (typeof result.summary === "string"
            ? result.summary.trim().length > 0
            : true)
        ) {
          rawText = formatContent(result.summary).trim();
        } else if (result.content != null) {
          rawText = formatContent(result.content).trim();
        } else if (result.description != null) {
          rawText = formatContent(result.description).trim();
        }

        let isTruncated = false;
        let body = rawText;
        if (body.length > MAX_PER_SOURCE_CHARS) {
          body = body.slice(0, MAX_PER_SOURCE_CHARS).trimEnd();
          isTruncated = true;
        }

        outputLines.push(`### ${i + 1}. ${title}`);
        if (url) outputLines.push(`**URL:** ${url}`);
        if (source) outputLines.push(`**Source:** ${source}`);
        if (sourceType) outputLines.push(`**Source Type:** ${sourceType}`);
        if (pubDate) outputLines.push(`**Publication Date:** ${pubDate}`);

        if (body) {
          outputLines.push(`\n${body}`);
          if (isTruncated) {
            outputLines.push(
              `\n*(Content truncated: exceeded per-source limit of ${MAX_PER_SOURCE_CHARS} characters)*`,
            );
          }
          outputLines.push("");
        } else {
          outputLines.push("\n*(No textual content extracted)*\n");
        }

        if (url && !citations.some((c) => c.url === url)) {
          citations.push({ title, url });
        }
      });

      const footerLines: string[] = [];
      if (citations.length > 0) {
        footerLines.push("---\n**Sources:**");
        citations.forEach((c, i) => {
          footerLines.push(`${i + 1}. [${c.title}](${c.url})`);
        });
        footerLines.push(
          `\n<!-- CITATIONS_JSON:${JSON.stringify(citations)} -->`,
        );
      }

      const footer = footerLines.length > 0 ? `\n${footerLines.join("\n")}` : "";
      const evidenceBody = outputLines.join("\n");
      const truncationNotice = `\n\n*(Total output truncated: exceeded limit of ${MAX_TOTAL_CHARS} characters)*`;

      let fullOutput = "";
      if (evidenceBody.length + footer.length > MAX_TOTAL_CHARS) {
        const allowedBodyLength = Math.max(
          0,
          MAX_TOTAL_CHARS - footer.length - truncationNotice.length,
        );
        const truncatedBody = evidenceBody.slice(0, allowedBodyLength).trimEnd();
        fullOutput = `${truncatedBody}${truncationNotice}${footer}`;
      } else {
        fullOutput = `${evidenceBody}${footer}`;
      }

      logger.debug(
        `✓ Valyu content extraction completed with ${citations.length} sources and ${results.length} processed URLs`,
      );
      return fullOutput;
    } catch (error) {
      logger.error(
        `✗ Valyu content extraction error: ${(error as Error).message}`,
      );
      return `Valyu content extraction error: ${(error as Error).message}`;
    }
  },
  {
    name: "valyu_extract_content",
    description: `Extract source-separated factual content from 1 to 3 authoritative URLs discovered during research using Valyu Contents API.

Use this tool when you have discovered specific high-value URLs (such as investor presentations, SEC filings, press releases, company blog posts, or research articles) and need to extract the detailed factual content or a goal-directed summary.

Args:
    urls: Array of 1 to 3 valid HTTP(S) URLs to extract content from.
    extraction_goal: Optional specific fact-extraction instruction (max 500 characters) to focus extraction on specific metrics, dates, or factual points.
    extract_effort: Extraction thoroughness level ('normal' or 'high', default 'normal').

Returns:
    Source-separated factual text and summaries for each URL, with publication date and source metadata when available, markdown citations, and structured CITATIONS_JSON. Returns neutral extracted facts only; does not generate investment fit, risk scores, or verdicts.`,
    schema: valyuExtractContentInputSchema,
  },
);

export const valyuExtractContentTool = valyuExtractContent;
