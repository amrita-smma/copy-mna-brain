import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityNotFoundError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getFundRollupMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getFundRollupMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { NextRequest } from 'next/server';
import { GET } from './route';

function makeGetRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

const PARAMS = Promise.resolve({ id: 'fund-1' });

describe('GET /api/fund-ledger/funds/[id]/rollup', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getFundRollupMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flBalanceService: {
        getFundRollup: getFundRollupMock,
      },
    });
  });

  it('returns fund rollup on success, awaits params, and parses asOf date', async () => {
    const mockRollup = {
      fund: { id: 'fund-1', name: 'Fund I' },
      as_of_date: '2026-06-30',
      lp_registry: {
        total_committed: '100000000.00000000',
        total_contributed: '50000000.00000000',
        total_unfunded: '50000000.00000000',
        total_distributed: '0.00000000',
        total_units: '0.00000000',
        lps: [],
      },
      portfolio: {
        total_invested: '40000000.00000000',
        total_value: '45000000.00000000',
        positions: [],
      },
    };
    getFundRollupMock.mockResolvedValueOnce(mockRollup);

    const res = await GET(
      makeGetRequest('http://localhost/api/fund-ledger/funds/fund-1/rollup?asOf=2026-06-30') as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: mockRollup });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(getFundRollupMock).toHaveBeenCalledWith('ws-1', 'fund-1', '2026-06-30');
  });

  it('returns 422 with error_name on EntityNotFoundError when fund does not exist', async () => {
    getFundRollupMock.mockRejectedValueOnce(
      new EntityNotFoundError('Fund fund-1 not found in workspace ws-1'),
    );

    const res = await GET(
      makeGetRequest('http://localhost/api/fund-ledger/funds/fund-1/rollup') as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      error: 'Fund fund-1 not found in workspace ws-1',
      error_name: 'EntityNotFoundError',
    });
  });

  it('returns 500 on unexpected throw', async () => {
    getFundRollupMock.mockRejectedValueOnce(new Error('Rollup calculation crash'));

    const res = await GET(
      makeGetRequest('http://localhost/api/fund-ledger/funds/fund-1/rollup') as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Rollup calculation crash' });
  });
});
