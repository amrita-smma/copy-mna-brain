import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, changeStreamMock, listCompanyTasksMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    changeStreamMock: vi.fn(),
    listCompanyTasksMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/server/sse', () => ({
  changeStream: changeStreamMock,
  SSE_HEADERS: { 'Content-Type': 'text/event-stream; charset=utf-8' },
}));

import { GET } from './route';

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  listCompanyTasksMock.mockReset().mockResolvedValue([]);
  createContainerMock.mockReset().mockReturnValue({
    aiScreeningService: { listCompanyTasks: listCompanyTasksMock },
  });
  changeStreamMock.mockReset().mockReturnValue(new ReadableStream());
});

describe('GET /api/ai-screening/tasks/stream', () => {
  it('streams the workspace’s screening tasks, re-emitting only when a run or status changes', async () => {
    const res = await GET(new NextRequest('http://localhost/api/ai-screening/tasks/stream'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');

    const { snapshot, signature } = changeStreamMock.mock.calls[0][0];
    await snapshot();
    expect(listCompanyTasksMock).toHaveBeenCalledTimes(1);
    expect(
      signature([
        { runId: 'r1', status: 'pending' },
        { runId: 'r2', status: 'running' },
      ]),
    ).toBe('r1:pending|r2:running');
  });

  it('returns 500 when the stream cannot be set up', async () => {
    createContainerMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await GET(new NextRequest('http://localhost/api/ai-screening/tasks/stream'));
    expect(res.status).toBe(500);
  });
});
