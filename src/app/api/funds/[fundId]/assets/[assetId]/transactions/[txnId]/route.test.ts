import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidTransactionError,
  LastTransactionDeleteError,
  TransactionNotFoundError,
} from '@/lib/services/fundAssetLedgerService';

const { createDbMock, getActiveWorkspaceIdMock, updateTransactionMock, deleteTransactionMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    updateTransactionMock: vi.fn(),
    deleteTransactionMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services', () => ({
  createContainer: () => ({
    fundAssetLedgerService: {
      updateTransaction: updateTransactionMock,
      deleteTransaction: deleteTransactionMock,
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

import { DELETE, PATCH } from './route';

function makeRequest(body: unknown, method: string = 'PATCH'): Request {
  return new Request('http://localhost/api/funds/fund-1/assets/asset-1/transactions/txn-1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method !== 'DELETE' ? JSON.stringify(body) : undefined,
  });
}

const PARAMS = Promise.resolve({ fundId: 'fund-1', assetId: 'asset-1', txnId: 'txn-1' });

describe('PATCH & DELETE /api/funds/[fundId]/assets/[assetId]/transactions/[txnId]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    updateTransactionMock.mockReset().mockResolvedValue({ id: 'txn-1' });
    deleteTransactionMock.mockReset().mockResolvedValue(undefined);
  });

  describe('PATCH', () => {
    it('updates transaction with sell_proceeds_destination when provided', async () => {
      const res = await PATCH(
        makeRequest({
          sellProceedsDestination: 'cash_in_fund',
        }) as never,
        { params: PARAMS },
      );
      expect(res.status).toBe(200);
      expect(updateTransactionMock).toHaveBeenCalledWith(
        'asset-1',
        'txn-1',
        expect.objectContaining({
          sell_proceeds_destination: 'cash_in_fund',
        }),
      );
    });

    it('returns 400 when update violates sell proceeds destination invariant', async () => {
      updateTransactionMock.mockRejectedValueOnce(
        new InvalidTransactionError('sell_proceeds_destination is required for divestment transactions'),
      );
      const res = await PATCH(
        makeRequest({
          txnType: 'divestment',
        }) as never,
        { params: PARAMS },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('sell_proceeds_destination is required for divestment');
    });

    it('returns 400 when PATCH includes invalid sellProceedsDestination runtime string', async () => {
      const res = await PATCH(
        makeRequest({
          sellProceedsDestination: 'invalid_destination',
        }) as never,
        { params: PARAMS },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid sellProceedsDestination');
      expect(updateTransactionMock).not.toHaveBeenCalled();
    });

    it('returns 404 when transaction is not found', async () => {
      updateTransactionMock.mockRejectedValueOnce(new TransactionNotFoundError('txn-1'));
      const res = await PATCH(makeRequest({ notes: 'abc' }) as never, { params: PARAMS });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Transaction txn-1 not found');
    });

    it('returns 400 when PATCH attempts to convert transaction to internal_transfer', async () => {
      const res = await PATCH(
        makeRequest({ txnType: 'internal_transfer' }) as never,
        { params: PARAMS },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Transactions cannot be converted to internal_transfer');
      expect(updateTransactionMock).not.toHaveBeenCalled();
    });

    it('returns 400 when PATCH attempts to modify sourceDivestmentTxnId directly', async () => {
      const res = await PATCH(
        makeRequest({ sourceDivestmentTxnId: 'other-id' }) as never,
        { params: PARAMS },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('sourceDivestmentTxnId cannot be modified directly');
      expect(updateTransactionMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('deletes transaction and returns success', async () => {
      const res = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: PARAMS });
      expect(res.status).toBe(200);
      expect(deleteTransactionMock).toHaveBeenCalledWith('asset-1', 'txn-1');
    });

    it('returns 409 when deleting the last remaining transaction', async () => {
      deleteTransactionMock.mockRejectedValueOnce(new LastTransactionDeleteError('asset-1'));
      const res = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: PARAMS });
      expect(res.status).toBe(409);
    });

    it('returns 400 when attempting to directly delete an internal_transfer transaction', async () => {
      deleteTransactionMock.mockRejectedValueOnce(
        new InvalidTransactionError('Generated internal_transfer transactions cannot be deleted directly'),
      );
      const res = await DELETE(makeRequest(undefined, 'DELETE') as never, { params: PARAMS });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Generated internal_transfer transactions cannot be deleted directly');
    });
  });
});
