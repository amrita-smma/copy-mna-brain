import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import {
  createInsightFromDocument,
  getInsightChatContext,
  getInsightHead,
  getInsightRefreshRoutine,
  listInsightFailedRefreshRuns,
  listInsights,
  publishInsightVersion,
  restoreInsight,
  refreshInsightNow,
  setInsightAgentBinding,
} from './insights';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe.each([
  ['listInsightFailedRefreshRuns', listInsightFailedRefreshRuns, 'refresh-runs'],
  ['getInsightHead', getInsightHead, 'head'],
  ['getInsightChatContext', getInsightChatContext, 'chat-context'],
  ['getInsightRefreshRoutine', getInsightRefreshRoutine, 'refresh-routine'],
] as const)('%s', (_name, fn, suffix) => {
  it(`requests the insight's ${suffix} endpoint with the id encoded and returns its data`, async () => {
    const data = { any: 'payload' };
    apiRequestMock.mockResolvedValueOnce(data);

    expect(await fn('a/b')).toBe(data);
    expect(apiRequestMock).toHaveBeenCalledWith(`/api/insights/a%2Fb/${suffix}`);
  });
});

describe('listInsights', () => {
  it('requests the first page with no query string when nothing is set', async () => {
    const page = { items: [], total: 0 };
    apiRequestMock.mockResolvedValueOnce(page);

    expect(await listInsights()).toBe(page);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights');
  });

  it('sends the search, filters and page window as query params', async () => {
    apiRequestMock.mockResolvedValueOnce({ items: [], total: 0 });

    await listInsights({ q: 'apac', agent: 'general', mine: true, archived: true, limit: 50, offset: 50 });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/insights?q=apac&agent=general&mine=1&archived=1&limit=50&offset=50',
    );
  });
});

describe('restoreInsight', () => {
  it('PATCHes archive: false and returns the summary', async () => {
    const summary = { id: 'a/b', is_featured: false };
    apiRequestMock.mockResolvedValueOnce(summary);

    expect(await restoreInsight('a/b')).toBe(summary);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights/a%2Fb', {
      method: 'PATCH',
      body: JSON.stringify({ archive: false }),
    });
  });
});

describe('setInsightAgentBinding', () => {
  it('PATCHes the insight with the agent key and returns the summary', async () => {
    const summary = { id: 'a/b', agent_key: 'bangun' };
    apiRequestMock.mockResolvedValueOnce(summary);

    expect(await setInsightAgentBinding('a/b', 'bangun')).toBe(summary);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights/a%2Fb', {
      method: 'PATCH',
      body: JSON.stringify({ agent_key: 'bangun' }),
    });
  });

  it('sends an explicit null to unbind', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'i1', agent_key: null });

    await setInsightAgentBinding('i1', null);

    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights/i1', { method: 'PATCH', body: '{"agent_key":null}' });
  });
});

describe('publishInsightVersion', () => {
  it("sends the chat id so the server can stamp the version with that thread's agent", async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'i1', version_no: 3 });

    await publishInsightVersion('i1', { html: '<p>x</p>', chat_id: 'c1' });

    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights/i1', {
      method: 'POST',
      body: JSON.stringify({ html: '<p>x</p>', chat_id: 'c1' }),
    });
  });
});

describe('createInsightFromDocument', () => {
  it('sends the chat id along with the document', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'i1' });

    await createInsightFromDocument({ name: 'N', html: '<p>x</p>', chat_id: 'c1' });

    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights', {
      method: 'POST',
      body: JSON.stringify({ name: 'N', html: '<p>x</p>', chat_id: 'c1' }),
    });
  });

  it('sends the source template id along with the document', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'i1' });
    const templateId = '66666666-7777-4888-9999-000000000000';

    await createInsightFromDocument({ name: 'N', html: '<p>x</p>', template_id: templateId });

    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights', {
      method: 'POST',
      body: JSON.stringify({ name: 'N', html: '<p>x</p>', template_id: templateId }),
    });
  });
});

describe('refreshInsightNow', () => {
  it("POSTs the insight's refresh-now endpoint with the id encoded and returns the run", async () => {
    const result = { runId: 'run-1', created: true, routineId: null };
    apiRequestMock.mockResolvedValueOnce(result);

    expect(await refreshInsightNow('a/b')).toEqual(result);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/insights/a%2Fb/refresh-now', { method: 'POST' });
  });
});
