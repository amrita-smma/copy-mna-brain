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
      return `**Error:** reason is required. Explain why this company is being promoted to L1 (e.g. financial thesis fit, comparable acquisitions, screening outcome) — the human reviewer sees this before approving.`;
    }

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db);
      const company = await companyRepo.findByNameFuzzy(trimmedName);

      if (!company) {
        return `No company found matching "${trimmedName}". Use get_company_details or query_companies first to confirm the exact spelling.`;
      }

      if (company.status === "dropped") {
        return `Cannot promote "${company.target}": this company is dropped and is read-only.`;
      }

      const stage = company.pipeline_stage ?? null;
      if (stage !== CURRENT_STAGE) {
        return `Cannot promote "${company.target}" to ${NEXT_STAGE}: current pipeline stage is ${stage ?? "unset"}, expected ${CURRENT_STAGE}.`;
      }

      const trimmedNote = note?.trim() || undefined;
      // Persist the rationale on the deal alongside any caveat note so the
      // audit trail captures both *why* the agent proposed the promotion and
      // any caveats the user acknowledged. Reason comes first; the optional
      // note is appended after a blank line when present.
      const recordedNote = trimmedNote
        ? `Reason: ${trimmedReason}\n\nNote: ${trimmedNote}`
        : `Reason: ${trimmedReason}`;
      const { companyService } = createContainer(db);
      await companyService.promote(
        company.id,
        CURRENT_STAGE,
        NEXT_STAGE,
        recordedNote,
      );

      logger.debug(
        `✓ Promoted ${company.target} (${company.id}) from L0 to L1`,
      );
      return `Promoted "${company.target}" from ${CURRENT_STAGE} to ${NEXT_STAGE}. Reason and any note recorded on the deal.`;
    } catch (error) {
      logger.error(`promote_to_l1 error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "promote_to_l1",
    description: `Promote a company from pipeline stage L0 to L1.

This is the workforce-side execution of an L0→L1 promotion. The HITL middleware pauses execution before this tool runs and shows the human reviewer the \`reason\` you pass — write it so a reviewer with no other context can decide approve/reject.

The tool refuses to promote any company whose current stage is not L0; surface that error directly so the workforce trace records why nothing happened.

Args:
    company_name: The company to promote. Required (non-empty). Fuzzy-matched (case-insensitive) against both the target name and the project name in the DB; use query_companies or get_company_details first if you're unsure of the spelling.
    reason: REQUIRED. Why this company should move from L0 to L1, written as 1–3 sentences a human reviewer can read in isolation. Cite the concrete evidence: financial fit (revenue, EBITDA margin, growth), comparable-acquisition multiples, screening criteria the company passed, source meeting/file. Avoid vague phrasing like "looks good" or "matches thesis" — name the numbers and references.
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
          "Why this company should be promoted from L0 to L1 — 1–3 sentences citing concrete evidence (financials, comparables, screening results). Shown to the human reviewer in the HITL approval card.",
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
