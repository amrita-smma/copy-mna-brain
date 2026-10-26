import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CompanyRepository, stripCompanySuffix } from './companyRepository';
import type { Tables } from './types';
import type { CompanyGraphMirror } from './companyRelationRepository';

/** Build a db whose `select().from().where().limit()` resolves to `rows`. */
function makeFuzzyDb(rows: Array<Partial<Tables<'companies'>>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where, orderBy, limit };
}

/** Build a db whose `select(...).from(...).where(...)` resolves to the given rows. */
function makeDb(rows: Array<{ banker: string | null }>) {
  const whereMock = vi.fn().mockResolvedValue(rows);
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  return { db: { select: selectMock } as never, selectMock, fromMock, whereMock };
}

/**
 * Build a db whose insert/update chains resolve to `rows` via `.returning()`
 * and whose delete chain resolves. Mirrors the chains CompanyRepository uses.
 */
function makeWriteDb(rows: Array<Partial<Tables<'companies'>>>) {
  const returning = vi.fn().mockResolvedValue(rows);
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({ returning }),
  });
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
  });
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockReturnValue({ where: deleteWhere });
  return { db: { insert, update, delete: del } as never };
}

function makeMirror(): CompanyGraphMirror & {
  upsertCompany: ReturnType<typeof vi.fn>;
  deleteCompany: ReturnType<typeof vi.fn>;
} {
  return {
    upsertCompany: vi.fn().mockResolvedValue(undefined),
    deleteCompany: vi.fn().mockResolvedValue(undefined),
  };
}

function row(overrides: Partial<Tables<'companies'>> = {}): Partial<Tables<'companies'>> {
  return {
    id: 'c1',
    target: 'Acme Corp',
    project_name: null,
    segment: 'technology',
    geography: 'Indonesia',
    ownership: 'Public',
    ...overrides,
  };
}

/** Build a db whose `select(...).from(...).where(...)` resolves to `rows`. */
function makeWhereDb(rows: Array<{ id: string; ai_opinion_status: string | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where };
}

