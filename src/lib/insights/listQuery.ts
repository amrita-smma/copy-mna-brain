import type { InsightListQuery } from './types';

/** Rows per page of the insight list when no `limit` is given. */
export const INSIGHT_LIST_DEFAULT_LIMIT = 50;
/** The most rows one list request returns; a larger `limit` is clamped. */
export const INSIGHT_LIST_MAX_LIMIT = 100;
/** The `agent` value that means the general CoPilot (`agent_key IS NULL`). */
export const INSIGHT_LIST_GENERAL_AGENT = 'general';

/** The list query as the service takes it. */
export interface ParsedInsightListQuery {
  q?: string;
  /** A sector agent key, `null` for the general CoPilot, absent for any. */
  agentKey?: string | null;
  mine: boolean;
  archived: boolean;
  limit: number;
  offset: number;
}

export type ParseInsightListQueryResult =
  | { ok: true; query: ParsedInsightListQuery }
  | { ok: false; error: string };

const isFlagOn = (value: string | null) => value === '1' || value === 'true';

const NON_NEGATIVE_INT = /^\d+$/;

/**
 * Parses `GET /api/insights`'s query. `limit` defaults to 50 and is clamped to
 * 100; a `limit` below 1, or a `limit`/`offset` that is not a whole number, is
 * refused rather than guessed at. `mine` and `archived` are on for `1` or
 * `true`.
 */
export function parseInsightListQuery(params: URLSearchParams): ParseInsightListQueryResult {
  const limitParam = params.get('limit');
  let limit = INSIGHT_LIST_DEFAULT_LIMIT;
  if (limitParam !== null) {
    if (!NON_NEGATIVE_INT.test(limitParam) || Number(limitParam) < 1) {
      return { ok: false, error: 'Invalid limit query parameter' };
    }
    limit = Math.min(Number(limitParam), INSIGHT_LIST_MAX_LIMIT);
  }

  const offsetParam = params.get('offset');
  let offset = 0;
  if (offsetParam !== null) {
    if (!NON_NEGATIVE_INT.test(offsetParam) || !Number.isSafeInteger(Number(offsetParam))) {
      return { ok: false, error: 'Invalid offset query parameter' };
    }
    offset = Number(offsetParam);
  }

  const q = params.get('q')?.trim();
  const agent = params.get('agent')?.trim();

  return {
    ok: true,
    query: {
      ...(q ? { q } : {}),
      ...(agent ? { agentKey: agent === INSIGHT_LIST_GENERAL_AGENT ? null : agent } : {}),
      mine: isFlagOn(params.get('mine')),
      archived: isFlagOn(params.get('archived')),
      limit,
      offset,
    },
  };
}

/**
 * The query string for {@link InsightListQuery}, with a leading `?`, or `''`
 * when nothing is set. Empty and default-off fields are left out.
 */
export function buildInsightListSearch(query: InsightListQuery = {}): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.agent) params.set('agent', query.agent);
  if (query.mine) params.set('mine', '1');
  if (query.archived) params.set('archived', '1');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const search = params.toString();
  return search ? `?${search}` : '';
}
