import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { InvestmentThesisRepository } from "@/lib/repositories";
import { logger } from "../../logger";

/**
 * Retrieve investment theses configured in the current workspace.
 * Returns active theses by default, with an option to include inactive theses.
 */
export const getInvestmentTheses = tool(
  async ({ include_inactive = false }: { include_inactive?: boolean } = {}) => {
    logger.debug(
      `🔧 TOOL CALLED: get_investment_theses(include_inactive=${include_inactive})`,
    );

    try {
      const workspaceId = await getActiveWorkspaceId();
      const db = createDb();
      const thesisRepo = new InvestmentThesisRepository(db, workspaceId);

      const theses = include_inactive
        ? await thesisRepo.findAll()
        : await thesisRepo.findAllActive();

      if (!theses || theses.length === 0) {
        return include_inactive
          ? "No investment theses configured in this workspace."
          : "No active investment thesis configured in this workspace.";
      }

      const sections = theses.map((thesis) => {
        const lines = [
          `## Thesis: ${thesis.title || "Untitled"}`,
          `- **ID:** ${thesis.id}`,
          `- **Title:** ${thesis.title || "N/A"}`,
          `- **PIC:** ${thesis.pic ?? "N/A"}`,
          `- **Is Active:** ${thesis.is_active ? "true" : "false"}`,
          `- **Updated At:** ${thesis.updated_at ?? "N/A"}`,
          `\n### Content\n${thesis.content || "(No content)"}`,
        ];
        return lines.join("\n");
      });

      let out = `**Investment Theses (${theses.length}):**\n\n`;
      out += sections.join("\n\n---\n\n");
      return out;
    } catch (error) {
      logger.error(`get_investment_theses error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_investment_theses",
    description: `Retrieve investment theses ("Tracks") configured in this workspace.

By default, returns all active investment theses. Pass include_inactive: true to also retrieve inactive theses.
Returns factual structured details (id, title, content, pic, is_active, updated_at) for each thesis without scoring or fit judgment.

Args:
    include_inactive: Whether to include inactive investment theses (default: false, returns active theses only).

Returns:
    Structured details for each matching investment thesis, or a message when no theses are found.`,
    schema: z.object({
      include_inactive: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Whether to include inactive investment theses (default false, returns active theses only)",
        ),
    }),
  },
);

export const get_investment_theses = getInvestmentTheses;
export default getInvestmentTheses;
