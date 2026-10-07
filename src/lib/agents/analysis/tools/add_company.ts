import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { CompanyRepository, UserRepository } from "@/lib/repositories";
import { companyDisplayTitle } from "@/lib/companyDisplay";
import { DEAL_TYPES, normalizeDealType } from "@/lib/companies/dealTypes";
import { defaultDealTypeFor } from "../flavors/flavorDealTypes";

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
// target/project_name/segment/geography/source. Blank strings are dropped, not
// stored. These are the same columns `update_company_details` can edit later —
// an intake should be able to record everything the instruction gives in ONE
// call rather than landing a bare row and enriching it afterwards.
const DETAIL_TEXT_FIELDS = [
  "company_focus",
  "website",
  "ownership",
  "comments",
  "remarks",
  "thesis_content",
  "watchlist_status",
  // Free-form markdown background, shown on the company card's Context tab and
  // read back by the AI Opinion run, the slide generators and the read tools.
  "context",
  "segment_related_offerings",
  // ── Deal shape ──
  "stake",
  "deal_size",
  "doc_type",
  "workflow_status",
  "key_rationale",
  // ── Deal contacts (free text, NOT user references) ──
  "banker",
  "banker_source",
  "advisor",
  "originator",
] as const;
type DetailTextField = (typeof DETAIL_TEXT_FIELDS)[number];

/**
 * Columns holding a `users.id` uuid. The agent is given a person's NAME (or
 * email), never a uuid, so each is resolved against the workspace's members
 * before the insert — see {@link resolvePeopleFields}.
 */
const PEOPLE_FIELDS = ["deal_sponsor", "deal_captain", "entered_by"] as const;
type PeopleField = (typeof PEOPLE_FIELDS)[number];


/**
 * Outcome of resolving the people columns. A single shape rather than a
 * discriminated union: this project compiles with `strictNullChecks: false`,
 * where narrowing on a boolean discriminant is not reliable. `error` set means
 * nothing was resolved and the caller must refuse.
 */
interface PeopleResolution {
  values: Partial<Record<PeopleField, string>>;
  error?: string;
}

interface FinancialRow {
  fiscal_year: number;
  revenue_usd_mn?: number;
  ebitda_usd_mn?: number;
  ev_usd_mn?: number;
}

/**
 * Resolve the people columns from the names the agent was given.
 *
 * Reads the workspace's members ONCE and matches in memory, however many
 * people fields were passed — a per-field lookup would be a fan-out over a
 * table every intake touches. Only workspace members are valid: these columns
 * are uuid FKs to `users.id` and every picker in the app offers exactly this
 * list.
 *
 * Returns an error string instead of guessing when a name matches nothing or
 * matches more than one member — silently attributing a deal to the wrong
 * person is worse than refusing.
 */
