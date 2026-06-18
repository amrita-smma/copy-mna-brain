import { describe, expect, it, vi } from 'vitest';
import { CompanyRepository } from './companyRepository';

/** Build a db whose `select(...).from(...)` resolves to the given rows. */
function makeDb(rows: Array<{ banker: string | null }>) {
  const fromMock = vi.fn().mockResolvedValue(rows);
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  return { db: { select: selectMock } as never, selectMock, fromMock };
}

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
