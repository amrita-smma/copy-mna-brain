import { describe, expect, it, vi } from 'vitest';

import {
  COMPANY_FILTER_DOC,
  applyStageDefault,
  companyFilterSchema,
  companyFilterShape,
  hasGraphFilter,
  mapCompanyFilters,
  mergeGraphFilter,
  resolveCompanyGraphFilter,
  summarizeCompanyFilters,
  type GraphDeps,
} from './companyFilters';

function makeDeps(overrides: Partial<GraphDeps> = {}): GraphDeps {
  return {
    resolveCompany: vi.fn().mockResolvedValue(null),
    getConnectedCompanies: vi.fn().mockResolvedValue([]),
    getGraphData: vi.fn().mockResolvedValue({ links: [] }),
    ...overrides,
  };
}

describe('companyFilterShape', () => {
  // The whole point of the shared shape is that the read tool and the export
  // tool cannot drift apart; a column missing here is a filter the agent can
  // query by but not export by.
  it('exposes a filter for every user-meaningful companies column', () => {
    const expected = [
      'company_ids',
      'entry_id',
      'watchlist_id',
      'name',
      'alias',
      'website',
      'segment',
      'segment_related_offerings',
      'company_focus',
      'geography',
      'ownership',
      'stage',
      'stage_in',
      'status',
      'watchlist_status',
      'workflow_status',
      'source',
      'deal_type',
      'stake',
      'deal_size',
      'doc_type',
      'is_live',
      'has_nbo_date',
      'nbo_after',
      'nbo_before',
      'deal_sponsor',
      'deal_captain',
      'entered_by',
      'originator',
      'banker',
      'banker_source',
      'advisor',
      'comments',
      'remarks',
      'key_rationale',
      'thesis_content',
      'context',
      'has_context',
      'promoted_reasons',
      'dropped_reason',
      'has_ai_opinion',
      'ai_opinion_verdict',
      'ai_opinion_status',
      'ai_opinion_summary',
      'min_revenue',
      'max_revenue',
      'min_ebitda',
      'max_ebitda',
      'created_after',
      'created_before',
      'updated_after',
      'updated_before',
      'last_activity_after',
      'last_activity_before',
      'dropped_after',
      'dropped_before',
      'dropped_by',
      'has_resurface_scheduled',
      'has_possible_duplicate',
      'matched_track_id',
      'connected_to',
      'relation_type',
      'has_relationships',
      'search_term',
    ];
    for (const key of expected) {
      expect(Object.keys(companyFilterShape)).toContain(key);
    }
  });

  it('documents every filter it accepts', () => {
    for (const key of Object.keys(companyFilterShape)) {
      expect(COMPANY_FILTER_DOC).toContain(key);
    }
  });

  it('accepts an empty object — every filter is optional', () => {
    expect(companyFilterSchema.parse({})).toEqual({});
  });
});

describe('mapCompanyFilters', () => {
  it('maps snake_case tool args onto the repository camelCase filters', () => {
    const mapped = mapCompanyFilters({
      company_ids: ['c1'],
      entry_id: 7,
      segment: 'Tech',
      is_live: true,
      workflow_status: 'NDA',
      ai_opinion_status: 'completed',
      last_activity_after: '2026-01-01',
      matched_track_id: 'track-1',
      search_term: 'acme',
    });

    expect(mapped).toMatchObject({
      ids: ['c1'],
      entryId: 7,
      segment: 'Tech',
      isLive: true,
      workflowStatus: 'NDA',
      aiOpinionStatus: 'completed',
      lastActivityAfter: '2026-01-01',
      matchedTrackId: 'track-1',
      searchTerm: 'acme',
    });
  });

  it('maps the Context-tab filters onto context / hasContext', () => {
    expect(
      mapCompanyFilters({ context: 'founder wants out', has_context: true }),
    ).toMatchObject({ context: 'founder wants out', hasContext: true });
    expect(mapCompanyFilters({ has_context: false })).toMatchObject({
      hasContext: false,
    });
  });

  it('maps every shape key to some repository field', () => {
    // Graph filters are resolved separately, so they are the only keys that may
    // vanish in the mapping.
    const graphOnly = new Set([
      'connected_to',
      'relation_type',
      'has_relationships',
      'include_pre_pipeline',
    ]);
    for (const key of Object.keys(companyFilterShape)) {
      if (graphOnly.has(key)) continue;
      const probe =
        key.startsWith('min_') || key.startsWith('max_') || key.endsWith('_id')
          ? 1
          : 'x';
      const value = key === 'company_ids' || key === 'stage_in' ? ['a'] : probe;
      const mapped = mapCompanyFilters({ [key]: value } as never);
      const set = Object.values(mapped).filter((v) => v !== undefined);
      expect(set, `${key} is not mapped to a repository filter`).toHaveLength(1);
    }
  });
});