async function resolvePeopleFields(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  requested: Partial<Record<PeopleField, string>>,
): Promise<PeopleResolution> {
  const entries = PEOPLE_FIELDS.map((field) => [field, requested[field]?.trim()] as const)
    .filter((entry): entry is readonly [PeopleField, string] => Boolean(entry[1]));
  if (entries.length === 0) return { values: {} };

  const members = await new UserRepository(db).findAllInWorkspace(workspaceId);
  const values: Partial<Record<PeopleField, string>> = {};

  for (const [field, raw] of entries) {
    const needle = raw.toLowerCase();
    // A uuid is accepted too, so an agent that already read an id off a company
    // record (e.g. to copy a sponsor across) doesn't have to round-trip a name.
    const matches = members.filter(
      (m) =>
        m.id.toLowerCase() === needle ||
        m.name?.trim().toLowerCase() === needle ||
        m.email?.trim().toLowerCase() === needle,
    );
    if (matches.length === 0) {
      const known = members
        .map((m) => m.name?.trim())
        .filter((name): name is string => Boolean(name))
        .slice(0, 15);
      const hint = known.length > 0 ? ` Workspace members include: ${known.join(", ")}.` : "";
      return {
        values: {},
        error: `**Error:** no workspace member matches ${field} "${raw}". Pass the person's name or email exactly as it appears in the workspace, or omit ${field}.${hint}`,
      };
    }
    if (matches.length > 1) {
      return {
        values: {},
        error: `**Error:** ${field} "${raw}" matches ${matches.length} workspace members (${matches
          .map((m) => m.email ?? m.id)
          .join(", ")}). Pass the person's email instead so the right one is recorded.`,
      };
    }
    values[field] = matches[0].id;
  }

  return { values };
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
    project_name,
    stage,
    segment,
    geography,
    source,
    deal_type,
    nbo_date,
    is_live,
    note,
    watchlist_id,
    financials,
    deal_sponsor,
    deal_captain,
    entered_by,
    ...details
  }: {
    target?: string;
    project_name?: string;
    stage?: string;
    segment?: string;
    geography?: string;
    source?: string;
    deal_type?: string;
    nbo_date?: string;
    is_live?: boolean;
    note?: string;
    watchlist_id?: number;
    financials?: FinancialRow[];
  } & Partial<Record<PeopleField, string>> &
    Partial<Record<DetailTextField, string>>) => {
    const resolvedStage = (stage ?? DEFAULT_STAGE) as AddableStage;
    logger.debug(
      `🔧 TOOL CALLED: add_company(target='${target ?? ""}', project_name='${project_name ?? ""}', stage='${resolvedStage}')`,
    );

    // A company is identified by its real name OR its internal project
    // codename. Deals that arrive under a codename ("Project Sunrise") have no
    // target yet, and refusing them would force the agent to invent one.
    const trimmedTarget = target?.trim() || undefined;
    const trimmedProjectName = project_name?.trim() || undefined;
    if (!trimmedTarget && !trimmedProjectName) {
      return `**Error:** give the company a name: pass \`target\` (the real company name), \`project_name\` (the internal codename), or both. At least one is required.`;
    }
    const displayTitle = companyDisplayTitle({
      target: trimmedTarget ?? null,
      project_name: trimmedProjectName ?? null,
    });

    if (!ADDABLE_STAGES.includes(resolvedStage)) {
      return `**Error:** stage must be one of ${ADDABLE_STAGES.join(", ")}; got "${stage}".`;
    }

    const normalizedSource = (source ?? DEFAULT_SOURCE).trim().toLowerCase();
    if (!ALLOWED_SOURCES.includes(normalizedSource as (typeof ALLOWED_SOURCES)[number])) {
      return `**Error:** source must be one of ${ALLOWED_SOURCES.join(", ")}; got "${source}".`;
    }

    // `normalizeDealType` accepts the handful of spellings an LLM reasonably
    // writes for the multi-word values ("Public Market Investing", "M&A
    // Advisory") and returns undefined for anything else.
    const normalizedDealType = deal_type?.trim() ? normalizeDealType(deal_type) : undefined;
    if (deal_type?.trim() && !normalizedDealType) {
      return `**Error:** deal_type must be one of ${DEAL_TYPES.join(", ")}; got "${deal_type}".`;
    }

    const trimmedNboDate = nbo_date?.trim() || undefined;
    if (trimmedNboDate && !/^\d{4}-\d{2}-\d{2}$/.test(trimmedNboDate)) {
      return `**Error:** nbo_date must be YYYY-MM-DD; got "${nbo_date}".`;
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
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);

      // Duplicate guard: fuzzy-match BOTH names the intake supplied, since
      // `project_name` alone can identify a company and an existing record may
      // carry only the codename (or only the real name) for the same deal.
      for (const name of [trimmedTarget, trimmedProjectName].filter(Boolean) as string[]) {
        const existing = await companyRepo.findByNameFuzzy(name);
        if (!existing) continue;
        const stageLabel = existing.pipeline_stage ?? "unset";
        return `A company matching "${name}" already exists in the pipeline (id: ${existing.id}, target: "${existing.target ?? "—"}", project: "${existing.project_name ?? "—"}", stage: ${stageLabel}). Did not create a duplicate — use update_company_details to edit it instead.`;
      }

      // Names → users.id. Done before the insert so a bad name is a refusal,
      // not a company row with a silently missing sponsor.
      const people = await resolvePeopleFields(db, workspaceId, {
        deal_sponsor,
        deal_captain,
        entered_by,
      });
      if (people.error) return people.error;

      const { companyService, dealNoteService, workspaceService } = createContainer(
        db,
        workspaceId,
      );

      // No explicit deal_type → the workspace's Copilot flavor decides. A
      // capital-markets desk should not accumulate deals labelled "majority"
      // just because that is the column default.
      const resolvedDealType =
        normalizedDealType ??
        defaultDealTypeFor(await workspaceService.getCopilotAgent(workspaceId));
      const trimmedNote = note?.trim() || undefined;
      const trimmedSegment = segment?.trim() || undefined;
      const trimmedGeography = geography?.trim() || undefined;

      const created = await companyService.create(
        {
          ...(trimmedTarget ? { target: trimmedTarget } : {}),
          ...(trimmedProjectName ? { project_name: trimmedProjectName } : {}),
          segment: trimmedSegment,
          geography: trimmedGeography,
          source: normalizedSource as (typeof ALLOWED_SOURCES)[number],
          deal_type: resolvedDealType,
          ...(trimmedNboDate ? { nbo_date: trimmedNboDate } : {}),
          ...(is_live !== undefined ? { is_live } : {}),
          ...people.values,
          ...detailFields,
          ...(watchlist_id !== undefined ? { watchlist_id } : {}),
          pipeline_stage: resolvedStage,
          status: "active",
        } as never,
        logActionFor(resolvedStage),
      );

      logger.debug(`✓ Created ${displayTitle} (${created.id}) at ${resolvedStage}`);

      // The triage note lands on the company's notes timeline (the Context tab
      // of the company card), not just in the tool's reply — a note the agent
      // only reported back would be lost the moment the run finished. A failed
      // note write must not look like a failed create, so it degrades to a
      // warning on an otherwise successful message.
      let noteSuffix = trimmedNote ? ` Note recorded on the timeline: ${trimmedNote}` : "";
      if (trimmedNote) {
        try {
          await dealNoteService.create(created.id, trimmedNote, resolvedStage);
        } catch (error) {
          logger.error(`add_company note error: ${(error as Error).message}`);
          noteSuffix = ` **Warning:** the note could not be saved to the timeline (${(error as Error).message}); it was: ${trimmedNote}`;
        }
      }
      const added = `Added "${displayTitle}" to the database at ${resolvedStage} (id: ${created.id}).`;

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

## Naming the company (IMPORTANT)

EVERY argument is optional except that you must give the company **at least one name**:

- **target** — the real company name ("Acme Corp"). Use this whenever you know it.
- **project_name** — the internal project codename ("Project Sunrise"). Deals that arrive under a codename often have no disclosed company name at all; add them under \`project_name\` alone rather than inventing a target or refusing to add.
- Pass **both** when the instruction gives both. They are separate columns, not alternatives — do not stuff a codename into \`target\`.

Before inserting, the tool fuzzy-matches EVERY name you supplied against existing companies (their target, project_name and aliases). If any matches, no row is inserted; the tool returns the existing record so the agent can decide whether to update it with \`update_company_details\` instead.

Args:
    target: The real company name. Optional, but either this or project_name is required.
    project_name: Internal project codename (e.g. "Project Sunrise"). Optional; the only identifier for a deal running under a codename.
    stage: Intake stage — one of "market_screening" (default), "discovered", or "unreviewed". Defaults to "market_screening". L0 is NOT accepted.
    segment: Optional sector/segment classification. Keep it BROAD, not hyper-specific — a category many companies can share (e.g. "Semiconductor", "CMP Slurry", "Petrochemical"), not a narrow niche unique to one company. Over-specific segments create minimal overlap and make cohort grouping useless. Always in English, even if source material is in another language.
    segment_related_offerings: Optional products/offerings within that segment.
    geography: Optional headquarters country — EXACTLY ONE country name (e.g. "South Korea", "United States"). Never combine multiple countries, regions, cities, or facility/R&D locations. Always in English, even if source material is in another language.
    source: Optional origin tag. One of "inbound" or "outbound"; defaults to "outbound" (AI-discovered companies are outbound by nature).
    company_focus: Optional 1-2 line description of what the company does.
    website, ownership: Optional (ownership e.g. "family office", "PE-backed", "public").
    deal_type: Optional deal type (lowercase). One of: majority, minority, public_market, bond_issuance, ipo, follow_on_offering, private_placement, equity_crowdfunding, debt_financing, ma_advisory, restructuring, joint_venture. Omit it unless the instruction states the transaction shape — the workspace's Copilot flavor supplies the right default.
    stake, deal_size: Optional free text — the stake on offer and the indicative deal size.
    doc_type: Optional document type the deal arrived as (e.g. "teaser", "im").
    workflow_status: Optional free-text pipeline workflow status (e.g. "First contact made").
    key_rationale: Optional one-paragraph reason for pursuing the company.
    nbo_date: Optional Non-Binding Offer due date as YYYY-MM-DD.
    is_live: Optional explicit live-process flag. Leave it unset to derive the status from \`advisor\`; set it only when the instruction states the process is live or dead.
    banker, banker_source, advisor, originator: Optional deal contacts, recorded as FREE TEXT (these are not platform users).
    deal_sponsor, deal_captain, entered_by: Optional PEOPLE columns, each the NAME (or email) of a workspace member — e.g. deal_sponsor: "Nur Khairusy". The tool resolves the name against the workspace's members and refuses if it matches nobody or more than one person, so pass the name exactly as the workspace spells it and fall back to the email when two members share a name. Deal Sponsor is the owner shown at L0–L2 and Deal Captain at L3+; \`entered_by\` is whoever sourced the record.
    comments, remarks, thesis_content: Optional free-text notes recorded on the company.
    context: Optional MARKDOWN background recorded on the company's Context tab. This is the place for everything the instruction says about the company that no other column captures — what it does and why it matters, who surfaced it and how, the deal situation, financial or operational colour, caveats, open questions. Write it as short markdown (headings and bullets are fine), in English. It is read back by the AI Opinion run, the company card / slide generators, and the agent read tools, so a company added with good context is judged on far more than its columns. Record it at create time whenever the instruction gives you more than the structured fields can hold — do NOT leave it empty and plan to add it later, and never invent facts the instruction does not state.
    watchlist_id, watchlist_status: Optional watchlist reference.
    financials: Optional per-fiscal-year figures in USD millions, max ${MAX_FINANCIAL_ROWS} rows: [{ fiscal_year, revenue_usd_mn?, ebitda_usd_mn?, ev_usd_mn? }]. One row per year, each with at least one figure. EBITDA margin and EV/EBITDA are computed for you.
    note: Optional short triage note — one remark about this specific intake (why it is being added now, what to check next). Saved to the company's notes timeline, which is shown under the Context tab. Use \`context\` instead for durable background about the company itself.

Record every detail the instruction gives at create time — the whole point of the wide argument list is that an intake lands complete in ONE call. Do not drop the project name, the deal sponsor, the deal shape, the financials or the context and leave them for a later \`update_company_details\` edit. Equally: never invent a value the instruction does not state — an absent field is correct, a guessed one is not.

Returns:
    A success message with the new company id, or a duplicate-found message, or an error string.`,
    schema: z.object({
      target: z
        .string()
        .optional()
        .describe(
          "The real company name. Optional, but the call needs at least one of target / project_name.",
        ),
      project_name: z
        .string()
        .optional()
        .describe(
          'Internal project codename (e.g. "Project Sunrise"). Pass it alongside target when both are known, or on its own for a deal running under a codename with no disclosed company name.',
        ),
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
      segment_related_offerings: z
        .string()
        .optional()
        .describe("Products / offerings within the segment"),
      deal_type: z
        .string()
        .optional()
        .describe(
          `Deal type. One of: ${DEAL_TYPES.join(", ")} (snake_case), or a ` +
            "human/LLM spelling such as \"Public Market Investing\" or \"M&A Advisory\". " +
            "Omit to use the workspace's flavor default.",
        ),
      stake: z.string().optional().describe("Stake on offer / targeted"),
      deal_size: z.string().optional().describe("Indicative deal size"),
      doc_type: z
        .string()
        .optional()
        .describe('Document type the deal arrived as (e.g. "teaser", "im")'),
      workflow_status: z
        .string()
        .optional()
        .describe('Free-text pipeline workflow status (e.g. "First contact made")'),
      key_rationale: z
        .string()
        .optional()
        .describe("Why the company is worth pursuing, in a short paragraph"),
      nbo_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "nbo_date must be YYYY-MM-DD")
        .optional()
        .describe("Non-Binding Offer due date as YYYY-MM-DD"),
      is_live: z
        .boolean()
        .optional()
        .describe(
          "Explicit live-process flag. Leave unset to derive it from advisor; set it only when the instruction states the process is live or dead.",
        ),
      banker: z.string().optional().describe("Banker name on an inbound deal (free text)"),
      banker_source: z
        .string()
        .optional()
        .describe("Banker firm that sourced the deal (free text)"),
      advisor: z
        .string()
        .optional()
        .describe(
          "Deal advisor engaged on the deal (free text). A non-empty advisor implies a live process while is_live is unset.",
        ),
      originator: z.string().optional().describe("Who originated the deal (free text)"),
      deal_sponsor: z
        .string()
        .optional()
        .describe(
          'NAME or email of the workspace member who owns the deal at L0–L2 (e.g. "Nur Khairusy"). Resolved against the workspace\'s members; the tool refuses if it matches nobody or several people.',
        ),
      deal_captain: z
        .string()
        .optional()
        .describe(
          "NAME or email of the workspace member who owns the deal at L3+. Resolved against the workspace's members, like deal_sponsor.",
        ),
      entered_by: z
        .string()
        .optional()
        .describe(
          "NAME or email of the workspace member who sourced / entered the record. Resolved against the workspace's members, like deal_sponsor.",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Markdown background for the company's Context tab: everything the instruction gives that no structured column captures — what the company does and why it matters, how it was surfaced, deal situation, financial/operational colour, caveats. Read back by the AI Opinion run, the slide generators and the read tools. Fill it at create time; never invent facts.",
        ),
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
        .describe(
          "Short triage remark about this intake, saved to the company's notes timeline (shown under the Context tab). For durable background about the company itself, use `context`.",
        ),
    }),
  },
);
