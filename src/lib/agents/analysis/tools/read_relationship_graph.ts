import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";

const MAX_COMPANIES = 25;

interface Resolved {
  /** The raw name the caller passed. */
  query: string;
  id: string;
  /** Canonical display name from Postgres. */
  name: string;
}

/**
 * Read from the Neo4j relationship graph.
 *
 * Read-only. Two behaviours, chosen by how many of the supplied company names
 * resolve to a known company:
 *
 * 1. Exactly one company → list every company it is directly connected to,
 *    grouped by edge direction (outgoing / incoming) with the relation type.
 * 2. Two or more companies → for every unordered pair, report whether a direct
 *    connection exists between them (and the relation type + direction).
 *
 * Names are fuzzy-matched against existing companies (same matching as
 * get_company_details). Any name that doesn't resolve is reported separately
 * and excluded from the analysis.
 */
export const readRelationshipGraph = tool(
  async ({ companies }: { companies: string[] }) => {
    logger.debug(
      `🔧 TOOL CALLED: read_relationship_graph(${companies?.length ?? 0} company(ies))`,
    );

    if (!Array.isArray(companies) || companies.length === 0) {
      return "**Error:** provide at least one company name.";
    }
    if (companies.length > MAX_COMPANIES) {
      return `**Error:** too many companies (${companies.length}); max ${MAX_COMPANIES} per call.`;
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { companyGraphService } = createContainer(db, workspaceId);

      // Resolve names → companies, deduping repeats and names that collapse to
      // the same underlying company. Preserve first-seen order.
      const resolved: Resolved[] = [];
      const seenIds = new Set<string>();
      const unresolved: string[] = [];

      for (const raw of companies) {
        const query = raw?.trim() ?? "";
        if (!query) continue;
        const match = await companyRepo.findByNameFuzzy(query);
        if (!match) {
          unresolved.push(query);
          continue;
        }
        if (seenIds.has(match.id)) continue;
        seenIds.add(match.id);
        resolved.push({ query, id: match.id, name: match.target ?? query });
      }

      const unresolvedNote = unresolved.length
        ? `\n\n_Not found (excluded): ${unresolved.map((u) => `"${u}"`).join(", ")}._`
        : "";

      if (resolved.length === 0) {
        return `No companies matched: ${companies
          .map((c) => `"${c}"`)
          .join(", ")}. Use query_companies to browse available companies.`;
      }

      // --- Behaviour 1: single company → list its connections ---
      if (resolved.length === 1) {
        const target = resolved[0];
        const edges = await companyGraphService.getConnectedCompanies(target.id);

        if (edges.length === 0) {
          return `**${target.name}** has no relationships recorded in the graph.${unresolvedNote}`;
        }

        const lines = edges.map((e) => {
          const other = e.company.name;
          const arrow =
            e.direction === "outgoing"
              ? `${target.name} --${e.type}--> ${other}`
              : `${other} --${e.type}--> ${target.name}`;
          const meta = [e.notes, e.evidence, e.date].filter(Boolean).join(" · ");
          return `- ${arrow}${meta ? ` (${meta})` : ""}`;
        });

        return `## Relationships for ${target.name}\n${edges.length} direct connection(s):\n${lines.join(
          "\n",
        )}${unresolvedNote}`;
      }

      // --- Behaviour 2: multiple companies → pairwise connection check ---
      const connections = await companyGraphService.getConnectionsAmong(
        resolved.map((r) => r.id),
      );

      // Index edges by unordered pair key so we can look up both directions.
      const byPair = new Map<string, string[]>();
      const nameById = new Map(resolved.map((r) => [r.id, r.name]));
      const pairKey = (a: string, b: string) => [a, b].sort().join("::");
      for (const c of connections) {
        const key = pairKey(c.sourceId, c.targetId);
        const desc = `${nameById.get(c.sourceId)} --${c.type}--> ${nameById.get(
          c.targetId,
        )}`;
        const list = byPair.get(key) ?? [];
        list.push(desc);
        byPair.set(key, list);
      }

      const connectedLines: string[] = [];
      const unconnectedPairs: string[] = [];
      for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          const a = resolved[i];
          const b = resolved[j];
          const edges = byPair.get(pairKey(a.id, b.id));
          if (edges && edges.length) {
            connectedLines.push(...edges.map((e) => `- ${e}`));
          } else {
            unconnectedPairs.push(`${a.name} ↔ ${b.name}`);
          }
        }
      }

      const totalPairs = (resolved.length * (resolved.length - 1)) / 2;
      const parts = [
        `## Pairwise connections among ${resolved.length} companies`,
        `${connectedLines.length ? connectedLines.length : 0} of ${totalPairs} pair(s) directly connected.`,
      ];
      if (connectedLines.length) {
        parts.push(`\n### Connected\n${connectedLines.join("\n")}`);
      }
      if (unconnectedPairs.length) {
        parts.push(
          `\n### No direct connection\n${unconnectedPairs.map((p) => `- ${p}`).join("\n")}`,
        );
      }

      return parts.join("\n") + unresolvedNote;
    } catch (error) {
      logger.error(`read_relationship_graph error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "read_relationship_graph",
    description: `Read from the company relationship graph (Neo4j). Read-only.

Two behaviours, chosen automatically by how many companies you pass:

1. ONE company → lists every company it is directly connected to, with the relationship type and direction (who sells to / invested in / partners with whom). Use this to answer "what is X connected to?".

2. TWO OR MORE companies → checks every unordered pair and reports which pairs have a direct connection (and which don't). Use this to answer "are any of these companies connected to each other?".

Company names are fuzzy-matched against existing records. Names that don't resolve are reported separately and excluded. This tool only reads existing edges — it never creates or modifies relationships.

Args:
    companies: List of company names (1–${MAX_COMPANIES}). Pass one name for a connection listing, or several for a pairwise connection check.

Returns:
    A markdown summary of the connections found, or an error string.`,
    schema: z.object({
      companies: z
        .array(z.string())
        .describe(
          "Company names. One name lists that company's connections; two or more checks every pair for a direct connection.",
        ),
    }),
  },
);