describe('applyStageDefault', () => {
  it('defaults the cohort to every pipeline stage, added ones included, by excluding the pre-pipeline buckets', () => {
    const filters = applyStageDefault({}, {});
    expect(filters.stageIn).toBeUndefined();
    expect(filters.stageNotIn).toEqual(['market_screening', 'unreviewed', 'discovered']);
  });

  it('widens to every stage with include_pre_pipeline', () => {
    const filters = applyStageDefault({}, { include_pre_pipeline: true });
    expect(filters.stageIn).toBeUndefined();
    expect(filters.stageNotIn).toEqual([]);
  });

  it('leaves an explicit stage, stage_in, or id list alone', () => {
    expect(applyStageDefault({}, { stage: 'L2' }).stageIn).toBeUndefined();
    expect(applyStageDefault({}, { stage_in: ['L4'] }).stageIn).toBeUndefined();
    expect(applyStageDefault({}, { company_ids: ['c1'] }).stageIn).toBeUndefined();
    expect(applyStageDefault({}, { stage: 'L2' }).stageNotIn).toBeUndefined();
  });

  it('accepts a stage key the workspace added', () => {
    const schema = companyFilterSchema;
    expect(schema.parse({ stage: 'stg-3f9a1c2e' }).stage).toBe('stg-3f9a1c2e');
    expect(schema.parse({ stage_in: ['L3', 'stg-3f9a1c2e'] }).stage_in).toEqual([
      'L3',
      'stg-3f9a1c2e',
    ]);
  });
});