describe('CompanyRepository.findProcessingAiOpinions', () => {
  it('returns id + ai_opinion_status for companies filtered to the processing state', async () => {
    const rows = [{ id: 'c1', ai_opinion_status: 'processing' }];
    const { db, select, where } = makeWhereDb(rows);
    const repo = new CompanyRepository(db, 'workspace-1', makeMirror());

    const result = await repo.findProcessingAiOpinions();

    expect(result).toEqual(rows);
    expect(select).toHaveBeenCalledWith({
      id: expect.anything(),
      ai_opinion_status: expect.anything(),
    });
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe('CompanyRepository graph mirror', () => {
  it('upserts the inserted company onto the graph with mapped fields', async () => {
    const { db } = makeWriteDb([row()]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.insert(row() as never);

    expect(mirror.upsertCompany).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Acme Corp',
      segment: 'technology',
      geography: 'Indonesia',
      ownership: 'public', // normalized to lowercase
    });
  });

  it('falls back to project_name then "(unnamed)" for the node name', async () => {
    const { db } = makeWriteDb([
      row({ id: 'c2', target: null, project_name: 'Project Phoenix' }),
    ]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.insert(row() as never);

    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c2', name: 'Project Phoenix' }),
    );
  });

  it('drops unknown ownership values to undefined', async () => {
    const { db } = makeWriteDb([row({ ownership: 'state-owned' })]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.insert(row() as never);

    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ ownership: undefined }),
    );
  });

  it('mirrors every returned row on update', async () => {
    const { db } = makeWriteDb([row()]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.update('c1', { geography: 'Singapore' });

    expect(mirror.upsertCompany).toHaveBeenCalledTimes(1);
    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }),
    );
  });

  it('mirrors each returned row on updateMany', async () => {
    const { db } = makeWriteDb([row({ id: 'c1' }), row({ id: 'c2' })]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.updateMany(['c1', 'c2'], { pipeline_stage: 'L1' as never });

    expect(mirror.upsertCompany).toHaveBeenCalledTimes(2);
  });

  it('removes the node from the graph on delete', async () => {
    const { db } = makeWriteDb([]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.delete('c1');

    expect(mirror.deleteCompany).toHaveBeenCalledWith('c1');
  });

  it('does not touch the graph when no mirror is wired', async () => {
    const { db } = makeWriteDb([row()]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await expect(repo.insert(row() as never)).resolves.toBeDefined();
    await expect(repo.delete('c1')).resolves.toBeUndefined();
  });

  it('swallows mirror failures so the Postgres write still succeeds', async () => {
    const { db } = makeWriteDb([row()]);
    const mirror = makeMirror();
    mirror.upsertCompany.mockRejectedValue(new Error('neo4j down'));
    const repo = new CompanyRepository(db, 'workspace-1', mirror);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await repo.insert(row() as never);

    expect(result).toMatchObject({ id: 'c1' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('markAiOpinionFailedIfProcessing mirrors the returned row when one is updated', async () => {
    const { db } = makeWriteDb([row({ ai_opinion_status: 'failed' } as never)]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.markAiOpinionFailedIfProcessing('c1');

    expect(mirror.upsertCompany).toHaveBeenCalledTimes(1);
  });

  it('skips the empty-list insertMany without mirroring', async () => {
    const { db } = makeWriteDb([]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, 'workspace-1', mirror);

    await repo.insertMany([]);

    expect(mirror.upsertCompany).not.toHaveBeenCalled();
  });
});

describe('CompanyRepository.findBankerNames', () => {
  it('returns [] when no companies have a banker', async () => {
    const { db } = makeDb([{ banker: null }, { banker: '   ' }]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findBankerNames()).toEqual([]);
  });

  it('trims, drops blanks, dedupes case-insensitively, and sorts', async () => {
    const { db } = makeDb([
      { banker: 'Goldman Sachs' },
      { banker: '  ' },
      { banker: null },
      { banker: 'goldman sachs' }, // dup of first — keeps first-seen casing
      { banker: 'JP Morgan' },
      { banker: ' UBS ' }, // trimmed to "UBS"
    ]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findBankerNames()).toEqual([
      'Goldman Sachs',
      'JP Morgan',
      'UBS',
    ]);
  });
});

describe('stripCompanySuffix', () => {
  it('strips common trailing legal suffixes regardless of trailing period', () => {
    expect(stripCompanySuffix('Acme Ltd.')).toBe('Acme');
    expect(stripCompanySuffix('Acme Ltd')).toBe('Acme');
    expect(stripCompanySuffix('Acme Co.')).toBe('Acme');
    expect(stripCompanySuffix('Acme Inc')).toBe('Acme');
    expect(stripCompanySuffix('Acme Corporation')).toBe('Acme');
    expect(stripCompanySuffix('Acme LLC')).toBe('Acme');
  });

  it('collapses different endings of the same name to the same base', () => {
    expect(stripCompanySuffix('Acme Ltd.')).toBe(stripCompanySuffix('Acme Co.'));
  });

  it('peels multi-word and stacked endings', () => {
    expect(stripCompanySuffix('Widget Sdn Bhd')).toBe('Widget');
    expect(stripCompanySuffix('Widget Holdings Ltd.')).toBe('Widget');
  });

  it('drops a leading Indonesian PT marker and trailing Tbk', () => {
    expect(stripCompanySuffix('PT Bank Mandiri Tbk')).toBe('Bank Mandiri');
    expect(stripCompanySuffix('PT. Astra')).toBe('Astra');
  });

  it('does not strip suffix letters embedded inside a word', () => {
    expect(stripCompanySuffix('Cisco')).toBe('Cisco');
    expect(stripCompanySuffix('Incognito')).toBe('Incognito');
  });

  it('leaves a name with no recognized suffix unchanged', () => {
    expect(stripCompanySuffix('Northwind Traders')).toBe('Northwind Traders');
  });
});

/** Render a Drizzle SQL condition to its parameterized SQL string + params. */
function renderSql(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

/** Build a db for `select().from().where().limit()`, capturing the where arg. */
function makeAgentSearchDb(rows: Array<Partial<Tables<'companies'>>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, where };
}

/** Build a db for `select().from().where().orderBy()`, capturing the where arg. */
function makeListDb(rows: Array<Partial<Tables<'companies'>>>) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, where };
}

describe('CompanyRepository.searchForAgent', () => {
  it('matches searchTerm against target, project_name, segment, geography, and context', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ searchTerm: '中文股份' });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"target" ilike');
    expect(rendered).toContain('"project_name" ilike');
    expect(rendered).toContain('"segment" ilike');
    expect(rendered).toContain('"geography" ilike');
    expect(rendered).toContain('"context" ilike');
    expect(params.filter((p) => p === '%中文股份%')).toHaveLength(5);
  });

  it('partial-matches the context filter against the context column', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ context: 'founder wants out' });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"context" ilike');
    expect(params).toContain('%founder wants out%');
  });

  it('treats a whitespace-only context as "no context" for hasContext', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ hasContext: true });
    const yes = renderSql(where.mock.calls[0][0] as SQL).sql;
    expect(yes).toContain("coalesce(trim(");
    expect(yes).toContain("<> ''");

    const second = makeAgentSearchDb([]);
    const repo2 = new CompanyRepository(second.db, 'workspace-1');
    await repo2.searchForAgent({ hasContext: false });
    const no = renderSql(second.where.mock.calls[0][0] as SQL).sql;
    expect(no).toContain("= ''");
  });

  it('renders inclusive created_at bounds for createdAfter/createdBefore', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({
      createdAfter: '2026-01-01',
      createdBefore: '2026-06-30',
    });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"created_at" >=');
    expect(rendered).toContain('"created_at" <=');
    expect(params).toContain('2026-01-01');
    expect(params).toContain('2026-06-30');
  });

  it('always excludes discovered-stage companies from the search', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({});

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"pipeline_stage" <>');
    expect(params).toContain('discovered');
  });

  it('scopes to an explicit id list and stops excluding discovered stubs', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ ids: ['c1', 'c2'] });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"id" in');
    expect(params).toContain('c1');
    expect(params).toContain('c2');
    // The caller pinned exact rows; second-guessing their stage would drop them.
    expect(params).not.toContain('discovered');
  });

  // An empty id list means "the caller resolved zero companies" — widening to
  // the whole workspace would export rows nobody asked for.
  it('matches nothing when the id list is empty', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ ids: [] });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered } = renderSql(condition);
    expect(rendered).toContain('false');
    expect(rendered).not.toContain('"id" in');
  });

  it('renders excludeIds as a not-in list', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ excludeIds: ['c9'] });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"id" not in');
    expect(params).toContain('c9');
  });

  it('ignores an empty excludeIds list rather than emitting a vacuous not-in', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ excludeIds: [] });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered } = renderSql(condition);
    expect(rendered).not.toContain('not in');
  });

  it('derives isLive from the advisor when is_live is unset', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ isLive: true });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered } = renderSql(condition);
    expect(rendered).toContain('"is_live" = true');
    expect(rendered).toContain('"is_live" is null');
    expect(rendered).toContain('"advisor"');
  });

  it('inverts the live derivation for isLive=false', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ isLive: false });

    const { sql: rendered } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"is_live" = false');
    expect(rendered).toContain('not (');
  });

  it('matches an alias against the jsonb aliases array', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ alias: 'Old Name' });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('jsonb_array_elements_text');
    expect(params).toContain('%old name%');
  });

  it('matches matchedTrackId with a jsonb containment check', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ matchedTrackId: 'track-7' });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('@>');
    expect(params).toContain('["track-7"]');
  });

  it('renders the newly exposed column filters', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({
      entryId: 42,
      website: 'acme.com',
      workflowStatus: 'NDA signed',
      advisor: 'Goldman',
      stake: '51%',
      docType: 'teaser',
      originator: 'Referral',
      remarks: 'follow up',
      hasNboDate: true,
      hasPossibleDuplicate: false,
      aiOpinionStatus: 'processing',
      updatedAfter: '2026-01-01',
      lastActivityBefore: '2026-06-30',
    });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"entry_id" =');
    expect(rendered).toContain('"website" ilike');
    expect(rendered).toContain('"workflow_status" ilike');
    expect(rendered).toContain('"advisor" ilike');
    expect(rendered).toContain('"stake" ilike');
    expect(rendered).toContain('"doc_type" ilike');
    expect(rendered).toContain('"originator" ilike');
    expect(rendered).toContain('"remarks" ilike');
    expect(rendered).toContain('"nbo_date" is not null');
    expect(rendered).toContain('"possible_duplicate_company_id" is null');
    expect(rendered).toContain('"updated_at" >=');
    expect(rendered).toContain('"last_activity_at" <=');
    expect(params).toContain(42);
    expect(params).toContain('processing');
  });
});

