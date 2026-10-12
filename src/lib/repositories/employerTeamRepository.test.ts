import { describe, expect, it, vi } from 'vitest';
import { EmployerTeamRepository } from './employerTeamRepository';

describe('EmployerTeamRepository.addMany', () => {
  it('deduplicates pairs and ignores conflicts', async () => {
    const returning = vi.fn().mockResolvedValue([
      { employer_id: 'e1', user_id: 'u1' },
    ]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    const repo = new EmployerTeamRepository(db as never);

    const inserted = await repo.addMany([
      { employer_id: 'e1', user_id: 'u1' },
      { employer_id: 'e1', user_id: 'u1' },
    ]);

    expect(values).toHaveBeenCalledWith([
      { employer_id: 'e1', user_id: 'u1' },
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(inserted).toBe(1);
  });

  it('does not query for an empty assignment list', async () => {
    const db = { insert: vi.fn() };
    const repo = new EmployerTeamRepository(db as never);

    await expect(repo.addMany([])).resolves.toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('EmployerTeamRepository.listForEmployers', () => {
  it('returns [] without hitting the DB when the id list is empty', async () => {
    const db = { select: vi.fn() };
    const repo = new EmployerTeamRepository(db as never);

    await expect(repo.listForEmployers([])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fetches coverage for many employers in one query', async () => {
    const rows = [{ employer_id: 'e1', id: 'u1', name: 'Nico', email: 'n@x.com' }];
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const db = { select: vi.fn().mockReturnValue({ from }) };
    const repo = new EmployerTeamRepository(db as never);

    await expect(repo.listForEmployers(['e1', 'e2'])).resolves.toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
