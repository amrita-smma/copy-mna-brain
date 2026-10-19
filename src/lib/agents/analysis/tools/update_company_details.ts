import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  InvestmentThesisRepository,
} from "@/lib/repositories";
import type { Tables } from "@/lib/repositories";
import type { FinancialUpsertInput } from "@/lib/services/companyService";
import { DEAL_TYPES, normalizeDealType } from "@/lib/companies/dealTypes";

/**
 * Edit any editable detail on an existing company — its name, profile, deal
 * fields, matched tracks, and per-year financials.
 *
 * Workforce-only, deliberately. Chat has no direct write tools: a "change
 * Acme's segment to Semiconductor" request goes through
 * `propose_workforce_handoff`, the user approves the card, and the workforce
 * run calls THIS tool. That keeps every field-level mutation behind an
 * explicit human approval and inside a trace a human can audit later.
 *
 * What this tool does NOT touch, and why:
 *  - `pipeline_stage` — a stage move is a promotion. `promote_to_l0` /
 *    `promote_to_l1` own it, and `promote_to_l1` is HITL-gated; accepting a
 *    stage here would route around that gate.
 *  - `status` / `dropped_reason` — `drop_company` owns dropping.
 *  - `ai_opinion_*` — `save_ai_opinion` owns the verdict and its lifecycle.
 *  - user-reference columns (`entered_by`, `deal_sponsor`, `deal_captain`)
 *    and the L0/L1 screening-derived columns — these are either uuid FKs the
 *    agent can't resolve or outputs of the screening pipeline rather than
 *    facts about the company.
 *
 * `matched_track_ids` IS editable: unlike a user reference, a track id (or
 * title) is resolvable against the workspace's `investment_thesis` rows, so
 * the handler validates every entry before writing and never persists an id
 * the Tracks UI can't render.
 *
 * Dropped companies stay editable here on purpose: `CompanyService` allows
 * detail edits after a drop so records can be kept accurate, and only blocks
 * pipeline lifecycle moves.
 */

/** Core `companies` columns this tool may write, in the order reported back. */
const CORE_FIELDS = [
  "target",
  "project_name",
  "segment",
  "segment_related_offerings",
  "company_focus",
  "website",
  "geography",
  "ownership",
  "source",
  "deal_type",
  "stake",
  "deal_size",
  "banker",
  "banker_source",
  "advisor",
  "originator",
  "doc_type",
  "nbo_date",
  "is_live",
  "workflow_status",
  "watchlist_status",
  "key_rationale",
  "comments",
  "remarks",
  "thesis_content",
  "context",
] as const;

type CoreField = (typeof CORE_FIELDS)[number];

/**
 * Every key `fields` accepts: the plain columns plus `matched_track_ids`,
 * which is resolved against the workspace's tracks rather than copied through.
 */
const EDITABLE_FIELDS = [...CORE_FIELDS, "matched_track_ids"] as const;

const EDITABLE_FIELD_SET: ReadonlySet<string> = new Set(EDITABLE_FIELDS);

/**
 * Rejected keys the model is most likely to reach for, mapped to the tool (or
 * argument) that actually owns them. Anything not listed here still gets
 * rejected — just without the pointer.
 */
const REJECTED_FIELD_HINTS: Readonly<Record<string, string>> = {
  pipeline_stage: "use promote_to_l0 or promote_to_l1 to move a company between stages",
  stage: "use promote_to_l0 or promote_to_l1 to move a company between stages",
  status: "use drop_company to drop a company",
  dropped_reason: "use drop_company to drop a company",
  dropped_at: "use drop_company to drop a company",
  ai_opinion_verdict: "use save_ai_opinion",
  ai_opinion_summary: "use save_ai_opinion",
  ai_opinion_status: "use save_ai_opinion",
  entered_by: "user-reference columns are not editable from a workforce run",
  deal_sponsor: "user-reference columns are not editable from a workforce run",
  deal_captain: "user-reference columns are not editable from a workforce run",
};

/** e.g. revenue_2024_usd_mn, ebitda_2023_usd_mn, ev_2024, ev_ebitda_2024. */
const FLAT_FINANCIAL_KEY = /^(revenue|ebitda|ev)(_ebitda)?_(19|20)\d{2}(_usd_mn)?$/;

