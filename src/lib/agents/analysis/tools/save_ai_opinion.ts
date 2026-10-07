import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  AiWorkforceQueueRepository,
  CompanyRepository,
} from "@/lib/repositories";
import type { TablesUpdate } from "@/lib/repositories";

/** LangGraph `thread_id` === `ai_workforce_queue.id` for the owning run. */
function extractRunId(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.thread_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

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
  async (
    {
      company_id,
      verdict,
      summary,
    }: {
      company_id: string;
      verdict: Verdict;
      summary: string;
    },
    runtime?: RunnableConfig,
  ) => {
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
      const workspaceId = await getActiveWorkspaceId();
      const repo = new CompanyRepository(db, workspaceId);

      // Refuse writes from a cancelled/terminal run even if a newer dispatch
      // has flipped the company back to `processing`.
      const runId = extractRunId(runtime);
      if (runId) {
        const queueRepo = new AiWorkforceQueueRepository(db, workspaceId);
        const run = await queueRepo.findById(runId);
        if (!run || AiWorkforceQueueRepository.isTerminal(run.status)) {
          return (
            `**Error:** workforce run is no longer active` +
            `${run ? ` (status '${run.status}')` : ""}; verdict was not saved.`
          );
        }
      }

      const clamped = clampWords(text, 50);
      const updates: TablesUpdate<"companies"> = {
        ai_opinion_verdict: verdict,
        ai_opinion_summary: clamped,
        ai_opinion_status: "completed",
        ai_opinion_updated_at: new Date().toISOString(),
      };

      // Conditional on still-processing so cancel → failed wins the race.
      const updated = await repo.completeAiOpinionIfProcessing(id, updates);
      if (!updated) {
        const existing = await repo.findById(id);
        if (!existing) {
          return `**Error:** No company found for company_id "${id}".`;
        }
        return (
          `**Error:** AI Opinion for company_id "${id}" is no longer processing ` +
          `(cancelled or superseded); verdict was not saved.`
        );
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
- "tentative": yellow question mark — a near-forbidden last resort, ONLY for the rare case where the evidence is genuinely and exactly balanced and no further analysis could break the tie.

Be DECISIVE. Do NOT use "tentative" unless it is absolutely necessary — in almost every case commit to "pass" or "fail". Even when every automated AI Screening criterion fails, that is itself a strong signal (usually "fail"), never grounds for "tentative". Write the summary in confident, direct language — state the verdict as a conclusion, and avoid hedging words like "may", "might", "could", "possibly", "appears", or "seems". The summary must be ≤50 words, plain prose, and justify the verdict (it is truncated server-side if longer).

Keep the verdict UNBIASED, but NOT mandate-blind:
- Form it from fundamentals only. Do not read any human-recorded drop reason before deciding; consult it only afterwards, if your verdict disagrees with an existing drop decision, and note the disagreement in the summary.
- MANDATE FIT COUNTS when a mandate exists. Read the firm's active investment mandate with get_investment_theses and judge the company against what it actually says — sector, sub-sector, geography, deal size, deal type. A target outside that stated scope is a strong negative signal and normally warrants "fail" unless there is a specific, compelling reason to pursue it anyway. Name the mandate fit — aligned or mismatched, and on which dimension — in the summary. If get_investment_theses reports no active mandate, that is normal — omit mandate fit from the summary entirely, do not flag the absence, and still commit to pass or fail on the other evidence.
- Track *tagging* is a separate thing: it is an organizational grouping, not a screening criterion. Matching no track is never a reason to "fail", and track tagging should carry little weight either way.

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
        .describe(
          "Firm verdict: pass or fail. Use tentative only as a near-forbidden last resort when the evidence is exactly balanced.",
        ),
      summary: z
        .string()
        .min(1)
        .describe("≤50-word rationale justifying the verdict"),
    }),
  },
);
