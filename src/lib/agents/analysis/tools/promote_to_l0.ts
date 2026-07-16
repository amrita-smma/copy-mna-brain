import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";
import { IN_PIPELINE_STAGES } from "@/lib/services/companyService";

const NEXT_STAGE = "L0" as const;

export const promoteToL0 = tool(
  async ({
    company_name,
    reason,
    note,
    segment,
    geography,
    deal_type,
    source,
    banker,
    banker_source,
  }: {
    company_name: string;
    reason: string;
    note?: string;
    segment?: string;
    geography?: string;
    deal_type?: string;
    source?: string;
    banker?: string;
    banker_source?: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: promote_to_l0(company_name='${company_name}')`,
    );

    const trimmedName = company_name?.trim() ?? "";
    if (trimmedName.length === 0) {
      return `**Error:** company_name is required.`;
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);
      const company = await companyRepo.findByNameFuzzy(trimmedName);

      if (!company) {
        return `No company found matching "${trimmedName}". Use query_companies to confirm spelling.`;
      }

      if (company.status === "dropped") {
        return `Cannot promote "${company.target}": this company is dropped.`;
      }

      const stage = company.pipeline_stage ?? null;
      if (stage && IN_PIPELINE_STAGES.has(stage)) {
        return `Cannot promote "${company.target}" to ${NEXT_STAGE}: it is already in the pipeline (stage: ${stage}).`;
      }

      const { companyService } = createContainer(db, workspaceId);
      
      // Update missing L0 fields if provided
      const updates: any = {};
      if (segment?.trim()) updates.segment = segment.trim();
      if (geography?.trim()) updates.geography = geography.trim();
      if (deal_type?.trim()) updates.deal_type = deal_type.trim();
      if (source?.trim()) updates.source = source.trim().toLowerCase();
      if (banker?.trim()) updates.banker = banker.trim();
      if (banker_source?.trim()) updates.banker_source = banker_source.trim();
      
      // Also default source to 'outbound' if missing
      if (!company.source && !updates.source) updates.source = 'outbound';

      if (Object.keys(updates).length > 0) {
        await companyService.update(company.id, updates);
      }

      const recordedNote = note?.trim()
        ? `Reason: ${reason.trim()}\n\nNote: ${note.trim()}`
        : `Reason: ${reason.trim()}`;

      await companyService.promote(
        company.id,
        stage ?? undefined,
        NEXT_STAGE,
        recordedNote,
        undefined,
        undefined,
        undefined,
        reason.trim(),
      );

      logger.debug(`✓ Promoted ${company.target} (${company.id}) to L0`);
      return `Promoted "${company.target}" to ${NEXT_STAGE}.`;
    } catch (error) {
      logger.error(`promote_to_l0 error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "promote_to_l0",
    description: `Promote a company from a pre-pipeline intake stage (like 'discovered', 'market_screening', or 'unreviewed') to the active pipeline (L0).

Use this tool to move companies surfaced through outbound search or relationship graph discovery into the active pipeline. If the company is missing required L0 fields (like segment, geography, deal_type, or source), provide them in the tool call to satisfy the pipeline entry requirements.

Args:
    company_name: The company to promote (fuzzy-matched).
    reason: REQUIRED. Why this company should enter the pipeline (e.g. thesis fit, strong outbound signal).
    note: Optional caveat.
    segment: Optional sector/segment (required for L0 if not already set). Keep broad (e.g. "Semiconductor").
    geography: Optional HQ country (required for L0 if not already set). Exactly ONE country name.
    deal_type: Optional deal type (required for L0 if not already set). "Majority" or "Minority".
    source: Optional source (required for L0 if not already set). "inbound" or "outbound". Defaults to outbound if left blank.
    banker: Optional banker name (required for L0 if source is inbound).
    banker_source: Optional banker source (alternative to banker).`,
    schema: z.object({
      company_name: z.string().min(1).describe("Company name to promote"),
      reason: z.string().min(1).describe("Why it should enter L0"),
      note: z.string().optional().describe("Optional caveat"),
      segment: z.string().optional().describe("Sector/segment"),
      geography: z.string().optional().describe("HQ country"),
      deal_type: z.string().optional().describe("Majority or Minority"),
      source: z.enum(["inbound", "outbound"]).optional().describe("inbound or outbound"),
      banker: z.string().optional().describe("Banker name"),
      banker_source: z.string().optional().describe("Banker firm"),
    }),
  },
);
