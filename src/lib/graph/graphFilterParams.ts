import type { Ownership, RelationType } from '@/lib/repositories/companyRelationRepository';
import { RELATION_TYPES } from './nodeStyle';

/**
 * URL query-param codec for the relationship graph's filter panel, so a filtered
 * view of the graph is shareable as a plain link.
 *
 * `views/CompanyGraph` seeds its filter state from `decodeGraphFilters(...)` on
 * mount and writes `encodeGraphFilters(...)` back into the URL bar whenever a
 * filter changes. Only non-default values are encoded, so an unfiltered graph
 * has a clean `/graph` URL. Multi-value filters use repeated params
 * (`?sector=A&sector=B`) rather than a delimiter, so values containing commas
 * (e.g. "Food, Beverage & Tobacco") survive a round trip.
 */

/** Sentinel filter value for companies that have no relationships at all. */
export const NO_RELATION = 'NONE' as const;
export type RelationFilter = RelationType | typeof NO_RELATION;

/**
 * Sentinel filter value for companies with no pipeline stage recorded on the
 * graph node (e.g. seed data synced before the field existed).
 */
export const NO_STAGE = '__none__' as const;

/** Every relationship filter value — the default (nothing de-selected). */
export const ALL_RELATION_FILTERS: RelationFilter[] = [...RELATION_TYPES, NO_RELATION];

const OWNERSHIP_VALUES: Ownership[] = ['public', 'private'];
const STATUS_VALUES = ['active', 'dropped'];

/** The shareable slice of the graph's filter panel. */
export interface GraphFilterState {
  /** Highlighted company ids — the graph is pinned to these plus their paths. */
  highlighted: string[];
  /** Whether the highlight view also includes the highlighted companies' direct neighbours. */
  showConnectedCompanies: boolean;
  /** Company pinned by "Display only connected companies", or null. */
  connectedTo: string | null;
  ownership: Ownership[];
  geography: string[];
  sector: string[];
  /** Pipeline stages, where `NO_STAGE` matches companies with no stage. */
  pipelineStage: string[];
  status: string[];
  /** Enabled relationship types, where `NO_RELATION` keeps unconnected companies. */
  relationTypes: RelationFilter[];
  hasEvidenceOnly: boolean;
  /** `YYYY-MM-DD`, or '' when unset. */
  dateFrom: string;
  dateTo: string;
}

/** The filter state of an unfiltered graph — what an empty query string means. */
export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  highlighted: [],
  showConnectedCompanies: false,
  connectedTo: null,
  ownership: [],
  geography: [],
  sector: [],
  pipelineStage: [],
  status: [],
  relationTypes: ALL_RELATION_FILTERS,
  hasEvidenceOnly: false,
  dateFrom: '',
  dateTo: '',
};

/**
 * Param names. `connectedTo` predates this codec — it's the deep link behind
 * "Show in relationship graph" on the company detail page — so its name is
 * fixed for backwards compatibility.
 */
export const GRAPH_FILTER_PARAMS = {
  highlighted: 'highlight',
  showConnectedCompanies: 'connected',
  connectedTo: 'connectedTo',
  ownership: 'ownership',
  geography: 'geography',
  sector: 'sector',
  pipelineStage: 'stage',
  status: 'status',
  relationTypes: 'rel',
  hasEvidenceOnly: 'evidence',
  dateFrom: 'from',
  dateTo: 'to',
} as const satisfies Record<keyof GraphFilterState, string>;

