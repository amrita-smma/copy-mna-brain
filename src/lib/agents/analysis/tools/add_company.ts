import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository } from "@/lib/repositories";

// Stages the agent is allowed to add a company at. All three sit BELOW L1, so
// none requires a HITL approval — they are triage/intake stages, not
// commitments:
//   - market_screening  — DEFAULT. AI-screened intake ("AI Screened Companies" /
//                          "Market Scanning"). Any company the AI Workforce
//                          surfaces on its own initiative lands here unless
//                          told otherwise.
//   - discovered        — a company surfaced via the relationship graph that is
//                          not a market-scan find. Use when the instruction
//                          frames the company as a graph/relationship discovery.
//   - unreviewed        — a company a HUMAN explicitly asked to be added via
//                          chat (typed details or an attached teaser/screenshot),
//                          relayed through propose_workforce_handoff. Mirrors the
//                          stage used for companies auto-created from email
//                          attachments — a person is triaging it, so it is not
//                          an AI-discovery pick and must not land in
//                          market_screening/discovered.
// The AI Workforce must NEVER add directly to L0 (the first committed pipeline
// stage, "Sourcing"). Entry into L0+ happens through the gated promote flow /
// human action, never as a raw intake write.
const ADDABLE_STAGES = ["market_screening", "discovered", "unreviewed"] as const;
type AddableStage = (typeof ADDABLE_STAGES)[number];
const DEFAULT_STAGE: AddableStage = "market_screening";

const DEFAULT_SOURCE = "outbound" as const;
const ALLOWED_SOURCES = ["inbound", "outbound"] as const;
const MAX_FINANCIAL_ROWS = 5;

// Free-text company columns the tool records at create time, alongside
// target/segment/geography/source. Blank strings are dropped, not stored.
const DETAIL_TEXT_FIELDS = [
  "company_focus",
  "website",
  "ownership",
  "comments",
  "remarks",
  "thesis_content",
  "watchlist_status",
] as const;
type DetailTextField = (typeof DETAIL_TEXT_FIELDS)[number];

interface FinancialRow {
  fiscal_year: number;
  revenue_usd_mn?: number;
  ebitda_usd_mn?: number;
  ev_usd_mn?: number;
}

// Per-stage company_logs action so the activity feed / audit trail can tell how
// a company entered (CREATED_AS_MARKET_SCREENING for AI-screened intake;
// CREATED_AS_DISCOVERED mirrors what the relationship tooling records).
function logActionFor(stage: AddableStage): string {
  return `CREATED_AS_${stage.toUpperCase()}`;
}

