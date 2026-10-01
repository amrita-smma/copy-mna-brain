import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { FileRepository } from './fileRepository';
import { DEDICATED_FILE_TYPES, SMART_FILES_TABS } from '@/lib/smartFilesTabs';
import type { Tables } from './types';

function makeDb() {
  const execute = vi.fn().mockResolvedValue(undefined);
  return { db: { execute } as never, execute };
}

/**
 * Build a db that satisfies the two queries `listPaginated` fires in a
 * Promise.all: the page query
 * (`select().from().where().orderBy().limit().offset()`) resolving to `rows`,
 * then the count query (`select().from().where()`) resolving to `[{ total }]`.
 * `select` is called twice, so each call returns its own chain via
 * `mockReturnValueOnce`.
 */
function makeListDb(rows: Array<Partial<Tables<'files'>>>, total: number) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const whereRows = vi.fn().mockReturnValue({ orderBy });
  const fromRows = vi.fn().mockReturnValue({ where: whereRows });

  const whereCount = vi.fn().mockResolvedValue([{ total }]);
  const fromCount = vi.fn().mockReturnValue({ where: whereCount });

  const select = vi
    .fn()
    .mockReturnValueOnce({ from: fromRows })
    .mockReturnValueOnce({ from: fromCount });

  return { db: { select } as never, select, orderBy, limit, offset, whereRows, whereCount };
}

describe('FileRepository.removeMatchedCompany', () => {
  it('issues a single UPDATE against the files table', async () => {
    const { db, execute } = makeDb();
    const repo = new FileRepository(db, 'workspace-1');

    await repo.removeMatchedCompany('company-1');

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds the company id into the statement so only matching files are rewritten', async () => {
    const { db, execute } = makeDb();
    const repo = new FileRepository(db, 'workspace-1');

    await repo.removeMatchedCompany('company-1');

    // The SQL is a drizzle template; the interpolated values land in queryChunks
    // as plain strings. Confirm the id is bound (used in the `<>` filter) and
    // the jsonb containment matcher (the `@>` guard) is present.
    const [statement] = execute.mock.calls[0];
    const chunks = (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
    const stringChunks = chunks.map((c) => String(c));

    expect(stringChunks).toContain('company-1');
    expect(stringChunks).toContain(JSON.stringify([{ id: 'company-1' }]));
  });
});

describe('FileRepository.listPaginated', () => {
  it('returns the page rows alongside the unpaginated total', async () => {
    const rows = [{ id: 'file-1' }, { id: 'file-2' }];
    const { db } = makeListDb(rows, 42);
    const repo = new FileRepository(db, 'workspace-1');

    const result = await repo.listPaginated({ limit: 10, offset: 0 });

    expect(result.rows).toEqual(rows);
    expect(result.total).toBe(42);
  });

  it('forwards limit and offset to the page query', async () => {
    const { db, limit, offset } = makeListDb([], 0);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.listPaginated({ limit: 20, offset: 40 });

    expect(limit).toHaveBeenCalledWith(20);
    expect(offset).toHaveBeenCalledWith(40);
  });

  it('pins awaiting-review rows first, then applies the requested sort', async () => {
    const { db, orderBy } = makeListDb([], 0);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.listPaginated({ sortField: 'file_name', sortDirection: 'asc', limit: 10, offset: 0 });

    // Two ORDER BY expressions: the awaiting_review pin, then the sort column.
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(orderBy.mock.calls[0]).toHaveLength(2);
  });

  it('excludes every dedicated tab type from the "other" bucket', async () => {
    const { db, whereRows } = makeListDb([], 0);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.listPaginated({ fileType: 'other', limit: 10, offset: 0 });

    const [condition] = whereRows.mock.calls[0];
    const { params } = new PgDialect().sqlToQuery(condition as SQL);
    for (const fileType of DEDICATED_FILE_TYPES) {
      expect(params).toContain(fileType);
    }
  });

  it('adds a search filter matching file_name, tags and matched company names', async () => {
    const { db, whereRows } = makeListDb([], 0);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.listPaginated({ search: 'acme', limit: 10, offset: 0 });

    // Render the composed where condition to SQL and assert the search term is
    // bound once per branch (file_name / tags / matched_companies).
    const [condition] = whereRows.mock.calls[0];
    const { sql: text, params } = new PgDialect().sqlToQuery(condition as SQL);
    expect(text).toContain('ilike');
    expect(params.filter((p) => p === '%acme%')).toHaveLength(3);
  });
});

/**
 * Chain for `findByMatchedCompanyId`:
 * `select().from().where().orderBy().limit()`.
 */
function makeMatchedDb(rows: Array<Partial<Tables<'files'>>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, where, orderBy, limit };
}