describe('CompanyRepository.findForAgentStats', () => {
  it('always excludes discovered-stage companies from the snapshot', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findForAgentStats({});

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"pipeline_stage" <>');
    expect(params).toContain('discovered');
  });

  it('excludes discovered even alongside other filters', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findForAgentStats({ segment: 'Tech' });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"segment" ilike');
    expect(rendered).toContain('"pipeline_stage" <>');
    expect(params).toContain('discovered');
  });
});

describe('CompanyRepository.findAll targetSearch', () => {
  it('matches targetSearch against both target and project_name', async () => {
    const { db, where } = makeListDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findAll({ targetSearch: '凤凰项目' });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"target" ilike');
    expect(rendered).toContain('"project_name" ilike');
    expect(params.filter((p) => p === '%凤凰项目%')).toHaveLength(2);
  });

  it('trims the term and wraps it in wildcards', async () => {
    const { db, where } = makeListDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findAll({ targetSearch: '  凤凰  ' });

    const condition = where.mock.calls[0][0] as SQL;
    const { params } = renderSql(condition);
    expect(params).toContain('%凤凰%');
  });
});


describe('CompanyRepository.findByNameFuzzy', () => {
  it('returns null for a short name with no exact match', async () => {
    const { db } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByNameFuzzy('ENJ')).toBeNull();
  });

  it('returns the row for a short name that exactly matches (case-insensitive)', async () => {
    const match = { id: 'c1', target: 'TSMC' };
    const { db } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByNameFuzzy('tsmc')).toEqual(match);
  });

  it('returns the matched row when one exists', async () => {
    const match = { id: 'c9', target: 'Acme Co.' };
    const { db } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByNameFuzzy('Acme Ltd.')).toEqual(match);
  });

  it('matches regardless of the casing of the search term', async () => {
    const match = { id: 'c9', target: 'Acme Co.' };
    const { db } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByNameFuzzy('ACME LTD.')).toEqual(match);
    expect(await repo.findByNameFuzzy('acme ltd.')).toEqual(match);
    expect(await repo.findByNameFuzzy('aCmE CoRp')).toEqual(match);
    expect(await repo.findByNameFuzzy('ACME CO.')).toEqual(match);
    expect(await repo.findByNameFuzzy('ACME LTD')).toEqual(match);
  });

  it('returns null when the query finds no row', async () => {
    const { db } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByNameFuzzy('Nonexistent Holdings Ltd.')).toBeNull();
  });

  it('matches against the aliases array (substring branch) scoped to the workspace', async () => {
    const { db, where } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findByNameFuzzy('Acme Holdings Ltd.');

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('jsonb_array_elements_text');
    expect(clause.sql).toContain('"aliases"');
    expect(clause.sql).toContain('like');
    // workspace-scoped
    expect(clause.params).toContain('workspace-1');
  });

  it('matches against the aliases array (short-name exact branch) scoped to the workspace', async () => {
    const { db, where } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findByNameFuzzy('IBM');

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('jsonb_array_elements_text');
    expect(clause.sql).toContain('"aliases"');
    expect(clause.params).toContain('workspace-1');
  });

  it('ranks the substring match so the closest name wins the limit(1)', async () => {
    const { db, orderBy } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    // "杭州华友" is a substring of "杭州华友新材料"; without an ORDER BY, Postgres
    // is free to return either row.
    await repo.findByNameFuzzy('杭州华友控股');

    expect(orderBy).toHaveBeenCalledTimes(1);
    const [rank, length] = orderBy.mock.calls[0] as SQL[];
    const rankSql = new PgDialect().sqlToQuery(rank).sql;
    // Exact-on-full-input outranks exact-on-base, which outranks a prefix
    // match, which outranks a bare substring hit.
    expect(rankSql).toContain('case');
    expect(rankSql).toContain('then 0');
    expect(rankSql).toContain('then 1');
    expect(rankSql).toContain('then 2');
    expect(rankSql).toContain('else 3');
    // Shortest name breaks a tie — the least-embellished record.
    expect(new PgDialect().sqlToQuery(length).sql).toContain('char_length');
  });

  it('ranks alias hits alongside names, not in the leftover bucket', async () => {
    const { db, orderBy } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findByNameFuzzy('杭州华友控股');

    // A company that absorbed the searched name as an alias via "combine" has
    // to outrank a leftover stub whose target merely starts with it, or the
    // combine is undone on the next lookup.
    const rankSql = new PgDialect().sqlToQuery(orderBy.mock.calls[0][0] as SQL).sql;
    const aliasHits = rankSql.match(/jsonb_array_elements_text/g) ?? [];
    expect(aliasHits).toHaveLength(3); // exact-full, exact-base, prefix
    expect(rankSql.slice(0, rankSql.indexOf('then 0'))).toContain(
      'jsonb_array_elements_text',
    );
  });

  it('orders the short-name exact branch so a name match beats an alias-only match', async () => {
    const { db, orderBy } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findByNameFuzzy('IBM');

    expect(orderBy).toHaveBeenCalledTimes(1);
    const rankSql = new PgDialect().sqlToQuery(orderBy.mock.calls[0][0] as SQL).sql;
    expect(rankSql).toContain('case');
    expect(rankSql).toContain('then 0 else 1 end');
  });
});

