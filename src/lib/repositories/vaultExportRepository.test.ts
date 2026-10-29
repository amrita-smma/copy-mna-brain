import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { VaultExportRepository } from './vaultExportRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
}

describe('VaultExportRepository.findLastArchivedAt', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: VaultExportRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new VaultExportRepository(db as never);
  });

  it('returns the newest archived export time, counting partial archives', async () => {
    db.limit.mockResolvedValueOnce([{ updated_at: '2026-10-28 03:00:00+00' }]);

    expect(await repo.findLastArchivedAt()).toBe('2026-10-28 03:00:00+00');

    const where = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"vault_exports"."status" in');
    expect(where.params).toEqual(['archived', 'archived_partial']);
    const order = new PgDialect().sqlToQuery(db.orderBy.mock.calls[0][0]);
    expect(order.sql).toContain('"vault_exports"."updated_at" desc');
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when no export has been archived yet', async () => {
    db.limit.mockResolvedValueOnce([]);
    expect(await repo.findLastArchivedAt()).toBeNull();
  });
});
