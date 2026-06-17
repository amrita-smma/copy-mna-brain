import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CorrespondentRepository,
  EmployerRelatedCompanyRepository,
  EmployerRepository,
} from "@/lib/repositories";

/**
 * Look up CRM data — firms (employers) and their correspondents (bankers).
 *
 * "Correspondent" and "banker" are used interchangeably: a correspondent is a
 * person (deal contact / PIC) attached to a firm. This tool fuzzy-matches the
 * query against firm names, banker names, and banker emails, then returns each
 * matching firm with its full roster of bankers.
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

      const firms = await employerRepo.list({
        search: trimmed,
        limit: cappedLimit,
      });

      if (firms.length === 0) {
        return `No CRM firms or bankers found matching "${trimmed}".`;
      }

      const sections = await Promise.all(
        firms.map(async (firm) => {
          const [bankers, relatedCompanies] = await Promise.all([
            correspondentRepo.findByEmployerId(firm.id),
            relatedCompanyRepo.listForEmployer(firm.id),
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

### Bankers (correspondents)
${bankerLines}

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
    description: `Look up CRM data — firms and their bankers (correspondents).

Use this when the user asks about a firm/bank, a banker, or a deal contact —
e.g. "who is our contact at Goldman", "what firm does Jane Doe work at", or
"list the bankers at Evercore". "Banker" and "correspondent" mean the same
thing here.

Fuzzy-matches the query against firm names, banker names, and banker emails,
then returns each matching firm with its full roster of bankers (name, title,
email, phone, and which one is primary) plus the pipeline companies linked to
that firm — useful for "which deals is this banker on".

Args:
    query: Firm name, banker (correspondent) name, or email to look up
    limit: Max number of firms to return (1-20, default 5)

Returns:
    A markdown list of matching firms, each with its bankers.`,
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