describe('CompanyRepository.findByIdOrNull', () => {
  /** Build a db whose `select(...).from(...).where(...).limit(1)` resolves to `rows`. */
  function makeDb(rows: Array<Partial<Tables<'companies'>>>) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, where };
  }

  it('returns the row, scoped to the workspace', async () => {
    const row = { id: 'c1', target: 'Acme' };
    const { db, where } = makeDb([row]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByIdOrNull('c1')).toEqual(row);
    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.params).toEqual(expect.arrayContaining(['c1', 'workspace-1']));
  });

  it('returns null instead of throwing when there is no such row', async () => {
    const { db } = makeDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByIdOrNull('missing')).toBeNull();
  });

  it('makes findById throw on the same miss', async () => {
    const { db } = makeDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await expect(repo.findById('missing')).rejects.toThrow('Company missing not found');
  });
});

describe('CompanyRepository.findExistingIds', () => {
  /** Build a db whose `select(...).from(...).where(...)` resolves to `rows`. */
  function makeIdDb(rows: Array<{ id: string }>) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, select, where };
  }

  it('returns [] without hitting the DB when the id list is empty', async () => {
    const { db, select } = makeIdDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findExistingIds([])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('returns the matching ids in a single workspace-scoped query', async () => {
    const { db, select, where } = makeIdDb([{ id: 'c1' }, { id: 'c3' }]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findExistingIds(['c1', 'c2', 'c3'])).toEqual(['c1', 'c3']);
    expect(select).toHaveBeenCalledTimes(1);

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('in');
    expect(clause.params).toEqual(expect.arrayContaining(['c1', 'c2', 'c3', 'workspace-1']));
  });
});

