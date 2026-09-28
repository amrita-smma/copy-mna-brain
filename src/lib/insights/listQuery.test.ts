import { describe, it, expect } from 'vitest';
import {
  buildInsightListSearch,
  INSIGHT_LIST_DEFAULT_LIMIT,
  INSIGHT_LIST_MAX_LIMIT,
  parseInsightListQuery,
} from './listQuery';

const parse = (search: string) => parseInsightListQuery(new URLSearchParams(search));

describe('parseInsightListQuery', () => {
  it('defaults to the first 50 live insights with no filters', () => {
    expect(parse('')).toEqual({
      ok: true,
      query: { mine: false, archived: false, limit: INSIGHT_LIST_DEFAULT_LIMIT, offset: 0 },
    });
  });

  it('reads every param', () => {
    expect(parse('q=%20apac%20&agent=bangun&mine=1&archived=true&limit=20&offset=40')).toEqual({
      ok: true,
      query: { q: 'apac', agentKey: 'bangun', mine: true, archived: true, limit: 20, offset: 40 },
    });
  });

  it('maps agent=general to the general CoPilot (null)', () => {
    expect(parse('agent=general')).toMatchObject({ ok: true, query: { agentKey: null } });
  });

  it('leaves a blank search or agent out', () => {
    const result = parse('q=%20%20&agent=');
    expect(result).toMatchObject({ ok: true });
    if ('query' in result) {
      expect(result.query).not.toHaveProperty('q');
      expect(result.query).not.toHaveProperty('agentKey');
    }
  });

  it('treats any flag value other than 1 or true as off', () => {
    expect(parse('mine=0&archived=yes')).toMatchObject({
      ok: true,
      query: { mine: false, archived: false },
    });
  });

  it('clamps a limit above 100 to 100', () => {
    expect(parse('limit=500')).toMatchObject({ ok: true, query: { limit: INSIGHT_LIST_MAX_LIMIT } });
  });

  it.each(['0', '-1', 'abc', '1.5', ''])('refuses limit=%s', (limit) => {
    expect(parse(`limit=${limit}`)).toEqual({ ok: false, error: 'Invalid limit query parameter' });
  });

  it.each(['-1', 'abc', '2.5', '', '99999999999999999999'])('refuses offset=%s', (offset) => {
    expect(parse(`offset=${offset}`)).toEqual({ ok: false, error: 'Invalid offset query parameter' });
  });
});

describe('buildInsightListSearch', () => {
  it('is empty with nothing set', () => {
    expect(buildInsightListSearch()).toBe('');
    expect(buildInsightListSearch({ q: '  ', mine: false, archived: false, offset: 0 })).toBe('');
  });

  it('writes the set fields, round-tripping through the parser', () => {
    const search = buildInsightListSearch({
      q: ' 50% off ',
      agent: 'general',
      mine: true,
      archived: true,
      limit: 50,
      offset: 100,
    });
    expect(search).toBe('?q=50%25+off&agent=general&mine=1&archived=1&limit=50&offset=100');
    expect(parse(search.slice(1))).toEqual({
      ok: true,
      query: { q: '50% off', agentKey: null, mine: true, archived: true, limit: 50, offset: 100 },
    });
  });
});
