import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createContainerMock,
  createFromDocumentMock,
  agentStampForMock,
  listMock,
  getActiveWorkspaceIdMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  createFromDocumentMock: vi.fn(),
  agentStampForMock: vi.fn(),
  listMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';
import { InsightEvidenceMarkerError } from '@/lib/services/insightService';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/insights', { method: 'POST', body: JSON.stringify(body) }));

describe('GET /api/insights', () => {
  const get = (search = '') => GET(new NextRequest(`http://localhost/api/insights${search}`));
  const page = { items: [{ id: 'i1' }], total: 1 };

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listMock.mockReset().mockResolvedValue(page);
    createContainerMock.mockReset().mockReturnValue({ insightService: { list: listMock } });
  });

  it('returns { data: { items, total } } for the first 50 live insights by default', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: page });
    expect(listMock).toHaveBeenCalledWith('ws-1', {
      mine: false,
      archived: false,
      limit: 50,
      offset: 0,
      userId: null,
    });
    // The session is only read for `mine`.
    expect(authMock).not.toHaveBeenCalled();
  });

  it('parses the search, filters and page window, clamping limit to 100', async () => {
    await get('?q=apac&agent=general&archived=1&limit=500&offset=100');

    expect(listMock).toHaveBeenCalledWith('ws-1', {
      q: 'apac',
      agentKey: null,
      mine: false,
      archived: true,
      limit: 100,
      offset: 100,
      userId: null,
    });
  });

  it('filters mine=1 to the session user', async () => {
    await get('?mine=1');

    expect(listMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ mine: true, userId: 'u1' }));
  });

  it('passes a null user for mine=1 without a session, which the service answers with nothing', async () => {
    authMock.mockResolvedValue(null);

    await get('?mine=1');

    expect(listMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ mine: true, userId: null }));
  });

  it.each(['?limit=0', '?limit=abc', '?offset=-5'])('answers 400 for %s without listing', async (search) => {
    const res = await get(search);

    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns an empty page when there is no active workspace', async () => {
    getActiveWorkspaceIdMock.mockResolvedValue(null);

    const res = await get();

    expect(await res.json()).toEqual({ data: { items: [], total: 0 } });
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/insights', () => {
  beforeEach(() => {
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createFromDocumentMock.mockReset().mockResolvedValue({ id: 'i1' });
    agentStampForMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      insightService: { createFromDocument: createFromDocumentMock },
      copilotChatsService: { agentStampFor: agentStampForMock },
    });
  });

  it("stamps v1 of an insight created from a chat card with that thread's agent", async () => {
    const stamp = { agentKey: 'dikti' };
    agentStampForMock.mockResolvedValue(stamp);

    const res = await post({ name: 'N', html: '<p>x</p>', chat_id: CHAT_ID });

    expect(res.status).toBe(201);
    expect(agentStampForMock).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(createFromDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentStamp: stamp }),
    );
  });

  it('writes a null stamp when no chat is given', async () => {
    await post({ name: 'N', html: '<p>x</p>' });

    expect(agentStampForMock).not.toHaveBeenCalled();
    expect(createFromDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentStamp: null }),
    );
  });

  it('passes the template_id through to the service as the source template', async () => {
    const templateId = '66666666-7777-4888-9999-000000000000';

    const res = await post({ name: 'N', html: '<p>x</p>', template_id: templateId });

    expect(res.status).toBe(201);
    expect(createFromDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId }),
    );
  });

  it('passes a null template id when none is given', async () => {
    await post({ name: 'N', html: '<p>x</p>' });

    expect(createFromDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: null }),
    );
  });

  it('creates the insight rather than answering 400 for a template_id that is not a string', async () => {
    const res = await post({ name: 'N', html: '<p>x</p>', template_id: 42 });

    expect(res.status).toBe(201);
    expect(createFromDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: null }),
    );
  });

  it("answers 400 with the correction when a @dikti card's markers are malformed (MB-543)", async () => {
    agentStampForMock.mockResolvedValue({ agentKey: 'dikti' });
    createFromDocumentMock.mockRejectedValue(new InsightEvidenceMarkerError('1 malformed evidence marker'));

    const res = await post({ name: 'N', html: '<p>x</p>', chat_id: CHAT_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '1 malformed evidence marker' });
  });
});
