import {
  companyRowToGraphNode,
  type CompanyRelationRepository,
  type ConnectedCompany,
  type GraphConnection,
  type GraphData,
  type RelationType,
} from '@/lib/repositories/companyRelationRepository';
import type { JobDispatcher } from './jobDispatcher';

/** Minimal company shape the reconciliation needs from Postgres. */
export interface GraphSyncCompany {
  id: string;
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  geography: string | null;
  ownership: string | null;
  pipeline_stage?: string | null;
  status?: string | null;
  // EV year fields (ev_2024, ev_2025, …) are picked up dynamically by
  // companyRowToGraphNode — callers pass the full Postgres row.
  [evKey: string]: unknown;
}

export interface GraphSyncResult {
  /** Company nodes upserted from Postgres (the full company count). */
  upserted: number;
  /** Graph nodes pruned because their Postgres row no longer exists. */
  deleted: number;
}

export class CompanyGraphService {
  constructor(
    private readonly repo: CompanyRelationRepository,
    // Only required for dispatchSync(); the read path and direct reconciliation
    // (invoked from the job handler) work without it.
    private readonly jobDispatcher?: JobDispatcher,
  ) {}

  async getGraphData(): Promise<GraphData> {
    return this.repo.getGraphData();
  }

  /** Direct neighbours of a company (both edge directions). See repo doc. */
  async getConnectedCompanies(id: string): Promise<ConnectedCompany[]> {
    return this.repo.getConnectedCompanies(id);
  }

  /** All edges whose endpoints both fall within `ids`. See repo doc. */
  async getConnectionsAmong(ids: string[]): Promise<GraphConnection[]> {
    return this.repo.getConnectionsAmong(ids);
  }

  async setNodeSizeOverride(id: string, override: number | null): Promise<void> {
    await this.repo.setNodeSizeOverride(id, override);
  }

  async reassignAndDeleteNode(deletedId: string, replacementId?: string): Promise<void> {
    await this.repo.reassignAndDeleteNode(deletedId, replacementId);
  }

  async deleteRelation(sourceId: string, targetId: string, type: RelationType): Promise<void> {
    await this.repo.deleteRelation(sourceId, targetId, type);
  }

  async updateRelation(params: {
    rawSourceId: string;
    rawTargetId: string;
    rawType: RelationType;
    newSourceId: string;
    newTargetId: string;
    newType: RelationType;
    notes?: string;
    evidence?: string;
    date?: string;
  }): Promise<void> {
    const changed =
      params.rawSourceId !== params.newSourceId ||
      params.rawTargetId !== params.newTargetId ||
      params.rawType !== params.newType;
    if (changed) {
      await this.repo.deleteRelation(params.rawSourceId, params.rawTargetId, params.rawType);
    }
    await this.repo.upsertRelation({
      sourceId: params.newSourceId,
      targetId: params.newTargetId,
      type: params.newType,
      notes: params.notes,
      evidence: params.evidence,
      date: params.date,
    });
  }

  /**
   * Create or update a directed relationship between two companies in the
   * graph. Both company nodes are upserted first (idempotent MERGE) so the
   * relation's MATCH always resolves — this matters for companies that predate
   * graph wiring or were never reconciled, and for freshly created
   * `discovered` companies whose node may not exist yet. Postgres remains the
   * source of truth; callers pass the resolved company rows.
   */
  async relateCompanies(params: {
    source: GraphSyncCompany;
    target: GraphSyncCompany;
    type: RelationType;
    notes?: string;
    evidence?: string;
    date?: string;
  }): Promise<void> {
    await this.repo.upsertCompanies([
      companyRowToGraphNode(params.source),
      companyRowToGraphNode(params.target),
    ]);
    await this.repo.upsertRelation({
      sourceId: params.source.id,
      targetId: params.target.id,
      type: params.type,
      notes: params.notes,
      evidence: params.evidence,
      date: params.date,
    });
  }

  /**
   * Queue a full database→graph reconciliation as a background job and return
   * immediately with the job id. Lifecycle/state is tracked in jobs + job_logs.
   * The handler is imported lazily to avoid a static import cycle (the handler
   * builds this service).
   */
  async dispatchSync(): Promise<{ jobId: string }> {
    if (!this.jobDispatcher) {
      throw new Error('CompanyGraphService.dispatchSync requires a JobDispatcher');
    }
    const { GRAPH_SYNC_TIMEOUT_SECONDS, runGraphSync } = await import(
      '@/lib/jobs/handlers/graphSync'
    );
    return this.jobDispatcher.dispatch({
      type: 'graph_sync',
      payload: {},
      timeoutSeconds: GRAPH_SYNC_TIMEOUT_SECONDS,
      work: ({ db }) => runGraphSync({ db }),
    });
  }

  /**
   * Make the graph mirror Postgres exactly: upsert a node for every company,
   * then prune any graph node whose company row no longer exists. Postgres is
   * the source of truth, so relationships hanging off pruned nodes go with them.
   */
  async syncFromDatabase(companies: GraphSyncCompany[]): Promise<GraphSyncResult> {
    const nodes = companies.map(companyRowToGraphNode);
    await this.repo.upsertCompanies(nodes);

    const keepIds = new Set(companies.map((c) => c.id));
    const graphIds = await this.repo.getAllCompanyIds();
    const staleIds = graphIds.filter((id) => !keepIds.has(id));
    await this.repo.deleteCompaniesByIds(staleIds);

    return { upserted: nodes.length, deleted: staleIds.length };
  }
}
