import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/server/internalApi', () => ({
  internalApiUrl: (path: string) => `https://app.test${path}`,
  internalApiHeaders: () => ({ 'content-type': 'application/json', 'x-api-secret': 's3' }),
}));

import { sendBotMessage } from './botMessageClient';
import type { BotMessageJob } from '@/lib/services/botService';

const job: BotMessageJob = {
  userId: 'u1',
  origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
  toBotId: 'scout',
  text: 'Find targets',
  requestId: 'req-1',
};

describe('sendBotMessage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the message — workspace, user, bot, text, origin, request — to the internal route and returns the ids', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { jobId: 'job-1', runId: 'run-1' } }), { status: 202 }),
    );

    const out = await sendBotMessage({ workspaceId: 'ws-9', job });

    expect(out).toEqual({ jobId: 'job-1', runId: 'run-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.test/api/internal/bot-messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-secret': 's3' });
    expect(JSON.parse(init.body)).toEqual({ workspaceId: 'ws-9', ...job });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces the route's error on a JSON failure", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid bot message' }), { status: 400 }));
    await expect(sendBotMessage({ workspaceId: 'ws-9', job })).rejects.toThrow(/\(400\): Invalid bot message/);
  });

  it('names Deployment Protection or the secret when the deployment answers 401 without JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Authentication Required</html>', { status: 401 }));
    await expect(sendBotMessage({ workspaceId: 'ws-9', job })).rejects.toThrow(/\(401\): the deployment refused the call/);
  });

  it('rejects an OK response without the ids', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(sendBotMessage({ workspaceId: 'ws-9', job })).rejects.toThrow(/unexpected response/);
  });

  it('wraps a network failure with the URL it could not reach, and never retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendBotMessage({ workspaceId: 'ws-9', job })).rejects.toThrow(
      /could not reach https:\/\/app.test\/api\/internal\/bot-messages: fetch failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
