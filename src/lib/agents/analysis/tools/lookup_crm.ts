import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { getActiveWorkspaceId } from "@/lib/workspace";
import {
  CorrespondentRepository,
  EmailRepository,
  EmployerNoteRepository,
  EmployerRelatedCompanyRepository,
  EmployerRepository,
  EmployerTeamRepository,
  TopicRepository,
  type CorrespondentSearchFilters,
  type CorrespondentSearchResult,
} from "@/lib/repositories";
import {
  expandDealType,
  expandDepartment,
  expandSeniority,
} from "@/lib/crm/dealExpertise";
import { expandGeography } from "@/lib/crm/geoExpansion";

// How many recent emails / notes to surface per firm. The card stays scannable
// for the model rather than dumping the full history; deeper history lives in
// the CRM UI.
const RECENT_EMAILS = 5;
const RECENT_NOTES = 5;
const NOTE_PREVIEW_CHARS = 240;
// Expansion lists get long (a "US LBO" ask fans out to ~10 desks); the header
// only has to show enough for the user to see how the query was read.
const INTERPRETATION_TERMS = 6;

/** ISO timestamp → YYYY-MM-DD; empty string for null/unparseable input. */
function toDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

/** Human label per search facet, for the "why this banker" line. */
const FACET_LABELS: Record<string, string> = {
  banker: "name/email",
  firm: "firm",
  departments: "desk",
  regions: "coverage region",
  broadRegions: "broad coverage",
  expertise: "expertise",
  seniorities: "seniority",
  industries: "firm industry",
  topics: "firm topic",
  keyword: "keyword",
};

function preview(terms: string[]): string {
  if (terms.length === 0) return "";
  const shown = terms.slice(0, INTERPRETATION_TERMS).join(", ");
  return terms.length > INTERPRETATION_TERMS
    ? `${shown}, +${terms.length - INTERPRETATION_TERMS} more`
    : shown;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Group rows carrying an `employer_id` into a Map keyed by that id. */
function groupByEmployer<T extends { employer_id: string }>(
  rows: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.employer_id);
    if (bucket) bucket.push(row);
    else map.set(row.employer_id, [row]);
  }
  return map;
}

interface MatchArgs {
  query?: string;
  firm?: string;
  banker?: string;
  department?: string;
  deal_type?: string;
  geography?: string;
  specialization?: string;
  seniority?: string;
  industry?: string;
  topic?: string;
}

/**
 * Turn the deal description the user gave into the CRM vocabulary the records
 * are actually written in — "LBO" into the desks that run one, "United States"
 * into the coverage labels that include it. Returns both the repository
 * filters and a human-readable account of the translation, so the answer can
 * show its working (and the user can see when a term was taken literally).
 */
function buildSearchFilters(
  args: MatchArgs,
  limit: number,
): { filters: CorrespondentSearchFilters; interpretation: string[] } {
  const interpretation: string[] = [];

  const dealExpertise = args.deal_type
    ? expandDealType(args.deal_type)
    : { departments: [], keywords: [], recognized: true };
  const departments = dedupe([
    ...(args.department ? expandDepartment(args.department) : []),
    ...dealExpertise.departments,
  ]);
  if (departments.length > 0) {
    interpretation.push(`desks: ${preview(departments)}`);
  }
  if (args.deal_type && !dealExpertise.recognized) {
    interpretation.push(
      `(no desk playbook for "${args.deal_type}" — matched literally)`,
    );
  }

  const expertise = dedupe([
    ...(args.specialization ? [args.specialization] : []),
    ...dealExpertise.keywords,
  ]);
  if (expertise.length > 0) {
    interpretation.push(`expertise: ${preview(expertise)}`);
  }

  const geo = args.geography
    ? expandGeography(args.geography)
    : { exact: [], broad: [], region: null, countryCode: null };
  if (geo.exact.length > 0) {
    interpretation.push(
      `coverage: ${preview(geo.exact)}${
        geo.broad.length > 0 ? ` (also accepting ${preview(geo.broad)})` : ""
      }`,
    );
  }
  if (args.geography && !geo.region && !geo.countryCode) {
    interpretation.push(
      `(no country or region matched "${args.geography}" — matched literally)`,
    );
  }

  const seniorities = args.seniority ? expandSeniority(args.seniority) : [];
  if (seniorities.length > 0) {
    interpretation.push(`seniority: ${preview(seniorities)}`);
  }
  if (args.industry) interpretation.push(`firm industry: ${args.industry}`);
  if (args.topic) interpretation.push(`firm topic: ${args.topic}`);
  if (args.firm) interpretation.push(`firm: ${args.firm}`);
  if (args.banker) interpretation.push(`banker: ${args.banker}`);
  if (args.query) interpretation.push(`keyword: ${args.query}`);

  return {
    filters: {
      keyword: args.query,
      banker: args.banker,
      firm: args.firm,
      departments,
      expertise,
      regions: geo.exact,
      broadRegions: geo.broad,
      seniorities,
      industries: args.industry ? [args.industry] : [],
      topics: args.topic ? [args.topic] : [],
      limit,
    },
    interpretation,
  };
}