describe('FileRepository.findByMatchedCompanyId', () => {
  it('returns the files linked to the company', async () => {
    const rows = [{ id: 'file-1' }, { id: 'file-2' }];
    const { db } = makeMatchedDb(rows);
    const repo = new FileRepository(db, 'workspace-1');

    await expect(repo.findByMatchedCompanyId('company-1')).resolves.toEqual(rows);
  });

  it('filters on the jsonb matched_companies containment and the workspace', async () => {
    const { db, where } = makeMatchedDb([]);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.findByMatchedCompanyId('company-1');

    const [condition] = where.mock.calls[0];
    const { sql: text, params } = new PgDialect().sqlToQuery(condition as SQL);
    expect(text).toContain('@>');
    expect(params).toContain(JSON.stringify([{ id: 'company-1' }]));
    expect(params).toContain('workspace-1');
  });

  it('orders by the business file_date first so the newest information leads', async () => {
    const { db, orderBy } = makeMatchedDb([]);
    const repo = new FileRepository(db, 'workspace-1');

    await repo.findByMatchedCompanyId('company-1');

    // Two ORDER BY expressions: file_date desc, then created_at desc as the
    // tiebreak for files the extractor could not date.
    expect(orderBy.mock.calls[0]).toHaveLength(2);
  });

  it('caps the result set, defaulting to 50 and honouring an explicit limit', async () => {
    const first = makeMatchedDb([]);
    await new FileRepository(first.db, 'workspace-1').findByMatchedCompanyId('company-1');
    expect(first.limit).toHaveBeenCalledWith(50);

    const second = makeMatchedDb([]);
    await new FileRepository(second.db, 'workspace-1').findByMatchedCompanyId('company-1', 5);
    expect(second.limit).toHaveBeenCalledWith(5);
  });
});

/** Chain for `countsByType`: `select().from().where().groupBy()`. */
function makeCountsDb(rows: Array<{ file_type: string | null; count: number }>) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ groupBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never };
}

describe('FileRepository.countsByType', () => {
  it('reports 0 (not undefined) for every tab with no rows', async () => {
    const { db } = makeCountsDb([]);
    const repo = new FileRepository(db, 'workspace-1');

    const counts = await repo.countsByType();

    // The view hides zero-count tabs, so it must be able to tell a real 0
    // from "counts haven't loaded".
    for (const tab of SMART_FILES_TABS) {
      expect(counts[tab]).toBe(0);
    }
  });

  it('gives the new financial statement and bond issuance types their own buckets', async () => {
    const { db } = makeCountsDb([
      { file_type: 'financial_statement', count: 4 },
      { file_type: 'bond_issuance', count: 2 },
    ]);
    const repo = new FileRepository(db, 'workspace-1');

    const counts = await repo.countsByType();

    expect(counts.financial_statement).toBe(4);
    expect(counts.bond_issuance).toBe(2);
    // They used to fall through to the catch-all bucket.
    expect(counts.other).toBe(0);
  });

  it('folds NULL and undedicated types into the "other" bucket', async () => {
    const { db } = makeCountsDb([
      { file_type: null, count: 3 },
      { file_type: 'legal_document', count: 1 },
      { file_type: 'mom', count: 5 },
    ]);
    const repo = new FileRepository(db, 'workspace-1');

    const counts = await repo.countsByType();

    expect(counts.other).toBe(4);
    expect(counts.mom).toBe(5);
  });
});
