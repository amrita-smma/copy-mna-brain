import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  AiWorkforceQueueRepository,
  FlAssetRepository,
  FlValuationRepository,
} from "@/lib/repositories";
import {
  assessFundAiOpinionDataSufficiency,
  clampFundAiOpinionConfidence,
  formatFundAiOpinionDataGaps,
  FUND_AI_OPINION_CONFIDENCE,
  type FundAiOpinionConfidence,
} from "@/lib/services/fundAiOpinionDataSufficiency";

/** LangGraph `thread_id` === `ai_workforce_queue.id` for the owning run. */
function extractRunId(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.thread_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Workforce-only tool: persist a fund holding's AI Opinion — a firm
 * BUY / HOLD / SELL verdict plus a brief (≤50-word) rationale — onto the
 * `fl_assets.instrument_terms.aiOpinion` JSON object.
 *
 * Auto-executes (no human approval) — it only writes a narrative verdict, not
 * fund state. Overwrites any prior opinion so re-evaluation is a clean
 * replace, and stamps `status = 'completed'` so the UI swaps the
 * spinner for the verdict icon on its next refresh.
 *
 * Confidence is clamped by a server-side data-sufficiency check so a thin
 * holding cannot be saved as "high" even if the model claims otherwise.
 */

const VERDICTS = ["buy", "hold", "sell"] as const;
type Verdict = (typeof VERDICTS)[number];

/** Trim a summary to at most `maxWords` words (the column shows ≤50). */
function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ").replace(/[.,;:]+$/, "") + "…";
}

export const saveFundAiOpinion = tool(
  async (
    {
      asset_id,
      fund_asset_id,
      verdict,
      summary,
      confidence,
    }: {
      asset_id?: string;
      fund_asset_id?: string;
      verdict: Verdict;
      summary: string;
      confidence: FundAiOpinionConfidence;
    },
    runtime?: RunnableConfig,
  ) => {
    const rawId = (asset_id ?? fund_asset_id)?.trim();
    logger.debug(
      `🔧 TOOL CALLED: save_fund_ai_opinion(asset_id='${rawId}', verdict='${verdict}', confidence='${confidence}')`,
    );

    if (!rawId) return "**Error:** asset_id is required.";
    const text = summary?.trim();
    if (!text) return "**Error:** summary is required and cannot be empty.";
    if (!VERDICTS.includes(verdict)) {
      return `**Error:** verdict must be one of: ${VERDICTS.join(", ")}.`;
    }
    if (!(FUND_AI_OPINION_CONFIDENCE as readonly string[]).includes(confidence)) {
      return `**Error:** confidence must be one of: ${FUND_AI_OPINION_CONFIDENCE.join(", ")}.`;
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const assetRepo = new FlAssetRepository(db);
      const valuationRepo = new FlValuationRepository(db);

      // Refuse writes from a cancelled/terminal run even if a newer dispatch
      // has flipped the holding back to `processing`.
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

      const asset = await assetRepo.findById(workspaceId, rawId);
      if (!asset) {
        return `**Error:** No fund asset found for asset_id "${rawId}".`;
      }

      const existingTerms = (asset.instrument_terms as Record<string, unknown>) ?? {};
      const existingOpinion = (existingTerms.aiOpinion as Record<string, unknown>) ?? {};

      if (existingOpinion.status && existingOpinion.status !== 'processing') {
        return (
          `**Error:** AI Opinion for asset_id "${rawId}" is no longer processing ` +
          `(cancelled or superseded); verdict was not saved.`
        );
      }

      const valuations = await valuationRepo.findSeriesByTarget(workspaceId, { assetId: rawId });
      const latestVal = valuations[valuations.length - 1];
      const fmvAmount = latestVal ? (latestVal.market_value ? parseFloat(latestVal.market_value) : null) : null;

      const sufficiency = assessFundAiOpinionDataSufficiency(
        {
          sector: asset.sector,
          country: asset.country,
          investment_description: asset.description,
          fmv_amount: fmvAmount,
        },
        valuations.length,
      );
      const clampedConfidence = clampFundAiOpinionConfidence(
        confidence,
        sufficiency.maxConfidence,
      );
      const dataGaps = formatFundAiOpinionDataGaps(sufficiency.dataGaps);
      const clamped = clampWords(text, 50);

      const updatedTerms = {
        ...existingTerms,
        aiOpinion: {
          ...existingOpinion,
          verdict,
          summary: clamped,
          confidence: clampedConfidence,
          data_gaps: dataGaps || null,
          status: 'completed',
          updated_at: new Date().toISOString(),
        },
      };

      await assetRepo.update(workspaceId, rawId, {
        instrument_terms: updatedTerms,
      });

      logger.info(
        `✓ Fund AI Opinion saved for fund asset ${rawId}: ${verdict} (${clampedConfidence})`,
      );
      return (
        `Saved AI Opinion for asset_id "${rawId}": ${verdict.toUpperCase()} ` +
        `(confidence ${clampedConfidence}) — "${clamped}". ` +
        `The AI Opinion column now reflects this verdict.`
      );
    } catch (error) {
      logger.error(`save_fund_ai_opinion error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "save_fund_ai_opinion",
    description: `Persist a fund holding's AI Opinion: a FIRM verdict (buy / hold / sell), a confidence level (high / medium / low), plus a brief rationale of at most 50 words. This is the final step of an "Analyze AI Opinion" / "Re-evaluate" workforce run for a Fund Management holding — call it exactly once, after you have reviewed the holding's metrics and formed a decisive view.

Verdict meaning (rendered as icons in the Fund Management Asset table's AI Opinion column):
- "buy": attractive outlook — you'd add exposure if you could (many holdings are illiquid).
- "hold": the position is fairly valued — no strong buy or sell signal.
- "sell": you'd exit this position.

Confidence meaning (be honest about the basis even when the verdict is firm):
- "high": rich recorded marks/metrics and reliable context.
- "medium": usable data with material gaps.
- "low": sparse recorded data and/or unreliable external research. The instruction may cap the maximum you may use.

Be DECISIVE about the verdict. Do NOT use "hold" as a way to avoid committing — reserve it for when the evidence genuinely does not favor buy or sell. Be HONEST about confidence — do not claim high confidence when the holding's recorded data is thin. Cite concrete recorded figures in the summary; say so when external research found nothing reliable. Write the summary in direct language — state the verdict as a conclusion, and avoid hedging words like "may", "might", "could", "possibly", or "seems". The summary must be ≤50 words, plain prose, and justify the verdict (it is truncated server-side if longer).

Args:
    asset_id: UUID of the fl_assets row to record the opinion for. Required.
    verdict: One of "buy", "hold", "sell".
    confidence: One of "high", "medium", "low".
    summary: The ≤50-word rationale. Required, non-empty.

Returns:
    A success message echoing the saved verdict, or an error string starting with **Error:**.`,
    schema: z.object({
      asset_id: z
        .string()
        .optional()
        .describe("UUID of the fl_assets row to record the AI Opinion for"),
      fund_asset_id: z
        .string()
        .optional()
        .describe("Legacy alias for asset_id"),
      verdict: z
        .enum(VERDICTS)
        .describe(
          "Firm verdict: buy, hold, or sell. Use hold only when there is genuinely no strong signal either way.",
        ),
      confidence: z
        .enum(FUND_AI_OPINION_CONFIDENCE)
        .describe(
          "Honesty about the basis: high, medium, or low. Respect any max confidence noted in the instruction.",
        ),
      summary: z
        .string()
        .min(1)
        .describe("≤50-word rationale justifying the verdict; cite recorded figures"),
    }),
  },
);