/**
 * Add a newly surfaced company to the database at a chosen intake stage.
 *
 * Workforce-only write tool. AUTO-EXECUTES (no HITL gate) — every stage this
 * tool can write to (`market_screening`, `discovered`, `unreviewed`) sits below
 * L1, so it is triage/intake, not a commitment. The tool CANNOT write to L0 or
 * any committed pipeline stage; entry into L0+ goes through the gated
 * `promote_to_l1` / HITL middleware or human action. See the gating policy in
 * `src/lib/agents/analysis/index.ts`.
 *
 * Stage policy:
 *   - Default is `market_screening` ("AI Screened Companies"). Any company the
 *     AI Workforce surfaces lands in the AI-screened intake bucket, never in L0.
 *   - `discovered` is for relationship-graph / non-scan surfacing.
 *   - `unreviewed` is for a company a human explicitly asked to be added via
 *     chat — never the default; only use it when the instruction says so.
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
    watchlist_id,
    financials,
    ...details
  }: {
    target: string;
    stage?: string;
    segment?: string;
    geography?: string;
    source?: string;
    note?: string;
    watchlist_id?: number;
    financials?: FinancialRow[];
  } & Partial<Record<DetailTextField, string>>) => {
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

    const rows = financials ?? [];
    const seenYears = new Set<number>();
    for (const row of rows) {
      if (seenYears.has(row.fiscal_year)) {
        return `**Error:** fiscal_year ${row.fiscal_year} appears more than once in \`financials\`. Combine the metrics for a year into one row.`;
      }
      seenYears.add(row.fiscal_year);
      if (
        row.revenue_usd_mn === undefined &&
        row.ebitda_usd_mn === undefined &&
        row.ev_usd_mn === undefined
      ) {
        return `**Error:** the \`financials\` row for ${row.fiscal_year} sets no figures. Include at least one of revenue_usd_mn, ebitda_usd_mn, ev_usd_mn, or drop the row.`;
      }
    }

    const detailFields: Partial<Record<DetailTextField, string>> = {};
    for (const key of DETAIL_TEXT_FIELDS) {
      const value = details[key]?.trim();
      if (value) detailFields[key] = value;
    }

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());

      // Duplicate guard: fuzzy-match against target/project_name to avoid
      // inserting a near-duplicate of a company already in the pipeline.
      const existing = await companyRepo.findByNameFuzzy(trimmedTarget);
      if (existing) {
        const stageLabel = existing.pipeline_stage ?? "unset";
        return `A company matching "${trimmedTarget}" already exists in the pipeline (id: ${existing.id}, target: "${existing.target}", stage: ${stageLabel}). Did not create a duplicate.`;
      }

      const { companyService } = createContainer(db, await getActiveWorkspaceId());
      const trimmedNote = note?.trim() || undefined;
      const trimmedSegment = segment?.trim() || undefined;
      const trimmedGeography = geography?.trim() || undefined;

      const created = await companyService.create(
        {
          target: trimmedTarget,
          segment: trimmedSegment,
          geography: trimmedGeography,
          source: normalizedSource as (typeof ALLOWED_SOURCES)[number],
          ...detailFields,
          ...(watchlist_id !== undefined ? { watchlist_id } : {}),
          pipeline_stage: resolvedStage,
          status: "active",
        } as never,
        logActionFor(resolvedStage),
      );

      logger.debug(`✓ Created ${trimmedTarget} (${created.id}) at ${resolvedStage}`);
      const noteSuffix = trimmedNote ? ` Note: ${trimmedNote}` : "";
      const added = `Added "${trimmedTarget}" to the database at ${resolvedStage} (id: ${created.id}).`;

      // A second service call, so a second commit: the company row can land
      // while the financials write fails. `updateFinancials` owns the
      // EBITDA-margin / EV-EBITDA recompute, so it stays a service call.
      if (rows.length > 0) {
        try {
          await companyService.updateFinancials(
            created.id,
            rows,
            [],
            "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
          );
        } catch (error) {
          logger.error(`add_company financials error: ${(error as Error).message}`);
          return `${added} **Error:** the company was created but its financials failed to save: ${(error as Error).message}. Retry them with update_company_details.${noteSuffix}`;
        }
        const years = rows.map((r) => `FY${r.fiscal_year}`).join(", ");
        return `${added} Financials saved for ${years}.${noteSuffix}`;
      }
      return `${added}${noteSuffix}`;
    } catch (error) {
      logger.error(`add_company error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "add_company",
    description: `Add a newly surfaced company to the database at an intake stage.

This is the workforce-side execution of a company intake. Every stage this tool writes to sits below L1, so no human approval is required and the tool executes immediately. The tool CANNOT add to L0 or any committed pipeline stage — to move a company into the pipeline (→ L0/L1+), use \`promote_to_l1\` (which is gated by human approval).

## Choosing the stage (IMPORTANT)

- **market_screening** (DEFAULT): the "AI Screened Companies" intake bucket ("Market Scanning"). Any company you surface on your own initiative lands here. A bare "add this company" / "add Acme" MUST use this. NEVER add a company directly to the L0 pipeline — that is not an option here.
- **discovered**: a company surfaced via the relationship graph that is not a market-scan find. Use only when the instruction frames the company as a graph/relationship discovery.
- **unreviewed**: a company a HUMAN explicitly asked to be added via chat (named it directly, typed its details, or attached a teaser/screenshot). Use ONLY when the instruction says the request came from a human via chat, not an AI-sourced discovery — this keeps it out of the "AI Screened Companies" bucket and in the same triage queue as companies auto-created from email attachments.

Before inserting, the tool fuzzy-matches the target name against existing companies (target or project_name). If a match is found, no row is inserted; the tool returns the existing record so the agent can decide whether to update instead.

Args:
    target: Company name to record. Required.
    stage: Intake stage — one of "market_screening" (default), "discovered", or "unreviewed". Defaults to "market_screening". L0 is NOT accepted.
    segment: Optional sector/segment classification. Keep it BROAD, not hyper-specific — a category many companies can share (e.g. "Semiconductor", "CMP Slurry", "Petrochemical"), not a narrow niche unique to one company. Over-specific segments create minimal overlap and make cohort grouping useless. Always in English, even if source material is in another language.
    geography: Optional headquarters country — EXACTLY ONE country name (e.g. "South Korea", "United States"). Never combine multiple countries, regions, cities, or facility/R&D locations. Always in English, even if source material is in another language.
    source: Optional origin tag. One of "inbound" or "outbound"; defaults to "outbound" (AI-discovered companies are outbound by nature).
    company_focus: Optional 1-2 line description of what the company does.
    website, ownership: Optional (ownership e.g. "family office", "PE-backed", "public").
    comments, remarks, thesis_content: Optional free-text notes recorded on the company.
    watchlist_id, watchlist_status: Optional watchlist reference.
    financials: Optional per-fiscal-year figures in USD millions, max ${MAX_FINANCIAL_ROWS} rows: [{ fiscal_year, revenue_usd_mn?, ebitda_usd_mn?, ev_usd_mn? }]. One row per year, each with at least one figure. EBITDA margin and EV/EBITDA are computed for you.
    note: Optional triage note. Recorded informationally on the action message; not persisted to the row.

Record every detail the instruction gives at create time — do not drop website, ownership, financials or notes and leave them for a later edit. Never invent a value the instruction does not state.

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
          'Intake stage: "market_screening" (default, the "AI Screened Companies" bucket), "discovered", or "unreviewed" (a human explicitly asked to add this via chat — never the default). L0 is not accepted — the workforce never adds directly to the committed pipeline.',
        ),
      segment: z
        .string()
        .optional()
        .describe(
          'Broad sector / segment classification — a category many companies can share (e.g. "Semiconductor", "CMP Slurry", "Petrochemical"), NOT a hyper-specific niche unique to one company. Too specific means minimal segment overlap and useless cohort grouping. Always in English, even if source material is in another language.',
        ),
      geography: z
        .string()
        .optional()
        .describe(
          'Headquarters country — EXACTLY ONE country name (e.g. "South Korea", "United States"). Never combine multiple countries, regions, cities, or facility/R&D locations. Always in English, even if source material is in another language.',
        ),
      source: z
        .enum(ALLOWED_SOURCES)
        .optional()
        .describe("Origin tag: outbound (default, AI-discovered) or inbound"),
      company_focus: z
        .string()
        .optional()
        .describe("What the company does, in 1-2 lines"),
      website: z.string().optional().describe("Company website"),
      ownership: z
        .string()
        .optional()
        .describe('Ownership, e.g. "family office", "PE-backed", "public"'),
      comments: z.string().optional().describe("Free-text comments"),
      remarks: z.string().optional().describe("Free-text remarks"),
      thesis_content: z
        .string()
        .optional()
        .describe("Thesis notes recorded on the company"),
      watchlist_id: z.number().int().optional().describe("Watchlist ID"),
      watchlist_status: z.string().optional().describe("Watchlist status"),
      financials: z
        .array(
          z.object({
            fiscal_year: z
              .number()
              .int()
              .min(1990)
              .max(2100)
              .describe("Fiscal year the figures belong to"),
            revenue_usd_mn: z.number().finite().optional().describe("Revenue in USD millions"),
            ebitda_usd_mn: z.number().finite().optional().describe("EBITDA in USD millions"),
            ev_usd_mn: z
              .number()
              .finite()
              .optional()
              .describe("Enterprise value in USD millions"),
          }),
        )
        .max(MAX_FINANCIAL_ROWS)
        .optional()
        .describe("Per-fiscal-year figures in USD millions, one row per year"),
      note: z
        .string()
        .optional()
        .describe("Optional triage note (not persisted to the row)"),
    }),
  },
);
