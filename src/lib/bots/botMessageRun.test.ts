import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  start: vi.fn(),
  create: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('workflow/api', () => ({ start: m.start }));
vi.mock('@/lib/repositories', () => ({
  JobRepository: class {
    create = m.create;
    markFailed = m.markFailed;
  },
}));
vi.mock('./botMessageWorkflow', () => ({ botMessageWorkflow: vi.fn() }));

import { BotMessageStartTimeoutError, START_RUN_TIMEOUT_MS, botJobType, startBotMessageRun } from './botMessageRun';
import { botMessageWorkflow } from './botMessageWorkflow';
import type { BotMessageJob } from '@/lib/services/botService';

const job: BotMessageJob = {
  userId: 'u1',
  origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
  toBotId: 'scout',
  text: 'Find targets',
  requestId: 'req-1',
};

describe('botJobType', () => {
  it('audits a routine firing, a fan-in reply and an @mention under their own job types', () => {
    expect(botJobType({ kind: 'routine', routine: { id: 'r1', title: 'Daily' } })).toBe('bot_routine');
    expect(botJobType({ kind: 'bot_reply', replies: [] })).toBe('bot_reply');
    expect(botJobType({ kind: 'bot_mention', fromBot: { id: 'a', name: 'A' } })).toBe('bot_message');
    expect(botJobType({ kind: 'user_mention', inBot: { id: 'a', name: 'A' } })).toBe('bot_message');
  });
});

describe('startBotMessageRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'job-1', ...input }));
    m.start.mockResolvedValue({ runId: 'run-1' });
    m.markFailed.mockResolvedValue(undefined);
  });

  it('inserts the audit row, then starts the workflow run with the message and the row id', async () => {
    const out = await startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });

    expect(m.create).toHaveBeenCalledWith({
      type: 'bot_message',
      payload: job,
      timeout_seconds: 600,
      workspace_id: 'ws-9',
    });
    expect(m.start).toHaveBeenCalledWith(botMessageWorkflow, [{ ...job, jobId: 'job-1', workspaceId: 'ws-9' }]);
    expect(m.create.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0]);
    expect(out).toEqual({ jobId: 'job-1', runId: 'run-1' });
  });

  it('does not run the turn itself: nothing but the row and the start call happens', async () => {
    await startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });
    expect(botMessageWorkflow).not.toHaveBeenCalled();
    expect(m.markFailed).not.toHaveBeenCalled();
  });

  it('fails the row and rethrows when the run cannot be started, so the caller sees it', async () => {
    m.start.mockRejectedValueOnce(new Error('no workflow world'));

    await expect(startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job })).rejects.toThrow(
      'no workflow world',
    );
    expect(m.markFailed).toHaveBeenCalledWith('job-1', 'could not start the workflow run: no workflow world');
  });

  it('reads the turn budget without loading the agent runtime', async () => {
    // The route runs this on a cold start: the constant comes from its own
    // light module, never from the handler (whose imports are the runtime).
    await startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });
    expect(m.create.mock.calls[0][0].timeout_seconds).toBe(600);
  });

  describe('when start() hangs', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('gives up at the deadline, fails the row with the reason, and throws a typed error', async () => {
      m.start.mockReturnValueOnce(new Promise(() => undefined));

      const pending = startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });
      const outcome = pending.then(
        () => 'resolved',
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(START_RUN_TIMEOUT_MS);
      const err = await outcome;

      expect(err).toBeInstanceOf(BotMessageStartTimeoutError);
      expect((err as BotMessageStartTimeoutError).jobId).toBe('job-1');
      expect(m.markFailed).toHaveBeenCalledWith(
        'job-1',
        'could not start the workflow run: starting the workflow run timed out after 15s',
      );
    });

    it('clears the deadline when start() returns in time', async () => {
      const out = await startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });
      expect(out).toEqual({ jobId: 'job-1', runId: 'run-1' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not leave an unhandled rejection when start() rejects after the deadline', async () => {
      m.start.mockReturnValueOnce(
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late')), START_RUN_TIMEOUT_MS + 1);
        }),
      );

      const pending = startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job });
      const outcome = expect(pending).rejects.toBeInstanceOf(BotMessageStartTimeoutError);
      await vi.advanceTimersByTimeAsync(START_RUN_TIMEOUT_MS);
      await outcome;
      await vi.advanceTimersByTimeAsync(1);
    });
  });

  it('still rethrows the start error when marking the row failed also fails', async () => {
    m.start.mockRejectedValueOnce(new Error('no workflow world'));
    m.markFailed.mockRejectedValueOnce(new Error('db gone'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(startBotMessageRun({ db: {} as never, workspaceId: 'ws-9', job })).rejects.toThrow(
      'no workflow world',
    );
    errorSpy.mockRestore();
  });
});
