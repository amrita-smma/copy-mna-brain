import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { FileRepository } from './fileRepository';
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
