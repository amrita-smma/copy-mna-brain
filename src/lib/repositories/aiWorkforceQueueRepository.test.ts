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

describe('AiWorkforceQueueRepository.cancelById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips a non-terminal row to failed with cancellation marker', async () => {
    const { db, updateChain } = makeMockDb();
    const row = { id: 'r1', status: 'failed' };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.cancelById('r1', { userId: 'u1', reason: 'too slow' });

    expect(result).toBe(row);
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.status).toBe('failed');
    expect(setArg.error).toMatchObject({
      code: 'cancelled_by_user',
      cancelled_by_user_id: 'u1',
      reason: 'too slow',
    });
    expect(setArg.error.cancelled_at).toBeTypeOf('string');
    expect(setArg.ended_at).toBeTypeOf('string');
  });

  it('omits cancelled_by_user_id / reason when not provided', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([{ id: 'r2', status: 'failed' }]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.cancelById('r2');

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.error).not.toHaveProperty('cancelled_by_user_id');
    expect(setArg.error).not.toHaveProperty('reason');
    expect(setArg.error.code).toBe('cancelled_by_user');
  });

  it('returns null when the row is already terminal (predicate matches nothing)', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.cancelById('r3');

    expect(result).toBeNull();
  });
});

describe('AiWorkforceQueueRepository.retryById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a fresh pending row carrying retried_from_id', async () => {
    const { db, selectChain, insertChain } = makeMockDb();
    const original = {
      id: 'orig',
      agent_name: 'analysis',
      trigger_source: 'chat',
      input: { prompt: 'hi' },
      priority: 5,
      parent_run_id: null,
      origin_routine_id: null,
      triggered_by_user_id: 'u-original',
      title: 'My task',
      status: 'failed',
    };
    selectChain.limit.mockResolvedValueOnce([original]);
    const newRow = { id: 'new', retried_from_id: 'orig' };
    insertChain.returning.mockResolvedValueOnce([newRow]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.retryById('orig', { userId: 'u-new' });

    expect(result).toBe(newRow);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_name: 'analysis',
        trigger_source: 'chat',
        input: { prompt: 'hi' },
        priority: 5,
        title: 'My task',
        retried_from_id: 'orig',
        // userId arg overrides the original's owner
        triggered_by_user_id: 'u-new',
      }),
    );
    // No idempotency_key, no trigger_meta carried over
    const values = insertChain.values.mock.calls[0][0];
    expect(values).not.toHaveProperty('idempotency_key');
    expect(values).not.toHaveProperty('trigger_meta');
  });

  it('falls back to the original triggered_by_user_id when no userId is supplied', async () => {
    const { db, selectChain, insertChain } = makeMockDb();
    selectChain.limit.mockResolvedValueOnce([
      {
        id: 'orig',
        agent_name: 'a',
        trigger_source: 'cron',
        input: {},
        priority: 0,
        parent_run_id: null,
        origin_routine_id: 'rt-1',
        triggered_by_user_id: 'u-original',
        title: null,
      },
    ]);
    insertChain.returning.mockResolvedValueOnce([{ id: 'new' }]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.retryById('orig');

    const values = insertChain.values.mock.calls[0][0];
    expect(values.triggered_by_user_id).toBe('u-original');
    expect(values.origin_routine_id).toBe('rt-1');
  });

  it('throws when the original row does not exist', async () => {
    const { db, selectChain } = makeMockDb();
    selectChain.limit.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(repo.retryById('missing')).rejects.toThrow(/row missing not found/);
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

describe('AiWorkforceQueueRepository.markResumeReady', () => {
  it('persists status, resume_reason, and resume_token when token is provided', async () => {
    const { db, updateChain } = makeMockDb();
    const row = { id: 'r1', status: 'resume_ready' };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const payloadJson = JSON.stringify({ decisions: [{ type: 'approve' }] });
    const result = await repo.markResumeReady('r1', 'human approve', payloadJson);

    expect(result).toBe(row);
    expect(updateChain.set).toHaveBeenCalledWith({
      status: 'resume_ready',
      resume_reason: 'human approve',
      resume_token: payloadJson,
    });
  });

  it('omits resume_token from the patch when not provided', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([{ id: 'r1' }]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.markResumeReady('r1', 'subagent done');

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg).toEqual({
      status: 'resume_ready',
      resume_reason: 'subagent done',
    });
    expect(setArg).not.toHaveProperty('resume_token');
  });
});

describe('AiWorkforceQueueRepository.setPriorities', () => {
  it('returns early without opening a transaction when the update list is empty', async () => {
    const { db } = makeMockDb();
    const repo = new AiWorkforceQueueRepository(db as never);

    await repo.setPriorities([]);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('issues one UPDATE per id inside a single transaction', async () => {
    const { db, updateChain } = makeMockDb();
    // updateChain.where is mockReturnThis(), so resolves to itself; we just
    // need the call counts and arguments.
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.setPriorities([
      { id: 'r1', priority: 3 },
      { id: 'r2', priority: 2 },
      { id: 'r3', priority: 1 },
    ]);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(3);
    expect(updateChain.set).toHaveBeenNthCalledWith(1, { priority: 3 });
    expect(updateChain.set).toHaveBeenNthCalledWith(2, { priority: 2 });
    expect(updateChain.set).toHaveBeenNthCalledWith(3, { priority: 1 });
  });
});

describe('AiWorkforceQueueRepository.clearResumeToken', () => {
  it('updates resume_token to null without throwing on missing rows', async () => {
    const { db, updateChain } = makeMockDb();
    // No .returning() chain expected — clearResumeToken is fire-and-forget.
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(repo.clearResumeToken('r1')).resolves.toBeUndefined();

    expect(updateChain.set).toHaveBeenCalledWith({ resume_token: null });
  });
});

describe('AiWorkforceQueueRepository.appendPendingUserMessage', () => {
  it('returns queue_position equal to the post-append buffer length', async () => {
    const { db, updateChain } = makeMockDb();
    const row = {
      id: 'r1',
      pending_user_messages: [{ id: 'm-old' }, { id: 'm-new' }],
    };
    updateChain.returning.mockResolvedValueOnce([row]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.appendPendingUserMessage('r1', {
      id: 'm-new',
      text: 'hello',
      submitted_at: '2026-06-04T10:00:00Z',
      submitted_by_user_id: 'u1',
    });

    expect(result.row).toBe(row);
    expect(result.queue_position).toBe(2);
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg).toHaveProperty('pending_user_messages');
  });

  it('throws when the row does not exist', async () => {
    const { db, updateChain } = makeMockDb();
    updateChain.returning.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(
      repo.appendPendingUserMessage('missing', {
        id: 'm',
        text: 't',
        submitted_at: 'now',
        submitted_by_user_id: 'u',
      }),
    ).rejects.toThrow(/row missing not found/);
  });
});

describe('AiWorkforceQueueRepository.consumePendingUserMessages', () => {
  function makeTxChainMock(rows: unknown[]) {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const tx = {
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn().mockReturnValue(updateChain),
    };
    return { tx, selectChain, updateChain };
  }

  it('returns [] and skips the UPDATE when the buffer is empty', async () => {
    const { tx, updateChain } = makeTxChainMock([{ msgs: [] }]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.consumePendingUserMessages('r1');

    expect(result).toEqual([]);
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('returns the previous buffer and clears it in a single tx when present', async () => {
    const msgs = [
      { id: 'm1', text: 'a', submitted_at: 't1', submitted_by_user_id: 'u1' },
      { id: 'm2', text: 'b', submitted_at: 't2', submitted_by_user_id: 'u1' },
    ];
    const { tx, updateChain } = makeTxChainMock([{ msgs }]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.consumePendingUserMessages('r1');

    expect(result).toEqual(msgs);
    expect(updateChain.set).toHaveBeenCalledWith({ pending_user_messages: [] });
  });

  it('returns [] when the row is not found', async () => {
    const { tx, updateChain } = makeTxChainMock([]);
    const { db } = makeMockDb();
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.consumePendingUserMessages('missing');

    expect(result).toEqual([]);
    expect(updateChain.set).not.toHaveBeenCalled();
  });
});

describe('AiWorkforceQueueRepository notifications', () => {
  function makeNotifTxMock(currentError: unknown) {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ error: currentError }]),
    };
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    };
    const tx = {
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn().mockReturnValue(updateChain),
    };
    return { tx, selectChain, updateChain };
  }

  beforeEach(() => vi.clearAllMocks());

  function makeNotif(overrides: Record<string, unknown> = {}) {
    return {
      id: 'n-1',
      kind: 'request_timeout' as const,
      severity: 'critical' as const,
      title: 'Request timed out',
      description: 'The upstream call did not respond in time.',
      actions: [],
      dismissible: true,
      autoDismissMs: null,
      dismissedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('addNotification appends to an empty error payload', async () => {
    const { db } = makeMockDb();
    const { tx, updateChain } = makeNotifTxMock(null);
    const newRow = { id: 'r-1', error: { notifications: [makeNotif()] } };
    updateChain.returning.mockResolvedValueOnce([newRow]);
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.addNotification('r-1', makeNotif());

    expect(result).toBe(newRow);
    expect(updateChain.set).toHaveBeenCalledTimes(1);
    const patch = updateChain.set.mock.calls[0][0] as { error: { notifications: unknown[] } };
    expect(patch.error.notifications).toHaveLength(1);
  });

  it('addNotification preserves other error keys (e.g. cancelled_by_user)', async () => {
    const { db } = makeMockDb();
    const existing = { code: 'something_else', other_field: true };
    const { tx, updateChain } = makeNotifTxMock(existing);
    updateChain.returning.mockResolvedValueOnce([{ id: 'r-1' }]);
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.addNotification('r-1', makeNotif());

    const patch = updateChain.set.mock.calls[0][0] as { error: Record<string, unknown> };
    expect(patch.error.code).toBe('something_else');
    expect(patch.error.other_field).toBe(true);
    expect(patch.error.notifications).toHaveLength(1);
  });

  it('addNotification throws when the row does not exist', async () => {
    const { db } = makeMockDb();
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tx = {
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    await expect(repo.addNotification('missing', makeNotif())).rejects.toThrow(
      /ai_workforce_queue row missing not found/,
    );
  });

  it('dismissNotification sets dismissedAt on the matching id only', async () => {
    const { db } = makeMockDb();
    const a = makeNotif({ id: 'a' });
    const b = makeNotif({ id: 'b' });
    const c = makeNotif({ id: 'c', dismissedAt: '2025-01-01T00:00:00Z' });
    const { tx, updateChain } = makeNotifTxMock({ notifications: [a, b, c] });
    updateChain.returning.mockResolvedValueOnce([{ id: 'r-1' }]);
    db.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.dismissNotification('r-1', 'b');

    const patch = updateChain.set.mock.calls[0][0] as {
      error: { notifications: Array<{ id: string; dismissedAt: string | null }> };
    };
    const dismissed = patch.error.notifications.find((n) => n.id === 'b');
    expect(dismissed?.dismissedAt).toBeTruthy();
    expect(
      patch.error.notifications.find((n) => n.id === 'a')?.dismissedAt,
    ).toBeNull();
    // Already-dismissed rows must not be overwritten.
    expect(
      patch.error.notifications.find((n) => n.id === 'c')?.dismissedAt,
    ).toBe('2025-01-01T00:00:00Z');
  });

  it('listNotifications filters dismissed by default', () => {
    const repo = new AiWorkforceQueueRepository({} as never);
    const a = makeNotif({ id: 'a' });
    const b = makeNotif({ id: 'b', dismissedAt: '2026-01-01T00:00:00Z' });
    const row = { error: { notifications: [a, b] } } as never;

    expect(repo.listNotifications(row).map((n) => n.id)).toEqual(['a']);
    expect(
      repo.listNotifications(row, { includeDismissed: true }).map((n) => n.id),
    ).toEqual(['a', 'b']);
  });

  it('listNotifications tolerates null/non-object error payloads', () => {
    const repo = new AiWorkforceQueueRepository({} as never);
    expect(repo.listNotifications({ error: null } as never)).toEqual([]);
    expect(repo.listNotifications({ error: 'oops' } as never)).toEqual([]);
    expect(repo.listNotifications({ error: ['arr'] } as never)).toEqual([]);
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

describe('AiWorkforceQueueRepository.listFiltered', () => {
  function makeListDb() {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };
    const db = {
      select: vi.fn().mockReturnValue(chain),
    };
    return { db, chain };
  }

  it('returns [] without hitting the DB when status is an empty array', async () => {
    const { db } = makeListDb();
    const repo = new AiWorkforceQueueRepository(db as never);

    const result = await repo.listFiltered({ status: [] });

    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('passes no WHERE clause when no filters are provided', async () => {
    const { db, chain } = makeListDb();
    chain.limit.mockResolvedValueOnce([]);

    const repo = new AiWorkforceQueueRepository(db as never);
    await repo.listFiltered({});

    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledWith(undefined);
    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it('combines status, agentName, and triggeredByUserId into a single AND', async () => {
    const { db, chain } = makeListDb();
    const rows = [{ id: 'r1' }];
    chain.limit.mockResolvedValueOnce(rows);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.listFiltered({
      status: 'running',
      agentName: 'chat_handoff',
      triggeredByUserId: 'user-1',
      limit: 5,
    });

    expect(result).toBe(rows);
    expect(chain.where).toHaveBeenCalledTimes(1);
    // We don't introspect the drizzle SQL fragment; we just verify a clause
    // was attached and the limit propagated.
    expect(chain.where.mock.calls[0][0]).toBeDefined();
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it('accepts a status array and forwards rows from the chain', async () => {
    const { db, chain } = makeListDb();
    chain.limit.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const repo = new AiWorkforceQueueRepository(db as never);
    const result = await repo.listFiltered({
      status: ['failed', 'rejected', 'timed_out'],
    });

    expect(result).toHaveLength(2);
    expect(chain.where.mock.calls[0][0]).toBeDefined();
  });
});