/** One ranked banker, rendered with the firm context needed to act on it. */
function renderBanker(
  banker: CorrespondentSearchResult,
  rank: number,
  topics: Array<{ name: string; is_deal_related: boolean }>,
  team: Array<{ name: string; email: string | null }>,
): string {
  const headline = [banker.title, banker.department && `${banker.department} desk`]
    .filter(Boolean)
    .join(", ");
  const why = banker.matched
    .map((key) => FACET_LABELS[key] ?? key)
    .join(", ");

  const lines = [
    `### ${rank}. ${banker.name}${headline ? ` — ${headline}` : ""} @ ${banker.employer_name}`,
    `- **Why this banker:** matched ${why || "nothing specific"} (fit score ${banker.match_score})`,
  ];
  if (banker.coverage_region) lines.push(`- **Covers:** ${banker.coverage_region}`);
  if (banker.specialization) lines.push(`- **Focus:** ${banker.specialization}`);
  if (banker.seniority && banker.seniority !== banker.title) {
    lines.push(`- **Seniority:** ${banker.seniority}`);
  }

  const contact = [banker.email, banker.phone, banker.linkedin_url].filter(Boolean);
  if (contact.length > 0) lines.push(`- **Contact:** ${contact.join(" · ")}`);

  const firmFacts = [
    banker.employer_industry,
    `${banker.email_count} email(s) on record`,
    `last contact ${toDay(banker.last_contact_at) || "never"}`,
  ].filter(Boolean);
  lines.push(`- **Firm:** ${banker.employer_name} — ${firmFacts.join(", ")}`);

  if (topics.length > 0) {
    lines.push(
      `- **Firm topics:** ${topics
        .map((t) => (t.is_deal_related ? `**${t.name}**` : t.name))
        .join(", ")}`,
    );
  }
  if (team.length > 0) {
    lines.push(
      `- **Our coverage:** ${team
        .map((m) => `${m.name}${m.email ? ` (${m.email})` : ""}`)
        .join(", ")}`,
    );
  }
  if (banker.bio) lines.push(`- _${banker.bio.trim()}_`);

  return lines.join("\n");
}

/**
 * Look up CRM data — firms (employers) and the full relationship picture around
 * them: correspondents (bankers), topics, internal team coverage, recent email
 * history, notes, and linked pipeline companies.
 *
 * "Correspondent" and "banker" are used interchangeably: a correspondent is a
 * person (deal contact / PIC) attached to a firm.
 *
 * Two modes, picked from the arguments:
 *
 *  - **Firm profile** (`query`/`firm`/`banker` alone) — fuzzy-matches firm
 *    names, banker names and banker emails, then returns each matching firm
 *    with everything we know about the relationship.
 *  - **Banker match** (any of `department`, `deal_type`, `geography`,
 *    `specialization`, `seniority`, `industry`, `topic`) — ranks individual
 *    bankers against a deal profile. This is the "who can help me close this
 *    deal?" path: the deal's country is translated into the coverage labels
 *    that include it and the mandate type into the desks that run it, since
 *    neither is stored the way a user describes it.
 */