/** Build a db whose `select().from().where().orderBy()` resolves to `rows`. */
function makeExactNameDb(rows: Array<Partial<Tables<'companies'>>>) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, where, orderBy };
}

describe('CompanyRepository.findByExactName', () => {
  it('returns [] without hitting the DB for a blank name', async () => {
    const { db, select } = makeExactNameDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByExactName('   ')).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('returns every exact match so the caller can ignore its own row', async () => {
    const rows = [{ id: 'c1', target: 'Acme Corp' }, { id: 'c2', target: 'Acme Corp' }];
    const { db } = makeExactNameDb(rows);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findByExactName('Acme Corp')).toEqual(rows);
  });

  // This is the identity check a rename relies on, so it must compare whole
  // names case-insensitively across target, project name, and aliases — never
  // substring-match the way findByNameFuzzy does.
  it('matches target, project_name and aliases on the lower-cased full name, workspace-scoped', async () => {
    const { db, where } = makeExactNameDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findByExactName('  Acme Holdings Ltd.  ');

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('"target"');
    expect(clause.sql).toContain('"project_name"');
    expect(clause.sql).toContain('jsonb_array_elements_text');
    expect(clause.sql).not.toContain('like');
    expect(clause.params).toEqual(
      expect.arrayContaining(['workspace-1', 'acme holdings ltd.']),
    );
    // The full name is compared verbatim — no legal-suffix stripping.
    expect(clause.params).not.toContain('acme');
  });
});

describe('CompanyRepository.findIdAndNameByIds', () => {
  /** Build a db whose `select(...).from(...).where(...)` resolves to `rows`. */
  function makeNameDb(
    rows: Array<{ id: string; target: string | null; project_name: string | null }>,
  ) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, select, where };
  }

  it('returns [] without hitting the DB when the id list is empty', async () => {
    const { db, select } = makeNameDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findIdAndNameByIds([])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('resolves every name in a single workspace-scoped query', async () => {
    const rows = [
      { id: 'c1', target: 'Acme Corp', project_name: null },
      { id: 'c2', target: null, project_name: 'Project Beta' },
    ];
    const { db, select, where } = makeNameDb(rows);
    const repo = new CompanyRepository(db, 'workspace-1');

    expect(await repo.findIdAndNameByIds(['c1', 'c2'])).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(1);

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('in');
    expect(clause.params).toEqual(expect.arrayContaining(['c1', 'c2', 'workspace-1']));
  });
});

