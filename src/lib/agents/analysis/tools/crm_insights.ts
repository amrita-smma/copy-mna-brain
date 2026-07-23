import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { EmailRepository, EmployerRepository } from "@/lib/repositories";

// A firm is "stale" once we haven't exchanged an email with it in this many
// days. Mirrors CRMService.insights so the chatbot and the CRM dashboard report
// the same number.
const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Portfolio-wide CRM health metrics: how many firms have gone stale, how many
 * records are flagged for curation, and how many emails landed today. This is
 * the aggregate counterpart to lookup_crm (which is per-firm).
 */
export const crmInsights = tool(
  async (_arg: any, config?: RunnableConfig) => {
    logger.debug("🔧 TOOL CALLED: crm_insights()");

    try {
      const workspaceId = config?.configurable?.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required in the runnable config");
      }

      const db = createDb();
      const employerRepo = new EmployerRepository(db);
      const emailRepo = new EmailRepository(db);

      const now = Date.now();
      const staleThreshold = new Date(now - STALE_DAYS * DAY_MS).toISOString();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [stale, flagged, emailsToday] = await Promise.all([
        emailRepo.countStaleEmployers(staleThreshold, workspaceId),
        employerRepo.countFlagged(workspaceId),
        emailRepo.countSince(todayStart.toISOString(), workspaceId),
      ]);

      logger.debug(
        `✓ CRM insights: stale=${stale} flagged=${flagged} today=${emailsToday}`,
      );

      return `## CRM Insights
- **Stale relationships:** ${stale} (no contact in the last ${STALE_DAYS} days)
- **Flagged records:** ${flagged} (awaiting curation)
- **Emails today:** ${emailsToday}`;
    } catch (error) {
      logger.error(`CRM insights error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "crm_insights",
    description: `Get portfolio-wide CRM health metrics.

Use this when the user asks about the CRM as a whole rather than one firm —
e.g. "how many stale relationships do we have", "how many records need
curation", or "how many emails came in today". Takes no arguments.

For details about a specific firm or banker, use lookup_crm instead.

Returns:
    A markdown summary with stale-relationship, flagged-record, and
    emails-today counts.`,
    schema: z.object({}),
  }
);
