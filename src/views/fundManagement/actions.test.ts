import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import {
  executeDeleteInvestor,
  executeDeleteFundingSource,
  executeDeleteAsset,
  executeHardDeleteAsset,
  executeReopenHolding,
  executeUpdateActionItems,
  executeSetInvestmentType,
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

describe('executeHardDeleteAsset', () => {
  const holding = { id: 'asset-1', n: 'Acme' };

  it('deletes the asset, reloads, and toasts the counts', async () => {
    const deleteAssetApi = vi.fn().mockResolvedValue({ entries: 3, events: 2, positions: 1 });
    const reloadAll = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn<ToastFn>();

    await executeHardDeleteAsset(holding, { deleteAssetApi, reloadAll, toast });

    expect(deleteAssetApi).toHaveBeenCalledWith('asset-1');
    expect(reloadAll).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Asset deleted',
        description: expect.stringContaining('3 ledger entries across 1 position'),
      }),
    );
  });

  it('toasts and rethrows when the delete fails', async () => {
    const deleteAssetApi = vi.fn().mockRejectedValue(new Error('boom'));
    const reloadAll = vi.fn();
    const toast = vi.fn<ToastFn>();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      executeHardDeleteAsset(holding, { deleteAssetApi, reloadAll, toast }),
    ).rejects.toThrow('boom');
    expect(reloadAll).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to delete asset', variant: 'destructive' }),
    );
    vi.restoreAllMocks();
  });

  it('does nothing for a holding without an id', async () => {
    const deleteAssetApi = vi.fn();
    await executeHardDeleteAsset({ n: 'Mock' }, { deleteAssetApi, reloadAll: vi.fn(), toast: vi.fn() });
    expect(deleteAssetApi).not.toHaveBeenCalled();
  });
});

describe('executeUpdateActionItems', () => {
  it('saves trimmed action items and reloads', async () => {
    const updateAssetApi = vi.fn().mockResolvedValue({});
    const reloadAll = vi.fn().mockResolvedValue(undefined);
    await executeUpdateActionItems({ id: 'asset-1', n: 'Acme' }, '  Call CFO  ', {
      updateAssetApi,
      reloadAll,
      toast: vi.fn(),
    });
    expect(updateAssetApi).toHaveBeenCalledWith('asset-1', { action_items: 'Call CFO' });
    expect(reloadAll).toHaveBeenCalledTimes(1);
  });

  it('clears action items when the text is blank', async () => {
    const updateAssetApi = vi.fn().mockResolvedValue({});
    await executeUpdateActionItems({ id: 'asset-1', n: 'Acme' }, '   ', {
      updateAssetApi,
      reloadAll: vi.fn().mockResolvedValue(undefined),
      toast: vi.fn(),
    });
    expect(updateAssetApi).toHaveBeenCalledWith('asset-1', { action_items: null });
  });
});

describe('executeSetInvestmentType', () => {
  it('assigns the type and reloads', async () => {
    const setAssetInvestmentTypeApi = vi.fn().mockResolvedValue({});
    const reloadAll = vi.fn().mockResolvedValue(undefined);
    await executeSetInvestmentType({ id: 'asset-1', n: 'Acme' }, 'type-vc', {
      setAssetInvestmentTypeApi,
      reloadAll,
      toast: vi.fn(),
    });
    expect(setAssetInvestmentTypeApi).toHaveBeenCalledWith('asset-1', 'type-vc');
    expect(reloadAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a holding without an asset id', async () => {
    const setAssetInvestmentTypeApi = vi.fn();
    await executeSetInvestmentType({ id: null, n: 'Acme' }, null, {
      setAssetInvestmentTypeApi,
      reloadAll: vi.fn(),
      toast: vi.fn(),
    });
    expect(setAssetInvestmentTypeApi).not.toHaveBeenCalled();
  });

  it('toasts and rethrows on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const toast = vi.fn();
    const reloadAll = vi.fn();
    await expect(
      executeSetInvestmentType({ id: 'asset-1', n: 'Acme' }, null, {
        setAssetInvestmentTypeApi: vi.fn().mockRejectedValue(new Error('nope')),
        reloadAll,
        toast,
      }),
    ).rejects.toThrow('nope');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(reloadAll).not.toHaveBeenCalled();
  });
});
