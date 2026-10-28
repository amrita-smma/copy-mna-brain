import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrGetByIdempotencyKey,
  afterCalls,
  after,
  dispatcherTick,
  createDb,
  generateWorkforceTitle,
  persistWorkforceTitle,
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
    persistWorkforceTitle: vi.fn(),
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

const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

vi.mock('./title', () => ({
  generateWorkforceTitle,
  persistWorkforceTitle,
  TITLE_MAX_CHARS: 80,
}));

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

import { enqueueAgentRun } from './enqueue';
// Deliberately not mocked: the attribution assertions below need the real store.
import { getLangfuseUserId } from '@/lib/langfuseUser';

const fakeDb = {} as never;

describe('enqueueAgentRun', () => {
  beforeEach(() => {
    createOrGetByIdempotencyKey.mockReset();
    dispatcherTick.mockReset();
    createDb.mockReset();
    createDb.mockReturnValue(fakeDb);
    generateWorkforceTitle.mockReset();
    generateWorkforceTitle.mockResolvedValue('Mock title');
    persistWorkforceTitle.mockReset();
    persistWorkforceTitle.mockResolvedValue(undefined);
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

  it('stamps the passed workspace instead of the fallback when a caller has no request', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-1' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'crm_contact',
      triggerSource: 'cron',
      input: { title: 'X' },
      workspaceId: 'ws-b',
    });

    const [insertArg] = createOrGetByIdempotencyKey.mock.calls[0];
    expect(insertArg.workspace_id).toBe('ws-b');
  });

  it('publishes the new run on the workforce live topic, but not an existing row', async () => {
    liveMocks.publishLiveEvent.mockClear();
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-new' }, created: true });
    await enqueueAgentRun(fakeDb, { agentName: 'research', triggerSource: 'webhook', input: {}, workspaceId: 'ws-a' });
    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith('ws-a', 'workforce', ['r-new']);

    liveMocks.publishLiveEvent.mockClear();
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-existing' }, created: false });
    await enqueueAgentRun(fakeDb, { agentName: 'research', triggerSource: 'webhook', input: {}, workspaceId: 'ws-a' });
    expect(liveMocks.publishLiveEvent).not.toHaveBeenCalled();
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

  const LONG_TITLE =
    'Build the semiconductor value-chain conviction ranking (15 stages, ~103 names) as an HTML report insight';

  it.each([
    ['verbatim (trimmed)', '  Build value-chain ranking  ', 'Build value-chain ranking'],
    ['truncated to 80 chars', `  ${LONG_TITLE}  `, LONG_TITLE.slice(0, 80)],
  ])('persists input.title %s after the response and skips Haiku', async (_label, title, persisted) => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-title' }, created: true });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { title, prompt: 'Very long prompt...' },
    });

    expect(persistWorkforceTitle).not.toHaveBeenCalled();
    expect(afterCalls).toHaveLength(1);
    await afterCalls[0]();
    expect(persistWorkforceTitle).toHaveBeenCalledWith('r-title', persisted);
    expect(generateWorkforceTitle).not.toHaveBeenCalled();
  });

  it('falls back to the Haiku path when input.title is whitespace-only', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-ws' }, created: true });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { title: '   ', prompt: 'Refresh project Oriole' },
    });

    await afterCalls[0]();
    expect(persistWorkforceTitle).not.toHaveBeenCalled();
    expect(generateWorkforceTitle).toHaveBeenCalledWith('r-ws', 'Refresh project Oriole');
  });

  it('falls back to the Haiku path when input.title is absent and input.prompt is present', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({
      row: { id: 'r-t' },
      created: true,
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { prompt: 'Refresh project Oriole' },
    });

    expect(persistWorkforceTitle).not.toHaveBeenCalled();
    expect(afterCalls).toHaveLength(1);

    await afterCalls[0]();
    expect(generateWorkforceTitle).toHaveBeenCalledWith(
      'r-t',
      'Refresh project Oriole',
    );
  });

  it('attributes the generated title to whoever enqueued the run', async () => {
    // The `after` callback runs after the response, off this request's async
    // chain, so the scope has to be opened inside it rather than inherited.
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-u' }, created: true });
    let userDuringTitle: string | undefined;
    generateWorkforceTitle.mockImplementation(async () => {
      userDuringTitle = getLangfuseUserId();
      return 'Mock title';
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'chat',
      input: { prompt: 'Refresh project Oriole' },
      triggeredByUserId: 'u-7',
    });
    await afterCalls[0]();

    expect(userDuringTitle).toBe('u-7');
    expect(getLangfuseUserId()).toBeUndefined();
  });

  it('leaves a cron enqueue with no user unattributed', async () => {
    createOrGetByIdempotencyKey.mockResolvedValueOnce({ row: { id: 'r-cron' }, created: true });
    let userDuringTitle: string | undefined = 'sentinel';
    generateWorkforceTitle.mockImplementation(async () => {
      userDuringTitle = getLangfuseUserId();
      return 'Mock title';
    });

    await enqueueAgentRun(fakeDb, {
      agentName: 'x',
      triggerSource: 'cron',
      input: { prompt: 'Nightly refresh' },
    });
    await afterCalls[0]();

    expect(generateWorkforceTitle).toHaveBeenCalledWith('r-cron', 'Nightly refresh');
    expect(userDuringTitle).toBeUndefined();
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