/** Build a db whose `select().from().where().groupBy()` resolves to `rows`. */
function makeGroupedDb(
  rows: Array<{
    stage: string | null;
    source: string | null;
    watchlist_status: string | null;
    count: number | string;
  }>,
) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ groupBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where, groupBy };
}

describe('CompanyRepository.countByStageAndSource', () => {
  it('groups by stage, source and watchlist_status in one workspace-scoped query', async () => {
    const { db, select, where, groupBy } = makeGroupedDb([
      { stage: 'L0', source: 'inbound', watchlist_status: null, count: '7' },
      { stage: 'L1', source: null, watchlist_status: 'active', count: 2 },
    ]);
    const repo = new CompanyRepository(db, 'workspace-1');

    const result = await repo.countByStageAndSource({ excludeDropped: true });

    expect(select).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { stage: 'L0', source: 'inbound', watchlist_status: null, count: 7 },
      { stage: 'L1', source: null, watchlist_status: 'active', count: 2 },
    ]);

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.params).toContain('workspace-1');
  });

  it('coerces a null stage rather than dropping the row', async () => {
    const { db } = makeGroupedDb([
      { stage: null, source: null, watchlist_status: null, count: '3' },
    ]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await expect(repo.countByStageAndSource()).resolves.toEqual([
      { stage: null, source: null, watchlist_status: null, count: 3 },
    ]);
  });
});

describe('CompanyRepository.findOwnedByUser', () => {
  /** `select().from().leftJoin().where().orderBy().limit()` resolving to `rows`. */
  function makeOwnedDb(rows: unknown[]) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    const db = { select: vi.fn().mockReturnValue(chain) };
    return { db, chain };
  }

  it('matches an assignee, a deal sponsor or a deal captain, scoped to active companies', async () => {
    const { db, chain } = makeOwnedDb([]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await repo.findOwnedByUser('user-1');

    const { sql: text, params } = new PgDialect().sqlToQuery(
      chain.where.mock.calls[0][0] as SQL,
    );
    expect(params).toContain('workspace-1');
    expect(params).toContain('active');
    expect(text).toContain('"company_assignees"."user_id" is not null');
    expect(text).toContain('"deal_sponsor" =');
    expect(text).toContain('"deal_captain" =');
    expect(params.filter((p) => p === 'user-1')).toHaveLength(2);
  });

  it('pre-filters the assignee join to this user so one company cannot fan out into several rows', async () => {
    const { db, chain } = makeOwnedDb([]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await repo.findOwnedByUser('user-1');

    expect(chain.leftJoin).toHaveBeenCalledTimes(1);
    const { params } = new PgDialect().sqlToQuery(
      chain.leftJoin.mock.calls[0][1] as SQL,
    );
    expect(params).toContain('user-1');
  });

  it('orders newest-touched first and bounds the result to the limit', async () => {
    const rows = [{ id: 'c1', target: 'Acme' }];
    const { db, chain } = makeOwnedDb(rows);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await expect(repo.findOwnedByUser('user-1')).resolves.toEqual(rows);
    const { sql: orderText } = new PgDialect().sqlToQuery(
      chain.orderBy.mock.calls[0][0] as SQL,
    );
    expect(orderText).toContain('COALESCE');
    expect(orderText).toContain('desc');
    expect(chain.limit).toHaveBeenCalledWith(20);

    await repo.findOwnedByUser('user-1', 5);
    expect(chain.limit).toHaveBeenLastCalledWith(5);
  });
});

describe('CompanyRepository.countOwnedByUser', () => {
  function makeCountDb(rows: unknown[]) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
    const db = { select: vi.fn().mockReturnValue(chain) };
    return { db, chain };
  }

  it('returns the total as a number', async () => {
    const { db } = makeCountDb([{ total: '7' }]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await expect(repo.countOwnedByUser('user-1')).resolves.toBe(7);
  });

  it('returns 0 when the count query comes back empty', async () => {
    const { db } = makeCountDb([]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await expect(repo.countOwnedByUser('user-1')).resolves.toBe(0);
  });

  it('counts exactly what the page query matches', async () => {
    const { db, chain } = makeCountDb([{ total: 0 }]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await repo.countOwnedByUser('user-1');

    const { sql: text, params } = new PgDialect().sqlToQuery(
      chain.where.mock.calls[0][0] as SQL,
    );
    expect(params).toContain('workspace-1');
    expect(params).toContain('active');
    expect(text).toContain('"company_assignees"."user_id" is not null');
  });
});

describe('CompanyRepository.findForAgentStats — stage exclusion', () => {
  it('excludes the given stages, so stages a workspace added are kept', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findForAgentStats({ stageNotIn: ['market_screening', 'unreviewed', 'discovered'] });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"pipeline_stage" not in');
    expect(params).toEqual(expect.arrayContaining(['market_screening', 'unreviewed', 'discovered']));
    expect(rendered).not.toContain('"pipeline_stage" in');
  });

  it('treats an empty exclusion list as every stage, discovered stubs included', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.findForAgentStats({ stageNotIn: [] });

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).not.toContain('"pipeline_stage"');
    expect(params).not.toContain('discovered');
  });
});

