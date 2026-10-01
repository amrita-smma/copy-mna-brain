import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import {
  executeDeleteInvestor,
  executeDeleteFundingSource,
  executeDeleteAsset,
  executeReopenHolding,
  type ToastFn,
} from './actions';

describe('FundManagement actions: executeDeleteInvestor, executeDeleteFundingSource & executeDeleteAsset', () => {
  let reloadAllMock = vi.fn<() => Promise<void>>();
  let toastMock = vi.fn<ToastFn>();
  let deleteInvestorApiMock: ReturnType<typeof vi.spyOn>;
  let deleteFundingSourceApiMock: ReturnType<typeof vi.spyOn>;
  let listPositionsApiMock: ReturnType<typeof vi.spyOn>;
  let closePositionsApiMock: ReturnType<typeof vi.spyOn>;
  let closePositionApiMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reloadAllMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    toastMock = vi.fn();
    deleteInvestorApiMock = vi.spyOn(fundLedgerApi, 'deleteInvestor');
    deleteFundingSourceApiMock = vi.spyOn(fundLedgerApi, 'deleteFundingSource');
    listPositionsApiMock = vi.spyOn(fundLedgerApi, 'listPositions');
    closePositionsApiMock = vi.spyOn(fundLedgerApi, 'closePositions');
    closePositionApiMock = vi.spyOn(fundLedgerApi, 'closePosition');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeDeleteInvestor', () => {
    it('deletes investor via fundLedgerApi default dependency and reloads state upon success', async () => {
      deleteInvestorApiMock.mockResolvedValueOnce(undefined);

      await executeDeleteInvestor('inv-123', {
        reloadAll: reloadAllMock,
        toast: toastMock,
      });

      expect(deleteInvestorApiMock).toHaveBeenCalledWith('inv-123');
      expect(reloadAllMock).toHaveBeenCalledTimes(1);
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('surfaces error and rethrows when FK RESTRICT blocks deletion of in-use investor', async () => {
      deleteInvestorApiMock.mockRejectedValueOnce(
        new Error(
          'update or delete on table "fl_investors" violates foreign key constraint "fl_positions_holder_investor_id_fl_investors_id_fk"',
        ),
      );

      await expect(
        executeDeleteInvestor('inv-in-use', {
          reloadAll: reloadAllMock,
          toast: toastMock,
        }),
      ).rejects.toThrow('violates foreign key constraint');

      expect(deleteInvestorApiMock).toHaveBeenCalledWith('inv-in-use');
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Failed to delete investor',
        description: expect.stringContaining('violates foreign key constraint'),
        variant: 'destructive',
      });
    });
  });

  describe('executeDeleteFundingSource', () => {
    it('deletes funding source via fundLedgerApi default dependency and reloads state upon success', async () => {
      deleteFundingSourceApiMock.mockResolvedValueOnce(undefined);

      await executeDeleteFundingSource('source-456', {
        reloadAll: reloadAllMock,
        toast: toastMock,
      });

      expect(deleteFundingSourceApiMock).toHaveBeenCalledWith('source-456');
      expect(reloadAllMock).toHaveBeenCalledTimes(1);
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('surfaces error and rethrows when FK RESTRICT blocks deletion of in-use funding source', async () => {
      deleteFundingSourceApiMock.mockRejectedValueOnce(
        new Error(
          'update or delete on table "fl_funding_sources" violates foreign key constraint "fl_positions_holder_source_of_fund_id_fl_funding_sources_id_fk"',
        ),
      );

      await expect(
        executeDeleteFundingSource('source-in-use', {
          reloadAll: reloadAllMock,
          toast: toastMock,
        }),
      ).rejects.toThrow('violates foreign key constraint');

      expect(deleteFundingSourceApiMock).toHaveBeenCalledWith('source-in-use');
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Failed to delete source of fund',
        description: expect.stringContaining('violates foreign key constraint'),
        variant: 'destructive',
      });
    });
  });

  describe('executeDeleteAsset', () => {
    it('closes only the exact represented position IDs without a broad lookup', async () => {
      closePositionsApiMock.mockResolvedValueOnce([
        { id: 'pos-1', status: 'closed' },
        { id: 'pos-2', status: 'closed' },
      ]);

      await executeDeleteAsset(
        { id: 'fund-1' },
        { id: 'asset-1', n: 'Acme Corp', tp: 'Direct Investments', positionIds: ['pos-1', 'pos-2'] },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(listPositionsApiMock).not.toHaveBeenCalled();
      expect(closePositionsApiMock).toHaveBeenCalledTimes(1);
      expect(closePositionsApiMock).toHaveBeenCalledWith(['pos-1', 'pos-2']);
      expect(closePositionApiMock).not.toHaveBeenCalled();

      expect(reloadAllMock).toHaveBeenCalledTimes(1);
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('uses a FoF holding positionId directly', async () => {
      closePositionsApiMock.mockResolvedValueOnce([
        { id: 'pos-fof-1', status: 'closed' },
      ]);

      await executeDeleteAsset(
        { id: 'fund-1' },
        { id: 'target-fund-1', n: 'Venture Fund II', tp: 'Fund of funds', positionId: 'pos-fof-1' },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(listPositionsApiMock).not.toHaveBeenCalled();
      expect(closePositionsApiMock).toHaveBeenCalledWith(['pos-fof-1']);
      expect(reloadAllMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the holding has no exact position identity', async () => {
      await executeDeleteAsset(
        { id: 'fund-1' },
        { id: 'asset-empty', n: 'Empty Holding', tp: 'Direct Investments' },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(listPositionsApiMock).not.toHaveBeenCalled();
      expect(closePositionsApiMock).not.toHaveBeenCalled();
      expect(closePositionApiMock).not.toHaveBeenCalled();
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('returns early when holding.id is missing or empty', async () => {
      await executeDeleteAsset(
        { id: 'fund-1' },
        { id: null, n: 'Ghost Holding', tp: 'Direct Investments' },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(listPositionsApiMock).not.toHaveBeenCalled();
      expect(closePositionsApiMock).not.toHaveBeenCalled();
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('surfaces error and rethrows when batch close rejects (e.g. unsettled positions)', async () => {
      closePositionsApiMock.mockRejectedValueOnce(
        new Error('Position pos-unsettled has nonzero remaining quantity (50.00000000) and cannot be closed'),
      );

      await expect(
        executeDeleteAsset(
          { id: 'fund-1' },
          { id: 'asset-1', n: 'Acme Corp', tp: 'Direct Investments', positionId: 'pos-unsettled' },
          {
            reloadAll: reloadAllMock,
            toast: toastMock,
          },
        ),
      ).rejects.toThrow('nonzero remaining quantity');

      expect(closePositionsApiMock).toHaveBeenCalledWith(['pos-unsettled']);
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Failed to close holding',
        description: expect.stringContaining('nonzero remaining quantity'),
        variant: 'destructive',
      });
    });
  });

  describe('executeReopenHolding', () => {
    let reopenPositionApiMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      reopenPositionApiMock = vi.spyOn(fundLedgerApi, 'reopenPosition');
    });

    it('reopens holding with single positionId and reloads state', async () => {
      reopenPositionApiMock.mockResolvedValueOnce({ id: 'pos-1', status: 'open' });

      await executeReopenHolding(
        { id: 'fund-1' },
        { id: 'asset-1', n: 'Acme Corp', positionId: 'pos-1' },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(reopenPositionApiMock).toHaveBeenCalledWith('pos-1');
      expect(reloadAllMock).toHaveBeenCalledTimes(1);
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Holding reopened',
        description: '"Acme Corp" was reopened successfully.',
      });
    });

    it('refuses to reopen multiple positions without an atomic batch operation', async () => {
      await executeReopenHolding(
        { id: 'fund-1' },
        { id: 'asset-1', n: 'Acme Corp', positionIds: ['pos-1', 'pos-2'] },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(reopenPositionApiMock).not.toHaveBeenCalled();
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Cannot reopen holding',
        description: 'Reopening multiple linked positions is disabled because no atomic batch-reopen operation exists.',
        variant: 'destructive',
      });
    });

    it('toasts error and returns early when positionId and positionIds are missing', async () => {
      await executeReopenHolding(
        { id: 'fund-1' },
        { id: 'asset-1', n: 'Acme Corp' },
        {
          reloadAll: reloadAllMock,
          toast: toastMock,
        },
      );

      expect(reopenPositionApiMock).not.toHaveBeenCalled();
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Failed to reopen holding',
        description: 'No position ID found for this holding.',
        variant: 'destructive',
      });
    });

    it('surfaces error and rethrows when reopen fails', async () => {
      reopenPositionApiMock.mockRejectedValueOnce(
        new Error('Database connection lost'),
      );

      await expect(
        executeReopenHolding(
          { id: 'fund-1' },
          { id: 'asset-1', n: 'Acme Corp', positionId: 'pos-1' },
          {
            reloadAll: reloadAllMock,
            toast: toastMock,
          },
        ),
      ).rejects.toThrow('Database connection lost');

      expect(reopenPositionApiMock).toHaveBeenCalledWith('pos-1');
      expect(reloadAllMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Failed to reopen holding',
        description: 'Database connection lost',
        variant: 'destructive',
      });
    });
  });
});
