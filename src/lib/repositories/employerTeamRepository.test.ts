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
