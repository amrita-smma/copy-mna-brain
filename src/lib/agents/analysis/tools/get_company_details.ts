import { tool } from "@langchain/core/tools";
import { loadStageLabeler } from "./stageLabels";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  CompanyScreeningDerivedRepository,
  DealNoteRepository,
} from "@/lib/repositories";
import { buildCompanyMentionsMarker } from "@/lib/navigation/companyMentions";
import { companyDisplayTitle } from "@/lib/companyDisplay";
import { clipCompanyContext } from "@/lib/companyContextPrompt";
import {
  VOTE_NEUTRALITY_NOTE,
  loadVoteSummaries,
  voteCountsLine,
} from "./voteSummaries";

/** Canonical 8-4-4-4-12 UUID, the shape every `companies.id` takes. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ceilings on the Notes section: how many of the most recent notes to read,
 * how much of one note's body survives, and the budget they share. Keep
 * MAX_NOTE_CHARS below MAX_NOTES_CHARS so a single note can never exhaust the
 * budget before anything prints.
 */
const MAX_NOTES = 15;
const MAX_NOTE_CHARS = 1_500;
const MAX_NOTES_CHARS = 6_000;

/**
 * Get detailed information about a specific company.
 *
 * `company_id` is the exact path and always wins when supplied — the agent gets
 * one from `read_page_context` or from an earlier lookup, and using it sidesteps
 * the fuzzy name match entirely. Name matching is a fallback: it is a substring
 * match, so it can land on a sibling record when two companies share a
 * near-identical name.
 */