describe('summarizeCompanyFilters', () => {
  it('reports the no-filter case', () => {
    expect(summarizeCompanyFilters({})).toMatch(/All companies/i);
  });

  it('joins the set filters and collapses long lists', () => {
    expect(summarizeCompanyFilters({ stage: 'L1', geography: 'Japan' })).toBe(
      'geography=Japan, stage=L1',
    );
    expect(
      summarizeCompanyFilters({ company_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toBe('company_ids=6 values');
  });

  it('ignores keys that are not filters', () => {
    expect(summarizeCompanyFilters({ title: 'My Export' })).toMatch(/All companies/i);
  });
});

describe('hasGraphFilter', () => {
  it('is false when no graph filter is set', () => {
    expect(hasGraphFilter({})).toBe(false);
  });

  it('is true for each graph filter', () => {
    expect(hasGraphFilter({ connected_to: 'Acme' })).toBe(true);
    expect(hasGraphFilter({ relation_type: 'PARTNER' })).toBe(true);
    expect(hasGraphFilter({ has_relationships: false })).toBe(true);
  });
});

describe('resolveCompanyGraphFilter', () => {
  it('never constructs the graph services when no graph filter is set', async () => {
    const factory = vi.fn();

    const result = await resolveCompanyGraphFilter({}, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(result.ids).toBeUndefined();
    expect(result.notes).toEqual([]);
  });

  it('returns the direct neighbours of connected_to', async () => {
    const deps = makeDeps({
      resolveCompany: vi.fn().mockResolvedValue({ id: 'anchor', name: 'Acme' }),
      getConnectedCompanies: vi.fn().mockResolvedValue([
        { company: { id: 'n1', name: 'Beta' }, type: 'SELLS_TO', direction: 'outgoing' },
        { company: { id: 'n2', name: 'Gamma' }, type: 'PARTNER', direction: 'incoming' },
      ]),
    });

    const result = await resolveCompanyGraphFilter({ connected_to: 'Acme' }, () => deps);

    expect(result.ids).toEqual(['n1', 'n2']);
    expect(result.edgeSummaries.get('n1')).toEqual(['Acme --SELLS_TO--> Beta']);
    expect(result.edgeSummaries.get('n2')).toEqual(['Gamma --PARTNER--> Acme']);
  });

  it('narrows neighbours to a single relation type', async () => {
    const deps = makeDeps({
      resolveCompany: vi.fn().mockResolvedValue({ id: 'anchor', name: 'Acme' }),
      getConnectedCompanies: vi.fn().mockResolvedValue([
        { company: { id: 'n1', name: 'Beta' }, type: 'SELLS_TO', direction: 'outgoing' },
        { company: { id: 'n2', name: 'Gamma' }, type: 'PARTNER', direction: 'incoming' },
      ]),
    });

    const result = await resolveCompanyGraphFilter(
      { connected_to: 'Acme', relation_type: 'PARTNER' },
      () => deps,
    );

    expect(result.ids).toEqual(['n2']);
  });

  it('accepts a uuid for connected_to without a name lookup', async () => {
    const resolveCompany = vi.fn();
    const deps = makeDeps({
      resolveCompany,
      getConnectedCompanies: vi.fn().mockResolvedValue([]),
    });

    await resolveCompanyGraphFilter(
      { connected_to: '11111111-2222-3333-4444-555555555555' },
      () => deps,
    );

    expect(resolveCompany).not.toHaveBeenCalled();
    expect(deps.getConnectedCompanies).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it('reports an error when connected_to does not resolve', async () => {
    const result = await resolveCompanyGraphFilter({ connected_to: 'Ghost' }, () =>
      makeDeps(),
    );

    expect(result.error).toContain('Ghost');
    expect(result.ids).toBeUndefined();
  });

  it('collects every company with at least one edge for has_relationships=true', async () => {
    const deps = makeDeps({
      getGraphData: vi.fn().mockResolvedValue({
        links: [
          { source: 'a', target: 'b', label: 'PARTNER' },
          { source: 'b', target: 'c', label: 'SELLS_TO' },
        ],
      }),
    });

    const result = await resolveCompanyGraphFilter({ has_relationships: true }, () => deps);

    expect(result.ids?.sort()).toEqual(['a', 'b', 'c']);
    expect(result.excludeIds).toBeUndefined();
  });

  it('excludes connected companies for has_relationships=false', async () => {
    const deps = makeDeps({
      getGraphData: vi.fn().mockResolvedValue({
        links: [{ source: 'a', target: 'b', label: 'PARTNER' }],
      }),
    });

    const result = await resolveCompanyGraphFilter({ has_relationships: false }, () => deps);

    expect(result.excludeIds?.sort()).toEqual(['a', 'b']);
    expect(result.ids).toBeUndefined();
  });

  it('restricts a bare relation_type to that edge type', async () => {
    const deps = makeDeps({
      getGraphData: vi.fn().mockResolvedValue({
        links: [
          { source: 'a', target: 'b', label: 'PARTNER' },
          { source: 'c', target: 'd', label: 'SELLS_TO' },
        ],
      }),
    });

    const result = await resolveCompanyGraphFilter({ relation_type: 'SELLS_TO' }, () => deps);

    expect(result.ids?.sort()).toEqual(['c', 'd']);
  });

  // "connected to X" and "has no relationships" cannot both hold; say so
  // instead of quietly dropping one of the two constraints.
  it('matches nothing when has_relationships=false contradicts connected_to', async () => {
    const deps = makeDeps({
      resolveCompany: vi.fn().mockResolvedValue({ id: 'anchor', name: 'Acme' }),
      getConnectedCompanies: vi
        .fn()
        .mockResolvedValue([
          { company: { id: 'n1', name: 'Beta' }, type: 'PARTNER', direction: 'outgoing' },
        ]),
    });

    const result = await resolveCompanyGraphFilter(
      { connected_to: 'Acme', has_relationships: false },
      () => deps,
    );

    expect(result.ids).toEqual([]);
    expect(result.notes.join(' ')).toContain('conflicts');
  });
});

describe('mergeGraphFilter', () => {
  it('uses the graph ids when no explicit id list was given', () => {
    const merged = mergeGraphFilter(
      { segment: 'Tech' },
      { ids: ['a', 'b'], edgeSummaries: new Map(), notes: [] },
    );
    expect(merged).toEqual({ segment: 'Tech', ids: ['a', 'b'] });
  });

  it('intersects an explicit id list with the graph ids', () => {
    const merged = mergeGraphFilter(
      { ids: ['a', 'c'] },
      { ids: ['a', 'b'], edgeSummaries: new Map(), notes: [] },
    );
    expect(merged.ids).toEqual(['a']);
  });

  it('carries excludeIds through', () => {
    const merged = mergeGraphFilter(
      {},
      { excludeIds: ['z'], edgeSummaries: new Map(), notes: [] },
    );
    expect(merged.excludeIds).toEqual(['z']);
  });

  it('leaves the filters untouched when the graph result is empty', () => {
    const merged = mergeGraphFilter(
      { segment: 'Tech' },
      { edgeSummaries: new Map(), notes: [] },
    );
    expect(merged).toEqual({ segment: 'Tech' });
  });
});