/** The read side of `URLSearchParams` (also satisfied by Next's `ReadonlyURLSearchParams`). */
export interface ReadableSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Non-empty, de-duplicated values for a repeated param, order preserved. */
function readList(params: ReadableSearchParams, name: string): string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll(name)) {
    const value = raw.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** As `readList`, but dropping values outside the known set. */
function readEnumList<T extends string>(
  params: ReadableSearchParams,
  name: string,
  allowed: readonly T[],
): T[] {
  return readList(params, name).filter((v): v is T => (allowed as readonly string[]).includes(v));
}

function readFlag(params: ReadableSearchParams, name: string): boolean {
  const raw = params.get(name);
  return raw === '1' || raw === 'true';
}

function readDate(params: ReadableSearchParams, name: string): string {
  const raw = params.get(name)?.trim() ?? '';
  return ISO_DATE.test(raw) ? raw : '';
}

/**
 * Read a filter state out of a query string. Unknown, malformed or empty values
 * fall back to their default, so a hand-edited link can never wedge the graph
 * into an unusable state.
 */
export function decodeGraphFilters(params: ReadableSearchParams): GraphFilterState {
  const P = GRAPH_FILTER_PARAMS;
  // An absent `rel` means "nothing de-selected" — every type is enabled. A
  // present-but-blank `rel=` is how the encoder writes the opposite extreme,
  // every type unticked, which is otherwise indistinguishable from absent.
  // Present-but-unrecognised values (a hand-mangled link) fall back to all
  // enabled rather than blanking the graph.
  const rawRelations = params.getAll(P.relationTypes);
  const relationTypes = readEnumList<RelationFilter>(params, P.relationTypes, ALL_RELATION_FILTERS);
  const noRelationsSelected =
    rawRelations.length > 0 && rawRelations.every((v) => v.trim() === '');
  const connectedTo = params.get(P.connectedTo)?.trim();

  return {
    highlighted: readList(params, P.highlighted),
    showConnectedCompanies: readFlag(params, P.showConnectedCompanies),
    connectedTo: connectedTo ? connectedTo : null,
    ownership: readEnumList<Ownership>(params, P.ownership, OWNERSHIP_VALUES),
    geography: readList(params, P.geography),
    sector: readList(params, P.sector),
    pipelineStage: readList(params, P.pipelineStage),
    status: readEnumList(params, P.status, STATUS_VALUES),
    relationTypes: noRelationsSelected
      ? []
      : relationTypes.length > 0
        ? relationTypes
        : ALL_RELATION_FILTERS,
    hasEvidenceOnly: readFlag(params, P.hasEvidenceOnly),
    dateFrom: readDate(params, P.dateFrom),
    dateTo: readDate(params, P.dateTo),
  };
}

/** True when every relationship filter is enabled (i.e. the filter is inactive). */
function allRelationsEnabled(relationTypes: readonly string[]): boolean {
  const set = new Set(relationTypes);
  return (
    set.size === ALL_RELATION_FILTERS.length && ALL_RELATION_FILTERS.every((t) => set.has(t))
  );
}

/**
 * Serialise a filter state to a query string (no leading `?`), omitting every
 * default so an unfiltered graph encodes to ''. Param order is fixed, so the
 * same filters always produce the same URL.
 */
export function encodeGraphFilters(state: GraphFilterState): string {
  const P = GRAPH_FILTER_PARAMS;
  const params = new URLSearchParams();
  const appendAll = (name: string, values: readonly string[]) => {
    for (const value of values) params.append(name, value);
  };

  appendAll(P.highlighted, state.highlighted);
  if (state.showConnectedCompanies) params.set(P.showConnectedCompanies, '1');
  if (state.connectedTo) params.set(P.connectedTo, state.connectedTo);
  appendAll(P.ownership, state.ownership);
  appendAll(P.geography, state.geography);
  appendAll(P.sector, state.sector);
  appendAll(P.pipelineStage, state.pipelineStage);
  appendAll(P.status, state.status);
  // Only worth encoding when at least one type is de-selected. With *every* type
  // de-selected there's nothing to list, so a blank `rel=` carries that state —
  // an omitted param would decode back to all types enabled.
  if (state.relationTypes.length === 0) params.set(P.relationTypes, '');
  else if (!allRelationsEnabled(state.relationTypes)) {
    appendAll(P.relationTypes, state.relationTypes);
  }
  if (state.hasEvidenceOnly) params.set(P.hasEvidenceOnly, '1');
  if (state.dateFrom) params.set(P.dateFrom, state.dateFrom);
  if (state.dateTo) params.set(P.dateTo, state.dateTo);

  return params.toString();
}