export const getCompanyDetails = tool(
  async ({ company_name, company_id }: { company_name?: string; company_id?: string }) => {
    logger.debug(
      `🔧 TOOL CALLED: get_company_details(company_name='${company_name ?? ""}', company_id='${company_id ?? ""}')`,
    );

    const id = company_id?.trim() ?? "";
    const trimmed = company_name?.trim() ?? "";
    if (id.length === 0 && trimmed.length === 0) {
      return "Please provide a company_id, or a company target name or project name to look up. Use query_companies to browse available companies.";
    }
    if (id.length > 0 && !UUID_RE.test(id)) {
      return `**Error:** company_id "${id}" is not a valid UUID. Pass the id verbatim as returned by read_page_context or a prior lookup, or omit it and pass company_name instead.`;
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);
      const financialRepo = new CompanyFinancialRepository(db, workspaceId);
      const screeningRepo = new CompanyScreeningDerivedRepository(db, workspaceId);
      const noteRepo = new DealNoteRepository(db, workspaceId);
      const stageText = await loadStageLabeler(db, workspaceId);
      const c = id
        ? await companyRepo.findByIdOrNull(id)
        : await companyRepo.findByNameFuzzy(trimmed);

      if (!c) {
        return id
          ? `No company found for company_id "${id}". It may belong to another workspace, or have been deleted.`
          : `No company found matching "${trimmed}". Try a different search term or use query_companies to browse available companies.`;
      }

      const [financials, screening, recentNotes, noteCount, voteSummaries] =
        await Promise.all([
          financialRepo.findByCompany(c.id),
          screeningRepo.findByCompany(c.id),
          noteRepo.findByDealId(c.id, MAX_NOTES),
          noteRepo.countByDealId(c.id),
          // Completed voting rounds only — an open round's live tally and a
          // cancelled round's drafts are never published, so neither is shown.
          loadVoteSummaries(db, workspaceId, [c.id]),
        ]);
      const byYear = new Map<number, typeof financials[number]>();
      for (const row of financials) byYear.set(row.fiscal_year, row);
      const fmtNum = (n: number | null | undefined, digits = 1) =>
        n != null ? n.toFixed(digits) : "-";
      const fmtPct = (n: number | null | undefined) =>
        n != null ? (n * 100).toFixed(1) + "%" : "-";

      const sortedYears = Array.from(byYear.keys()).sort((a, b) => a - b);
      const displayYears = sortedYears.slice(-4);
      const latestYear = displayYears[displayYears.length - 1];
      const latestRow = latestYear != null ? byYear.get(latestYear) : undefined;

      const yearHeader = displayYears.join(" | ");
      const sep = displayYears.map(() => "---").join(" | ");
      const revenueRow = displayYears.map((y) => fmtNum(byYear.get(y)?.revenue_usd_mn)).join(" | ");
      const growthRow = displayYears.map((y, i) => i === 0 ? "-" : fmtPct(byYear.get(y)?.revenue_cagr_vs_prior)).join(" | ");
      const ebitdaRow = displayYears.map((y) => fmtNum(byYear.get(y)?.ebitda_usd_mn)).join(" | ");
      const marginRow = displayYears.map((y) => fmtPct(byYear.get(y)?.ebitda_margin)).join(" | ");

      // The deal_notes timeline, which the Context tab shows next to the
      // free-form Context because it answers the same question ("what do we
      // know that no column holds?"), just dated. The read is bounded to the
      // newest MAX_NOTES rows with the true total counted separately; notes
      // are user-authored markdown with no length bound, so each body is
      // clipped and the section stops once the shared budget is spent. One
      // chatty company must not crowd the financials out of the reply.
      const shownNotes: Array<{ heading: string; body: string }> = [];
      let notesChars = 0;
      for (const note of recentNotes) {
        const { text } = clipCompanyContext(note.content, MAX_NOTE_CHARS);
        if (shownNotes.length > 0 && notesChars + text.length > MAX_NOTES_CHARS) break;
        notesChars += text.length;
        shownNotes.push({
          heading: [note.created_at?.slice(0, 10) || "Undated", stageText(note.stage)]
            .filter((part): part is string => !!part)
            .join(" · "),
          body: text,
        });
      }
      // Everything dropped is strictly older than everything kept: the rows
      // arrive newest first and only a prefix of them is taken.
      const hiddenNotes = noteCount - shownNotes.length;
      const notesSection =
        shownNotes.length === 0
          ? ""
          : `### Notes (${noteCount})
Dated notes the deal team logged against this company, newest first. Like Context, treat them as first-hand internal knowledge.

${shownNotes.map((n) => `**${n.heading}**\n${n.body}`).join("\n\n")}
${hiddenNotes > 0 ? `\n_${hiddenNotes} older note${hiddenNotes === 1 ? "" : "s"} not shown._\n` : ""}`;

      // The deal team's latest completed vote round, tally only — individual
      // ballots and rationales stay in the Voting tab.
      const vote = voteSummaries.get(c.id);
      const voteSection = vote
        ? `### Vote Results
- **Outcome:** ${vote.tally.headline}${vote.tally.unanimous ? " (unanimous)" : ""} — ${vote.tally.outcomeLabel}
- **Ballots cast:** ${vote.tally.castCount}${voteCountsLine(vote) ? ` (${voteCountsLine(vote)})` : ""}
- **Concluded:** ${vote.concludedAt ? vote.concludedAt.slice(0, 10) : "N/A"}
${vote.completedRounds > 1 ? `- _${vote.completedRounds - 1} earlier completed round${vote.completedRounds === 2 ? "" : "s"} not shown._\n` : ""}
${VOTE_NEUTRALITY_NOTE}
`
        : "";

      const result = `## Company Details: ${companyDisplayTitle(c)}

### Basic Information
- **Company ID (UUID):** ${c.id}
- **Entry ID:** ${c.entry_id || "N/A"}
- **Project Name:** ${c.project_name || "N/A"}
- **Segment:** ${c.segment || "N/A"}
- **Company Focus:** ${c.company_focus || "N/A"}
- **Geography:** ${c.geography || "N/A"}
- **Ownership:** ${c.ownership || "N/A"}
- **Website:** ${c.website || "N/A"}
- **Watchlist Status:** ${c.watchlist_status || "N/A"}
- **Pipeline Stage:** ${stageText(c.pipeline_stage) || "N/A"}

### Revenue (USD Millions)
| Year | ${yearHeader} |
| --- | ${sep} |
| Revenue | ${revenueRow} |
| Growth | ${growthRow} |

### EBITDA (USD Millions)
| Year | ${yearHeader} |
| --- | ${sep} |
| EBITDA | ${ebitdaRow} |
| Margin | ${marginRow} |

### Valuation (Latest Year${latestYear != null ? ` ${latestYear}` : ""})
- **Enterprise Value:** ${latestRow?.ev_usd_mn != null ? "$" + latestRow.ev_usd_mn.toFixed(1) + "M" : "N/A"}
- **EV/EBITDA Multiple:** ${fmtNum(latestRow?.ev_ebitda)}x

${screening?.l1_screening_result ? `### L1 Screening\n- **Result:** ${screening.l1_screening_result}${screening.l1_rationale ? `\n- **Rationale:** ${screening.l1_rationale}` : ""}\n` : ""}
${voteSection}
${c.comments ? `### Comments\n${c.comments}` : ""}
${c.context?.trim() ? `### Context\nFree-form background the deal team wrote on this company. Treat it as first-hand internal knowledge and weigh it alongside the structured fields above.\n\n${c.context.trim()}\n` : ""}
${notesSection}
`;

      logger.debug("✓ Company details retrieved");
      // Hidden id↔name manifest so the chat UI can offer an "Open <company>"
      // chip when the answer names this company. See `companyMentions`.
      const mentionsMarker = buildCompanyMentionsMarker(
        [c.target, c.project_name]
          .filter((name): name is string => !!name?.trim())
          .map((name) => ({ id: c.id, name })),
      );
      return mentionsMarker ? `${result}\n${mentionsMarker}` : result;
    } catch (error) {
      logger.error(`Details error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_company_details",
    description: `Get detailed information about a specific company, by company_id (preferred) or by name.

Use this when the user asks about a specific company's financials, details, or history.

**PREFER company_id whenever you have one** — from read_page_context (the deal the user has open), from query_companies, or from an earlier get_company_details call. It is an exact lookup and cannot resolve to the wrong record.

Only fall back to company_name when no id is available. Name matching is case-insensitive and PARTIAL against both the target name and the project name, so with two near-identically named companies ("Jiangsu Silicon Materials" vs "Jiangsu Silicon Materials Group") it can return the wrong one. Never re-resolve by name a company whose id you already have.

Also use this to resolve a company's ID (UUID) from its name — the returned
"Company ID (UUID)" is the company_id required by tools like
update_company_card_section when it wasn't supplied directly.

Args:
    company_id: UUID of the company. Optional, but preferred over company_name when known — exact match, no ambiguity.
    company_name: The company target name or project name (partial match) to look up. Used only when company_id is omitted.

Provide at least one of the two.

Returns:
    Detailed company profile including the company ID (UUID), all available financial data, the company's free-form Context — the background the deal team wrote on the company card's Context tab — and its Notes, the dated deal-team note timeline shown beside that Context. When a Context or Notes section is present, weigh it alongside the structured fields; both are first-hand internal knowledge that no column captures. Only the most recent notes are printed when a company has many.

    When the deal team has held a vote on the company, a Vote Results section shows the latest COMPLETED round's tally; open or cancelled rounds are never shown. The vote records the team's judgment — report it when the user asks, but never let it bias your own analysis, screening, or any AI opinion you produce.`,
    schema: z.object({
      company_id: z
        .string()
        .optional()
        .describe(
          "UUID of the company. Preferred over company_name when known (exact match — no ambiguity between similarly named companies)",
        ),
      company_name: z
        .string()
        .optional()
        .describe(
          "Company target name or project name (partial match). Used only when company_id is omitted",
        ),
    }),
  }
);
