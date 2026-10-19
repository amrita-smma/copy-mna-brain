import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listEntriesByPositionIdsMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listEntriesByPositionIdsMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { NextRequest } from 'next/server';
import { GET } from './route';

function makeGetRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/fund-ledger/entries', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listEntriesByPositionIdsMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flLedgerService: {
        listEntriesByPositionIds: listEntriesByPositionIdsMock,
      },
    });
  });

  it('parses comma-delimited positionIds, limit, and offset and returns entries + total', async () => {
    const mockEntries = [
      { id: 'ent-1', position_id: 'pos-1', entry_type: 'commitment', commitment_delta: '100.00000000' },
      { id: 'ent-2', position_id: 'pos-2', entry_type: 'paid_in', cash_delta: '-50.00000000' },
    ];
    listEntriesByPositionIdsMock.mockResolvedValueOnce({
      entries: mockEntries,
      total: 10,
    });

    const res = await GET(
      makeGetRequest(
        'http://localhost/api/fund-ledger/entries?positionIds=pos-1,pos-2&limit=25&offset=50',
      ) as never,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      data: mockEntries,
      total: 10,
    });

    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(listEntriesByPositionIdsMock).toHaveBeenCalledWith(
      'ws-1',
      ['pos-1', 'pos-2'],
      { limit: 25, offset: 50 },
    );
  });

  it('handles empty query parameters cleanly', async () => {
    listEntriesByPositionIdsMock.mockResolvedValueOnce({
      entries: [],
      total: 0,
    });

    const res = await GET(
      makeGetRequest('http://localhost/api/fund-ledger/entries') as never,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      data: [],
      total: 0,
    });

    expect(listEntriesByPositionIdsMock).toHaveBeenCalledWith('ws-1', [], {
      limit: undefined,
      offset: undefined,
    });
  });

  it('returns 500 on unexpected failure', async () => {
    listEntriesByPositionIdsMock.mockRejectedValueOnce(
      new Error('Failed to query ledger entries'),
    );

    const res = await GET(
      makeGetRequest('http://localhost/api/fund-ledger/entries') as never,
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Failed to query ledger entries' });
  });
});
