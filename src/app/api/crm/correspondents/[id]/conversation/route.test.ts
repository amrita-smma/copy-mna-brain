import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  getConversationMock,
  getSessionMock,
  notesEnabledMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  getConversationMock: vi.fn(),
  getSessionMock: vi.fn(),
  notesEnabledMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/server/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/flags', () => ({ crmEmailNotesEnabled: notesEnabledMock }));

import { GET } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';

const params = { params: Promise.resolve({ id: 'c1' }) };

function makeReq(url = 'https://example.com/api/crm/correspondents/c1/conversation') {
  return {
    nextUrl: new URL(url),
  } as never;
}

describe('GET /api/crm/correspondents/[id]/conversation', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ db: true });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
    getConversationMock.mockReset();
    getSessionMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    notesEnabledMock.mockReset().mockResolvedValue(true);
    createContainerMock.mockReset().mockReturnValue({
      contactConversationService: { getConversation: getConversationMock },
    });
  });

  it('asks for no notes while CRM_EMAIL_NOTES_ENABLED is off', async () => {
    notesEnabledMock.mockResolvedValueOnce(false);
    getConversationMock.mockResolvedValueOnce({ contactId: 'c1', notes: [] });
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);
    expect(getConversationMock.mock.calls[0][2]).toMatchObject({ includeNotes: false });
  });

  it('401s without a session and never reads notes', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(401);
    expect(getConversationMock).not.toHaveBeenCalled();
  });

  it('returns 200 with data on success', async () => {
    const mockData = {
      contactId: 'c1',
      hasSyncedData: true,
      roles: { roles: [], emailCount: 0, evidence: null },
      overview: { status: 'none', text: null, generatedAt: null, stale: false },
      notes: [],
      nextCursor: null,
    };
    getConversationMock.mockResolvedValueOnce(mockData);

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: mockData });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(getConversationMock).toHaveBeenCalledWith('c1', 'u1', {
      includeNotes: true,
      cursor: undefined,
      limit: undefined,
    });
  });

  it('passes cursor and limit to service when valid', async () => {
    getConversationMock.mockResolvedValueOnce({ contactId: 'c1' });
    const url = 'https://example.com/api/crm/correspondents/c1/conversation?cursor=cur123&limit=30';

    const res = await GET(makeReq(url), params);

    expect(res.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith('c1', 'u1', {
      includeNotes: true,
      cursor: 'cur123',
      limit: 30,
    });
  });

  it('returns 400 when limit is out of range or not an integer', async () => {
    const badLimits = ['0', '51', '-5', 'abc', '10.5'];
    for (const bad of badLimits) {
      getConversationMock.mockClear();
      const res = await GET(
        makeReq(`https://example.com/api/crm/correspondents/c1/conversation?limit=${bad}`),
        params,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid limit' });
      expect(getConversationMock).not.toHaveBeenCalled();
    }
  });

  it('returns 404 when contact is not found', async () => {
    getConversationMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
  });

  it('returns 500 on unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getConversationMock.mockRejectedValueOnce(new Error('db connection error'));

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