export const lookupCrm = tool(
  async (args: MatchArgs & { limit?: number }) => {
    const {
      query,
      firm,
      banker,
      department,
      deal_type,
      geography,
      specialization,
      seniority,
      industry,
      topic,
      limit,
    } = args;

    logger.debug(
      `🔧 TOOL CALLED: lookup_crm(${JSON.stringify({
        query,
        firm,
        banker,
        department,
        deal_type,
        geography,
        specialization,
        seniority,
        industry,
        topic,
        limit,
      })})`,
    );

    const trimmed = query?.trim() ?? "";
    // Attribute facets switch the tool into banker-matching mode; a bare
    // name/firm keeps the richer firm-profile output.
    const matchTerms = [
      department,
      deal_type,
      geography,
      specialization,
      seniority,
      industry,
      topic,
    ].filter((value) => value?.trim());
    // Firm-profile mode searches ONE string, so two names together ("Jane Doe"
    // at "Evercore") would silently drop one. Two names are a match, not a
    // profile — the scored search is what can hold both at once.
    // Deduped: an agent that puts the same string in two slots
    // (query="Evercore", firm="Evercore") named one thing, not two, and should
    // still get the firm profile.
    const nameTerms = dedupe(
      [trimmed, firm, banker].map((value) => value?.trim() ?? ""),
    );

    if (matchTerms.length === 0 && nameTerms.length === 0) {
      return "Please provide a firm name, banker (correspondent) name, or email to look up — or describe the deal (geography, deal_type, department) to match bankers against it.";
    }

    const matchMode = matchTerms.length > 0 || nameTerms.length > 1;
    const cappedLimit = Math.min(Math.max(limit ?? (matchMode ? 10 : 5), 1), 20);

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();

      if (matchMode) {
        return await matchBankers(
          db,
          workspaceId,
          { query: trimmed || undefined, firm, banker, department, deal_type, geography, specialization, seniority, industry, topic },
          cappedLimit,
        );
      }

      return await profileFirms(
        db,
        workspaceId,
        trimmed || firm?.trim() || banker?.trim() || "",
        cappedLimit,
      );
    } catch (error) {
      logger.error(`CRM lookup error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "lookup_crm",
    description: `Look up CRM data — firms, bankers, and which banker fits a deal.

"Banker" and "correspondent" mean the same thing here: a deal contact attached
to a firm, with a desk (department), a coverage region, a specialization and a
seniority.

TWO MODES:

1. Firm profile — pass \`query\` (or \`firm\` / \`banker\`) on its own.
   For "who is our contact at Goldman", "what firm does Jane Doe work at",
   "list the bankers at Evercore", "what have we discussed with Lazard".
   Returns, per matching firm: its bankers (name, title, desk, coverage,
   email, phone), deal/engagement topics, the internal team covering the
   relationship, recent emails, recent notes, and linked pipeline companies.

2. Banker match — pass any of \`geography\`, \`deal_type\`, \`department\`,
   \`specialization\`, \`seniority\`, \`industry\`, \`topic\`.
   For "which banker can help me close this deal", "who covers US leveraged
   finance", "find a semiconductor M&A MD in Asia". Returns individual bankers
   ranked by fit, each with why it matched, its firm, our last contact with
   that firm, and who internally covers the relationship.

   Describe the DEAL, not the CRM record — the tool does the translation:
     * \`geography\` takes the deal's country ("United States"); it is expanded
       to the coverage labels that include it ("North America", "Americas",
       "Global"), because coverage is stored regionally.
     * \`deal_type\` takes the mandate ("LBO", "IPO", "refinancing",
       "sell-side carve-out", "restructuring"); it is expanded to the desks
       that run it ("Leveraged Finance", "DCM", "Financial Sponsors"…).
   Matching is scored, not all-or-nothing: bankers matching more of the
   profile rank first, partial matches still come back. So for "a US company
   we want to LBO", call lookup_crm(geography="United States",
   deal_type="LBO") — do not pre-guess the department yourself.

For portfolio-wide CRM metrics (stale relationships, flagged records, emails
today) use crm_insights instead. For one banker as a PERSON — who on our team
has emailed them and how often, which deals they brought and how far
those got — or a ranking of bankers, use crm_banker_insights instead.

Returns:
    Markdown — a profile per firm, or a ranked banker list.`,
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free text: firm name, banker (correspondent) name, or email (partial match). On its own, returns full firm profiles.",
        ),
      firm: z
        .string()
        .optional()
        .describe("Restrict to firms whose name contains this."),
      banker: z
        .string()
        .optional()
        .describe("Restrict to bankers whose name or email contains this."),
      department: z
        .string()
        .optional()
        .describe(
          'Desk to look for, e.g. "Debt Capital Markets", "M&A", "ECM". Abbreviations and full names are treated as equivalent.',
        ),
      deal_type: z
        .string()
        .optional()
        .describe(
          'The mandate, in the user\'s own words: "LBO", "IPO", "refinancing", "sell-side carve-out", "restructuring". Expanded to the desks that run it — prefer this over guessing a department.',
        ),
      geography: z
        .string()
        .optional()
        .describe(
          'Where the deal/target is — a country ("United States", "Indonesia") or a region ("APAC", "EMEA"). Expanded to the coverage regions that include it.',
        ),
      specialization: z
        .string()
        .optional()
        .describe('Sector or skill, e.g. "semiconductors", "healthcare".'),
      seniority: z
        .string()
        .optional()
        .describe('Seniority band, e.g. "Managing Director" or "MD".'),
      industry: z
        .string()
        .optional()
        .describe("Industry of the FIRM (not the target), e.g. \"Private Equity\"."),
      topic: z
        .string()
        .optional()
        .describe("A deal/engagement topic recorded against the firm."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Max results (1-20). Default 5 firms in firm-profile mode, 10 bankers in banker-match mode.",
        ),
    }),
  },
);

