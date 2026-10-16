import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";

/**
 * Workforce-only tool behind the `ai_screening` task (one per company, queued
 * by `AIScreeningService.enqueue`): screen a company against its matched
 * tracks' criteria. Every criterion runs at once and writes its own
 * `screenings` row, which the Pipeline's AI Screening tab reads.
 *
 * - `pending_scan` — the Pending Confirmation auto-scan: match tracks when
 *   none are matched, screen, then auto drop/promote when the workspace has
 *   it on (`PendingAutoScanService.processCompany`).
 * - `tracks` — screen the matched tracks only; never moves the deal.
 */
export const runAiScreening = tool(
  async ({
    company_id,
    mode,
    force,
  }: {
    company_id: string;
    mode: "pending_scan" | "tracks";
    force: boolean;
  }) => {
    const id = company_id?.trim();
    if (!id) return `**Error:** company_id is required.`;

    logger.debug(`🔧 TOOL CALLED: run_ai_screening('${id}', ${mode}, force=${force})`);

    try {
      const db = createDb();
      const { pendingAutoScanService, aiScreeningService } = createContainer(
        db,
        await getActiveWorkspaceId(),
      );

      if (mode === "pending_scan") {
        const result = await pendingAutoScanService.processCompany(id, { force });
        return [
          `Pending Confirmation scan for company ${id}: outcome **${result.outcome}**` +
            (result.verdict ? `, verdict **${result.verdict}**` : "") +
            (typeof result.screened === "number" ? `, ${result.screened} criteria screened` : "") +
            ".",
          ...result.steps.map((s) => `- ${s}`),
        ].join("\n");
      }

      const { screened, tracks } = await aiScreeningService.screenCompanyTracks(id, { force });
      if (tracks.length === 0) {
        return `No matched track of company ${id} has screening criteria; nothing was screened.`;
      }
      return [
        `Screened ${screened} criteria across ${tracks.length} track(s) for company ${id}.`,
        ...tracks.map((t) => `- ${t.title}: ${t.verdict}`),
      ].join("\n");
    } catch (error) {
      logger.error(`run_ai_screening error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "run_ai_screening",
    description: `Run AI screening for ONE company against the criteria of its matched tracks (investment theses). Every criterion is evaluated in parallel and saved as a screening result (pass / fail / inconclusive) that appears on the Pipeline page's AI Screening tab.

Args:
    company_id: The company's UUID. Required.
    mode: "pending_scan" for a Pending Confirmation company — matches it to tracks if it has none, screens it, then promotes it to L0 on a pass or drops it on a fail when the workspace has auto drop/promote on. "tracks" screens the company's matched tracks only and never moves the deal.
    force: true re-screens criteria that already have a result; false screens only the ones without one.

Returns:
    The outcome, overall verdict and number of criteria screened, or an error string.`,
    schema: z.object({
      company_id: z.string().describe("The UUID of the company to screen"),
      mode: z
        .enum(["pending_scan", "tracks"])
        .describe('"pending_scan" for the Pending Confirmation auto-scan, "tracks" otherwise'),
      force: z.boolean().describe("Re-screen criteria that already have a result"),
    }),
  },
);
