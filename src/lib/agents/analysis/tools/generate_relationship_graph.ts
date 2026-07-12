import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import {
  RELATION_TYPES,
  type RelationType,
} from "@/lib/repositories/companyRelationRepository";
import { DISCOVERED_STAGE } from "@/lib/constants";

interface EdgeInput {
  source_company: string;
  target_company: string;
  relation_type: RelationType;
  notes?: string;
  evidence?: string;
  date?: string;
}

const MAX_EDGES = 100;

/**
 * Generate a relationship graph by writing a batch of directed edges to the
 * Neo4j graph DB in one call.
 *
 * Workforce-only write tool. AUTO-EXECUTES (no HITL gate) — recording
 * relationships is a low-stakes annotation, not a pipeline commitment, so it
 * runs immediately (mirrors `update_company_relationship` / `add_company`).
 *
 * Each edge is written via `CompanyRelationshipService.linkByName`: both sides
 * are fuzzy-matched against existing companies by name, any side with no match
 * is created at the special `discovered` stage, and the directed edge is
 * upserted in the graph (both nodes are MERGE'd first so the edge always
 * attaches). This is the bulk counterpart to `update_company_relationship` —
 * use it when an instruction describes a whole set of relationships at once
 * (e.g. a supplier/partner/investor map for a company), rather than calling the
 * single-edge tool repeatedly.
 *
 * Edges are processed independently: a malformed or failing edge is reported in
 * the summary and skipped; it does not abort the rest of the batch.
 */
export const generateRelationshipGraph = tool(
  async ({ edges }: { edges: EdgeInput[] }) => {
    logger.debug(
      `🔧 TOOL CALLED: generate_relationship_graph(${edges?.length ?? 0} edge(s))`,
    );

    if (!Array.isArray(edges) || edges.length === 0) {
      return `**Error:** at least one edge is required.`;
    }
    if (edges.length > MAX_EDGES) {
      return `**Error:** too many edges (${edges.length}); max ${MAX_EDGES} per call. Split the graph into multiple calls.`;
    }

    try {
      const db = createDb();
      const { companyRelationshipService } = createContainer(db, await getActiveWorkspaceId());

      const linked: string[] = [];
      const discovered = new Set<string>();
      const failures: string[] = [];

      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const label = `edge #${i + 1}`;
        const trimmedSource = edge.source_company?.trim() ?? "";
        const trimmedTarget = edge.target_company?.trim() ?? "";

        if (!trimmedSource || !trimmedTarget) {
          failures.push(`${label}: both source_company and target_company are required.`);
          continue;
        }
        if (trimmedSource.toLowerCase() === trimmedTarget.toLowerCase()) {
          failures.push(`${label}: source and target must differ (got "${trimmedSource}" for both).`);
          continue;
        }
        if (!RELATION_TYPES.includes(edge.relation_type)) {
          failures.push(
            `${label}: relation_type must be one of ${RELATION_TYPES.join(", ")}; got "${edge.relation_type}".`,
          );
          continue;
        }

        try {
          const { source, target } = await companyRelationshipService.linkByName({
            sourceName: trimmedSource,
            targetName: trimmedTarget,
            type: edge.relation_type,
            notes: edge.notes?.trim() || undefined,
            evidence: edge.evidence?.trim() || undefined,
            date: edge.date?.trim() || undefined,
          });

          linked.push(
            `"${source.row.target}" --${edge.relation_type}--> "${target.row.target}"`,
          );
          if (source.created) discovered.add(source.row.target ?? trimmedSource);
          if (target.created) discovered.add(target.row.target ?? trimmedTarget);
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`);
        }
      }

      const parts = [
        `Wrote ${linked.length}/${edges.length} edge(s) to the relationship graph.`,
      ];
      if (linked.length) parts.push(`Edges: ${linked.join("; ")}.`);
      if (discovered.size) {
        parts.push(
          `Created ${discovered.size} company(ies) as "${DISCOVERED_STAGE}" (not previously on record): ${Array.from(discovered).join(", ")}.`,
        );
      }
      if (failures.length) parts.push(`Skipped ${failures.length}: ${failures.join(" ")}`);

      return parts.join(" ");
    } catch (error) {
      logger.error(`generate_relationship_graph error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "generate_relationship_graph",
    description: `Generate a relationship graph by writing a batch of directed edges to the Neo4j graph DB in one call.

This is the bulk counterpart to \`update_company_relationship\`. Use it when an instruction describes a whole set of relationships at once — e.g. mapping a company's suppliers, partners, and investors — instead of calling the single-edge tool repeatedly.

Each edge is directed: source_company --[relation_type]--> target_company. Allowed relation types are INVESTED_IN, PARTNER, and SELLS_TO. Use SELLS_TO for any commercial supply/customer relationship (it is directional — source sells to target — so it captures both "supplier" and "customer" perspectives depending on which company is the source). SUPPLIER is accepted for backwards-compatibility only; prefer SELLS_TO for all new edges. Each company is matched by name against existing records; any company not found is automatically added at the special "discovered" stage. Re-running an edge with the same pair and type updates that edge's notes/evidence/date in place.

Edges are processed independently: a malformed or failing edge is reported in the summary and skipped — it does NOT abort the rest of the batch. Auto-executes (no human approval).

Args:
    edges: Array of edges to write (1–${MAX_EDGES}). Each edge:
        source_company: Name of the company the relationship originates from. Required.
        target_company: Name of the company the relationship points to. Required; must differ from source.
        relation_type: One of "INVESTED_IN", "PARTNER", or "SELLS_TO". Use "SELLS_TO" for all commercial supply/customer relationships. "SUPPLIER" is accepted but deprecated.
        notes: Optional free-text note about the relationship.
        evidence: Optional supporting evidence (URL or short description).
        date: Optional ISO date (YYYY-MM-DD) the relationship was observed.

Returns:
    A summary of how many edges were written, which companies were created as "discovered", and any edges that were skipped, or an error string.`,
    schema: z.object({
      edges: z
        .array(
          z.object({
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
        )
        .describe("Directed edges to write to the relationship graph"),
    }),
  },
);
