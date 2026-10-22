import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotMemoryRepository } from './botMemoryRepository';

const note = (text: string) => ({ text, created_at: 't' });
const row = { id: 'm1', workspace_id: 'ws-1', bot_id: 'b1', user_id: 'u1', notes: [note('x')] };

/** Three query chains, each returning itself explicitly (the methods are called detached from `db`/`tx`). */
function makeDb() {
  const select = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(),
  };
  select.select.mockImplementation(() => select);
  select.from.mockImplementation(() => select);
  select.where.mockImplementation(() => select);
  const insert = { insert: vi.fn(), values: vi.fn(), onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
  insert.insert.mockImplementation(() => insert);
  insert.values.mockImplementation(() => insert);
  const update = { update: vi.fn(), set: vi.fn(), where: vi.fn().mockResolvedValue(undefined) };
  update.update.mockImplementation(() => update);
  update.set.mockImplementation(() => update);
  const tx = { select: select.select, insert: insert.insert, update: update.update };
  const db = {
    select: select.select,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, select, insert, update };
}

describe('BotMemoryRepository.find', () => {
  let m: ReturnType<typeof makeDb>;
  beforeEach(() => {
    m = makeDb();
  });

  it('returns the row for the bot and user, or null when there is none', async () => {
    const repo = new BotMemoryRepository(m.db as never, 'ws-1');
    m.select.limit.mockResolvedValueOnce([row]);
    expect(await repo.find('b1', 'u1')).toEqual(row);
    m.select.limit.mockResolvedValueOnce([]);
    expect(await repo.find('b1', 'u2')).toBeNull();
    expect(m.select.limit).toHaveBeenCalledWith(1);
  });
});

describe('BotMemoryRepository.update', () => {
  it('creates the row if missing, locks it, hands the current notes to the change and writes the result', async () => {
    const m = makeDb();
    const repo = new BotMemoryRepository(m.db as never, 'ws-1');
    m.select.for.mockResolvedValueOnce([row]);
    const change = vi.fn(() => [note('x'), note('y')]);

    expect(await repo.update('b1', 'u1', change)).toEqual([note('x'), note('y')]);

    expect(m.db.transaction).toHaveBeenCalledTimes(1);
    expect(m.insert.values).toHaveBeenCalledWith({ workspace_id: 'ws-1', bot_id: 'b1', user_id: 'u1', notes: [] });
    expect(m.insert.onConflictDoNothing.mock.calls[0][0].target).toHaveLength(2);
    expect(m.select.for).toHaveBeenCalledWith('update');
    expect(change).toHaveBeenCalledWith([note('x')]);
    expect(m.update.set.mock.calls[0][0].notes).toEqual([note('x'), note('y')]);
  });

  it('writes nothing when the change returns null, and returns what is there', async () => {
    const m = makeDb();
    const repo = new BotMemoryRepository(m.db as never, 'ws-1');
    m.select.for.mockResolvedValueOnce([row]);
    expect(await repo.update('b1', 'u1', () => null)).toEqual([note('x')]);
    expect(m.update.update).not.toHaveBeenCalled();
  });
});
