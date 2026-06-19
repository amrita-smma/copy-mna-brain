import type { Driver } from 'neo4j-driver';

export type RelationType = 'INVESTED_IN' | 'PARTNER' | 'SUPPLIER';

/** The only relation types a company edge may have. */
export const RELATION_TYPES: readonly RelationType[] = ['INVESTED_IN', 'PARTNER', 'SUPPLIER'];

/** Whether a company is publicly listed or privately held. */
export type Ownership = 'public' | 'private';

export interface CompanyNode {
  id: string;
  name: string;
  segment?: string;
  industry?: string;
  geography?: string;
  ownership?: Ownership;
  /** Deal pipeline stage (e.g. `L0`–`L5`, `market_screening`, `discovered`). */
  pipelineStage?: string;
  /** Lifecycle status: `active` or `dropped`. */
  status?: string;
}

/**
 * Narrow port the Postgres `CompanyRepository` depends on to mirror company
 * writes into the graph. Kept minimal (just the two write verbs it needs) so
 * the SQL repository never imports the Neo4j driver — `CompanyRelationRepository`
 * satisfies this structurally and is injected by the container.
 */
export interface CompanyGraphMirror {
  upsertCompany(node: CompanyNode): Promise<void>;
  deleteCompany(id: string): Promise<void>;
}

/** The two ownership values the graph filters understand. */
function normalizeOwnership(raw: unknown): Ownership | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === 'public' || value === 'private') return value;
  return undefined;
}

/**
 * Map a Postgres companies row to the graph node shape. Shared by the
 * write-through mirror (`CompanyRepository`) and the full reconciliation
 * (`CompanyGraphService.syncFromDatabase`) so both produce identical nodes.
 * `target` is the display name; project-only rows fall back to `project_name`.
 */
export function companyRowToGraphNode(row: {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  geography: string | null;
  ownership: string | null;
  pipeline_stage?: string | null;
  status?: string | null;
}): CompanyNode {
  return {
    id: row.id,
    name: row.target ?? row.project_name ?? '(unnamed)',
    segment: row.segment ?? undefined,
    geography: row.geography ?? undefined,
    ownership: normalizeOwnership(row.ownership),
    pipelineStage: row.pipeline_stage ?? undefined,
    status: row.status ?? undefined,
  };
}

export interface CompanyRelation {
  sourceId: string;
  targetId: string;
  type: RelationType;
  notes?: string;
  /** Supporting evidence (URL or free text) for the relationship. */
  evidence?: string;
  /** ISO date (YYYY-MM-DD) the relationship was established or observed. */
  date?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  segment?: string;
  geography?: string;
  ownership?: Ownership;
  /** Deal pipeline stage (e.g. `L0`–`L5`, `market_screening`, `discovered`). */
  pipelineStage?: string;
  /** Lifecycle status: `active` or `dropped`. */
  status?: string;
  val: number;
}

