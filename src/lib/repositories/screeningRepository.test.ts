import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreeningRepository } from './screeningRepository';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};

describe('ScreeningRepository.markFailedIfPending', () => {
  let repo: ScreeningRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ScreeningRepository(mockDb as never, 'workspace-1');
  });

  it('writes failed/error/remarks and returns the updated row when the row was still pending', async () => {
    const updated = {
      id: 's1',
      state: 'failed',
      result: 'error',
      remarks: 'Job j1 timed out',
    };
    mockDb.returning.mockResolvedValueOnce([updated]);

    const result = await repo.markFailedIfPending('s1', 'Job j1 timed out');

    expect(result).toEqual(updated);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({
      state: 'failed',
      result: 'error',
      remarks: 'Job j1 timed out',
    });
  });

  it('returns null when the row is no longer pending (no rows matched the WHERE)', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await repo.markFailedIfPending('s2', 'whatever');

    expect(result).toBeNull();
  });
});

describe('ScreeningRepository.findByCompanyIds', () => {
  it('returns [] without hitting the DB when the id list is empty', async () => {
    vi.clearAllMocks();
    const repo = new ScreeningRepository(mockDb as never, 'workspace-1');

    await expect(repo.findByCompanyIds([])).resolves.toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('ScreeningRepository.findAllWithRelations', () => {
  function makeJoinDb() {
    const orderBy = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where,
    };
    const select = vi.fn().mockReturnValue(chain);
    return { db: { select } as never, where };
  }

  it('limits to active Pending Confirmation and L0 companies in SQL when inScreening', async () => {
    const { db, where } = makeJoinDb();
    await new ScreeningRepository(db, 'ws-1').findAllWithRelations({ inScreening: true });

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('"companies"."pipeline_stage" in');
    expect(clause.sql).toContain('"companies"."status" = ');
    expect(clause.params).toEqual(
      expect.arrayContaining(['ws-1', 'unreviewed', 'L0', 'active']),
    );
  });

  it('leaves stage and status unconstrained otherwise', async () => {
    const { db, where } = makeJoinDb();
    await new ScreeningRepository(db, 'ws-1').findAllWithRelations({ companyId: 'c1' });

    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).not.toContain('pipeline_stage');
    expect(clause.params).toEqual(expect.arrayContaining(['ws-1', 'c1']));
  });
});

describe('ScreeningRepository.markPendingFailedForCompany', () => {
  it('fails only the company’s still-pending rows in one update and counts them', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({}) }),
    });
    const repo = new ScreeningRepository({ update, select } as never, 'ws-1');

    await expect(repo.markPendingFailedForCompany('c1', 'gone')).resolves.toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ state: 'failed', result: 'error', remarks: 'gone' });
    const clause = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(clause.sql).toContain('"screenings"."state" = ');
    expect(clause.params).toEqual(expect.arrayContaining(['c1', 'pending']));
  });
});