describe('CompanyRepository.findActiveTrackMatchesByStage', () => {
  it('returns active companies at the stage with their matched tracks, defaulting null to []', async () => {
    const where = vi.fn().mockResolvedValue([
      { id: 'c1', matched_track_ids: ['t1'] },
      { id: 'c2', matched_track_ids: null },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repo = new CompanyRepository({ select } as never, 'workspace-1');

    await expect(repo.findActiveTrackMatchesByStage('unreviewed')).resolves.toEqual([
      { id: 'c1', matched_track_ids: ['t1'] },
      { id: 'c2', matched_track_ids: [] },
    ]);

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"pipeline_stage" =');
    expect(rendered).toContain('"status" =');
    expect(rendered).toContain('"workspace_id" =');
    expect(params).toEqual(expect.arrayContaining(['unreviewed', 'active', 'workspace-1']));
  });
});

describe('CompanyRepository.findActiveIdsByStage', () => {
  it('returns the ids of active companies at the stage in this workspace', async () => {
    const where = vi.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repo = new CompanyRepository({ select } as never, 'workspace-1');

    await expect(repo.findActiveIdsByStage('stg-calls')).resolves.toEqual(['c1', 'c2']);

    const { sql: rendered, params } = renderSql(where.mock.calls[0][0] as SQL);
    expect(rendered).toContain('"pipeline_stage" =');
    expect(rendered).toContain('"status" =');
    expect(rendered).toContain('"workspace_id" =');
    expect(params).toEqual(expect.arrayContaining(['stg-calls', 'active', 'workspace-1']));
  });
});

describe('CompanyRepository.count', () => {
  function makeCountDb(value: number | string) {
    const where = vi.fn().mockResolvedValue([{ value }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, where };
  }

  it('filters on an exact source alongside stage and the dropped exclusion', async () => {
    const { db, where } = makeCountDb('5');
    const repo = new CompanyRepository(db, 'workspace-1');

    const result = await repo.count({ stage: 'unreviewed', source: 'inbound', excludeDropped: true });

    expect(result).toBe(5);
    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('"companies"."source" = ');
    expect(clause.params).toEqual(
      expect.arrayContaining(['workspace-1', 'unreviewed', 'inbound', 'dropped']),
    );
  });

  it('leaves source unconstrained when no source is given', async () => {
    const { db, where } = makeCountDb(0);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.count({ stage: 'unreviewed' });

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).not.toContain('"companies"."source"');
  });
});

describe('CompanyRepository.findByIds', () => {
  it('returns [] without hitting the DB when the id list is empty', async () => {
    const select = vi.fn();
    const repo = new CompanyRepository({ select } as never, 'workspace-1');

    await expect(repo.findByIds([])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('reads the companies in one workspace-scoped query', async () => {
    const orderBy = vi.fn().mockResolvedValue([{ id: 'c1' }]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repo = new CompanyRepository({ select } as never, 'workspace-1');

    await expect(repo.findByIds(['c1', 'c2'])).resolves.toEqual([{ id: 'c1' }]);
    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.params).toEqual(expect.arrayContaining(['c1', 'c2', 'workspace-1']));
  });
});

type SponsorChain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
};

/** Drizzle chain stub: every builder step returns the chain; awaiting it yields `result`. */
function makeChainDb(result: unknown[] = []) {
  const chain = {} as SponsorChain;
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'groupBy', 'update', 'set']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.returning = vi.fn().mockResolvedValue(result);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const sponsorDialect = new PgDialect();
const render = (s: unknown) => sponsorDialect.sqlToQuery(s as SQL);

describe('CompanyRepository.findOwnedDealsForSponsorMatch', () => {
  it('returns [] without hitting the DB when there is nothing to match on', async () => {
    const db = makeChainDb();
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await expect(
      repo.findOwnedDealsForSponsorMatch({ segments: [], geographies: [], before: '2026-10-21', limit: 10 }),
    ).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('matches normalised sector or country on owned, in-pipeline deals created before arrival', async () => {
    const rows = [{ id: 'c1' }];
    const db = makeChainDb(rows);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    const result = await repo.findOwnedDealsForSponsorMatch({
      segments: ['healthcare'],
      geographies: ['indonesia'],
      before: '2026-10-21T00:00:00.000Z',
      limit: 2000,
    });

    expect(result).toEqual(rows);
    const { sql, params } = render(db.where.mock.calls[0][0]);
    expect(sql).toContain(`trim(regexp_replace(replace(lower(coalesce("companies"."segment", '')), '&', ' and '), '\\s+', ' ', 'g'))`);
    expect(sql).toContain('"companies"."deal_captain" is not null');
    expect(sql).toContain('"companies"."pipeline_stage" not in');
    expect(sql).toContain('"companies"."created_at" <');
    expect(params).toEqual(
      expect.arrayContaining(['workspace-1', 'unreviewed', 'healthcare', 'indonesia', '2026-10-21T00:00:00.000Z']),
    );
    expect(db.limit).toHaveBeenCalledWith(2000);
  });

  it('matches on country alone when the company has no sector', async () => {
    const db = makeChainDb([]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await repo.findOwnedDealsForSponsorMatch({ segments: [], geographies: ['indonesia'], before: 'x', limit: 5 });

    const { sql } = render(db.where.mock.calls[0][0]);
    expect(sql).not.toContain('"companies"."segment", \'\'))');
    expect(sql).toContain('"companies"."geography"');
  });
});

describe('CompanyRepository.assignDealSponsorsIfEmpty', () => {
  it('returns [] without hitting the DB for no assignments', async () => {
    const db = makeChainDb();
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    await expect(repo.assignDealSponsorsIfEmpty([])).resolves.toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('sets every sponsor in one statement, only where it is still empty, and mirrors the rows', async () => {
    const rows = [row({ id: 'c1', deal_sponsor: 'u1' })];
    const db = makeChainDb(rows);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db as never, 'workspace-1', mirror);

    const result = await repo.assignDealSponsorsIfEmpty([
      { companyId: 'c1', userId: 'u1' },
      { companyId: 'c2', userId: 'u2' },
    ]);

    expect(result).toEqual(rows);
    expect(db.update).toHaveBeenCalledTimes(1);
    const set = render(db.set.mock.calls[0][0].deal_sponsor);
    expect(set.sql).toBe('CASE "companies"."id" WHEN $1::uuid THEN $2::uuid WHEN $3::uuid THEN $4::uuid END');
    expect(set.params).toEqual(['c1', 'u1', 'c2', 'u2']);
    const where = render(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"companies"."deal_sponsor" is null');
    expect(where.params).toEqual(expect.arrayContaining(['c1', 'c2', 'workspace-1']));
    expect(mirror.upsertCompany).toHaveBeenCalledTimes(1);
  });
});

describe('CompanyRepository.countActiveDealsByOwners', () => {
  it('returns an empty map without hitting the DB for no users', async () => {
    const db = makeChainDb();
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    expect(await repo.countActiveDealsByOwners([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it('groups active deals by captain-else-sponsor in one query', async () => {
    const db = makeChainDb([
      { owner_id: 'u1', count: 3 },
      { owner_id: 'u2', count: '1' },
    ]);
    const repo = new CompanyRepository(db as never, 'workspace-1', makeMirror());

    expect(await repo.countActiveDealsByOwners(['u1', 'u2'])).toEqual(
      new Map([
        ['u1', 3],
        ['u2', 1],
      ]),
    );
    expect(db.groupBy).toHaveBeenCalledTimes(1);
    const { sql } = render(db.where.mock.calls[0][0]);
    expect(sql).toContain('coalesce("companies"."deal_captain", "companies"."deal_sponsor")');
  });
});