export interface GraphLink {
  source: string;
  target: string;
  label: string;
  evidence?: string;
  date?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export class CompanyRelationRepository {
  constructor(private readonly driver: Driver) {}

  async upsertCompany(node: CompanyNode): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (c:Company {id: $id})
         SET c.name = $name, c.segment = $segment, c.industry = $industry,
             c.geography = $geography, c.ownership = $ownership,
             c.pipelineStage = $pipelineStage, c.status = $status`,
        {
          id: node.id,
          name: node.name,
          segment: node.segment ?? null,
          industry: node.industry ?? null,
          geography: node.geography ?? null,
          ownership: node.ownership ?? null,
          pipelineStage: node.pipelineStage ?? null,
          status: node.status ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Update the display properties of an *existing* Company node, keyed by id.
   * Uses MATCH (not MERGE) so we never create graph nodes for companies that
   * were never part of the relationship graph — this is the sync target for
   * Postgres company-detail edits. Only the provided props are written, so a
   * partial patch won't clobber untouched fields. Returns the number of nodes
   * updated (0 when the company isn't in the graph).
   */
  async updateCompanyProps(
    id: string,
    props: {
      name?: string;
      segment?: string | null;
      industry?: string | null;
      geography?: string | null;
      ownership?: string | null;
      pipelineStage?: string | null;
      status?: string | null;
    },
  ): Promise<number> {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const key of [
      'name',
      'segment',
      'industry',
      'geography',
      'ownership',
      'pipelineStage',
      'status',
    ] as const) {
      if (props[key] !== undefined) {
        setClauses.push(`c.${key} = $${key}`);
        params[key] = props[key];
      }
    }
    if (setClauses.length === 0) return 0;

    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (c:Company {id: $id})
         SET ${setClauses.join(', ')}
         RETURN c`,
        params,
      );
      return result.records.length;
    } finally {
      await session.close();
    }
  }

  /**
   * MERGE many company nodes in a single round-trip. Used by the full
   * database→graph reconciliation where every Postgres company is a node.
   */
  async upsertCompanies(nodes: CompanyNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $rows AS row
         MERGE (c:Company {id: row.id})
         SET c.name = row.name, c.segment = row.segment, c.industry = row.industry,
             c.geography = row.geography, c.ownership = row.ownership,
             c.pipelineStage = row.pipelineStage, c.status = row.status`,
        {
          rows: nodes.map((n) => ({
            id: n.id,
            name: n.name,
            segment: n.segment ?? null,
            industry: n.industry ?? null,
            geography: n.geography ?? null,
            ownership: n.ownership ?? null,
            pipelineStage: n.pipelineStage ?? null,
            status: n.status ?? null,
          })),
        },
      );
    } finally {
      await session.close();
    }
  }

  /** Remove a single Company node (and its relationships) by id. No-op when absent. */
  async deleteCompany(id: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (c:Company {id: $id}) DETACH DELETE c', { id });
    } finally {
      await session.close();
    }
  }

  /** Bulk-remove Company nodes by id. Used to prune nodes whose Postgres row is gone. */
  async deleteCompaniesByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $ids AS id MATCH (c:Company {id: id}) DETACH DELETE c`,
        { ids },
      );
    } finally {
      await session.close();
    }
  }

  /** Every Company node id currently in the graph — the reconciliation keep/prune set. */
  async getAllCompanyIds(): Promise<string[]> {
    const session = this.driver.session();
    try {
      const result = await session.run('MATCH (c:Company) RETURN c.id AS id');
      return result.records
        .map((r) => r.get('id') as string | null)
        .filter((id): id is string => Boolean(id));
    } finally {
      await session.close();
    }
  }

  async upsertRelation(relation: CompanyRelation): Promise<void> {
    const session = this.driver.session();
    try {
      // Relation type is a controlled enum — safe to interpolate.
      await session.run(
        `MATCH (a:Company {id: $sourceId}), (b:Company {id: $targetId})
         MERGE (a)-[r:${relation.type}]->(b)
         SET r.notes = $notes, r.evidence = $evidence, r.date = $date`,
        {
          sourceId: relation.sourceId,
          targetId: relation.targetId,
          notes: relation.notes ?? null,
          evidence: relation.evidence ?? null,
          date: relation.date ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }

  async getGraphData(): Promise<GraphData> {
    const session = this.driver.session();
    try {
      // OPTIONAL MATCH so companies with no outgoing relationships are still
      // returned (as isolated nodes). A company with only incoming edges shows
      // up as `b` on the row where it's the target, so every company appears.
      const result = await session.run(
        `MATCH (a:Company)
         OPTIONAL MATCH (a)-[r]->(b:Company)
         RETURN a, b, type(r) AS relType, r.evidence AS evidence, r.date AS date`,
      );

      const nodesMap = new Map<string, GraphNode>();
      const links: GraphLink[] = [];

      const toNode = (c: CompanyNode): GraphNode => ({
        id: c.id,
        name: c.name,
        segment: c.segment,
        geography: c.geography ?? undefined,
        ownership: c.ownership ?? undefined,
        pipelineStage: c.pipelineStage ?? undefined,
        status: c.status ?? undefined,
        val: 3,
      });

      for (const record of result.records) {
        const a = record.get('a').properties as CompanyNode;
        if (!nodesMap.has(a.id)) {
          nodesMap.set(a.id, toNode(a));
        }

        // No outgoing relationship for this row — `a` is (so far) isolated.
        const bRaw = record.get('b');
        const relType = record.get('relType') as string | null;
        if (!bRaw || !relType) continue;

        const b = bRaw.properties as CompanyNode;
        const evidence = (record.get('evidence') as string | null) ?? undefined;
        const date = (record.get('date') as string | null) ?? undefined;

        if (!nodesMap.has(b.id)) {
          nodesMap.set(b.id, toNode(b));
        }

        links.push({ source: a.id, target: b.id, label: relType, evidence, date });
      }

      return { nodes: Array.from(nodesMap.values()), links };
    } finally {
      await session.close();
    }
  }

  async clearAll(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
  }
}
