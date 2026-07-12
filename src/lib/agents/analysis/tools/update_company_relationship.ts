import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import type { ResolvedCompany } from "@/lib/services";
import {
  RELATION_TYPES,
  type RelationType,
} from "@/lib/repositories/companyRelationRepository";
import { DISCOVERED_STAGE } from "@/lib/constants";

/**
 * Create or update a directed relationship between two companies in the
 * relationship graph (Neo4j).
 *
 * Workforce-only write tool. AUTO-EXECUTES (no HITL gate) — recording a
 * relationship is a low-stakes annotation, not a pipeline commitment, so it
 * runs immediately (mirrors `add_company`). Pipeline stage moves still
 * go through the gated `promote_to_l1`.
 *
 * Resolution: each side is fuzzy-matched against existing companies by name
 * (`target` / `project_name`). If a side has no match, a new companies row is
 * created at the special `discovered` stage — these are companies surfaced
 * only because they appeared in a relationship, not because they entered the
 * deal pipeline. The created/looked-up rows are then linked in the graph via
 * `CompanyGraphService.relateCompanies` (which upserts both nodes first so the
 * edge always attaches).
 *
 * Relationship is directed: source --[type]--> target. Re-running with the
 * same pair + type updates the edge's notes/evidence/date in place (MERGE).
 */
export const updateCompanyRelationship = tool(
  async ({
    source_company,
    target_company,
    relation_type,
    notes,
    evidence,
    date,
  }: {
    source_company: string;
    target_company: string;
    relation_type: RelationType;
    notes?: string;
    evidence?: string;
    date?: string;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: update_company_relationship('${source_company}' --${relation_type}--> '${target_company}')`,
    );

    const trimmedSource = source_company.trim();
    const trimmedTarget = target_company.trim();

    if (!trimmedSource || !trimmedTarget) {
      return `**Error:** both source_company and target_company are required.`;
    }
    if (
      trimmedSource.toLowerCase() === trimmedTarget.toLowerCase()
    ) {
      return `**Error:** source_company and target_company must be different companies; got "${trimmedSource}" for both.`;
    }
    if (!RELATION_TYPES.includes(relation_type)) {
      return `**Error:** relation_type must be one of ${RELATION_TYPES.join(", ")}; got "${relation_type}".`;
    }

    try {
      const db = createDb();
      const { companyRelationshipService } = createContainer(db, await getActiveWorkspaceId());

      const { source, target } = await companyRelationshipService.linkByName({
        sourceName: trimmedSource,
        targetName: trimmedTarget,
        type: relation_type,
        notes: notes?.trim() || undefined,
        evidence: evidence?.trim() || undefined,
        date: date?.trim() || undefined,
      });

      const noteCreated = (label: string, r: ResolvedCompany) =>
        r.created
          ? `${label} "${r.row.target}" was not on record — created it as a "${DISCOVERED_STAGE}" company (id: ${r.row.id}).`
          : null;

      const createdNotes = [
        noteCreated("Source", source),
        noteCreated("Target", target),
      ].filter(Boolean);
      const suffix = createdNotes.length ? ` ${createdNotes.join(" ")}` : "";

      return `Linked "${source.row.target}" --${relation_type}--> "${target.row.target}" in the relationship graph.${suffix}`;
    } catch (error) {
      logger.error(
        `update_company_relationship error: ${(error as Error).message}`,
      );
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "update_company_relationship",
    description: `Create or update a directed relationship between two companies in the relationship graph.

The relationship is directed: source_company --[relation_type]--> target_company. Allowed relation types are INVESTED_IN, PARTNER, and SELLS_TO. Use SELLS_TO for any commercial supply/customer relationship — it is directional (source sells to target), so it captures both "supplier" and "customer" perspectives depending on which company is the source. SUPPLIER is accepted for backwards-compatibility only; prefer SELLS_TO for all new edges.

Each company is matched by name against existing records (company name or project name). If a company is not found, it is automatically added to the database at the special "discovered" stage — these are companies that surface only through a relationship, not through the L0–L5 deal pipeline. They appear in their own section of Master Data.

Re-running with the same pair and relation type updates the edge's notes/evidence/date in place.

Args:
    source_company: Name of the company the relationship originates from. Required.
    target_company: Name of the company the relationship points to. Required; must differ from source.
    relation_type: One of "INVESTED_IN", "PARTNER", or "SELLS_TO". Use "SELLS_TO" for all commercial supply/customer relationships. "SUPPLIER" is accepted but deprecated.
    notes: Optional free-text note about the relationship.
    evidence: Optional supporting evidence (URL or short description).
    date: Optional ISO date (YYYY-MM-DD) the relationship was established or observed.

Returns:
    A success message naming the linked companies (and flagging any that were created as "discovered"), or an error string.`,
    schema: z.object({
      source_company: z
        .string()
        .describe("Name of the company the relationship originates from"),
      target_company: z
        .string()
        .describe("Name of the company the relationship points to"),
      relation_type: z
        .enum(RELATION_TYPES as unknown as [RelationType, ...RelationType[]])
        .describe("Relationship type: INVESTED_IN, PARTNER, or SELLS_TO (preferred for all commercial supply/customer edges; SUPPLIER accepted but deprecated)"),
      notes: z
        .string()
        .optional()
        .describe("Optional free-text note about the relationship"),
      evidence: z
        .string()
        .optional()
        .describe("Optional supporting evidence (URL or short description)"),
      date: z
        .string()
        .optional()
        .describe("Optional ISO date (YYYY-MM-DD) the relationship was observed"),
    }),
  },
);