/** Banker-match mode — rank individual bankers against a deal profile. */
async function matchBankers(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  args: MatchArgs,
  limit: number,
): Promise<string> {
  const correspondentRepo = new CorrespondentRepository(db);
  const topicRepo = new TopicRepository(db);
  const teamRepo = new EmployerTeamRepository(db);

  const { filters, interpretation } = buildSearchFilters(args, limit);
  const bankers = await correspondentRepo.search(filters, workspaceId);

  const header = `## Banker match
- **Read as:** ${interpretation.join("; ") || "no usable criteria"}`;

  if (bankers.length === 0) {
    logger.debug("✓ CRM banker match: 0 bankers");
    return `${header}

_No banker in this workspace's CRM matches any of those criteria. Try a broader
geography (the region rather than the country), a different desk, or
\`lookup_crm\` with just the firm name to see who we know there._`;
  }

  // Batched, not per-banker: one query each for topics and team coverage
  // across every matched firm (per-row lookups here would be an N+1).
  const employerIds = [...new Set(bankers.map((b) => b.employer_id))];
  const [topicRows, teamRows] = await Promise.all([
    topicRepo.listForEmployers(employerIds, workspaceId),
    teamRepo.listForEmployers(employerIds),
  ]);
  const topicsByEmployer = groupByEmployer(topicRows);
  const teamByEmployer = groupByEmployer(teamRows);

  logger.debug(`✓ CRM banker match: ${bankers.length} banker(s)`);

  const body = bankers
    .map((b, i) =>
      renderBanker(
        b,
        i + 1,
        topicsByEmployer.get(b.employer_id) ?? [],
        teamByEmployer.get(b.employer_id) ?? [],
      ),
    )
    .join("\n\n");

  return `${header}
- **Ranking:** best fit first — the fit score is the weighted sum of the criteria each banker matched, ties broken by most recent contact.

${body}`;
}

