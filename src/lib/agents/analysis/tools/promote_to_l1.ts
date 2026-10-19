import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";
import { PipelineStageUnavailableError } from "@/lib/services/companyService";
import {
  FIRST_STAGE_KEY,
  liveStageKeys,
  screeningTargetKey,
  stageCode,
} from "@/lib/pipeline/stages";

/**
 * Promote a company out of L0 into the stage that follows it — L1 in the
 * default pipeline, but whichever stage the workspace put after L0 (the name
 * stays `promote_to_l1` so the HITL gate and recorded traces keep matching).
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
    reason,
    note,
  }: {
    company_name: string;
    reason: string;
    note?: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: promote_to_l1(company_name='${company_name}')`,
    );

    const trimmedName = company_name?.trim() ?? "";
    if (trimmedName.length === 0) {
      return `**Error:** company_name is required. Pass the target name or project name of the company to promote.`;
    }

    const trimmedReason = reason?.trim() ?? "";
    if (trimmedReason.length === 0) {
      return `**Error:** reason is required. Explain why this company is being promoted out of L0 (e.g. financial thesis fit, comparable acquisitions, screening outcome) — the human reviewer sees this before approving.`;
    }

    // Set once the target is resolved, so the stage-deleted error can name it.
    let targetLabel = "the stage after L0";
    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);
      const company = await companyRepo.findByNameFuzzy(trimmedName);

      if (!company) {
        return `No company found matching "${trimmedName}". Use get_company_details or query_companies first to confirm the exact spelling.`;
      }

      if (company.status === "dropped") {
        return `Cannot promote "${company.target}": this company is dropped and is read-only.`;
      }

      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { companyService, pipelineStageService } = createContainer(db, workspaceId);
      const stages = await pipelineStageService.list();
      const fromLabel = stageCode(stages, FIRST_STAGE_KEY);

      const stage = company.pipeline_stage ?? null;
      if (stage !== FIRST_STAGE_KEY) {
        return `Cannot promote "${company.target}": current pipeline stage is ${stage ? stageCode(stages, stage) : "unset"}, expected ${fromLabel}.`;
      }

      const targetKey = screeningTargetKey(liveStageKeys(stages));
      if (!targetKey) {
        return `Cannot promote "${company.target}": this workspace has no pipeline stage after ${fromLabel}. Ask the user to add one in Pipeline Settings.`;
      }
      targetLabel = stageCode(stages, targetKey);

      const trimmedNote = note?.trim() || undefined;
      // Persist the rationale on the deal alongside any caveat note so the
      // audit trail captures both *why* the agent proposed the promotion and
      // any caveats the user acknowledged. Reason comes first; the optional
      // note is appended after a blank line when present.
      const recordedNote = trimmedNote
        ? `Reason: ${trimmedReason}\n\nNote: ${trimmedNote}`
        : `Reason: ${trimmedReason}`;
      await companyService.promote(
        company.id,
        FIRST_STAGE_KEY,
        targetKey,
        recordedNote,
        undefined,
        undefined,
        undefined,
        trimmedReason,
      );

      logger.debug(
        `✓ Promoted ${company.target} (${company.id}) from ${fromLabel} to ${targetLabel}`,
      );
      return `Promoted "${company.target}" from ${fromLabel} to ${targetLabel}. Reason and any note recorded on the deal.`;
    } catch (error) {
      // The target stage was deleted between the lookup and the write; say so
      // plainly rather than surfacing the raw stage-unavailable error.
      if (error instanceof PipelineStageUnavailableError) {
        return `Cannot promote "${trimmedName}" to ${targetLabel}: this workspace has just deleted that stage. Ask the user which stage the company should move to instead.`;
      }
      logger.error(`promote_to_l1 error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "promote_to_l1",
    description: `Promote a company from pipeline stage L0 into the stage that follows it — L1 in the default pipeline, or whichever stage the workspace configured after L0. The tool resolves that stage itself; you only name the company.

This is the workforce-side execution of a promotion out of L0. The HITL middleware pauses execution before this tool runs and shows the human reviewer the \`reason\` you pass — write it so a reviewer with no other context can decide approve/reject.

The tool refuses to promote any company whose current stage is not L0; surface that error directly so the workforce trace records why nothing happened.

Args:
    company_name: The company to promote. Required (non-empty). Fuzzy-matched (case-insensitive) against both the target name and the project name in the DB; use query_companies or get_company_details first if you're unsure of the spelling.
    reason: REQUIRED. Why this company should move out of L0 to the next stage, written as 1–3 sentences a human reviewer can read in isolation. Cite the concrete evidence: financial fit (revenue, EBITDA margin, growth), comparable-acquisition multiples, screening criteria the company passed, source meeting/file. Avoid vague phrasing like "looks good" or "matches thesis" — name the numbers and references.
    note: Optional caveat to record alongside the reason (e.g. "user acknowledged weak FY2024 EBITDA"). Distinct from \`reason\`: \`reason\` is the case FOR promotion, \`note\` is anything the reviewer should know in addition.

Returns:
    A success or error message string.`,
    schema: z.object({
      company_name: z
        .string()
        .min(1)
        .describe(
          "Company target name or project name to promote (fuzzy match, must be non-empty)",
        ),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why this company should be promoted out of L0 to the next stage — 1–3 sentences citing concrete evidence (financials, comparables, screening results). Shown to the human reviewer in the HITL approval card.",
        ),
      note: z
        .string()
        .optional()
        .describe(
          "Optional caveat recorded alongside the reason (e.g. acknowledged risks). Use `reason` for the justification; use `note` only for additional caveats.",
        ),
    }),
  },
);
