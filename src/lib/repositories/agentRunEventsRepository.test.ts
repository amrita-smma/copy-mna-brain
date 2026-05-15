import { describe, it, expect, vi } from 'vitest';
import { AgentRunEventsRepository } from './agentRunEventsRepository';

function makeMockDb() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    execute: vi.fn(),
  };
  return { db, selectChain, insertChain };
}

describe('AgentRunEventsRepository.append', () => {
  it('assigns seq = MAX(seq)+1 from the SELECT result', async () => {
    const { db, insertChain } = makeMockDb();
    db.execute.mockResolvedValueOnce([{ next_seq: 7 }]);
    const inserted = { id: 1, run_id: 'r1', seq: 7, kind: 'tool_call' };
    insertChain.returning.mockResolvedValueOnce([inserted]);

    const repo = new AgentRunEventsRepository(db as never);
    const result = await repo.append({
      run_id: 'r1',
      kind: 'tool_call',
      payload: { name: 'foo' },
    });

    expect(result).toEqual(inserted);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'r1', seq: 7, kind: 'tool_call' }),
    );
  });

  it('defaults seq to 1 when the SELECT returns nothing for a new run', async () => {
    const { db, insertChain } = makeMockDb();
    db.execute.mockResolvedValueOnce([]);
    insertChain.returning.mockResolvedValueOnce([{ id: 2 }]);

    const repo = new AgentRunEventsRepository(db as never);
    await repo.append({
      run_id: 'r-new',
      kind: 'assistant_message',
      payload: {},
    });

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 1 }),
    );
  });

  it('passes through optional latency/token fields', async () => {
    const { db, insertChain } = makeMockDb();
    db.execute.mockResolvedValueOnce([{ next_seq: 1 }]);
    insertChain.returning.mockResolvedValueOnce([{ id: 3 }]);

    const repo = new AgentRunEventsRepository(db as never);
    await repo.append({
      run_id: 'r',
      kind: 'tool_result',
      payload: {},
      latency_ms: 142,
      tokens_in: 100,
      tokens_out: 50,
    });

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        latency_ms: 142,
        tokens_in: 100,
        tokens_out: 50,
      }),
    );
  });
});

describe('AgentRunEventsRepository list helpers', () => {
  it('listForRun queries by run_id ordered by seq', async () => {
    const { db, selectChain } = makeMockDb();
    const rows = [{ seq: 1 }, { seq: 2 }];
    selectChain.orderBy.mockResolvedValueOnce(rows);

    const repo = new AgentRunEventsRepository(db as never);
    const result = await repo.listForRun('r1');

    expect(result).toEqual(rows);
    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('listSinceSeq queries by run_id + seq > cursor', async () => {
    const { db, selectChain } = makeMockDb();
    selectChain.orderBy.mockResolvedValueOnce([{ seq: 6 }]);

    const repo = new AgentRunEventsRepository(db as never);
    await repo.listSinceSeq('r1', 5);

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });
});
