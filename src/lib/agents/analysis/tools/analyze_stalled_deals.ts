import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createContainer } from "@/lib/services";
import type {
  StalledDealAnalysis,
  StageTimelineEvent,
} from "@/lib/services";
import { STAGE_LABELS } from "@/lib/constants";
import type { DealStage } from "@/lib/types";

/** "L2 (Initial Review)" — falls back to the raw code for unknown stages. */
function stageLabel(stage: string | null): string {
  if (!stage) return "-";
  const label = STAGE_LABELS[stage as DealStage];
  return label ? `${stage} (${label})` : stage;
}

/** YYYY-MM-DD from an ISO timestamp, or "-" when absent/invalid. */
function shortDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toISOString().slice(0, 10);
}

function renderTimeline(deal: StalledDealAnalysis): string {
  const steps: string[] = [];
  for (const ev of deal.timeline as StageTimelineEvent[]) {
    const move = ev.fromStage ? `${ev.fromStage} → ${ev.stage}` : `→ ${ev.stage}`;
    steps.push(`${shortDate(ev.enteredAt)}: ${move}`);
  }
  // No recorded stage moves — the deal has sat in its stage since it was added.
  if (steps.length === 0) {
    return `  - ${shortDate(deal.enteredStageAt)}: added to pipeline at ${deal.currentStage ?? "?"} (no stage changes since)`;
  }
  return steps.map((s) => `  - ${s}`).join("\n");
}

/**
 * Analyze "stalled" deals: pull today's active pipeline deals, work out how
 * long each has sat in its current stage (from the stage-move logs, falling
 * back to the created date), and flag the ones parked for too long. Delegates
 * the analysis to StalledDealService and renders a markdown report.
 */
export const analyzeStalledDeals = tool(
  async ({
    stalled_weeks = 2,
    stage,
  }: {
    stalled_weeks?: number;
    stage?: DealStage;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: analyze_stalled_deals(stalled_weeks=${stalled_weeks}, stage='${stage}')`,
    );

    try {
      const db = createDb();
      const { stalledDealService } = createContainer(
        db,
        await getActiveWorkspaceId(),
      );

      const thresholdDays = Math.round(stalled_weeks * 7);
      const report = await stalledDealService.getStalledDeals({
        thresholdDays,
        stage,
      });

      if (report.totalActive === 0) {
        return stage
          ? `No active deals found in stage ${stage}.`
          : "No active deals found in the L0–L5 pipeline.";
      }

      const scope = stage ? `stage ${stage}` : "the L0–L5 pipeline";
      const stalled = report.deals.filter((d) => d.isStalled);

      let out = `## Stalled Deals Analysis\n\n`;
      out += `As of ${shortDate(report.asOf)}, **${report.stalledCount} of ${report.totalActive}** active deals in ${scope} have been stuck in their current stage for **${stalled_weeks}+ week(s)** (≥ ${thresholdDays} days).\n\n`;

      if (stalled.length > 0) {
        out += `### 🚩 Stalled deals (longest first)\n\n`;
        out += `| Target | Stage | Days in Stage | In Stage Since | Segment | Geography |\n`;
        out += `| --- | --- | --- | --- | --- | --- |\n`;
        for (const d of stalled) {
          const name = d.target || d.projectName || "N/A";
          const since = `${shortDate(d.enteredStageAt)}${d.enteredStageBasis === "created_at" ? " (est.)" : ""}`;
          out += `| ${name} | ${d.currentStage ?? "-"} | ${d.daysInStage} | ${since} | ${d.segment || "-"} | ${d.geography || "-"} |\n`;
        }

        out += `\n### Timelines\n\n`;
        for (const d of stalled) {
          const name = d.target || d.projectName || "N/A";
          out += `**${name}** — currently ${stageLabel(d.currentStage)}, ${d.daysInStage} days in stage\n`;
          out += `${renderTimeline(d)}\n\n`;
        }
      } else {
        out += `No deals are currently stalled. 🎉\n\n`;
      }

      const active = report.deals.filter((d) => !d.isStalled);
      if (active.length > 0) {
        out += `### Other active deals (within threshold)\n\n`;
        out += `| Target | Stage | Days in Stage | In Stage Since |\n`;
        out += `| --- | --- | --- | --- |\n`;
        for (const d of active) {
          const name = d.target || d.projectName || "N/A";
          out += `| ${name} | ${d.currentStage ?? "-"} | ${d.daysInStage} | ${shortDate(d.enteredStageAt)} |\n`;
        }
      }

      logger.debug(
        `✓ Analyzed ${report.totalActive} active deals, ${report.stalledCount} stalled`,
      );
      return out;
    } catch (error) {
      logger.error(`Stalled deals error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "analyze_stalled_deals",
    description: `Analyze "stalled" deals — active pipeline deals that have been sitting in the same stage for too long.

Pulls every currently active deal (status = active) in the L0–L5 funnel, computes how long each has been in its CURRENT stage (from the stage-move history, falling back to the date the deal was added), and flags any that have been parked for 2+ weeks (configurable). Returns a markdown report: a summary count, a table of stalled deals ordered by days-in-stage, a per-deal stage timeline, and a compact table of the remaining within-threshold active deals.

Parameters:
    stalled_weeks: Number of weeks in a single stage before a deal counts as stalled (default: 2).
    stage: Optionally restrict the analysis to one pipeline stage (L0–L5). Omit to cover the whole L0–L5 funnel.

Use this to spot deals losing momentum, prioritize follow-ups, or answer "which deals are stuck?".`,
    schema: z.object({
      stalled_weeks: z
        .number()
        .positive()
        .default(2)
        .describe(
          "Weeks in the same stage before a deal is flagged as stalled (default 2)",
        ),
      stage: z
        .enum(["L0", "L1", "L2", "L3", "L4", "L5"])
        .optional()
        .describe("Restrict analysis to a single pipeline stage (L0–L5)"),
    }),
  },
);
