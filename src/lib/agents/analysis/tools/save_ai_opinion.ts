import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";
import type { TablesUpdate } from "@/lib/repositories";

/**
 * Workforce-only tool: persist a company's AI Opinion — a firm
 * PASS / FAIL / TENTATIVE verdict plus a brief (≤50-word) rationale — onto the
 * `companies` row. This is the write half of the right-most "AI Opinion"
 * column in the pipeline tables: the user clicks "Analyze AI Opinion" (or
 * "Re-evaluate"), which enqueues a workforce run; the run researches the
 * company and finishes by calling this tool to record its verdict.
 *
 * Auto-executes (no human approval) — it only writes a narrative verdict, not
 * pipeline state. Overwrites any prior opinion so re-evaluation is a clean
 * replace, and stamps `ai_opinion_status = 'completed'` so the UI swaps the
 * spinner for the verdict icon on its next refresh.
 */

const VERDICTS = ["pass", "fail", "tentative"] as const;
type Verdict = (typeof VERDICTS)[number];

/** Trim a summary to at most `maxWords` words (the column shows ≤50). */
function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ").replace(/[.,;:]+$/, "") + "…";
}

export const saveAiOpinion = tool(
  async ({
    company_id,
    verdict,
    summary,
  }: {
    company_id: string;
    verdict: Verdict;
    summary: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: save_ai_opinion(company_id='${company_id}', verdict='${verdict}')`,
    );

    const id = company_id?.trim();
    if (!id) return "**Error:** company_id is required.";
    const text = summary?.trim();
    if (!text) return "**Error:** summary is required and cannot be empty.";
    if (!VERDICTS.includes(verdict)) {
      return `**Error:** verdict must be one of: ${VERDICTS.join(", ")}.`;
    }

    try {
      const db = createDb();
      const repo = new CompanyRepository(db, await getActiveWorkspaceId());

      const clamped = clampWords(text, 50);
      const updates: TablesUpdate<"companies"> = {
        ai_opinion_verdict: verdict,
        ai_opinion_summary: clamped,
        ai_opinion_status: "completed",
        ai_opinion_updated_at: new Date().toISOString(),
      };

      const [updated] = await repo.update(id, updates);
      if (!updated) {
        return `**Error:** No company found for company_id "${id}".`;
      }

      logger.info(`✓ AI Opinion saved for company ${id}: ${verdict}`);
      return `Saved AI Opinion for company_id "${id}": ${verdict.toUpperCase()} — "${clamped}". The AI Opinion column now reflects this verdict.`;
    } catch (error) {
      logger.error(`save_ai_opinion error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "save_ai_opinion",
    description: `Persist a company's AI Opinion: a FIRM verdict (pass / fail / tentative) plus a brief rationale of at most 50 words. This is the final step of an "Analyze AI Opinion" / "Re-evaluate" workforce run — call it exactly once, after you have researched the company and formed a decisive view.

Verdict meaning (rendered as icons in the AI Opinion column):
- "pass": green check — you'd advance this as an acquisition target.
- "fail": red cross — you'd pass on it.
- "tentative": yellow question mark — genuinely on the fence; use sparingly, only when the evidence is truly balanced.

Be DECISIVE. Even when the automated AI Screening criteria all fail, do not default to "tentative" — weigh the company on its merits and commit to "pass" or "fail" unless the case is genuinely balanced. The summary must be ≤50 words, plain prose, and justify the verdict (it is truncated server-side if longer).

Keep the verdict UNBIASED:
- Form it from fundamentals only. Do not read any human-recorded drop reason before deciding; consult it only afterwards, if your verdict disagrees with an existing drop decision, and note the disagreement in the summary.
- Investment tracks are an organizational grouping, not screening criteria. Matching no track is never a reason to "fail", and track fit should carry little weight either way.

Args:
    company_id: UUID of the company to record the opinion for. Required (use verbatim from the instruction).
    verdict: One of "pass", "fail", "tentative".
    summary: The ≤50-word rationale. Required, non-empty.

Returns:
    A success message echoing the saved verdict, or an error string starting with **Error:**.`,
    schema: z.object({
      company_id: z
        .string()
        .describe("UUID of the company to record the AI Opinion for"),
      verdict: z
        .enum(VERDICTS)
        .describe("Firm verdict: pass, fail, or tentative"),
      summary: z
        .string()
        .min(1)
        .describe("≤50-word rationale justifying the verdict"),
    }),
  },
);