/** Upper bound on tracks one company can be matched to in a single write. */
const MAX_TRACKS = 50;

const FINANCIAL_METRICS = ["revenue_usd_mn", "ebitda_usd_mn", "ev_usd_mn"] as const;

const MAX_FINANCIAL_ROWS = 20;

const nullableText = () => z.string().trim().nullable().optional();

const FieldsSchema = z
  .object({
    target: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Company name. Renaming is allowed; the tool refuses if the new name already belongs to a DIFFERENT company.",
      ),
    project_name: nullableText().describe("Internal project codename (e.g. \"Project Sunrise\")"),
    segment: nullableText().describe(
      'Broad sector/segment category (e.g. "Semiconductor") — not a hyper-specific niche or a long clause. Always in English.',
    ),
    segment_related_offerings: nullableText().describe("Products/offerings within the segment"),
    company_focus: nullableText().describe("What the company focuses on"),
    website: nullableText().describe("Company website URL"),
    geography: nullableText().describe(
      "HQ country — EXACTLY ONE country name, never a region, city, or multiple countries. Always in English.",
    ),
    ownership: nullableText().describe('Ownership structure (e.g. "Family-owned", "PE-backed", "Listed")'),
    source: z
      .enum(["inbound", "outbound"])
      .nullable()
      .optional()
      .describe("Deal origin: inbound or outbound"),
    // z.string, not z.enum: the handler normalizes, and a z.enum here would
    // reject the human/LLM spellings ("M&A Advisory") before it ever ran —
    // the same mismatch add_company had.
    deal_type: z
      .string()
      .nullable()
      .optional()
      .describe(
        `Deal type. One of: ${DEAL_TYPES.join(", ")} (snake_case), or a ` +
          'human/LLM spelling such as "Public Market Investing" or "M&A Advisory".',
      ),
    stake: nullableText().describe("Stake on offer / targeted"),
    deal_size: nullableText().describe("Indicative deal size"),
    banker: nullableText().describe("Banker name for an inbound deal"),
    banker_source: nullableText().describe("Banker firm that sourced the deal"),
    advisor: nullableText().describe(
      "Deal advisor (banker engaged on the deal). Only DERIVES the live status while is_live is null — see is_live.",
    ),
    originator: nullableText().describe("Who originated the deal"),
    doc_type: nullableText().describe("Document type received (e.g. teaser, IM)"),
    nbo_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "nbo_date must be YYYY-MM-DD")
      .nullable()
      .optional()
      .describe("Non-Binding Offer due date as YYYY-MM-DD"),
    is_live: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Live-process override, INDEPENDENT of advisor: once true/false it wins, and clearing advisor does not reset it. Pass null to go back to deriving the status from advisor.",
      ),
    workflow_status: nullableText().describe("Free-text pipeline workflow status"),
    watchlist_status: nullableText().describe("Watchlist status"),
    key_rationale: nullableText().describe("Key rationale for pursuing the company"),
    comments: nullableText().describe("Free-text comments"),
    remarks: nullableText().describe("Free-text remarks"),
    thesis_content: nullableText().describe("Thesis narrative recorded on the company"),
    context: nullableText().describe(
      "Markdown background on the company's Context tab — what the company does and why it matters, how it was surfaced, deal situation, colour and caveats that no structured column holds. Read back by the AI Opinion run, the company card / slide generators and the read tools. Writing it REPLACES the whole document, so fetch the current text with get_company_details first and edit it rather than overwriting work the deal team wrote. Pass null to clear it.",
    ),
    matched_track_ids: z
      .array(z.string().trim().min(1))
      .max(MAX_TRACKS)
      .nullable()
      .optional()
      .describe(
        "The COMPLETE list of tracks (investment theses) this company is matched to — each entry a track id from get_investment_theses or its exact title. REPLACES the current list, so to add or remove one track, read the current Matched Tracks with get_company_details and pass the edited list. [] or null clears every match.",
      ),
  })
  // Unknown keys are kept rather than silently stripped so the handler can
  // name them back to the agent (and point at the tool that owns them)
  // instead of reporting a successful write that quietly dropped a field.
  .passthrough();

