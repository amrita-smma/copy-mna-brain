import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { DEFER_LOADING } from "./server_tools";
import { createDb } from "@/lib/server/db";
import { getActiveWorkspaceId } from "@/lib/workspace";
import type {
  StalledDealAnalysis,
  StageTimelineEvent,
} from "@/lib/services";
import {
  stageCode,
  stageLabel as workspaceStageLabel,
  type PipelineStageDef,
} from "@/lib/pipeline/stages";

/** "L2 · Deep Dive" in the workspace's own naming — the raw key for unknown stages. */
function stageLabel(stages: PipelineStageDef[], stage: string | null): string {
  if (!stage) return "-";
  return workspaceStageLabel(stages, stage);
}

/** The stage's code ("L2"), "-" when absent. */
function code(stages: PipelineStageDef[], stage: string | null): string {
  return stage ? stageCode(stages, stage) : "-";
}

/** YYYY-MM-DD from an ISO timestamp, or "-" when absent/invalid. */
function shortDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toISOString().slice(0, 10);
}

function renderTimeline(deal: StalledDealAnalysis, stages: PipelineStageDef[]): string {
  const steps: string[] = [];
  for (const ev of deal.timeline as StageTimelineEvent[]) {
    const move = ev.fromStage
      ? `${code(stages, ev.fromStage)} → ${code(stages, ev.stage)}`
      : `→ ${code(stages, ev.stage)}`;
    steps.push(`${shortDate(ev.enteredAt)}: ${move}`);
  }
  // No recorded stage moves — the deal has sat in its stage since it was added.
  if (steps.length === 0) {
    return `  - ${shortDate(deal.enteredStageAt)}: added to pipeline at ${deal.currentStage ? code(stages, deal.currentStage) : "?"} (no stage changes since)`;
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
    stage?: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: analyze_stalled_deals(stalled_weeks=${stalled_weeks}, stage='${stage}')`,
    );

    try {
      const db = createDb();
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { stalledDealService, pipelineStageService } = createContainer(
        db,
        await getActiveWorkspaceId(),
      );

      const thresholdDays = Math.round(stalled_weeks * 7);
      const [report, stages] = await Promise.all([
        stalledDealService.getStalledDeals({ thresholdDays, stage }),
        pipelineStageService.list(),
      ]);

      if (report.totalActive === 0) {
        return stage
          ? `No active deals found in stage ${stageLabel(stages, stage)}.`
          : "No active deals found in the pipeline.";
      }

      const scope = stage ? `stage ${stageLabel(stages, stage)}` : "the pipeline";
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
          out += `| ${name} | ${code(stages, d.currentStage)} | ${d.daysInStage} | ${since} | ${d.segment || "-"} | ${d.geography || "-"} |\n`;
        }

        out += `\n### Timelines\n\n`;
        for (const d of stalled) {
          const name = d.target || d.projectName || "N/A";
          out += `**${name}** — currently ${stageLabel(stages, d.currentStage)}, ${d.daysInStage} days in stage\n`;
          out += `${renderTimeline(d, stages)}\n\n`;
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
          out += `| ${name} | ${code(stages, d.currentStage)} | ${d.daysInStage} | ${shortDate(d.enteredStageAt)} |\n`;
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

Pulls every currently active deal (status = active) in the pipeline (every workspace stage, including ones the workspace added), computes how long each has been in its CURRENT stage (from the stage-move history, falling back to the date the deal was added), and flags any that have been parked for 2+ weeks (configurable). Returns a markdown report: a summary count, a table of stalled deals ordered by days-in-stage, a per-deal stage timeline, and a compact table of the remaining within-threshold active deals.

Parameters:
    stalled_weeks: Number of weeks in a single stage before a deal counts as stalled (default: 2).
    stage: Optionally restrict the analysis to one pipeline stage key (L0–L5 or a key from list_pipeline_stages). Omit to cover the whole pipeline.

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
        .string()
        .min(1)
        .optional()
        .describe(
          "Restrict analysis to a single pipeline stage key (L0–L5, or a key the workspace added — see list_pipeline_stages)",
        ),
    }),
    // Rare on a typical turn: loaded on demand through the tool-search
    // server tool (see `server_tools.ts`).
    extras: DEFER_LOADING,
  },
);
