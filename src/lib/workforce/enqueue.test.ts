import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrGetByIdempotencyKey,
  afterCalls,
  after,
  dispatcherTick,
  createDb,
  generateWorkforceTitle,
} = vi.hoisted(() => {
  const afterCalls: Array<() => Promise<void>> = [];
  return {
    createOrGetByIdempotencyKey: vi.fn(),
    afterCalls,
    after: vi.fn((fn: () => Promise<void>) => {
      afterCalls.push(fn);
    }),
    dispatcherTick: vi.fn(),
    createDb: vi.fn(),
    generateWorkforceTitle: vi.fn(),
  };
});

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    createOrGetByIdempotencyKey = createOrGetByIdempotencyKey;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

// after() defers work until after the response is sent — for tests, capture
// the callback so we can invoke it manually and assert downstream effects.
vi.mock('next/server', () => ({ after }));

vi.mock('./dispatcher', () => ({ dispatcherTick }));

vi.mock('./title', () => ({ generateWorkforceTitle }));

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

import { enqueueAgentRun } from './enqueue';

const fakeDb = {} as never;

describe('enqueueAgentRun', () => {
  beforeEach(() => {
    createOrGetByIdempotencyKey.mockReset();
    dispatcherTick.mockReset();
    createDb.mockReset();
    createDb.mockReturnValue(fakeDb);
    generateWorkforceTitle.mockReset();
    generateWorkforceTitle.mockResolvedValue('Mock title');
    afterCalls.length = 0;
  });

  it('inserts and schedules dispatch for a fresh run', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-1' },
      created: true,
    });

    const result = await enqueueAgentRun(fakeDb, {
      agentName: 'research',
      triggerSource: 'chat',
      input: { topic: 'X' },
    });

    expect(result).toEqual({ runId: 'r-1', created: true });
    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_name: 'research',
        trigger_source: 'chat',
        input: { topic: 'X' },
        priority: 0,
        trigger_meta: {},
      }),
    );
    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    expect(afterCalls).toHaveLength(0); // No title gen because no prompt
  });

  // Regression guard: createOrGetByIdempotencyKey is deliberately unscoped
  // (MB-147 surface) and does not stamp workspace_id itself — the caller
  // must supply a complete row. A prior version omitted this field (masked
  // by an `as never` cast) and violated the NOT NULL constraint on every
  // real insert despite this exact test passing, since the mock never
  // checked for the field's presence.
  it('always includes workspace_id in the insert payload', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-1' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'research',
      triggerSource: 'chat',
      input: { topic: 'X' },
    });

    const [insertArg] = createOrGetByIdempotencyKey.mock.calls[0];
    expect(insertArg.workspace_id).toBeTruthy();
  });

  it('does not schedule dispatch when idempotency-key returned an existing row', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-existing' },
      created: false,
    });

    const result = await enqueueAgentRun(fakeDb, {
      agentName: 'research',
      triggerSource: 'webhook',
      input: {},
      idempotencyKey: 'webhook-evt-42',
    });

    expect(result).toEqual({ runId: 'r-existing', created: false });
    expect(dispatcherTick).not.toHaveBeenCalled();
    expect(afterCalls).toHaveLength(0);
  });

  it('passes trigger_meta + priority through', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-2' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'lead_scan',
      triggerSource: 'cron',
      triggerMeta: { routine_id: 'rt-1', fired_at: '2026-05-12T09:00:00Z' },
      input: {},
      priority: 5,
    });

    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 5,
        trigger_meta: {
          routine_id: 'rt-1',
          fired_at: '2026-05-12T09:00:00Z',
        },
      }),
    );
  });

  it('the synchronous dispatcher uses a fresh DbClient (not the request one)', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-3' },
      created: true,
    });
    dispatcherTick.mockResolvedValue({ outcome: 'claimed', runId: 'r-3' });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'api',
      input: {},
    });

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    expect(dispatcherTick).toHaveBeenCalledWith(fakeDb);
  });

  it('persists origin_routine_id when provided', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-or' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'analysis',
      triggerSource: 'cron',
      input: {},
      originRoutineId: 'rt-99',
    });

    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ origin_routine_id: 'rt-99' }),
    );
  });

  it('defaults origin_routine_id to null', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-no' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'analysis',
      triggerSource: 'chat',
      input: {},
    });

    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ origin_routine_id: null }),
    );
  });

  it('persists triggered_by_user_id when provided', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-u' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: {},
      triggeredByUserId: 'user-42',
    });

    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ triggered_by_user_id: 'user-42' }),
    );
  });

  it('defaults triggered_by_user_id to null', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-nu' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'cron',
      input: {},
    });

    expect(createOrGetByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ triggered_by_user_id: null }),
    );
  });

  it('schedules title generation when input.prompt is a string', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-t' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { prompt: 'Refresh project Oriole' },
    });

    // One after() callback: for title generation.
    expect(afterCalls).toHaveLength(1);

    await afterCalls[0]();
    expect(generateWorkforceTitle).toHaveBeenCalledWith(
      'r-t',
      'Refresh project Oriole',
    );
  });

  it('skips title generation when input.prompt is missing', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-no-prompt' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { topic: 'X' }, // no prompt field
    });

    // Only the synchronous dispatcher, no title gen.
    expect(afterCalls).toHaveLength(0);
    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    expect(generateWorkforceTitle).not.toHaveBeenCalled();
  });

  it('skips title generation when prompt is not a string', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-bad-prompt' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { prompt: { nested: 'object' } },
    });

    expect(afterCalls).toHaveLength(0);
    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    expect(generateWorkforceTitle).not.toHaveBeenCalled();
  });

  it('does not schedule title generation for idempotency-key duplicates', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-dup' },
      created: false,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'webhook',
      input: { prompt: 'hello' },
      idempotencyKey: 'k1',
    });

    expect(afterCalls).toHaveLength(0);
  });

  it('swallows dispatcher errors so the response is not affected', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-4' },
      created: true,
    });
    dispatcherTick.mockRejectedValueOnce(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'api',
      input: {},
    });

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
