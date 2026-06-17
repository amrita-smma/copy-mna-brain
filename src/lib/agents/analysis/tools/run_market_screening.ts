import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { InvestmentThesisRepository } from "@/lib/repositories";
import { runMarketScreening } from "@/lib/jobs/handlers/marketScreening";

export const runMarketScreeningTool = tool(
  async ({ sources_count }: { sources_count?: number }) => {
    logger.debug(`🔧 TOOL CALLED: run_market_screening(sources_count=${sources_count ?? 5})`);
    try {
      const db = createDb();
      const thesisRepo = new InvestmentThesisRepository(db);
      const thesis = await thesisRepo.findActive();
      if (!thesis) {
        return "No active investment thesis found. Please set an active investment thesis before running market screening.";
      }
      // The thesis owns how many companies a scan should surface. Honor an
      // explicit override when the agent passes one, otherwise fall back to
      // the thesis value (and finally a hard default).
      const sources = sources_count ?? thesis.sources_count ?? 5;
      const result = await runMarketScreening(
        { thesis: thesis.content, thesisId: thesis.id, sourcesCount: sources },
        { db },
      );
      if (result.count === 0) {
        return result.message ?? "Market screening completed but no new companies were found.";
      }
      return `Market screening completed. Discovered ${result.count} new acquisition target(s): ${result.companies.join(", ")}.`;
    } catch (error) {
      logger.error(`run_market_screening error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "run_market_screening",
    description: `Run an AI-powered market scan to discover new acquisition targets matching the current active investment thesis.

Uses web search to find companies that match the thesis criteria, then adds them to the pipeline at the market_screening stage with financial data.

This tool is intended for the recurring market-scanning routine and can also be called ad-hoc. It automatically reads the active investment thesis — no need to pass the thesis content or the company count.

Args:
    sources_count: Optional override for the number of companies to discover. When omitted, the active thesis's configured count is used (max 20).

Returns:
    A summary string describing how many companies were discovered and their names, or an error message.`,
    schema: z.object({
      sources_count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of new acquisition targets to discover (default 5)"),
    }),
  },
);
