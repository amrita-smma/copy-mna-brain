import { describe, expect, it, vi } from 'vitest';
import { FileRepository } from './fileRepository';

function makeDb() {
  const execute = vi.fn().mockResolvedValue(undefined);
  return { db: { execute } as never, execute };
}

describe('FileRepository.removeMatchedCompany', () => {
  it('issues a single UPDATE against the files table', async () => {
    const { db, execute } = makeDb();
    const repo = new FileRepository(db);

    await repo.removeMatchedCompany('company-1');

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds the company id into the statement so only matching files are rewritten', async () => {
    const { db, execute } = makeDb();
    const repo = new FileRepository(db);

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
