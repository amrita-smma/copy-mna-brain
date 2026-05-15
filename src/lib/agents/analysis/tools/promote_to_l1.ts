import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";

const CURRENT_STAGE = "L0" as const;
const NEXT_STAGE = "L1" as const;

/**
 * Promote a company from pipeline stage L0 to L1.
 *
 * Workforce-only tool. The chat agent does NOT have direct write access —
 * chat goes through `propose_workforce_handoff`, which renders a
 * confirmation card. After the user approves, a workforce row is enqueued
 * and the workforce agent calls THIS tool to actually perform the
 * promotion.
 *
 * No chat-side confirm/preview dance here (which the original deleted
 * chat-side version had) — by the time the workforce agent runs, the user
 * has already given their explicit yes via the handoff card.
 */
export const promoteToL1 = tool(
  async ({
    company_name,
    note,
  }: {
    company_name: string;
    note?: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: promote_to_l1(company_name='${company_name}')`,
    );

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db);
      const company = await companyRepo.findByNameFuzzy(company_name);

      if (!company) {
        return `No company found matching "${company_name}". Use get_company_details or query_companies first to confirm the exact spelling.`;
      }

      const stage = company.pipeline_stage ?? null;
      if (stage !== CURRENT_STAGE) {
        return `Cannot promote "${company.target}" to ${NEXT_STAGE}: current pipeline stage is ${stage ?? "unset"}, expected ${CURRENT_STAGE}.`;
      }

      const trimmedNote = note?.trim() || undefined;
      const { companyService } = createContainer(db);
      await companyService.promote(
        company.id,
        CURRENT_STAGE,
        NEXT_STAGE,
        trimmedNote,
      );

      logger.debug(
        `✓ Promoted ${company.target} (${company.id}) from L0 to L1`,
      );
      return `Promoted "${company.target}" from ${CURRENT_STAGE} to ${NEXT_STAGE}.${trimmedNote ? ` Note recorded.` : ""}`;
    } catch (error) {
      logger.error(`promote_to_l1 error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "promote_to_l1",
    description: `Promote a company from pipeline stage L0 to L1.

This is the workforce-side execution of an L0→L1 promotion. By the time this is called, the user has already approved the promotion via a Copilot handoff card — execute directly, no further confirmation needed.

The tool refuses to promote any company whose current stage is not L0; surface that error directly so the workforce trace records why nothing happened.

Args:
    company_name: The company to promote. Fuzzy-matched against the names in the DB; use query_companies or get_company_details first if you're unsure of the spelling.
    note: Optional promotion note recorded on the deal. Use this to record any caveats from the handoff instruction (e.g. "user acknowledged weak FY2024 EBITDA").

Returns:
    A success or error message string.`,
    schema: z.object({
      company_name: z
        .string()
        .describe("Company name to promote (fuzzy match)"),
      note: z
        .string()
        .optional()
        .describe(
          "Optional promotion note to record on the deal (include caveats from the handoff)",
        ),
    }),
  },
);
