import { describe, expect, it, vi } from 'vitest';
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

/** Build a db whose `select(...).from(...)` resolves to the given rows. */
function makeDb(rows: Array<{ banker: string | null }>) {
  const fromMock = vi.fn().mockResolvedValue(rows);
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  return { db: { select: selectMock } as never, selectMock, fromMock };
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
    const repo = new CompanyRepository(db, makeMirror());

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
    const repo = new CompanyRepository(db, mirror);

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
    const repo = new CompanyRepository(db, mirror);

    await repo.insert(row() as never);

    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c2', name: 'Project Phoenix' }),
    );
  });

  it('drops unknown ownership values to undefined', async () => {
    const { db } = makeWriteDb([row({ ownership: 'state-owned' })]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, mirror);

    await repo.insert(row() as never);

    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ ownership: undefined }),
    );
  });

  it('mirrors every returned row on update', async () => {
    const { db } = makeWriteDb([row()]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, mirror);

    await repo.update('c1', { geography: 'Singapore' });

    expect(mirror.upsertCompany).toHaveBeenCalledTimes(1);
    expect(mirror.upsertCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }),
    );
  });

  it('mirrors each returned row on updateMany', async () => {
    const { db } = makeWriteDb([row({ id: 'c1' }), row({ id: 'c2' })]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, mirror);

    await repo.updateMany(['c1', 'c2'], { pipeline_stage: 'L1' as never });

    expect(mirror.upsertCompany).toHaveBeenCalledTimes(2);
  });

  it('removes the node from the graph on delete', async () => {
    const { db } = makeWriteDb([]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, mirror);

    await repo.delete('c1');

    expect(mirror.deleteCompany).toHaveBeenCalledWith('c1');
  });

  it('does not touch the graph when no mirror is wired', async () => {
    const { db } = makeWriteDb([row()]);
    const repo = new CompanyRepository(db);

    await expect(repo.insert(row() as never)).resolves.toBeDefined();
    await expect(repo.delete('c1')).resolves.toBeUndefined();
  });

  it('swallows mirror failures so the Postgres write still succeeds', async () => {
    const { db } = makeWriteDb([row()]);
    const mirror = makeMirror();
    mirror.upsertCompany.mockRejectedValue(new Error('neo4j down'));
    const repo = new CompanyRepository(db, mirror);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await repo.insert(row() as never);

    expect(result).toMatchObject({ id: 'c1' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips the empty-list insertMany without mirroring', async () => {
    const { db } = makeWriteDb([]);
    const mirror = makeMirror();
    const repo = new CompanyRepository(db, mirror);

    await repo.insertMany([]);

    expect(mirror.upsertCompany).not.toHaveBeenCalled();
  });
});

describe('CompanyRepository.findBankerNames', () => {
  it('returns [] when no companies have a banker', async () => {
    const { db } = makeDb([{ banker: null }, { banker: '   ' }]);
    const repo = new CompanyRepository(db);

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
    const repo = new CompanyRepository(db);

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

describe('CompanyRepository.findByNameFuzzy', () => {
  it('returns null without querying when the name is empty', async () => {
    const { db, select } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('   ')).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('exact-matches (not substring-matches) names under 5 chars', async () => {
    const match = { id: 'c1', target: 'TSMC' };
    const { db, select } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('TSMC')).toEqual(match);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('returns null when a short name has no exact match', async () => {
    const { db } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('ENJ')).toBeNull();
  });

  it('returns the matched row when one exists', async () => {
    const match = { id: 'c9', target: 'Acme Co.' };
    const { db } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('Acme Ltd.')).toEqual(match);
  });

  it('matches regardless of the casing of the search term', async () => {
    const match = { id: 'c9', target: 'Acme Co.' };
    const { db } = makeFuzzyDb([match]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('ACME LTD.')).toEqual(match);
    expect(await repo.findByNameFuzzy('acme ltd.')).toEqual(match);
    expect(await repo.findByNameFuzzy('aCmE CoRp')).toEqual(match);
    expect(await repo.findByNameFuzzy('ACME CO.')).toEqual(match);
    expect(await repo.findByNameFuzzy('ACME LTD')).toEqual(match);
  });

  it('returns null when the query finds no row', async () => {
    const { db } = makeFuzzyDb([]);
    const repo = new CompanyRepository(db);

    expect(await repo.findByNameFuzzy('Nonexistent Holdings Ltd.')).toBeNull();
  });
});
