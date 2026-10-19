import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getPortfolioMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getPortfolioMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

describe('GET /api/fund-ledger/portfolio', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getPortfolioMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPortfolioService: {
        getPortfolio: getPortfolioMock,
      },
    });
  });

  it('returns portfolio read model on success', async () => {
    const mockPortfolio = {
      as_of_date: null,
      funds: [{ id: 'fund-1', name: 'Fund I', managed: true }],
      managed_funds: [{ id: 'fund-1', name: 'Fund I', managed: true }],
      external_funds: [],
      assets: [],
      investors: [],
      funding_sources: [],
      positions: [],
      balances: [],
      entries: [],
      business_events: [],
      valuations: [],
    };
    getPortfolioMock.mockResolvedValueOnce(mockPortfolio);

    const req = new NextRequest('http://localhost/api/fund-ledger/portfolio');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: mockPortfolio });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(getPortfolioMock).toHaveBeenCalledWith('ws-1', undefined);
  });

  it('forwards asOf query param to service', async () => {
    getPortfolioMock.mockResolvedValueOnce({ as_of_date: '2026-03-31' });

    const req = new NextRequest('http://localhost/api/fund-ledger/portfolio?asOf=2026-03-31');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getPortfolioMock).toHaveBeenCalledWith('ws-1', '2026-03-31');
  });

  it('returns 500 on unexpected service failure', async () => {
    getPortfolioMock.mockRejectedValueOnce(new Error('Database offline'));

    const req = new NextRequest('http://localhost/api/fund-ledger/portfolio');
    const res = await GET(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Database offline' });
  });
});
