import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  createDb: vi.fn(),
  startBotMessageRun: vi.fn(),
  appendLog: vi.fn(),
  closeRequest: vi.fn(),
  createContainer: vi.fn(),
  runWithWorkforceWorkspaceId: vi.fn(),
  // The route's `instanceof` runs against the mocked module's class.
  BotMessageStartTimeoutError: class extends Error {
    constructor(readonly jobId: string) {
      super('starting the workflow run timed out after 15s');
      this.name = 'BotMessageStartTimeoutError';
    }
  },
}));

vi.mock('@/lib/server/db', () => ({ createDb: m.createDb }));
vi.mock('@/lib/bots/botMessageRun', () => ({
  startBotMessageRun: m.startBotMessageRun,
  BotMessageStartTimeoutError: m.BotMessageStartTimeoutError,
}));
vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));
vi.mock('@/lib/workspace', () => ({ runWithWorkforceWorkspaceId: m.runWithWorkforceWorkspaceId }));
vi.mock('@/lib/repositories', () => ({
  JobRepository: class {
    appendLog = m.appendLog;
  },
}));

import { NOT_STARTED_NOTE, POST } from './route';

const message = {
  workspaceId: 'ws-9',
  userId: 'u1',
  toBotId: 'scout',
  text: 'Find targets',
  origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
  requestId: 'req-1',
};

function post(body: unknown, headers: Record<string, string> = { 'x-api-secret': 's3' }) {
  return new NextRequest('http://localhost/api/internal/bot-messages', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/internal/bot-messages', () => {
  const env = { ADMIN_SECRET: process.env.ADMIN_SECRET };
  const db = { tag: 'db' };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_SECRET = 's3';
    m.createDb.mockReturnValue(db);
    m.startBotMessageRun.mockResolvedValue({ jobId: 'job-1', runId: 'run-1' });
    m.appendLog.mockResolvedValue(undefined);
    m.closeRequest.mockResolvedValue({ closed: true, repliedTo: 'copilot' });
    m.createContainer.mockReturnValue({ botRequestService: { close: m.closeRequest } });
    m.runWithWorkforceWorkspaceId.mockImplementation((_ws: string, fn: () => unknown) => fn());
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects a missing or wrong X-Api-Secret', async () => {
    expect((await POST(post(message, {}))).status).toBe(401);
    expect((await POST(post(message, { 'x-api-secret': 'nope' }))).status).toBe(401);
    expect(m.startBotMessageRun).not.toHaveBeenCalled();
  });

  it('fails closed when no secret is configured', async () => {
    delete process.env.ADMIN_SECRET;
    expect((await POST(post(message))).status).toBe(401);
    expect(m.startBotMessageRun).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a bot message', async () => {
    const bad = await POST(post({ ...message, origin: { kind: 'nope' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Invalid bot message');
    expect((await POST(post('not json'))).status).toBe(400);
    expect(m.startBotMessageRun).not.toHaveBeenCalled();
  });

  it('starts the run for the message, logs the hand-off on the job, and answers 202 with the ids', async () => {
    const res = await POST(post(message));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { jobId: 'job-1', runId: 'run-1' } });
    expect(m.startBotMessageRun).toHaveBeenCalledWith({
      db,
      workspaceId: 'ws-9',
      job: {
        userId: 'u1',
        toBotId: 'scout',
        text: 'Find targets',
        origin: message.origin,
        requestId: 'req-1',
      },
    });
    expect(m.appendLog).toHaveBeenCalledWith('job-1', {
      message: 'received over POST /api/internal/bot-messages',
      metadata: { origin: message.origin, requestId: 'req-1', runId: 'run-1' },
    });
  });

  it('accepts every origin kind and a message without a request', async () => {
    const { requestId: _omit, ...noRequest } = message;
    const origins = [
      { kind: 'user_mention', inBot: { id: 'a', name: 'A' } },
      { kind: 'routine', routine: { id: 'r1', title: 'Daily' } },
      { kind: 'bot_reply', replies: [{ fromBot: { id: 'b', name: 'B' }, requestId: 'req-2', ask: 'q', answer: 'a', failure: null }] },
    ];
    for (const origin of origins) {
      expect((await POST(post({ ...noRequest, origin }))).status).toBe(202);
    }
    expect(m.startBotMessageRun.mock.calls[0][0].job.requestId).toBeUndefined();
  });

  it('still answers 202 when the audit log row cannot be written', async () => {
    m.appendLog.mockRejectedValueOnce(new Error('db gone'));
    expect((await POST(post(message))).status).toBe(202);
  });

  it('answers 500 when the run cannot be started, and closes the request so the asker hears back now', async () => {
    m.startBotMessageRun.mockRejectedValueOnce(new Error('no workflow world'));
    const res = await POST(post(message));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(m.createContainer).toHaveBeenCalledWith(db, 'ws-9');
    expect(m.runWithWorkforceWorkspaceId).toHaveBeenCalledWith('ws-9', expect.any(Function));
    expect(m.closeRequest).toHaveBeenCalledWith('req-1', { failure: NOT_STARTED_NOTE });
  });

  it('answers 504 with the reason when starting the run timed out, instead of being killed by the platform', async () => {
    m.startBotMessageRun.mockRejectedValueOnce(new m.BotMessageStartTimeoutError('job-1'));
    const res = await POST(post(message));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'Timed out starting the turn' });
    expect(m.closeRequest).toHaveBeenCalledWith('req-1', { failure: NOT_STARTED_NOTE });
  });

  it('closes no request for a message that answers none', async () => {
    const { requestId: _omit, ...noRequest } = message;
    m.startBotMessageRun.mockRejectedValueOnce(new Error('no workflow world'));
    expect((await POST(post(noRequest))).status).toBe(500);
    expect(m.createContainer).not.toHaveBeenCalled();
    expect(m.closeRequest).not.toHaveBeenCalled();
  });

  it('still answers the sender when closing the request fails too (the sweep is the backstop)', async () => {
    m.startBotMessageRun.mockRejectedValueOnce(new m.BotMessageStartTimeoutError('job-1'));
    m.closeRequest.mockRejectedValueOnce(new Error('db gone'));
    const res = await POST(post(message));
    expect(res.status).toBe(504);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed to close request req-1'), expect.any(Error));
  });

  it('does not touch the container on the happy path', async () => {
    await POST(post(message));
    expect(m.createContainer).not.toHaveBeenCalled();
  });
});
