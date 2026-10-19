import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getPositionByIdMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getPositionByIdMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

describe('GET /api/fund-ledger/positions/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getPositionByIdMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPositionService: {
        getPositionById: getPositionByIdMock,
      },
    });
  });

  it('returns position when found', async () => {
    const position = { id: 'pos-1', status: 'open' };
    getPositionByIdMock.mockResolvedValueOnce(position);

    const req = new NextRequest('http://localhost/api/fund-ledger/positions/pos-1');
    const res = await GET(req, { params: Promise.resolve({ id: 'pos-1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: position });
    expect(getPositionByIdMock).toHaveBeenCalledWith('ws-1', 'pos-1');
  });

  it('returns 404 when position not found', async () => {
    getPositionByIdMock.mockResolvedValueOnce(undefined);

    const req = new NextRequest('http://localhost/api/fund-ledger/positions/pos-999');
    const res = await GET(req, { params: Promise.resolve({ id: 'pos-999' }) });
    expect(res.status).toBe(404);
  });
});
