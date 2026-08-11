import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CompanyRepository, stripCompanySuffix } from './companyRepository';
import type { Tables } from './types';
import type { CompanyGraphMirror } from './companyRelationRepository';

/** Build a db whose `select().from().where().limit()` resolves to `rows`. */
function makeFuzzyDb(rows: Array<Partial<Tables<'companies'>>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where, limit };
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
  it('matches searchTerm against target, project_name, segment, and geography', async () => {
    const { db, where } = makeAgentSearchDb([]);
    const repo = new CompanyRepository(db, 'workspace-1');

    await repo.searchForAgent({ searchTerm: '中文股份' });

    const condition = where.mock.calls[0][0] as SQL;
    const { sql: rendered, params } = renderSql(condition);
    expect(rendered).toContain('"target" ilike');
    expect(rendered).toContain('"project_name" ilike');
    expect(rendered).toContain('"segment" ilike');
    expect(rendered).toContain('"geography" ilike');
    expect(params.filter((p) => p === '%中文股份%')).toHaveLength(4);
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