/** Firm-profile mode — the full relationship picture per matching firm. */
async function profileFirms(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  search: string,
  limit: number,
): Promise<string> {
  const employerRepo = new EmployerRepository(db);
  const correspondentRepo = new CorrespondentRepository(db);
  const relatedCompanyRepo = new EmployerRelatedCompanyRepository(db);
  const noteRepo = new EmployerNoteRepository(db);
  const topicRepo = new TopicRepository(db);
  const teamRepo = new EmployerTeamRepository(db);
  const emailRepo = new EmailRepository(db);

  const firms = await employerRepo.list({ search, limit }, workspaceId);

  if (firms.length === 0) {
    return `No CRM firms or bankers found matching "${search}".`;
  }

  const sections = await Promise.all(
    firms.map(async (firm) => {
      const [bankers, relatedCompanies, topics, team, emails, notes] =
        await Promise.all([
          correspondentRepo.findByEmployerId(firm.id, workspaceId),
          relatedCompanyRepo.listForEmployer(firm.id, workspaceId),
          topicRepo.listForEmployer(firm.id, workspaceId),
          teamRepo.listForEmployer(firm.id),
          emailRepo.findByEmployerId(firm.id, { limit: RECENT_EMAILS }),
          noteRepo.findByEmployerId(firm.id, workspaceId),
        ]);

      const bankerLines =
        bankers.length === 0
          ? "- _No bankers/correspondents on record._"
          : bankers
              .map((b) => {
                const parts = [
                  `**${b.name}**${b.is_primary ? " (primary)" : ""}`,
                ];
                if (b.title) parts.push(b.title);
                if (b.department) parts.push(`${b.department} desk`);
                if (b.seniority && b.seniority !== b.title) {
                  parts.push(b.seniority);
                }
                if (b.specialization) parts.push(`focus: ${b.specialization}`);
                if (b.coverage_region) parts.push(`covers ${b.coverage_region}`);
                if (b.email) parts.push(b.email);
                if (b.phone) parts.push(b.phone);
                const line = `- ${parts.join(" — ")}`;
                return b.bio ? `${line}\n  - _${b.bio.trim()}_` : line;
              })
              .join("\n");

      const topicLine =
        topics.length === 0
          ? "_No topics on record._"
          : topics
              .map((t) => (t.is_highlight ? `**${t.name}**` : t.name))
              .join(", ");

      const teamLines =
        team.length === 0
          ? "- _No team members assigned._"
          : team
              .map((m) => `- ${m.name}${m.email ? ` (${m.email})` : ""}`)
              .join("\n");

      const emailLines =
        emails.length === 0
          ? "- _No emails on record._"
          : emails
              .map((e) => {
                const dir = e.direction === "outbound" ? "↗ sent" : "↘ received";
                const day = toDay(e.sent_at);
                const who = e.from_display_name || e.from_address;
                return `- ${day ? `${day} ` : ""}${dir}${
                  who ? ` (from ${who})` : ""
                }`;
              })
              .join("\n");

      const noteLines =
        notes.length === 0
          ? "- _No notes on record._"
          : notes
              .slice(0, RECENT_NOTES)
              .map((n) => {
                const day = toDay(n.created_at);
                const body = n.content.trim().replace(/\s+/g, " ");
                const text =
                  body.length > NOTE_PREVIEW_CHARS
                    ? `${body.slice(0, NOTE_PREVIEW_CHARS)}…`
                    : body;
                return `- ${day ? `${day}: ` : ""}${text}`;
              })
              .join("\n");

      // Collapse auto + manual rows that point at the same company (the
      // same company can appear under both sources) — key on company_id,
      // falling back to the normalized name for unresolved auto rows.
      const seen = new Set<string>();
      const uniqueCompanies = relatedCompanies.filter((r) => {
        const key = r.company_id ?? `name:${r.normalized_company_name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const companyLines =
        uniqueCompanies.length === 0
          ? "- _No linked pipeline companies on record._"
          : uniqueCompanies
              .map((r) => `- ${r.company_name} (confidence: ${r.confidence})`)
              .join("\n");

      return `## ${firm.name}
- **Industry:** ${firm.industry || "N/A"}
- **Status:** ${firm.status || "N/A"}
- **Emails on record:** ${firm.email_count}
- **Last contact:** ${firm.last_contact_at || "N/A"}
- **Topics:** ${topicLine}

### Bankers (correspondents)
${bankerLines}

### Team coverage
${teamLines}

### Recent emails
${emailLines}

### Notes
${noteLines}

### Linked companies
${companyLines}`;
    }),
  );

  logger.debug(`✓ CRM lookup matched ${firms.length} firm(s)`);
  return sections.join("\n\n");
}
