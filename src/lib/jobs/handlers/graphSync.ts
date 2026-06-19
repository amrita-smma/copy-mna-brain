import { CompanyRepository } from '@/lib/repositories';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import type { DbClient } from '@/lib/repositories';
import { createNeo4jDriver } from '@/lib/neo4j';
import {
  CompanyGraphService,
  type GraphSyncResult,
} from '@/lib/services/companyGraphService';

/** Full reconciliation can touch every company — give it generous headroom. */
export const GRAPH_SYNC_TIMEOUT_SECONDS = 480; // 8 minutes

/**
 * Reconcile the Neo4j relationship graph against Postgres (the source of
 * truth): MERGE a node for every company and DETACH DELETE any node whose
 * company row is gone. Relationships between surviving nodes are preserved.
 */
export async function runGraphSync(deps: { db: DbClient }): Promise<GraphSyncResult> {
  const companyRepo = new CompanyRepository(deps.db);
  const relationRepo = new CompanyRelationRepository(createNeo4jDriver());
  const service = new CompanyGraphService(relationRepo);

  const companies = await companyRepo.findAll();
  return service.syncFromDatabase(companies);
}
