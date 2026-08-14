import { describe, expect, it } from 'vitest';
import {
  ALL_RELATION_FILTERS,
  DEFAULT_GRAPH_FILTERS,
  NO_RELATION,
  NO_STAGE,
  decodeGraphFilters,
  encodeGraphFilters,
  type GraphFilterState,
} from './graphFilterParams';

const decode = (qs: string) => decodeGraphFilters(new URLSearchParams(qs));

function filters(overrides: Partial<GraphFilterState> = {}): GraphFilterState {
  return { ...DEFAULT_GRAPH_FILTERS, ...overrides };
}

describe('decodeGraphFilters', () => {
  it('returns the unfiltered defaults for an empty query string', () => {
    expect(decode('')).toEqual(DEFAULT_GRAPH_FILTERS);
  });

  it('reads every filter off the query string', () => {
    const state = decode(
      'q=Acme&highlight=c1&highlight=c2&connected=1&connectedTo=c9&ownership=public' +
        '&geography=Japan&geography=South+Korea&sector=Industrials&stage=L1&stage=__none__' +
        '&status=dropped&rel=PARTNER&rel=NONE&evidence=1&from=2024-01-01&to=2024-12-31',
    );
    expect(state).toEqual(
      filters({
        search: 'Acme',
        highlighted: ['c1', 'c2'],
        showConnectedCompanies: true,
        connectedTo: 'c9',
        ownership: ['public'],
        geography: ['Japan', 'South Korea'],
        sector: ['Industrials'],
        pipelineStage: ['L1', NO_STAGE],
        status: ['dropped'],
        relationTypes: ['PARTNER', NO_RELATION],
        hasEvidenceOnly: true,
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
      }),
    );
  });

  it('enables every relationship type when `rel` is absent', () => {
    expect(decode('sector=Industrials').relationTypes).toEqual(ALL_RELATION_FILTERS);
  });

  it('falls back to every relationship type when `rel` holds only unknown values', () => {
    expect(decode('rel=MYSTERY').relationTypes).toEqual(ALL_RELATION_FILTERS);
  });

  it('reads a blank `rel=` as every relationship type de-selected', () => {
    expect(decode('rel=').relationTypes).toEqual([]);
    expect(decode('rel=&rel=').relationTypes).toEqual([]);
  });

  it('drops values outside the known enums', () => {
    const state = decode('ownership=public&ownership=nationalised&status=active&status=zombie');
    expect(state.ownership).toEqual(['public']);
    expect(state.status).toEqual(['active']);
  });

  it('ignores malformed dates', () => {
    expect(decode('from=last-tuesday&to=2024-13').dateFrom).toBe('');
    expect(decode('from=last-tuesday&to=2024-13').dateTo).toBe('');
  });

  it('treats blank and repeated values as one, preserving order', () => {
    expect(decode('sector=A&sector=+&sector=B&sector=A').sector).toEqual(['A', 'B']);
  });

  it('accepts `true` as well as `1` for flags, and nothing else', () => {
    expect(decode('evidence=true&connected=1').hasEvidenceOnly).toBe(true);
    expect(decode('evidence=true&connected=1').showConnectedCompanies).toBe(true);
    expect(decode('evidence=yes&connected=0').hasEvidenceOnly).toBe(false);
    expect(decode('evidence=yes&connected=0').showConnectedCompanies).toBe(false);
  });

  it('trims the search term and treats a blank one as unset', () => {
    expect(decode('q=+Acme+Corp+').search).toBe('Acme Corp');
    expect(decode('q=+').search).toBe('');
    expect(decode('').search).toBe('');
  });

  it('reads the pre-existing `connectedTo` deep link, blank-safe', () => {
    expect(decode('connectedTo=abc-123').connectedTo).toBe('abc-123');
    expect(decode('connectedTo=').connectedTo).toBeNull();
  });
});

describe('encodeGraphFilters', () => {
  it('encodes the unfiltered defaults to an empty query string', () => {
    expect(encodeGraphFilters(DEFAULT_GRAPH_FILTERS)).toBe('');
  });

  it('omits the relationship filter while every type is enabled', () => {
    expect(encodeGraphFilters(filters({ relationTypes: [...ALL_RELATION_FILTERS] }))).toBe('');
    expect(encodeGraphFilters(filters({ relationTypes: ['PARTNER'] }))).toBe('rel=PARTNER');
  });

  it('writes a blank `rel=` when every type is de-selected', () => {
    // An omitted param would decode back to "all enabled" — the opposite state.
    expect(encodeGraphFilters(filters({ relationTypes: [] }))).toBe('rel=');
  });

  it('omits flags that are off and dates that are unset', () => {
    expect(
      encodeGraphFilters(filters({ showConnectedCompanies: false, hasEvidenceOnly: false })),
    ).toBe('');
    expect(encodeGraphFilters(filters({ dateFrom: '2024-01-01' }))).toBe('from=2024-01-01');
  });

  it('repeats multi-value params instead of joining them', () => {
    expect(encodeGraphFilters(filters({ sector: ['Food, Beverage', 'Industrials'] }))).toBe(
      'sector=Food%2C+Beverage&sector=Industrials',
    );
  });

  it('omits a blank search term and trims a set one', () => {
    expect(encodeGraphFilters(filters({ search: '   ' }))).toBe('');
    expect(encodeGraphFilters(filters({ search: ' Acme Corp ' }))).toBe('q=Acme+Corp');
  });

  it('emits params in a fixed order so the same filters share one URL', () => {
    const state = filters({
      search: 'Acme',
      highlighted: ['c1'],
      showConnectedCompanies: true,
      sector: ['X'],
    });
    expect(encodeGraphFilters(state)).toBe('q=Acme&highlight=c1&connected=1&sector=X');
    expect(encodeGraphFilters(state)).toBe(encodeGraphFilters({ ...state }));
  });
});

describe('encodeGraphFilters / decodeGraphFilters round trip', () => {
  it('survives a full filter state', () => {
    const state = filters({
      search: 'Acme Corp',
      highlighted: ['c1', 'c2'],
      showConnectedCompanies: true,
      connectedTo: 'c9',
      ownership: ['private'],
      geography: ['Japan'],
      sector: ['Food, Beverage & Tobacco'],
      pipelineStage: ['L3', NO_STAGE],
      status: ['active'],
      relationTypes: ['INVESTED_IN', NO_RELATION],
      hasEvidenceOnly: true,
      dateFrom: '2023-06-01',
      dateTo: '2024-06-01',
    });
    expect(decode(encodeGraphFilters(state))).toEqual(state);
  });

  it('survives the defaults', () => {
    expect(decode(encodeGraphFilters(DEFAULT_GRAPH_FILTERS))).toEqual(DEFAULT_GRAPH_FILTERS);
  });

  it('survives both relationship-filter extremes', () => {
    const none = filters({ relationTypes: [] });
    expect(decode(encodeGraphFilters(none))).toEqual(none);
    const all = filters({ relationTypes: [...ALL_RELATION_FILTERS] });
    expect(decode(encodeGraphFilters(all))).toEqual(all);
  });
});
