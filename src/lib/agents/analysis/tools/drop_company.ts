import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";

/**
 * Drop a company from the pipeline.
 *
 * Workforce-only tool. The chat agent does NOT have direct write access —
 * chat goes through `propose_workforce_handoff`, which renders a
 * confirmation card. After the user approves, a workforce row is enqueued
 * and the workforce agent calls THIS tool to actually perform the drop.
 */
export const dropCompany = tool(
  async ({
    company_name,
    reason,
  }: {
    company_name: string;
    reason: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: drop_company(company_name='${company_name}')`,
    );

    const trimmedName = company_name?.trim() ?? "";
    if (trimmedName.length === 0) {
      return `**Error:** company_name is required. Pass the target name or project name of the company to drop.`;
    }

    const trimmedReason = reason?.trim() ?? "";
    if (trimmedReason.length === 0) {
      return `**Error:** reason is required. Explain why this company is being dropped (e.g., poor financials, out of mandate).`;
    }

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());
      const company = await companyRepo.findByNameFuzzy(trimmedName);

      if (!company) {
        return `No company found matching "${trimmedName}". Use get_company_details or query_companies first to confirm the exact spelling.`;
      }

      if (company.status === "dropped") {
        return `"${company.target}" is already dropped.`;
      }

      const stage = company.pipeline_stage ?? undefined;
      const { companyService } = createContainer(db, await getActiveWorkspaceId());
      
      await companyService.dropDeal(
        company.id,
        stage,
        trimmedReason,
      );

      logger.debug(
        `✓ Dropped ${company.target} (${company.id})`,
      );
      return `Dropped "${company.target}". Reason recorded on the deal.`;
    } catch (error) {
      logger.error(`drop_company error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "drop_company",
    description: `Drop a single company from the pipeline (set its status to dropped).

This is the workforce-side execution of a single drop. It will change the company status to 'dropped' and record the provided reason.

Args:
    company_name: The company to drop. Required (non-empty). Fuzzy-matched (case-insensitive) against both the target name and the project name in the DB; use query_companies or get_company_details first if you're unsure of the spelling.
    reason: REQUIRED. Why this company should be dropped. One sentence citing concrete evidence (e.g., financials, mandate mismatch, lost to competitor).

Returns:
    A success or error message string.`,
    schema: z.object({
      company_name: z
        .string()
        .min(1)
        .describe(
          "Company target name or project name to drop (fuzzy match, must be non-empty)",
        ),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why this company should be dropped — one sentence citing concrete evidence.",
        ),
    }),
  },
);
