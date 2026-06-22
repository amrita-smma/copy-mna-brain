import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";

// Stages the agent is allowed to add a company at. All sit BELOW L1, so none
// require a HITL approval — they are triage/intake stages, not commitments:
//   - discovered        — DEFAULT. A company surfaced by the agent that is not
//                          (yet) a committed pipeline target. "Add this company"
//                          with no stage qualifier lands here.
//   - market_screening  — AI market-scan output ("Market Scanning"); use when
//                          the instruction frames the company as an
//                          AI-discovered scan result.
//   - L0                — the first committed pipeline stage ("Sourcing"). Only
//                          use when the instruction EXPLICITLY says L0 / the
//                          pipeline (e.g. "add Acme to L0", "source Acme").
const ADDABLE_STAGES = ["discovered", "market_screening", "L0"] as const;
type AddableStage = (typeof ADDABLE_STAGES)[number];
const DEFAULT_STAGE: AddableStage = "discovered";

const DEFAULT_SOURCE = "inbound" as const;
const ALLOWED_SOURCES = ["inbound", "outbound"] as const;

// Per-stage company_logs action so the activity feed / audit trail can tell how
// a company entered (mirrors CREATED_AS_DISCOVERED used by the relationship
// tooling and CREATED_AS_L0 used by the AI-sourced feed).
function logActionFor(stage: AddableStage): string {
  return `CREATED_AS_${stage.toUpperCase()}`;
}

/**
 * Add a newly surfaced company to the database at a chosen intake stage.
 *
 * Workforce-only write tool. AUTO-EXECUTES (no HITL gate) — every stage this
 * tool can write to (`discovered`, `market_screening`, `L0`) sits below L1, so
 * it is triage/intake, not a commitment. Promotions into L1+ still go through
 * the gated `promote_to_l1` / HITL middleware. See the gating policy in
 * `src/lib/agents/analysis/index.ts`.
 *
 * Stage policy:
 *   - Default is `discovered`. A bare "add this company" must NOT enter the L0
 *     pipeline — only land it at L0 when the instruction explicitly says so.
 *   - `market_screening` is for AI market-scan results.
 *
 * Idempotency: refuses to create a duplicate when a fuzzy match against
 * existing `target` or `project_name` is found. The agent should fall back to
 * reporting the existing match rather than retrying.
 */
export const addCompany = tool(
  async ({
    target,
    stage,
    segment,
    geography,
    source,
    note,
  }: {
    target: string;
    stage?: string;
    segment?: string;
    geography?: string;
    source?: string;
    note?: string;
  }) => {
    const resolvedStage = (stage ?? DEFAULT_STAGE) as AddableStage;
    logger.debug(
      `🔧 TOOL CALLED: add_company(target='${target}', stage='${resolvedStage}')`,
    );

    const trimmedTarget = target.trim();
    if (!trimmedTarget) {
      return `**Error:** target name is required.`;
    }

    if (!ADDABLE_STAGES.includes(resolvedStage)) {
      return `**Error:** stage must be one of ${ADDABLE_STAGES.join(", ")}; got "${stage}".`;
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
        const stageLabel = existing.pipeline_stage ?? "unset";
        return `A company matching "${trimmedTarget}" already exists in the pipeline (id: ${existing.id}, target: "${existing.target}", stage: ${stageLabel}). Did not create a duplicate.`;
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
          pipeline_stage: resolvedStage,
          status: "active",
        } as never,
        logActionFor(resolvedStage),
      );

      logger.debug(`✓ Created ${trimmedTarget} (${created.id}) at ${resolvedStage}`);
      const noteSuffix = trimmedNote ? ` Note: ${trimmedNote}` : "";
      return `Added "${trimmedTarget}" to the database at ${resolvedStage} (id: ${created.id}).${noteSuffix}`;
    } catch (error) {
      logger.error(`add_company error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "add_company",
    description: `Add a newly surfaced company to the database at a chosen intake stage.

This is the workforce-side execution of a company intake. Every stage this tool writes to sits below L1, so no human approval is required and the tool executes immediately. To later move a company up the pipeline (L0 → L1+), use \`promote_to_l1\` (which is gated by human approval).

## Choosing the stage (IMPORTANT)

- **discovered** (DEFAULT): a company you surfaced that is not a committed pipeline target. A bare "add this company" / "add Acme" with NO stage qualifier MUST use this. Do NOT put companies into the L0 pipeline by default.
- **market_screening**: an AI market-scan result ("Market Scanning"). Use when the instruction frames the company as an AI-discovered / market-scan find.
- **L0**: the first committed pipeline stage ("Sourcing"). ONLY use when the instruction EXPLICITLY says L0 / asks to source the company into the pipeline (e.g. "add Acme to L0", "source Acme into the pipeline").

Before inserting, the tool fuzzy-matches the target name against existing companies (target or project_name). If a match is found, no row is inserted; the tool returns the existing record so the agent can decide whether to update instead.

Args:
    target: Company name to record. Required.
    stage: Intake stage — one of "discovered" (default), "market_screening", or "L0". Defaults to "discovered"; only set "L0" when explicitly requested.
    segment: Optional sector/segment classification (e.g. "specialty chemicals").
    geography: Optional country/region (e.g. "Korea", "EU").
    source: Optional origin tag. One of "inbound" or "outbound"; defaults to "inbound".
    note: Optional triage note. Recorded informationally on the action message; not persisted to the row.

Returns:
    A success message with the new company id, or a duplicate-found message, or an error string.`,
    schema: z.object({
      target: z
        .string()
        .describe("Company name to record on the row"),
      stage: z
        .enum(ADDABLE_STAGES)
        .optional()
        .describe(
          'Intake stage: "discovered" (default), "market_screening", or "L0". Only use "L0" when explicitly requested.',
        ),
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
