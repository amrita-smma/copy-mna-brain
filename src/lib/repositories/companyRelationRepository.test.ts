import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CompanyRelationRepository,
  companyRowToGraphNode,
  type CompanyNode,
  type CompanyRelation,
} from './companyRelationRepository';

/** Builds a neo4j record-like object whose `.get(key)` reads from `values`. */
function makeRecord(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

/** Builds a fake neo4j Driver whose session().run() returns the given records. */
function makeDriver(records: ReturnType<typeof makeRecord>[] = []) {
  const run = vi.fn().mockResolvedValue({ records });
  const close = vi.fn().mockResolvedValue(undefined);
  const session = vi.fn().mockReturnValue({ run, close });
  return { driver: { session } as never, run, close, session };
}

describe('CompanyRelationRepository.getGraphData', () => {
  it('maps node geography/ownership/pipelineStage/status and relation evidence/date', async () => {
    const a = { id: 'c1', name: 'TechCorp', segment: 'technology', geography: 'Indonesia', ownership: 'public', pipelineStage: 'L2', status: 'active' };
    const b = { id: 'c2', name: 'LogistiKa', segment: 'logistics', geography: 'Singapore', ownership: 'private', pipelineStage: 'discovered', status: 'dropped' };
    const { driver, run, close } = makeDriver([
      makeRecord({
        a: { properties: a },
        b: { properties: b },
        relType: 'INVESTED_IN',
        evidence: 'https://example.com/evidence',
        date: '2024-01-20',
      }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const data = await repo.getGraphData();

    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(data.nodes).toEqual([
      { id: 'c1', name: 'TechCorp', segment: 'technology', geography: 'Indonesia', ownership: 'public', pipelineStage: 'L2', status: 'active', ev: null, graphSizeOverride: null, val: 3 },
      { id: 'c2', name: 'LogistiKa', segment: 'logistics', geography: 'Singapore', ownership: 'private', pipelineStage: 'discovered', status: 'dropped', ev: null, graphSizeOverride: null, val: 3 },
    ]);
    expect(data.links).toEqual([
      {
        source: 'c1',
        target: 'c2',
        label: 'INVESTED_IN',
        evidence: 'https://example.com/evidence',
        date: '2024-01-20',
      },
    ]);
  });

  it('coerces missing relation evidence/date and node geography/ownership to undefined', async () => {
    const a = { id: 'c1', name: 'TechCorp' };
    const b = { id: 'c2', name: 'LogistiKa' };
    const { driver } = makeDriver([
      makeRecord({
        a: { properties: a },
        b: { properties: b },
        relType: 'PARTNER',
        evidence: null,
        date: null,
      }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const data = await repo.getGraphData();

    expect(data.nodes[0]).toEqual({
      id: 'c1',
      name: 'TechCorp',
      segment: undefined,
      geography: undefined,
      ownership: undefined,
      ev: null,
      graphSizeOverride: null,
      val: 3,
    });
    expect(data.links[0]).toEqual({
      source: 'c1',
      target: 'c2',
      label: 'PARTNER',
      evidence: undefined,
      date: undefined,
    });
  });

  it('dedupes a company that appears in multiple relations', async () => {
    const a = { id: 'c1', name: 'TechCorp' };
    const b = { id: 'c2', name: 'LogistiKa' };
    const c = { id: 'c3', name: 'AutoMate' };
    const { driver } = makeDriver([
      makeRecord({ a: { properties: a }, b: { properties: b }, relType: 'INVESTED_IN', evidence: null, date: null }),
      makeRecord({ a: { properties: a }, b: { properties: c }, relType: 'SUPPLIER', evidence: null, date: null }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const data = await repo.getGraphData();

    expect(data.nodes.map((n) => n.id)).toEqual(['c1', 'c2', 'c3']);
    expect(data.links).toHaveLength(2);
  });

  it('returns companies with no relationships as isolated nodes', async () => {
    // OPTIONAL MATCH yields a null `b`/`relType` for a company with no edges.
    const lonely = { id: 'c9', name: 'Solo Inc', segment: 'finance' };
    const { driver } = makeDriver([
      makeRecord({ a: { properties: lonely }, b: null, relType: null, evidence: null, date: null }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const data = await repo.getGraphData();

    expect(data.nodes).toEqual([
      { id: 'c9', name: 'Solo Inc', segment: 'finance', geography: undefined, ownership: undefined, ev: null, graphSizeOverride: null, val: 3 },
    ]);
    expect(data.links).toEqual([]);
  });
});

describe('CompanyRelationRepository.updateCompanyProps', () => {
  it('updates only the provided props on an existing node via MATCH', async () => {
    const { driver, run } = makeDriver([makeRecord({ c: { properties: { id: 'c1' } } })]);
    const repo = new CompanyRelationRepository(driver);

    const updated = await repo.updateCompanyProps('c1', {
      name: 'Renamed Corp',
      geography: 'Vietnam',
      ownership: 'private',
    });

    expect(updated).toBe(1);
    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('MATCH (c:Company {id: $id})');
    expect(cypher).not.toContain('MERGE');
    expect(cypher).toContain('c.name = $name');
    expect(cypher).toContain('c.geography = $geography');
    expect(cypher).toContain('c.ownership = $ownership');
    // Untouched fields are not written.
    expect(cypher).not.toContain('c.segment = $segment');
    expect(params).toMatchObject({ id: 'c1', name: 'Renamed Corp', geography: 'Vietnam', ownership: 'private' });
  });

  it('writes pipelineStage and status when provided', async () => {
    const { driver, run } = makeDriver([makeRecord({ c: { properties: { id: 'c1' } } })]);
    const repo = new CompanyRelationRepository(driver);

    const updated = await repo.updateCompanyProps('c1', {
      pipelineStage: 'L4',
      status: 'dropped',
    });

    expect(updated).toBe(1);
    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('c.pipelineStage = $pipelineStage');
    expect(cypher).toContain('c.status = $status');
    expect(params).toMatchObject({ id: 'c1', pipelineStage: 'L4', status: 'dropped' });
  });

  it('is a no-op (no query) when no props are supplied', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    const updated = await repo.updateCompanyProps('c1', {});

    expect(updated).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports 0 when the company is not in the graph', async () => {
    const { driver } = makeDriver([]);
    const repo = new CompanyRelationRepository(driver);

    const updated = await repo.updateCompanyProps('missing', { name: 'Nope' });

    expect(updated).toBe(0);
  });
});

describe('CompanyRelationRepository.upsertRelation', () => {
  let repo: CompanyRelationRepository;
  let run: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const built = makeDriver();
    run = built.run;
    repo = new CompanyRelationRepository(built.driver);
  });

  it('persists evidence and date alongside notes', async () => {
    const relation: CompanyRelation = {
      sourceId: 'c1',
      targetId: 'c2',
      type: 'SUPPLIER',
      notes: 'Exclusive supply agreement',
      evidence: 'Signed MSA',
      date: '2023-07-01',
    };

    await repo.upsertRelation(relation);

    expect(run).toHaveBeenCalledTimes(1);
    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain(':SUPPLIER');
    expect(cypher).toContain('r.evidence = $evidence');
    expect(cypher).toContain('r.date = $date');
    expect(params).toMatchObject({
      sourceId: 'c1',
      targetId: 'c2',
      notes: 'Exclusive supply agreement',
      evidence: 'Signed MSA',
      date: '2023-07-01',
    });
  });

  it('defaults missing evidence/date to null', async () => {
    const relation: CompanyRelation = { sourceId: 'c1', targetId: 'c2', type: 'PARTNER' };

    await repo.upsertRelation(relation);

    const [, params] = run.mock.calls[0];
    expect(params.notes).toBeNull();
    expect(params.evidence).toBeNull();
    expect(params.date).toBeNull();
  });
});

describe('CompanyRelationRepository.upsertCompany', () => {
  it('persists geography and ownership', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);
    const node: CompanyNode = {
      id: 'c1',
      name: 'TechCorp',
      segment: 'technology',
      geography: 'Indonesia',
      ownership: 'public',
      pipelineStage: 'L3',
      status: 'active',
    };

    await repo.upsertCompany(node);

    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('c.geography = $geography');
    expect(cypher).toContain('c.ownership = $ownership');
    expect(cypher).toContain('c.pipelineStage = $pipelineStage');
    expect(cypher).toContain('c.status = $status');
    expect(params).toMatchObject({
      geography: 'Indonesia',
      ownership: 'public',
      pipelineStage: 'L3',
      status: 'active',
    });
  });

  it('defaults missing pipelineStage and status to null', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.upsertCompany({ id: 'c1', name: 'TechCorp' });

    const [, params] = run.mock.calls[0];
    expect(params.pipelineStage).toBeNull();
    expect(params.status).toBeNull();
  });
});

describe('CompanyRelationRepository.upsertCompanies', () => {
  it('MERGEs every node in a single UNWIND query', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.upsertCompanies([
      { id: 'c1', name: 'TechCorp', segment: 'tech' },
      { id: 'c2', name: 'LogistiKa', geography: 'Singapore' },
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('UNWIND $rows AS row');
    expect(cypher).toContain('MERGE (c:Company {id: row.id})');
    expect(cypher).toContain('c.pipelineStage = row.pipelineStage');
    expect(cypher).toContain('c.status = row.status');
    expect(params.rows).toEqual([
      { id: 'c1', name: 'TechCorp', segment: 'tech', industry: null, geography: null, ownership: null, pipelineStage: null, status: null, ev: null },
      { id: 'c2', name: 'LogistiKa', segment: null, industry: null, geography: 'Singapore', ownership: null, pipelineStage: null, status: null, ev: null },
    ]);
  });

  it('persists pipelineStage and status when present on the node', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.upsertCompanies([
      { id: 'c1', name: 'TechCorp', pipelineStage: 'L2', status: 'active' },
    ]);

    const [, params] = run.mock.calls[0];
    expect(params.rows[0]).toMatchObject({ pipelineStage: 'L2', status: 'active' });
  });

  it('is a no-op (no query, no session) for an empty list', async () => {
    const { driver, run, session } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.upsertCompanies([]);

    expect(run).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
});

describe('CompanyRelationRepository.deleteCompany', () => {
  it('DETACH DELETEs the node by id', async () => {
    const { driver, run, close } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.deleteCompany('c1');

    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('MATCH (c:Company {id: $id})');
    expect(cypher).toContain('DETACH DELETE c');
    expect(params).toEqual({ id: 'c1' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('CompanyRelationRepository.deleteCompaniesByIds', () => {
  it('bulk-deletes via UNWIND', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.deleteCompaniesByIds(['c1', 'c2']);

    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('UNWIND $ids AS id');
    expect(cypher).toContain('DETACH DELETE c');
    expect(params).toEqual({ ids: ['c1', 'c2'] });
  });

  it('is a no-op for an empty list', async () => {
    const { driver, run } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    await repo.deleteCompaniesByIds([]);

    expect(run).not.toHaveBeenCalled();
  });
});

describe('CompanyRelationRepository.getAllCompanyIds', () => {
  it('returns the id of every Company node, dropping nullish ids', async () => {
    const { driver } = makeDriver([
      makeRecord({ id: 'c1' }),
      makeRecord({ id: null }),
      makeRecord({ id: 'c2' }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    expect(await repo.getAllCompanyIds()).toEqual(['c1', 'c2']);
  });
});

describe('CompanyRelationRepository.getConnectedCompanies', () => {
  it('maps each edge to a neighbour with direction relative to the queried node', async () => {
    const beta = { id: 'c2', name: 'Beta' };
    const gamma = { id: 'c3', name: 'Gamma' };
    const { driver, run } = makeDriver([
      // Queried node c1 is the start → outgoing.
      makeRecord({ company: { properties: beta }, relType: 'SELLS_TO', startId: 'c1', notes: null, evidence: null, date: null }),
      // Queried node c1 is the target → incoming.
      makeRecord({ company: { properties: gamma }, relType: 'INVESTED_IN', startId: 'c3', notes: 'led round', evidence: 'url', date: '2024-01-01' }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const result = await repo.getConnectedCompanies('c1');

    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('MATCH (a:Company {id: $id})-[r]-(b:Company)');
    expect(params).toEqual({ id: 'c1' });
    expect(result).toEqual([
      { company: beta, type: 'SELLS_TO', direction: 'outgoing', notes: undefined, evidence: undefined, date: undefined },
      { company: gamma, type: 'INVESTED_IN', direction: 'incoming', notes: 'led round', evidence: 'url', date: '2024-01-01' },
    ]);
  });

  it('returns [] when the company has no edges', async () => {
    const { driver } = makeDriver([]);
    const repo = new CompanyRelationRepository(driver);
    expect(await repo.getConnectedCompanies('c1')).toEqual([]);
  });
});

describe('CompanyRelationRepository.getConnectionsAmong', () => {
  it('returns every directed edge whose endpoints are both in the id set', async () => {
    const { driver, run } = makeDriver([
      makeRecord({ sourceId: 'c1', targetId: 'c2', relType: 'SELLS_TO', notes: null, evidence: null, date: null }),
      makeRecord({ sourceId: 'c3', targetId: 'c1', relType: 'PARTNER', notes: 'jv', evidence: null, date: null }),
    ]);
    const repo = new CompanyRelationRepository(driver);

    const result = await repo.getConnectionsAmong(['c1', 'c2', 'c3']);

    const [cypher, params] = run.mock.calls[0];
    expect(cypher).toContain('a.id IN $ids AND b.id IN $ids');
    expect(params).toEqual({ ids: ['c1', 'c2', 'c3'] });
    expect(result).toEqual([
      { sourceId: 'c1', targetId: 'c2', type: 'SELLS_TO', notes: undefined, evidence: undefined, date: undefined },
      { sourceId: 'c3', targetId: 'c1', type: 'PARTNER', notes: 'jv', evidence: undefined, date: undefined },
    ]);
  });

  it('is a no-op returning [] for fewer than two ids', async () => {
    const { driver, run, session } = makeDriver();
    const repo = new CompanyRelationRepository(driver);

    expect(await repo.getConnectionsAmong(['c1'])).toEqual([]);
    expect(await repo.getConnectionsAmong([])).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
});

describe('companyRowToGraphNode', () => {
  it('maps target to name and normalizes ownership casing', () => {
    expect(
      companyRowToGraphNode({
        id: 'c1',
        target: 'Acme Corp',
        segment: 'technology',
        geography: 'Indonesia',
        ownership: 'Public',
        pipeline_stage: 'L1',
        status: 'active',
      }),
    ).toEqual({
      id: 'c1',
      name: 'Acme Corp',
      segment: 'technology',
      geography: 'Indonesia',
      ownership: 'public',
      pipelineStage: 'L1',
      status: 'active',
    });
  });

  it('coerces missing pipeline_stage/status to undefined', () => {
    const node = companyRowToGraphNode({
      id: 'c4',
      target: 'NoStage Inc',
      segment: null,
      geography: null,
      ownership: null,
    });
    expect(node.pipelineStage).toBeUndefined();
    expect(node.status).toBeUndefined();
  });

  it('falls back to project_name, then "(unnamed)", and drops unknown ownership', () => {
    expect(
      companyRowToGraphNode({
        id: 'c2',
        target: null,
        project_name: 'Project Phoenix',
        segment: null,
        geography: null,
        ownership: 'state-owned',
      }),
    ).toEqual({
      id: 'c2',
      name: 'Project Phoenix',
      segment: undefined,
      geography: undefined,
      ownership: undefined,
    });

    expect(
      companyRowToGraphNode({
        id: 'c3',
        target: null,
        project_name: null,
        segment: null,
        geography: null,
        ownership: null,
      }).name,
    ).toBe('(unnamed)');
  });
});
