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
      { workspace_id: 'w1', employer_id: 'e1', user_id: 'u1' },
      { workspace_id: 'w1', employer_id: 'e1', user_id: 'u1' },
      // Same pair in another workspace is its own row, not a duplicate.
      { workspace_id: 'w2', employer_id: 'e1', user_id: 'u1' },
    ]);

    expect(values).toHaveBeenCalledWith([
      { workspace_id: 'w1', employer_id: 'e1', user_id: 'u1' },
      { workspace_id: 'w2', employer_id: 'e1', user_id: 'u1' },
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

    await expect(repo.listForEmployers('w1', [])).resolves.toEqual([]);
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

    await expect(repo.listForEmployers('w1', ['e1', 'e2'])).resolves.toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('EmployerTeamRepository.setMembers', () => {
  it("replaces only this workspace's coverage, in one transaction", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const tx = {
      delete: vi.fn().mockReturnValue({ where }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const db = { transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const repo = new EmployerTeamRepository(db as never);

    await repo.setMembers('w1', 'e1', ['u1', 'u2']);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith([
      { workspace_id: 'w1', employer_id: 'e1', user_id: 'u1' },
      { workspace_id: 'w1', employer_id: 'e1', user_id: 'u2' },
    ]);
  });

  it('only clears when the new list is empty', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const tx = { delete: vi.fn().mockReturnValue({ where }), insert: vi.fn() };
    const db = { transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const repo = new EmployerTeamRepository(db as never);

    await repo.setMembers('w1', 'e1', []);

    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe('EmployerTeamRepository.listWorkspaceMembers', () => {
  it("lists the workspace's members by name in one query", async () => {
    const rows = [{ id: 'u1', name: 'Ann', email: 'a@x.com' }];
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const db = { select: vi.fn().mockReturnValue({ from }) };
    const repo = new EmployerTeamRepository(db as never);

    await expect(repo.listWorkspaceMembers('w1')).resolves.toEqual(rows);
  });
});
