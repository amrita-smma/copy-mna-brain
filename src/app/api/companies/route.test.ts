import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authMock,
  createDbMock,
  getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrowMock,
  createContainerMock,
  createFromDTOMock,
  listDTOMock,
  updateFromDTOMock,
  deleteMock,
  findByEmailMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  createContainerMock: vi.fn(),
  createFromDTOMock: vi.fn(),
  listDTOMock: vi.fn(),
  updateFromDTOMock: vi.fn(),
  deleteMock: vi.fn(),
  findByEmailMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/repositories/userRepository', () => ({
  UserRepository: class {
    findByEmail = findByEmailMock;
  },
}));
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>();
  return {
    ...actual,
    createContainer: createContainerMock,
  };
});

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/companies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/companies route', () => {
  const mockDb = { sentinel: 'mockDb' };

  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue(mockDb);
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('ws-1');
    createFromDTOMock.mockReset();
    listDTOMock.mockReset();
    updateFromDTOMock.mockReset();
    deleteMock.mockReset();
    findByEmailMock.mockReset();

    createContainerMock.mockReset().mockReturnValue({
      companyService: {
        createFromDTO: createFromDTOMock,
        listDTO: listDTOMock,
        updateFromDTO: updateFromDTOMock,
        delete: deleteMock,
      },
    });
  });

  describe('entered_by resolution', () => {
    it('defaults entered_by to DB user UUID resolved from session email (not session.user.name)', async () => {
      authMock.mockResolvedValueOnce({
        user: {
          name: 'Jane Doe',
          email: 'jane@example.com',
        },
      });
      findByEmailMock.mockResolvedValueOnce({
        id: 'user-uuid-123',
        email: 'jane@example.com',
        name: 'Jane Doe',
      });
      createFromDTOMock.mockResolvedValueOnce({
        id: 'comp-1',
        target: 'Acme Corp',
        entered_by: 'user-uuid-123',
      });

      const req = makePostRequest({
        company: {
          target: 'Acme Corp',
        },
        logAction: 'create_company',
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(findByEmailMock).toHaveBeenCalledWith('jane@example.com');
      expect(createFromDTOMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'Acme Corp',
          entered_by: 'user-uuid-123',
        }),
        'create_company',
      );
      // Ensure session.user.name ('Jane Doe') was NOT used
      expect(createFromDTOMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          entered_by: 'Jane Doe',
        }),
        expect.anything(),
      );
    });

    it('defaults entered_by to null when session user email is not found in database', async () => {
      authMock.mockResolvedValueOnce({
        user: {
          name: 'Unknown User',
          email: 'unknown@example.com',
        },
      });
      findByEmailMock.mockResolvedValueOnce(null);
      createFromDTOMock.mockResolvedValueOnce({
        id: 'comp-2',
        target: 'Beta Corp',
        entered_by: null,
      });

      const req = makePostRequest({
        company: {
          target: 'Beta Corp',
          entered_by: null,
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(findByEmailMock).toHaveBeenCalledWith('unknown@example.com');
      expect(createFromDTOMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'Beta Corp',
          entered_by: null,
        }),
        undefined,
      );
    });

    it('defaults entered_by to null when there is no active session or session email is missing', async () => {
      authMock.mockResolvedValueOnce(null);
      createFromDTOMock.mockResolvedValueOnce({
        id: 'comp-3',
        target: 'Gamma Corp',
        entered_by: null,
      });

      const req = makePostRequest({
        company: {
          target: 'Gamma Corp',
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(findByEmailMock).not.toHaveBeenCalled();
      expect(createFromDTOMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'Gamma Corp',
          entered_by: null,
        }),
        undefined,
      );
    });

    it('preserves an explicitly supplied entered_by unchanged without resolving session email', async () => {
      authMock.mockResolvedValueOnce({
        user: {
          name: 'Jane Doe',
          email: 'jane@example.com',
        },
      });
      createFromDTOMock.mockResolvedValueOnce({
        id: 'comp-4',
        target: 'Delta Corp',
        entered_by: 'custom-explicit-id',
      });

      const req = makePostRequest({
        company: {
          target: 'Delta Corp',
          entered_by: 'custom-explicit-id',
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(authMock).not.toHaveBeenCalled();
      expect(findByEmailMock).not.toHaveBeenCalled();
      expect(createFromDTOMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'Delta Corp',
          entered_by: 'custom-explicit-id',
        }),
        undefined,
      );
    });
  });
});

describe('GET /api/companies route (countOnly)', () => {
  const countMock = vi.fn();

  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'mockDb' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    countMock.mockReset().mockResolvedValue(4);
    createContainerMock.mockReset().mockReturnValue({ companyService: { count: countMock } });
  });

  function get(query: string) {
    return GET(new NextRequest(`http://localhost/api/companies?countOnly=true&${query}`));
  }

  it('passes a deal_origin source and excludeDropped through to the count', async () => {
    const res = await get('stage=unreviewed&source=inbound&excludeDropped=true');

    expect(await res.json()).toEqual({ data: { count: 4 } });
    expect(countMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'unreviewed', source: 'inbound', excludeDropped: true }),
    );
  });

  it('ignores a source that is not a deal_origin value instead of failing the enum cast', async () => {
    await get('source=bogus');

    expect(countMock).toHaveBeenCalledWith(expect.objectContaining({ source: undefined }));
  });
});
