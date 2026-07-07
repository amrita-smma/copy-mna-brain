import { CompanyRepository, WorkspaceRepository } from '@/lib/repositories';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import type { DbClient } from '@/lib/repositories';
import { createNeo4jDriver } from '@/lib/neo4j';
import {
  CompanyGraphService,
  type GraphSyncResult,
} from '@/lib/services/companyGraphService';

/** Full reconciliation can touch every company across every workspace — give it generous headroom. */
export const GRAPH_SYNC_TIMEOUT_SECONDS = 480; // 8 minutes

/**
 * Reconcile the Neo4j relationship graph against Postgres (the source of
 * truth): MERGE a node for every company across every workspace, then DETACH
 * DELETE any node whose company row is gone from all of them. Relationships
 * between surviving nodes are preserved.
 *
 * The keep-set for pruning must be the union across every workspace, not one
 * at a time — syncFromDatabase() treats "not in the company list I was just
 * given" as stale, so reconciling workspace by workspace would delete every
 * other workspace's nodes on each pass.
 *
 * The graph itself still has no per-tenant partition (RFC Story 6, still
 * open — Company nodes carry no workspace_id): every workspace's companies
 * land in the same shared graph. This only guarantees the graph is complete
 * and doesn't self-destruct across workspaces; read-side tenant isolation is
 * handled by filtering in the /api/graph route, not here.
 */
export async function runGraphSync(deps: { db: DbClient }): Promise<GraphSyncResult> {
  const workspaceRepo = new WorkspaceRepository(deps.db);
  const workspaces = await workspaceRepo.findAll();

  const companiesByWorkspace = await Promise.all(
    workspaces.map((w) => new CompanyRepository(deps.db, w.id).findAll()),
  );
  const allCompanies = companiesByWorkspace.flat();

  const relationRepo = new CompanyRelationRepository(createNeo4jDriver());
  const service = new CompanyGraphService(relationRepo);

  return service.syncFromDatabase(allCompanies);
}
