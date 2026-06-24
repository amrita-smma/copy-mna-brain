import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CorrespondentRepository,
  EmailRepository,
  EmployerNoteRepository,
  EmployerRelatedCompanyRepository,
  EmployerRepository,
  EmployerTeamRepository,
  TopicRepository,
} from "@/lib/repositories";

// How many recent emails / notes to surface per firm. The card stays scannable
// for the model rather than dumping the full history; deeper history lives in
// the CRM UI.
const RECENT_EMAILS = 5;
const RECENT_NOTES = 5;
const NOTE_PREVIEW_CHARS = 240;

/** ISO timestamp → YYYY-MM-DD; empty string for null/unparseable input. */
function toDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

/**
 * Look up CRM data — firms (employers) and the full relationship picture around
 * them: correspondents (bankers), topics, internal team coverage, recent email
 * history, notes, and linked pipeline companies.
 *
 * "Correspondent" and "banker" are used interchangeably: a correspondent is a
 * person (deal contact / PIC) attached to a firm. This tool fuzzy-matches the
 * query against firm names, banker names, and banker emails, then returns each
 * matching firm with everything we know about the relationship.
 */
export const lookupCrm = tool(
  async ({ query, limit }: { query: string; limit?: number }) => {
    logger.debug(`🔧 TOOL CALLED: lookup_crm(query='${query}', limit=${limit})`);

    const trimmed = query?.trim() ?? "";
    if (trimmed.length === 0) {
      return "Please provide a firm name, banker (correspondent) name, or email to look up.";
    }

    const cappedLimit = Math.min(Math.max(limit ?? 5, 1), 20);

    try {
      const db = createDb();
      const employerRepo = new EmployerRepository(db);
      const correspondentRepo = new CorrespondentRepository(db);
      const relatedCompanyRepo = new EmployerRelatedCompanyRepository(db);
      const noteRepo = new EmployerNoteRepository(db);
      const topicRepo = new TopicRepository(db);
      const teamRepo = new EmployerTeamRepository(db);
      const emailRepo = new EmailRepository(db);

      const firms = await employerRepo.list({
        search: trimmed,
        limit: cappedLimit,
      });

      if (firms.length === 0) {
        return `No CRM firms or bankers found matching "${trimmed}".`;
      }

      const sections = await Promise.all(
        firms.map(async (firm) => {
          const [bankers, relatedCompanies, topics, team, emails, notes] =
            await Promise.all([
              correspondentRepo.findByEmployerId(firm.id),
              relatedCompanyRepo.listForEmployer(firm.id),
              topicRepo.listForEmployer(firm.id),
              teamRepo.listForEmployer(firm.id),
              emailRepo.findByEmployerId(firm.id, { limit: RECENT_EMAILS }),
              noteRepo.findByEmployerId(firm.id),
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
                    if (b.email) parts.push(b.email);
                    if (b.phone) parts.push(b.phone);
                    return `- ${parts.join(" — ")}`;
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
                    const subject = e.subject?.trim() || "(no subject)";
                    const who = e.from_display_name || e.from_address;
                    return `- ${day ? `${day} ` : ""}${dir} — ${subject}${
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
                    const preview =
                      body.length > NOTE_PREVIEW_CHARS
                        ? `${body.slice(0, NOTE_PREVIEW_CHARS)}…`
                        : body;
                    return `- ${day ? `${day}: ` : ""}${preview}`;
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
    } catch (error) {
      logger.error(`CRM lookup error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "lookup_crm",
    description: `Look up CRM data — firms and the full relationship picture around them.

Use this when the user asks about a firm/bank, a banker, or a deal contact —
e.g. "who is our contact at Goldman", "what firm does Jane Doe work at", "list
the bankers at Evercore", "what have we discussed with Lazard", or "who covers
the Citi relationship". "Banker" and "correspondent" mean the same thing here.

Fuzzy-matches the query against firm names, banker names, and banker emails,
then returns each matching firm with:
  - its bankers (name, title, email, phone, primary flag)
  - deal/engagement topics
  - the internal team members covering the relationship
  - the most recent emails (direction, date, subject, sender)
  - the most recent relationship notes
  - linked pipeline companies (useful for "which deals is this banker on")

For portfolio-wide CRM metrics (stale relationships, flagged records, emails
today) use crm_insights instead.

Args:
    query: Firm name, banker (correspondent) name, or email to look up
    limit: Max number of firms to return (1-20, default 5)

Returns:
    A markdown profile per matching firm.`,
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Firm name, banker (correspondent) name, or email (partial match, must be non-empty)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max number of firms to return (1-20, default 5)"),
    }),
  }
);