const FinancialRowSchema = z.object({
  fiscal_year: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .describe("Fiscal year the figures belong to"),
  revenue_usd_mn: z
    .number()
    .finite()
    .nullable()
    .optional()
    .describe("Revenue in USD millions. null clears it."),
  ebitda_usd_mn: z
    .number()
    .finite()
    .nullable()
    .optional()
    .describe("EBITDA in USD millions. null clears it."),
  ev_usd_mn: z
    .number()
    .finite()
    .nullable()
    .optional()
    .describe("Enterprise value in USD millions. null clears it."),
});

type FinancialRow = z.infer<typeof FinancialRowSchema>;

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value)}"`;
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "(empty)";
  return `$${value}M`;
}

/**
 * Drop the fiscal-year rows that would write the figures already on record,
 * and describe the ones that survive as `metric old → new`. Without this a
 * re-run of the same instruction would bump `updated_at` on every year and
 * report figures as changes when nothing moved — which is exactly what the
 * tool's own description promises it won't do.
 */
function diffFinancials(
  rows: FinancialRow[],
  existing: Tables<"company_financials">[],
): { rows: FinancialRow[]; changes: string[] } {
  const existingByYear = new Map(existing.map((row) => [row.fiscal_year, row]));
  const changed: FinancialRow[] = [];
  const changes: string[] = [];

  for (const row of [...rows].sort((a, b) => a.fiscal_year - b.fiscal_year)) {
    const prior = existingByYear.get(row.fiscal_year);
    const moved: string[] = [];
    for (const metric of FINANCIAL_METRICS) {
      if (!(metric in row) || row[metric] === undefined) continue;
      const next = row[metric] ?? null;
      // A numeric column can surface as a string depending on the driver path,
      // so compare as numbers rather than by identity.
      const current = prior?.[metric] === null || prior?.[metric] === undefined
        ? null
        : Number(prior[metric]);
      if (next === current) continue;
      moved.push(
        `${metric.replace("_usd_mn", "")} ${formatMoney(current)} → ${formatMoney(next)}`,
      );
    }
    if (moved.length === 0) continue;
    changed.push(row);
    changes.push(`FY${row.fiscal_year}: ${moved.join(", ")}`);
  }

  return { rows: changed, changes };
}

/**
 * Normalize the caller's core-field patch: drop keys the caller left out,
 * turn a blank string into null (the agent's usual way of saying "clear
 * this"), and skip values already equal to what's stored.
 */
function buildCorePatch(
  fields: Record<string, unknown>,
  company: Record<string, unknown>,
): { patch: Record<string, unknown>; changes: string[] } {
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  for (const key of CORE_FIELDS) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    if (raw === undefined) continue;
    const next = typeof raw === "string" && raw.trim() === "" ? null : raw;
    const current = company[key] ?? null;
    if (next === current) continue;
    patch[key] = next;
    changes.push(`${key}: ${formatValue(current)} → ${formatValue(next)}`);
  }

  return { patch, changes };
}

type Track = Pick<Tables<"investment_thesis">, "id" | "title">;

/**
 * Resolve the caller's track references (ids or exact, case-insensitive
 * titles) to workspace track ids, de-duplicated in the order given. Returns an
 * error string naming every reference that is unknown or ambiguous so nothing
 * is written for a partially-valid list.
 */
function resolveTrackRefs(
  refs: string[],
  tracks: Track[],
): { ids: string[] } | { error: string } {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const byTitle = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = track.title?.trim().toLowerCase();
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), track]);
  }

  const ids: string[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const ref of refs) {
    const titleMatches = byTitle.get(ref.toLowerCase()) ?? [];
    const id = byId.has(ref)
      ? ref
      : titleMatches.length === 1
        ? titleMatches[0].id
        : null;
    if (!id) {
      (titleMatches.length > 1 ? ambiguous : unknown).push(ref);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }

  if (unknown.length === 0 && ambiguous.length === 0) return { ids };

  const problems = [
    unknown.length > 0 ? `unknown track(s): ${unknown.map((r) => `"${r}"`).join(", ")}` : null,
    ambiguous.length > 0
      ? `title(s) shared by more than one track — pass the id instead: ${ambiguous.map((r) => `"${r}"`).join(", ")}`
      : null,
  ].filter(Boolean);
  const available = tracks.length > 0
    ? tracks.map((t) => `${t.title ?? "Untitled"} (id: ${t.id})`).join("; ")
    : "none — this workspace has no tracks configured";
  return {
    error: `**Error:** matched_track_ids has ${problems.join("; ")}. Available tracks: ${available}.`,
  };
}

