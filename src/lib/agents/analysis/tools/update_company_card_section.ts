import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyAnalysisRepository } from "@/lib/repositories";
import type { TablesUpdate } from "@/lib/repositories";

/**
 * Chat-callable, self-service edit of a SINGLE section of a company's AI
 * Company Card (`company_analyses`). This is the write half of the
 * "right-click a section of the Overview slide → Edit with AI" feature: the
 * slide sends the copilot a targeted prompt naming the company_id, the section,
 * its current content, and the user's instruction; the agent composes the
 * rewritten markdown and persists it here.
 *
 * Unlike pipeline-mutating writes (promotions, drops) this does not flow
 * through the Workforce — it only overwrites narrative card content for a
 * company the user is already looking at, so it's an allowed inline write
 * (same rationale as `email_research_summary`). It overwrites exactly one
 * field and leaves every other section untouched.
 */

const SECTION_KEYS = [
  "business_overview",
  "business_model_summary",
  "key_takeaways",
  "investment_highlights",
  "investment_risks",
  "diligence_priorities",
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_LABELS: Record<SectionKey, string> = {
  business_overview: "Target Overview / Business Overview",
  business_model_summary: "Business Model & Value Chain",
  key_takeaways: "Key Takeaways",
  investment_highlights: "Investment Highlights / Investment Thesis",
  investment_risks: "Investment Risks / Kill Criteria",
  diligence_priorities: "Diligence Priorities / L1 Scope of Work",
};

export const updateCompanyCardSection = tool(
  async ({
    company_id,
    section,
    content,
  }: {
    company_id: string;
    section: SectionKey;
    content: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: update_company_card_section(company_id='${company_id}', section='${section}')`,
    );

    const id = company_id?.trim();
    if (!id) return "**Error:** company_id is required.";
    const text = content?.trim();
    if (!text) return "**Error:** content is required and cannot be empty.";

    try {
      const db = createDb();
      const repo = new CompanyAnalysisRepository(db, await getActiveWorkspaceId());
      const existing = await repo.findByCompanyId(id);
      if (!existing) {
        return `**Error:** No AI Company Card exists for company_id "${id}" yet. The card must be generated before a section can be edited.`;
      }

      const updates: TablesUpdate<"company_analyses"> = {
        status: "completed",
        error_message: null,
      };
      (updates as Record<string, unknown>)[section] = text;

      const updated = await repo.updateByCompanyId(id, updates);
      logger.info(
        `✓ Company card section "${section}" updated for company ${id}`,
      );
      return `Updated the "${SECTION_LABELS[section]}" section of the AI Company Card for company_id "${id}" (analysis id: ${updated.id}). The Overview slide now reflects the new content.`;
    } catch (error) {
      logger.error(
        `update_company_card_section error: ${(error as Error).message}`,
      );
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "update_company_card_section",
    description: `Overwrite a SINGLE section of a company's AI Company Card — the structured narrative shown on that company's L0→L1 Overview slide. Use this whenever the user asks to edit, refine, rewrite, shorten, expand, reword, or correct one specific section of a company's overview/company card.

You compose the FULL replacement markdown for that one section and pass it as \`content\`; the tool overwrites only that field and leaves every other section untouched. Match the existing concise, markdown bullet style of the card and stay factually grounded — if the request needs fresh facts, research first with the read tools (get_company_details, query_files, web_search) before composing the new content.

When invoked from the "right-click a section → Edit with AI" flow, the user's message includes the company_id, the section, and its current content — use that company_id verbatim. When the request is general (no company_id given), resolve it first: call get_company_details with the company name and use the "Company ID (UUID)" it returns as the company_id here.

Args:
    company_id: UUID of the company whose card section to update. Required.
    section: Which section to overwrite. One of: business_overview, business_model_summary, key_takeaways, investment_highlights, investment_risks, diligence_priorities.
    content: The full rewritten markdown for that section. Required, non-empty.

Returns:
    A success message naming the updated section, or an error string starting with **Error:** (e.g. when no card exists yet for the company).`,
    schema: z.object({
      company_id: z
        .string()
        .describe("UUID of the company whose card section to update"),
      section: z
        .enum(SECTION_KEYS)
        .describe("Which AI Company Card section to overwrite"),
      content: z
        .string()
        .min(1)
        .describe("Full rewritten markdown content for the section"),
    }),
  },
);
