import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PipelineStageRepository } from './pipelineStageRepository';

const dialect = new PgDialect();
const render = (condition: SQL) => dialect.sqlToQuery(condition);

function makeChain() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

type Chain = ReturnType<typeof makeChain>;

describe('PipelineStageRepository', () => {
  let db: Chain & { transaction: ReturnType<typeof vi.fn> };
  let repo: PipelineStageRepository;

  beforeEach(() => {
    db = { ...makeChain(), transaction: vi.fn() };
    db.transaction.mockImplementation(async (fn: (tx: Chain) => unknown) => fn(db));
    repo = new PipelineStageRepository(db as never, 'ws-a');
  });

  it('list scopes to the workspace and orders by position, deleted rows included', async () => {
    db.orderBy.mockResolvedValueOnce([{ key: 'L0' }]);
    await expect(repo.list()).resolves.toEqual([{ key: 'L0' }]);
    const where = render(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"workspace_id" = $1');
    expect(where.sql).not.toContain('deleted_at');
    expect(where.params).toEqual(['ws-a']);
  });

  it('insertAfter shifts later stages down and inserts at the next position in one transaction', async () => {
    db.returning.mockResolvedValueOnce([{ key: 'stg-1', position: 3 }]);
    const row = await repo.insertAfter(2, {
      key: 'stg-1',
      code: 'L2b',
      name: 'Expert Calls',
      description: '',
    });

    expect(row).toEqual({ key: 'stg-1', position: 3 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const shift = render(db.where.mock.calls[0][0]);
    expect(shift.sql).toContain('"workspace_id" = $1');
    expect(shift.sql).toContain('"position" > $2');
    expect(shift.params).toEqual(['ws-a', 2]);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'ws-a', key: 'stg-1', position: 3 }),
    );
  });

  it('update only touches a live stage in this workspace', async () => {
    db.returning.mockResolvedValueOnce([]);
    await expect(repo.update('L1', { name: 'Screening' })).resolves.toBeUndefined();
    const where = render(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"deleted_at" is null');
    expect(where.params).toEqual(['ws-a', 'L1']);
  });

  it('updateMany parks the edited codes, then writes every field in one statement, in one transaction', async () => {
    db.where.mockReturnValueOnce(Promise.resolve(undefined)).mockReturnValueOnce(db);
    db.returning.mockResolvedValueOnce([{ key: 'L1' }, { key: 'L2' }]);

    const rows = await repo.updateMany([
      { key: 'L1', code: 'L2', name: 'Deep Dive', description: '' },
      { key: 'L2', code: 'L1', name: 'Screening', description: 'First pass' },
    ]);

    expect(rows).toEqual([{ key: 'L1' }, { key: 'L2' }]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(2);
    const park = db.set.mock.calls[0][0] as { code: SQL };
    expect(render(park.code).sql).toContain(`'~' ||`);
    const write = db.set.mock.calls[1][0] as { code: SQL; name: SQL; description: SQL };
    expect(render(write.code).sql).toContain('CASE');
    expect(render(write.name).params).toEqual(['L1', 'Deep Dive', 'L2', 'Screening']);
    for (const call of db.where.mock.calls) {
      const where = render(call[0]);
      expect(where.sql).toContain('"workspace_id" = $1');
      expect(where.sql).toContain('"deleted_at" is null');
      expect(where.params).toEqual(['ws-a', 'L1', 'L2']);
    }
  });

  it('updateMany is a no-op for an empty list', async () => {
    await expect(repo.updateMany([])).resolves.toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('setPositions writes every position in a single statement', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.setPositions([
      { key: 'L2', position: 3 },
      { key: 'L3', position: 2 },
    ]);
    expect(db.update).toHaveBeenCalledTimes(1);
    const set = db.set.mock.calls[0][0] as { position: SQL };
    expect(render(set.position).sql).toContain('CASE');
  });

  it('setPositions is a no-op for an empty list', async () => {
    await repo.setPositions([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('softDelete stamps deleted_at on a live stage only', async () => {
    db.returning.mockResolvedValueOnce([{ key: 'L2' }]);
    await expect(repo.softDelete('L2')).resolves.toEqual({ key: 'L2' });
    expect(db.set).toHaveBeenCalledWith({ deleted_at: expect.anything() });
    const where = render(db.where.mock.calls[0][0]);
    expect(where.sql).toContain('"deleted_at" is null');
  });
});