function formatTracks(ids: string[], tracks: Track[]): string {
  if (ids.length === 0) return "(empty)";
  const titles = new Map(tracks.map((t) => [t.id, t.title ?? "Untitled"]));
  return `[${ids.map((id) => `"${titles.get(id) ?? id}"`).join(", ")}]`;
}

/**
 * Diff the resolved track list against what's stored. Order-insensitive: the
 * list is a set as far as matching and the Track filter are concerned, so a
 * reorder alone is not a change.
 */
function diffTracks(
  nextIds: string[],
  currentIds: string[],
  tracks: Track[],
): string | null {
  const current = new Set(currentIds);
  const same = nextIds.length === current.size && nextIds.every((id) => current.has(id));
  if (same) return null;
  return `matched_track_ids: ${formatTracks(currentIds, tracks)} → ${formatTracks(nextIds, tracks)}`;
}

export const updateCompanyDetails = tool(
  async ({
    company_id,
    company_name,
    fields,
    financials,
  }: {
    company_id?: string;
    company_name?: string;
    fields?: Record<string, unknown>;
    financials?: FinancialRow[];
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: update_company_details(company_id='${company_id ?? ""}', company_name='${company_name ?? ""}')`,
    );

    const id = company_id?.trim() ?? "";
    const name = company_name?.trim() ?? "";
    if (!id && !name) {
      return `**Error:** either company_id or company_name is required.`;
    }

    const providedFields = fields ?? {};

    // deal_type is a Postgres enum, so coerce before the patch is built —
    // clearing it (null / "") stays a clear.
    const rawDealType = providedFields.deal_type;
    if (typeof rawDealType === "string" && rawDealType.trim() !== "") {
      const normalized = normalizeDealType(rawDealType);
      if (!normalized) {
        return `**Error:** deal_type must be one of ${DEAL_TYPES.join(", ")}; got "${rawDealType}".`;
      }
      providedFields.deal_type = normalized;
    }

    const rows = financials ?? [];
    if (Object.keys(providedFields).length === 0 && rows.length === 0) {
      return `**Error:** nothing to update. Pass \`fields\` (company detail columns), \`financials\` (per-year figures), or both.`;
    }

    // Reject unsupported field names up front rather than writing a partial
    // patch and reporting success for keys that never landed.
    const unsupported = Object.keys(providedFields).filter(
      (key) => !EDITABLE_FIELD_SET.has(key) && providedFields[key] !== undefined,
    );
    if (unsupported.length > 0) {
      const detail = unsupported
        .map((key) => {
          const hint = FLAT_FINANCIAL_KEY.test(key)
            ? "pass yearly figures in the `financials` array instead, e.g. financials: [{ fiscal_year: 2024, revenue_usd_mn: 120 }]"
            : REJECTED_FIELD_HINTS[key];
          return hint ? `\`${key}\` (${hint})` : `\`${key}\``;
        })
        .join(", ");
      return `**Error:** these fields cannot be set with update_company_details: ${detail}. Editable fields: ${EDITABLE_FIELDS.join(", ")}.`;
    }

    if (rows.length > MAX_FINANCIAL_ROWS) {
      return `**Error:** at most ${MAX_FINANCIAL_ROWS} financial rows per call (got ${rows.length}). Split into multiple calls.`;
    }

    const seenYears = new Set<number>();
    for (const row of rows) {
      if (seenYears.has(row.fiscal_year)) {
        return `**Error:** fiscal_year ${row.fiscal_year} appears more than once in \`financials\`. Combine the metrics for a year into one row.`;
      }
      seenYears.add(row.fiscal_year);
      const hasMetric = FINANCIAL_METRICS.some((metric) => metric in row && row[metric] !== undefined);
      if (!hasMetric) {
        return `**Error:** the \`financials\` row for ${row.fiscal_year} sets no figures. Include at least one of ${FINANCIAL_METRICS.join(", ")} (use null to clear a value).`;
      }
    }

    let coreApplied = false;

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);

      const company = id
        ? await companyRepo.findByIdOrNull(id)
        : await companyRepo.findByNameFuzzy(name);

      if (!company) {
        return id
          ? `No company found with id "${id}". Use query_companies or get_company_details to get a valid company id.`
          : `No company found matching "${name}". Use query_companies or get_company_details first to confirm the exact spelling.`;
      }

      const label = company.target ?? company.project_name ?? company.id;
      const { patch, changes } = buildCorePatch(providedFields, company as unknown as Record<string, unknown>);

      // Track matching is resolved against the workspace's own tracks (the
      // workspace-scoped `findAll`, inactive included — the Tracks picker
      // offers both), so a foreign or deleted id can never be persisted.
      const rawTracks = providedFields.matched_track_ids;
      if (rawTracks !== undefined) {
        const refs = Array.isArray(rawTracks) ? (rawTracks as string[]) : [];
        const tracks = await new InvestmentThesisRepository(db, workspaceId).findAll();
        const resolved = resolveTrackRefs(refs, tracks);
        if ("error" in resolved) return resolved.error;
        const trackChange = diffTracks(resolved.ids, company.matched_track_ids ?? [], tracks);
        if (trackChange) {
          patch.matched_track_ids = resolved.ids;
          changes.push(trackChange);
        }
      }

      // A rename onto a name another company already answers to would fork one
      // company into two records and break every name lookup that follows.
      // This asks for an EXACT (case-insensitive) name match, not
      // `findByNameFuzzy` — the fuzzy helper strips legal suffixes and
      // substring-matches, so it would both refuse innocent renames ("Acme
      // Corp" → "Acme Holdings" collides with an unrelated "Acme Industries")
      // and miss a real duplicate it happened to rank second.
      if (typeof patch.target === "string") {
        const collisions = (await companyRepo.findByExactName(patch.target)).filter(
          (row) => row.id !== company.id,
        );
        if (collisions.length > 0) {
          const named = collisions
            .map((row) => `id: ${row.id}, target: "${row.target ?? row.project_name ?? ""}"`)
            .join("; ");
          return `**Error:** cannot rename "${label}" to "${patch.target}" — that name already belongs to a different company (${named}). Resolve the duplicate first.`;
        }
      }

      // Skip fiscal years whose figures already match, so a re-run doesn't
      // rewrite unchanged rows or report them as changes.
      const financialRepo = new CompanyFinancialRepository(db, workspaceId);
      const existingFinancials = rows.length > 0 ? await financialRepo.findByCompany(company.id) : [];
      const { rows: changedRows, changes: financialLines } = diffFinancials(rows, existingFinancials);

      if (Object.keys(patch).length === 0 && changedRows.length === 0) {
        return `No changes made to "${label}" (id: ${company.id}) — every value provided already matches what's on record.`;
      }

      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { companyService } = createContainer(db, workspaceId);

      if (Object.keys(patch).length > 0) {
        await companyService.updateFromDTO(company.id, patch, "UPDATED_DETAILS_BY_AI_WORKFORCE");
        coreApplied = true;
      }

      // Two service calls, so two commits: the core patch can land while the
      // financials write fails. `updateFinancials` owns the derived-column
      // recompute, so it has to stay a service call rather than a raw upsert
      // here; the catch below reports the partial state instead of implying a
      // clean rollback (same shape as promote_to_l0's update-then-promote).
      if (changedRows.length > 0) {
        await companyService.updateFinancials(
          company.id,
          changedRows as FinancialUpsertInput[],
          [],
          "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
        );
      }

      const summary = [...changes, ...financialLines];
      const finalLabel = typeof patch.target === "string" ? patch.target : label;
      logger.info(
        `✓ Updated company details for ${finalLabel} (${company.id}): ${summary.join("; ")}`,
      );
      return [
        `Updated "${finalLabel}" (id: ${company.id}).`,
        ...summary.map((line) => `- ${line}`),
      ].join("\n");
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`update_company_details error: ${message}`);
      return coreApplied
        ? `**Error:** the detail fields were saved but the financials write failed: ${message}`
        : `**Error:** ${message}`;
    }
  },
  {
    name: "update_company_details",
    description: `Edit the details of an existing company on record — its name, profile, deal fields, matched tracks, and per-year financials. This is the workforce-side execution of any "change / correct / fill in / update X for company Y" instruction.

Identify the company with \`company_id\` (preferred — exact) or \`company_name\` (fuzzy-matched against target and project name). Pass \`fields\` for company columns and/or \`financials\` for yearly figures; you may pass both in ONE call. Omitted keys are left alone; passing \`null\` (or an empty string) CLEARS a field. Values already equal to what's stored are skipped, and the tool reports every change it made as \`field: old → new\` so the trace records the before/after.

Editable \`fields\`: ${EDITABLE_FIELDS.join(", ")}.

\`matched_track_ids\` sets which tracks (investment theses) the company is matched to — the "Matched Tracks" on the company card, which drive the pipeline Track filter and which criteria AI screening runs. Pass track ids from \`get_investment_theses\` (an exact track title also works). It is the COMPLETE list and REPLACES what's stored: to add or remove a single track, read the current Matched Tracks with \`get_company_details\` and pass the edited list. \`[]\` or \`null\` clears every match. An unknown or ambiguous track fails the whole call and lists the available tracks.

\`financials\`: an array of rows, one per fiscal year (max ${MAX_FINANCIAL_ROWS} per call), each \`{ fiscal_year, revenue_usd_mn?, ebitda_usd_mn?, ev_usd_mn? }\`. Figures are USD millions. Every row needs at least one figure, and a year may appear only once — combine its metrics into a single row. A year whose figures already match is skipped rather than rewritten. EBITDA margin and EV/EBITDA are recomputed from the figures you write, so do NOT try to set them; revenue CAGR belongs to the screening pipeline and is left alone.

\`context\` is the company's free-form markdown background (the Context tab on the company card), and it is the field most likely to already hold work a human wrote. Writing it REPLACES the whole document — read the current text with \`get_company_details\` and edit it, rather than overwriting someone's notes with your own summary.

One field to be careful with: \`is_live\` is an independent override, not a function of \`advisor\`. Clearing \`advisor\` does NOT un-live a deal whose \`is_live\` is already true — if the instruction says a process is dead, set \`is_live: false\` (or \`null\` to go back to deriving it from \`advisor\`) in the same call.

This tool does NOT change pipeline state, and passing such a field is an error rather than a silent no-op:
- pipeline stage → use \`promote_to_l0\` / \`promote_to_l1\`
- dropping a company → use \`drop_company\`
- AI Opinion verdict/summary → use \`save_ai_opinion\`
- company card narrative sections → generated by \`generate_company_card\`
- relationship edges → \`update_company_relationship\` / \`generate_relationship_graph\`

Guards: an unknown company id/name is reported, not created (use \`add_company\` to add a new company). A rename that collides with a DIFFERENT company on record is refused so the rename can't fork one company into two. Dropped companies remain editable — keeping a dropped record factually correct is allowed; re-entering the pipeline is not.

Verify before you write: read the company with \`get_company_details\` first, and only write figures you actually have from the instruction or a tool (\`web_search\`, \`query_files\`). Never invent a number to fill a blank field.

Args:
    company_id: UUID of the company to edit. Preferred over company_name.
    company_name: Target or project name, fuzzy-matched. Used only when company_id is absent.
    fields: Object of company detail columns to set. See the editable list above.
    financials: Array of per-fiscal-year figures to upsert.

Returns:
    A success message listing each applied change, a "no changes made" note when everything already matched, or an error string starting with **Error:**.`,
    schema: z.object({
      company_id: z
        .string()
        .optional()
        .describe("UUID of the company to edit (preferred — exact match)"),
      company_name: z
        .string()
        .optional()
        .describe("Company target or project name, fuzzy-matched. Used only when company_id is absent."),
      fields: FieldsSchema.optional().describe(
        "Company detail columns to set. Omitted keys are untouched; null clears a value.",
      ),
      financials: z
        .array(FinancialRowSchema)
        .optional()
        .describe("Per-fiscal-year figures to upsert (USD millions), one row per year"),
    }),
  },
);
