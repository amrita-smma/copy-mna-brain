import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiWorkforceQueueRepository } from './aiWorkforceQueueRepository';

function makeMockDb() {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  return { db, selectChain, insertChain, updateChain };
}

describe('AiWorkforceQueueRepository.createOrGetByIdempotencyKey', () => {
  it('inserts directly when no idempotency_key is provided', async () => {
    const { db, insertChain } = makeMockDb();
    const newRow = { id: 'r1', agent_name: 'foo' };
    insertChain.returning.mockResolvedValueOnce([newRow]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.createOrGetByIdempotencyKey({
      agent_name: 'foo',
      trigger_source: 'chat',
      input: {},
    } as never);

    expect(result.created).toBe(true);
    expect(result.row).toBe(newRow);
    expect(insertChain.onConflictDoNothing).not.toHaveBeenCalled();
  });

  it('returns the inserted row when idempotency_key does not conflict', async () => {
    const { db, insertChain } = makeMockDb();
    const newRow = { id: 'r2', idempotency_key: 'k1' };
    insertChain.returning.mockResolvedValueOnce([newRow]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.createOrGetByIdempotencyKey({
      agent_name: 'foo',
      trigger_source: 'webhook',
      input: {},
      idempotency_key: 'k1',
    } as never);

    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ row: newRow, created: true });
  });

  it('returns the existing row when idempotency_key already exists', async () => {
    const { db, insertChain, selectChain } = makeMockDb();
    insertChain.returning.mockResolvedValueOnce([]); // ON CONFLICT DO NOTHING
    const existing = { id: 'r3', idempotency_key: 'k2' };
    selectChain.limit.mockResolvedValueOnce([existing]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.createOrGetByIdempotencyKey({
      agent_name: 'foo',
      trigger_source: 'webhook',
      input: {},
      idempotency_key: 'k2',
    } as never);

    expect(result).toEqual({ row: existing, created: false });
  });

  it('throws if ON CONFLICT returns nothing and the row also cannot be found', async () => {
    const { db, insertChain, selectChain } = makeMockDb();
    insertChain.returning.mockResolvedValueOnce([]);
    selectChain.limit.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(
      repo.createOrGetByIdempotencyKey({
        agent_name: 'foo',
        trigger_source: 'webhook',
        input: {},
        idempotency_key: 'k3',
      } as never),
    ).rejects.toThrow(/idempotency_key k3 conflicted but row not found/);
  });
});

describe('AiWorkforceQueueRepository.claimNextRunnable', () => {
  function makeTxMock(execResults: unknown[][]) {
    let i = 0;
    const tx = {
      execute: vi.fn().mockImplementation(() => {
        const result = execResults[i++] ?? [];
        return Promise.resolve(result);
      }),
    };
    return tx;
  }

  it('returns null when advisory lock is contended', async () => {
    const tx = makeTxMock([[{ locked: false }]]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.claimNextRunnable();

    expect(result).toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(1); // exited after lock check
  });

  it('returns null when something is already running', async () => {
    const tx = makeTxMock([
      [{ locked: true }],
      [{ has_running: true }],
    ]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.claimNextRunnable();

    expect(result).toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(2); // exited after running check
  });

  it('returns null when queue is empty (claim returns no rows)', async () => {
    const tx = makeTxMock([
      [{ locked: true }],
      [{ has_running: false }],
      [], // empty UPDATE result
    ]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.claimNextRunnable();

    expect(result).toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  it('returns the claimed row when one is available', async () => {
    const claimed = { id: 'r-99', status: 'running', agent_name: 'foo' };
    const tx = makeTxMock([
      [{ locked: true }],
      [{ has_running: false }],
      [claimed],
    ]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.claimNextRunnable();

    expect(result).toEqual(claimed);
  });
});

describe('AiWorkforceQueueRepository.markFailed / markSucceeded', () => {
  beforeEach(() => vi.clearAllMocks());

  it('markSucceeded updates status + output + ended_at', async () => {
    const { db, updateChain } = makeMockDb();
    const row = { id: 'r1', status: 'succeeded', output: { ok: true } };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.markSucceeded('r1', { ok: true });

    expect(result).toEqual(row);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        output: { ok: true },
        error: null,
      }),
    );
  });

  it('markFailed throws when row not found', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(
      repo.markFailed('missing', { code: 'oops' }),
    ).rejects.toThrow(/row missing not found/);
  });
});

describe('AiWorkforceQueueRepository.markWaitingForHumanInput', () => {
  it('updates status to waiting_for_human_input with reason', async () => {
    const { db, updateChain } = makeMockDb();
    const row = { id: 'r1', status: 'waiting_for_human_input' };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.markWaitingForHumanInput('r1', 'awaiting approval');

    expect(result).toBe(row);
    expect(updateChain.set).toHaveBeenCalledWith({
      status: 'waiting_for_human_input',
      resume_reason: 'awaiting approval',
    });
  });

  it('throws when the row does not exist', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(
      repo.markWaitingForHumanInput('missing', 'x'),
    ).rejects.toThrow(/not found/);
  });
});

describe('AiWorkforceQueueRepository.appendDecision', () => {
  it('appends one decision via jsonb concat and returns the row', async () => {
    const { db, updateChain } = makeMockDb();
    const row = { id: 'r1', human_decisions: [] };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const decision = {
      tool_call_id: 'c-1',
      tool_name: 'promote_to_l1',
      decision: 'approve' as const,
      decided_at: '2026-05-15T10:00:00Z',
    };
    const result = await repo.appendDecision('r1', decision);

    expect(result).toBe(row);
    expect(updateChain.set).toHaveBeenCalledTimes(1);
    // The set arg is a partial with a sql template for human_decisions.
    // Light check: just confirm the key was patched.
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg).toHaveProperty('human_decisions');
  });

  it('throws when the row does not exist', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(
      repo.appendDecision('missing', {
        tool_call_id: 'c-1',
        tool_name: 'promote_to_l1',
        decision: 'approve',
        decided_at: '2026-05-15T10:00:00Z',
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('AiWorkforceQueueRepository.isTerminal', () => {
  it('classifies terminal vs non-terminal statuses', () => {
    expect(AiWorkforceQueueRepository.isTerminal('succeeded')).toBe(true);
    expect(AiWorkforceQueueRepository.isTerminal('failed')).toBe(true);
    expect(AiWorkforceQueueRepository.isTerminal('rejected')).toBe(true);
    expect(AiWorkforceQueueRepository.isTerminal('timed_out')).toBe(true);
    expect(AiWorkforceQueueRepository.isTerminal('pending')).toBe(false);
    expect(AiWorkforceQueueRepository.isTerminal('running')).toBe(false);
    expect(AiWorkforceQueueRepository.isTerminal('resume_ready')).toBe(false);
    expect(
      AiWorkforceQueueRepository.isTerminal('waiting_for_human_input'),
    ).toBe(false);
    expect(
      AiWorkforceQueueRepository.isTerminal('waiting_for_subagent'),
    ).toBe(false);
  });
});
