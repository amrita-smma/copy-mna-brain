import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  createDb: vi.fn(),
  startBotMessageRun: vi.fn(),
  appendLog: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: m.createDb }));
vi.mock('@/lib/bots/botMessageRun', () => ({ startBotMessageRun: m.startBotMessageRun }));
vi.mock('@/lib/repositories', () => ({
  JobRepository: class {
    appendLog = m.appendLog;
  },
}));

import { POST } from './route';

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

  it('answers 500 when the run cannot be started', async () => {
    m.startBotMessageRun.mockRejectedValueOnce(new Error('no workflow world'));
    const res = await POST(post(message));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
