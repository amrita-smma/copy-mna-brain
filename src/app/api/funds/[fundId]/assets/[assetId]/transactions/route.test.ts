import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbMock, getActiveWorkspaceIdMock, addTransactionMock, listTransactionsMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    addTransactionMock: vi.fn(),
    listTransactionsMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services', () => ({
  createContainer: () => ({
    fundAssetLedgerService: {
      listTransactions: listTransactionsMock,
      addTransaction: addTransactionMock,
    },
    holdingEntityService: {
      listHoldingEntities: vi.fn().mockResolvedValue([]),
      createHoldingEntity: vi.fn(),
    },
    fundSourceService: {
      listFundSources: vi.fn().mockResolvedValue([]),
      createFundSource: vi.fn(),
    },
  }),
}));

import { GET, POST } from './route';

function makeRequest(body: unknown, method: string = 'POST'): Request {
  return new Request('http://localhost/api/funds/fund-1/assets/asset-1/transactions', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
}

const PARAMS = Promise.resolve({ fundId: 'fund-1', assetId: 'asset-1' });

describe('POST /api/funds/[fundId]/assets/[assetId]/transactions', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    addTransactionMock.mockReset().mockResolvedValue({ id: 'txn-1' });
    listTransactionsMock.mockReset().mockResolvedValue([{ id: 'txn-1' }]);
  });

  it('returns list of transactions on GET', async () => {
    const res = await GET(makeRequest(undefined, 'GET') as never, { params: PARAMS });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: [{ id: 'txn-1' }] });
    expect(listTransactionsMock).toHaveBeenCalledWith('asset-1');
  });

  it('returns 400 when txnDate or txnType is missing', async () => {
    const res = await POST(makeRequest({ txnDate: '2026-01-01' }) as never, { params: PARAMS });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'txnDate and txnType are required' });
  });

  it('returns 400 when manual POST divestment is missing sellProceedsDestination', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'divestment',
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('sellProceedsDestination is required for divestment');
    expect(addTransactionMock).not.toHaveBeenCalled();
  });

  it('returns 400 when manual POST divestment has invalid sellProceedsDestination runtime string', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'divestment',
        sellProceedsDestination: 'invalid_destination',
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid sellProceedsDestination');
    expect(addTransactionMock).not.toHaveBeenCalled();
  });

  it('accepts divestment with cash_in_fund destination', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'divestment',
        sellProceedsDestination: 'cash_in_fund',
        valueAmount: 100000,
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(200);
    expect(addTransactionMock).toHaveBeenCalledWith(
      'asset-1',
      expect.objectContaining({
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
      }),
    );
  });

  it('accepts divestment with distributed_to_investor destination', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'divestment',
        sellProceedsDestination: 'distributed_to_investor',
        valueAmount: 100000,
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(200);
    expect(addTransactionMock).toHaveBeenCalledWith(
      'asset-1',
      expect.objectContaining({
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
      }),
    );
  });

  it('passes null destination for non-divestment even if destination is supplied in body', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'contribution',
        sellProceedsDestination: 'cash_in_fund',
        valueAmount: 50000,
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(200);
    expect(addTransactionMock).toHaveBeenCalledWith(
      'asset-1',
      expect.objectContaining({
        txn_type: 'contribution',
        sell_proceeds_destination: null,
      }),
    );
  });

  it('returns 400 when cash_in_fund is requested for an unassigned fund', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'divestment',
        sellProceedsDestination: 'cash_in_fund',
        valueAmount: 50000,
        fundId: 'unassigned',
      }) as never,
      { params: Promise.resolve({ fundId: 'unassigned', assetId: 'asset-1' }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('fundId is required when sellProceedsDestination is cash_in_fund');
  });

  it('returns 400 when attempting to create an internal_transfer transaction directly', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'internal_transfer',
        valueAmount: 50000,
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('internal_transfer transactions cannot be created directly');
    expect(addTransactionMock).not.toHaveBeenCalled();
  });

  it('returns 400 when attempting to manually pass sourceDivestmentTxnId', async () => {
    const res = await POST(
      makeRequest({
        txnDate: '2026-01-01',
        txnType: 'contribution',
        valueAmount: 50000,
        sourceDivestmentTxnId: 'fake-id',
      }) as never,
      { params: PARAMS },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('sourceDivestmentTxnId cannot be set manually');
    expect(addTransactionMock).not.toHaveBeenCalled();
  });
});
