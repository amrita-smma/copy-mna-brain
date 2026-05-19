import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";

const TARGET_STAGE = "L0" as const;
const DEFAULT_SOURCE = "inbound" as const;
const ALLOWED_SOURCES = ["inbound", "outbound"] as const;

/**
 * Add a new company to the pipeline at stage L0.
 *
 * Workforce-only write tool. AUTO-EXECUTES (no HITL gate) — L0 is the
 * triage stage, not a commitment, so the agent enters discovered companies
 * directly. Subsequent stage moves (L0 → L1+) DO require human approval
 * and go through `promote_to_l1` / the HITL middleware. See the gating
 * policy in `src/lib/agents/analysis/index.ts`.
 *
 * Idempotency: refuses to create a duplicate when a fuzzy match against
 * existing `target` or `project_name` is found. The agent should fall
 * back to reporting the existing match rather than retrying.
 */
export const addCompanyToL0 = tool(
  async ({
    target,
    segment,
    geography,
    source,
    note,
  }: {
    target: string;
    segment?: string;
    geography?: string;
    source?: string;
    note?: string;
  }) => {
    logger.debug(`🔧 TOOL CALLED: add_company_to_l0(target='${target}')`);

    const trimmedTarget = target.trim();
    if (!trimmedTarget) {
      return `**Error:** target name is required.`;
    }

    const normalizedSource = (source ?? DEFAULT_SOURCE).trim().toLowerCase();
    if (!ALLOWED_SOURCES.includes(normalizedSource as (typeof ALLOWED_SOURCES)[number])) {
      return `**Error:** source must be one of ${ALLOWED_SOURCES.join(", ")}; got "${source}".`;
    }

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db);

      // Duplicate guard: fuzzy-match against target/project_name to avoid
      // inserting a near-duplicate of a company already in the pipeline.
      const existing = await companyRepo.findByNameFuzzy(trimmedTarget);
      if (existing) {
        const stage = existing.pipeline_stage ?? "unset";
        return `A company matching "${trimmedTarget}" already exists in the pipeline (id: ${existing.id}, target: "${existing.target}", stage: ${stage}). Did not create a duplicate.`;
      }

      const { companyService } = createContainer(db);
      const trimmedNote = note?.trim() || undefined;
      const trimmedSegment = segment?.trim() || undefined;
      const trimmedGeography = geography?.trim() || undefined;

      const created = await companyService.create(
        {
          target: trimmedTarget,
          segment: trimmedSegment,
          geography: trimmedGeography,
          source: normalizedSource as (typeof ALLOWED_SOURCES)[number],
          pipeline_stage: TARGET_STAGE,
          status: "active",
        } as never,
        "CREATED_AS_L0",
      );

      logger.debug(`✓ Created ${trimmedTarget} (${created.id}) at L0`);
      const noteSuffix = trimmedNote ? ` Note: ${trimmedNote}` : "";
      return `Added "${trimmedTarget}" to the pipeline at ${TARGET_STAGE} (id: ${created.id}).${noteSuffix}`;
    } catch (error) {
      logger.error(`add_company_to_l0 error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "add_company_to_l0",
    description: `Add a newly discovered company to the pipeline at stage L0.

This is the workforce-side execution of an L0 entry. L0 is the triage stage — no human approval is required, so the tool executes immediately. If the company should later be promoted to L1+, use \`promote_to_l1\` (which is gated by human approval).

Before inserting, the tool fuzzy-matches the target name against existing companies (target or project_name). If a match is found, no row is inserted; the tool returns the existing record so the agent can decide whether to update instead.

Args:
    target: Company name to record on the pipeline row. Required.
    segment: Optional sector/segment classification (e.g. "specialty chemicals").
    geography: Optional country/region (e.g. "Korea", "EU").
    source: Optional origin tag. One of "inbound" or "outbound"; defaults to "inbound".
    note: Optional triage note. Recorded informationally on the action message; not persisted to the row.

Returns:
    A success message with the new company id, or a duplicate-found message, or an error string.`,
    schema: z.object({
      target: z
        .string()
        .describe("Company name to record on the pipeline row"),
      segment: z
        .string()
        .optional()
        .describe("Sector / segment classification"),
      geography: z
        .string()
        .optional()
        .describe("Country or region (e.g. Korea, EU)"),
      source: z
        .enum(ALLOWED_SOURCES)
        .optional()
        .describe("Origin tag: inbound (default) or outbound"),
      note: z
        .string()
        .optional()
        .describe("Optional triage note (not persisted to the row)"),
    }),
  },
);
