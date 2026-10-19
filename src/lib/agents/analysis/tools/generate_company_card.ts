import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { generateCompanyCard as runGenerateCompanyCard } from "@/lib/jobs/handlers/companyAnalysis";

/**
 * Workforce-only tool: generate the AI Company Card for a company and link the
 * companies it surfaces as related into the relationship graph.
 *
 * Flow:
 *   1. Research the company on the stateless analysis agent and persist the
 *      structured 6-section card to `company_analyses` (this is what the
 *      Company Card UI polls for).
 *   2. For every related company the card surfaced, resolve it by name —
 *      creating a `discovered` row when it isn't on record — and upsert a
 *      directed edge in Neo4j. Reuses `CompanyRelationshipService.linkByName`,
 *      the same machinery behind `update_company_relationship`.
 *
 * Relationship linking is best-effort per company: a failure on one related
 * company is reported but does not fail the card itself.
 */
export const generateCompanyCard = tool(
  async ({ company_id }: { company_id: string }) => {
    const id = company_id?.trim();
    if (!id) {
      return `**Error:** company_id is required.`;
    }

    logger.debug(`🔧 TOOL CALLED: generate_company_card('${id}')`);

    try {
      const db = createDb();
      const { analysis, relatedCompanies, companyName } =
        await runGenerateCompanyCard({ companyId: id }, { db });

      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { companyRelationshipService } = createContainer(db, await getActiveWorkspaceId());

      const linked: string[] = [];
      for (const rc of relatedCompanies) {
        const name = rc.name?.trim();
        if (!name || name.toLowerCase() === companyName.toLowerCase()) continue;
        try {
          const { target } = await companyRelationshipService.linkByName({
            sourceName: companyName,
            targetName: name,
            type: rc.relation_type,
            notes: rc.notes?.trim() || undefined,
            evidence: rc.evidence?.trim() || undefined,
          });
          linked.push(
            `"${target.row.target}" (${rc.relation_type}${target.created ? ", new discovered" : ""})`,
          );
        } catch (err) {
          logger.error(
            `generate_company_card: failed to link "${name}": ${(err as Error).message}`,
          );
          linked.push(`"${name}" — link failed: ${(err as Error).message}`);
        }
      }

      const linkSummary = linked.length
        ? ` Linked ${linked.length} related ${linked.length === 1 ? "company" : "companies"}: ${linked.join("; ")}.`
        : " No related companies were surfaced.";

      return `Generated the AI Company Card for "${companyName}" (analysis id: ${analysis.id}).${linkSummary}`;
    } catch (error) {
      logger.error(`generate_company_card error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "generate_company_card",
    description: `Generate the AI Company Card for a company and link its related companies in the relationship graph.

Researches the company across all available data sources, produces the structured Company Card (business overview, business model, key takeaways, investment highlights/risks, diligence priorities), and saves it. It then identifies the company's notable suppliers, partners, and investors and records each as a directed edge in the relationship graph — creating any unknown company at the special "discovered" stage.

Args:
    company_id: The UUID of the company to generate the card for. Required.

Returns:
    A success message naming the company, the saved analysis id, and the related companies that were linked (flagging any created as "discovered"), or an error string.`,
    schema: z.object({
      company_id: z
        .string()
        .describe("The UUID of the company to generate the Company Card for"),
    }),
  },
);
