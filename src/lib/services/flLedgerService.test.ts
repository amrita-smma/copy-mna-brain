import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/repositories';
import {
  AllocationMismatchError,
  AllocationSourceMismatchError,
  CannotDeletePostedEventError,
  CannotReverseReversalError,
  EntityNotFoundError,
  EntryPositionKindMismatchError,
  EventAlreadyReversedError,
  IneligibleCashHolderError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidMasterDataError,
  PositionClosedError,
  UnbalancedTransferError,
  WorkspaceMismatchError,
} from './flErrors';
import { FlLedgerService } from './flLedgerService';

describe('FlLedgerService', () => {
  let mockDb: any;
  let mockLedgerRepo: any;
  let mockEventRepo: any;
  let mockAllocationRepo: any;
  let mockPositionRepo: any;
  let mockFundingSourceRepo: any;
  let mockSourceRecordRepo: any;
  let mockAssetRepo: any;
  let mockFundRepo: any;
  let mockInvestorRepo: any;
  let mockRevisionRepo: any;
  let service: FlLedgerService;

  const workspaceId = 'ws-ledger-1';
  const sentinelExecutor = { __sentinel: 'tx-ledger-sentinel' } as unknown as DbClient;

  const openFundPosition = {
    id: 'pos-fund-1',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openSourcedPosition = {
    id: 'pos-sourced-1',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_source_of_fund_id: 'fs-1',
    status: 'open',
  };

  const openFundPosition2 = {
    id: 'pos-fund-2',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openAssetPosition = {
    id: 'pos-asset-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-1',
    holder_fund_id: 'fund-1',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openCashPositionUsd = {
    id: 'pos-cash-usd-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holder_fund_id: 'fund-1',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openCashPositionEur = {
    id: 'pos-cash-eur-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-eur',
    holder_fund_id: 'fund-1',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openCashPositionUsdFund2 = {
    id: 'pos-cash-usd-fund2',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holder_fund_id: 'fund-2',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openM2MPositionFund1To2 = {
    id: 'pos-m2m-1-2',
    workspace_id: workspaceId,
    fund_id: 'fund-2',
    asset_id: null,
    holder_fund_id: 'fund-1',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const closedPosition = {
    id: 'pos-closed-1',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_source_of_fund_id: null,
    status: 'closed',
  };

  const openInvestorAssetPosition = {
    id: 'pos-inv-asset-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-1',
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestor2AssetPosition = {
    id: 'pos-inv2-asset-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-1',
    holder_investor_id: 'inv-2',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestorCashPositionUsd = {
    id: 'pos-inv-cash-usd-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestorCashPositionEur = {
    id: 'pos-inv-cash-eur-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-eur',
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestor2CashPositionUsd = {
    id: 'pos-inv2-cash-usd-1',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holder_investor_id: 'inv-2',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestorUnmanagedFundPosition = {
    id: 'pos-inv-fof-1',
    workspace_id: workspaceId,
    fund_id: 'fund-unmanaged',
    asset_id: null,
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openInvestorManagedFundPosition = {
    id: 'pos-inv-lp-managed-1',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openLpOnlyInvestorManagedFundPosition = {
    id: 'pos-lp-only-managed-1',
    workspace_id: workspaceId,
    fund_id: 'fund-1',
    asset_id: null,
    holder_investor_id: 'inv-lp-only',
    holder_fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
  };

  const openUnmanagedFundCashPosition = {
    id: 'pos-unmanaged-cash-usd',
    workspace_id: workspaceId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holder_investor_id: null,
    holder_fund_id: 'fund-unmanaged',
    holder_source_of_fund_id: null,
    status: 'open',
  };

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (cb: any) => cb(mockDb)),
    };
    mockEventRepo = {
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ ...data, id: data.id ?? 'evt-1' })),
      update: vi.fn().mockImplementation((_ws: string, id: string, updates: any) =>
        Promise.resolve({ id, workspace_id: _ws, status: 'posted', ...updates }),
      ),
      findById: vi.fn().mockResolvedValue(undefined),
      markReversed: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    mockRevisionRepo = {
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: 'rev-1', ...data })),
      findByBusinessEventId: vi.fn().mockResolvedValue([]),
      nextRevisionNo: vi.fn().mockResolvedValue(1),
    };
    mockLedgerRepo = {
      createMany: vi.fn().mockImplementation((entries: any) => Promise.resolve(entries)),
      findByBusinessEventId: vi.fn().mockResolvedValue([]),
      findByPositionIds: vi.fn().mockResolvedValue([]),
      countByPositionIds: vi.fn().mockResolvedValue(0),
      deleteByBusinessEventId: vi.fn().mockResolvedValue(undefined),
    };
    mockAllocationRepo = {
      createMany: vi.fn().mockImplementation((allocs: any) => Promise.resolve(allocs)),
      findByLedgerEntryIds: vi.fn().mockResolvedValue([]),
      deleteByLedgerEntryIds: vi.fn().mockResolvedValue(undefined),
    };
    const allAssets = [
      { id: 'asset-1', workspace_id: workspaceId, name: 'Test Asset', asset_kind: 'private_equity' },
      { id: 'asset-cash-usd', workspace_id: workspaceId, name: 'Cash (USD)', asset_kind: 'cash', instrument_terms: { system_cash: true, currency: 'USD' } },
      { id: 'asset-cash-eur', workspace_id: workspaceId, name: 'Cash (EUR)', asset_kind: 'cash', instrument_terms: { system_cash: true, currency: 'EUR' } },
    ];
    mockAssetRepo = {
      findByIds: vi.fn().mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(allAssets.filter((a) => ids.includes(a.id))),
      ),
      findById: vi.fn().mockImplementation((_ws: string, id: string) =>
        Promise.resolve(allAssets.find((a) => a.id === id)),
      ),
      findSystemCashAsset: vi.fn().mockImplementation((_ws: string, currency: string) =>
        Promise.resolve(
          allAssets.find(
            (a) =>
              a.asset_kind === 'cash' &&
              (a.instrument_terms as any)?.system_cash === true &&
              (a.instrument_terms as any)?.currency === currency.toUpperCase(),
          ),
        ),
      ),
      create: vi.fn().mockImplementation((data: any) => {
        const row = { id: `asset-${data.name}`, ...data };
        allAssets.push(row);
        return Promise.resolve(row);
      }),
    };
    const allPositions: any[] = [
      openFundPosition,
      openSourcedPosition,
      openFundPosition2,
      openAssetPosition,
      openCashPositionUsd,
      openCashPositionEur,
      openCashPositionUsdFund2,
      openM2MPositionFund1To2,
      closedPosition,
      openInvestorAssetPosition,
      openInvestor2AssetPosition,
      openInvestorCashPositionUsd,
      openInvestorCashPositionEur,
      openInvestor2CashPositionUsd,
      openInvestorUnmanagedFundPosition,
      openInvestorManagedFundPosition,
      openLpOnlyInvestorManagedFundPosition,
      openUnmanagedFundCashPosition,
    ];
    mockPositionRepo = {
      findByIds: vi.fn().mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(allPositions.filter((p) => ids.includes(p.id))),
      ),
      findById: vi.fn().mockImplementation((_ws: string, id: string) =>
        Promise.resolve(allPositions.find((p) => p.id === id)),
      ),
      findCashPosition: vi.fn().mockImplementation((_ws: string, fundId: string, cashAssetId: string) =>
        Promise.resolve(
          allPositions.find(
            (p) =>
              p.holder_fund_id === fundId &&
              p.asset_id === cashAssetId &&
              !p.holder_investor_id &&
              !p.fund_id,
          ),
        ),
      ),
      findInvestorCashPosition: vi.fn().mockImplementation((_ws: string, investorId: string, cashAssetId: string) =>
        Promise.resolve(
          allPositions.find(
            (p) =>
              p.holder_investor_id === investorId &&
              p.asset_id === cashAssetId &&
              !p.holder_fund_id &&
              !p.fund_id,
          ),
        ),
      ),
      findByNaturalKey: vi.fn().mockImplementation((_ws: string, key: any) =>
        Promise.resolve(
          allPositions.find(
            (p) =>
              (key.holderFundId ? p.holder_fund_id === key.holderFundId : !p.holder_fund_id) &&
              (key.holderInvestorId ? p.holder_investor_id === key.holderInvestorId : !p.holder_investor_id) &&
              (key.assetId ? p.asset_id === key.assetId : !p.asset_id),
          ),
        ),
      ),
      create: vi.fn().mockImplementation((data: any) => {
        const row = { id: `pos-created-${allPositions.length + 1}`, ...data };
        allPositions.push(row);
        return Promise.resolve(row);
      }),
      update: vi.fn().mockImplementation((_ws: string, id: string, updates: any) => {
        const pos = allPositions.find((p) => p.id === id);
        if (pos) Object.assign(pos, updates);
        return Promise.resolve(pos);
      }),
    };
    mockFundingSourceRepo = {
      findByIds: vi.fn().mockResolvedValue([]),
    };
    mockSourceRecordRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'src-1', workspace_id: workspaceId }),
      findByIds: vi.fn().mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, workspace_id: workspaceId }))),
      ),
    };
    const allFunds = [
      { id: 'fund-1', workspace_id: workspaceId, name: 'Fund 1', managed: true, base_currency: 'USD' },
      { id: 'fund-2', workspace_id: workspaceId, name: 'Fund 2', managed: true, base_currency: 'USD' },
      { id: 'fund-unmanaged', workspace_id: workspaceId, name: 'Unmanaged Fund', managed: false, base_currency: 'USD' },
    ];
    mockFundRepo = {
      findByIds: vi.fn().mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(allFunds.filter((f) => ids.includes(f.id))),
      ),
      findById: vi.fn().mockImplementation((_ws: string, id: string) =>
        Promise.resolve(allFunds.find((f) => f.id === id)),
      ),
    };
    const allInvestors = [
      { id: 'inv-1', workspace_id: workspaceId, name: 'Investor 1' },
      { id: 'inv-2', workspace_id: workspaceId, name: 'Investor 2' },
      { id: 'inv-lp-only', workspace_id: workspaceId, name: 'LP Only Investor' },
    ];
    mockInvestorRepo = {
      findByIds: vi.fn().mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(allInvestors.filter((i) => ids.includes(i.id))),
      ),
      findById: vi.fn().mockImplementation((_ws: string, id: string) =>
        Promise.resolve(allInvestors.find((i) => i.id === id)),
      ),
    };

    service = new FlLedgerService(
      mockDb,
      mockLedgerRepo,
      mockEventRepo,
      mockAllocationRepo,
      mockPositionRepo,
      mockFundingSourceRepo,
      mockSourceRecordRepo,
      mockAssetRepo,
      mockFundRepo,
      undefined,
      undefined,
      mockInvestorRepo,
      mockRevisionRepo,
    );
  });

  describe('postEvent validations', () => {
    it('successfully posts a single valid entry event', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-08-23',
        description: 'Test commitment',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'commitment',
            commitment_delta: '1000000.00000000',
            currency: 'USD',
          },
        ],
      });

      expect(res.event.id).toBe('evt-1');
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0].commitment_delta).toBe('1000000.00000000');
      expect(res.entries[0].quantity_delta).toBe('0.00000000');
      expect(res.entries[0].cash_delta).toBe('0.00000000');
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it('rejects is_reversal: true in postEvent input', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'commitment',
              commitment_delta: '1000000',
              currency: 'USD',
              is_reversal: true,
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects invalid currency', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'commitment',
              commitment_delta: '1000000',
              currency: 'FAKE_CURR',
            },
          ],
        }),
      ).rejects.toThrow(InvalidCurrencyError);
    });

    it('rejects numeric JS inputs at runtime', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'commitment',
              commitment_delta: 1000000 as any,
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      await expect(
        service.recordCommitment(workspaceId, {
          positionId: 'pos-fund-1',
          amount: 50000 as any,
          date: '2026-08-23',
          currency: 'USD',
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects every entry type on bad delta shape', async () => {
      // 1. commitment: c=0 or q!=0 or k!=0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'commitment', commitment_delta: '0', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 2. paid_in: c!=0 or q < 0 or k >= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '100', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 3. distribution: c!=0 or q!=0 or k <= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'distribution', cash_delta: '-100', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 4. redemption: c!=0 or q >= 0 or k <= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'redemption', quantity_delta: '10', cash_delta: '100', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 5. buy: c!=0 or q < 0 or k >= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-asset-1', entry_type: 'buy', cash_delta: '100', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 6. sell: c!=0 or q > 0 or k <= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-asset-1', entry_type: 'sell', quantity_delta: '5', cash_delta: '100', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 7. income: k <= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'income', cash_delta: '-50', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 8. expense: k >= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'expense', cash_delta: '50', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // commitment_transfer: c=0 or q!=0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'commitment_transfer', commitment_delta: '0', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // unit_transfer: c!=0 or q=0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-asset-1', entry_type: 'unit_transfer', quantity_delta: '0', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      // 9. adjustment: k != 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [{ position_id: 'pos-fund-1', entry_type: 'adjustment', cash_delta: '10', currency: 'USD' }],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects counterparty_position_id on non-transfer entry types', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              counterparty_position_id: 'pos-fund-2',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects a transfer whose counterparty is the same position', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              counterparty_position_id: 'pos-fund-1',
              entry_type: 'commitment_transfer',
              commitment_delta: '1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects type ↔ position kind mismatch', async () => {
      // 1. Fund-only type on asset position
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'commitment',
              commitment_delta: '100000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(EntryPositionKindMismatchError);

      // 2. Asset-only type on fund position
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'buy',
              quantity_delta: '10',
              cash_delta: '-10000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(EntryPositionKindMismatchError);
    });

    it('keeps fund-style contributions restricted on ordinary assets', async () => {
      await expect(service.postEvent(workspaceId, {
        event_date: '2026-08-23',
        entries: [{ position_id: 'pos-asset-1', entry_type: 'paid_in', cash_delta: '-100', currency: 'USD' }],
      })).rejects.toThrow(EntryPositionKindMismatchError);
    });

    it('still rejects commitments on a FoF asset target', async () => {
      mockAssetRepo.findByIds.mockResolvedValue([{
        id: 'asset-1', workspace_id: workspaceId, asset_kind: 'equity',
        instrument_terms: { investmentTypeLabel: 'Fund of Funds' },
      }]);
      await expect(service.postEvent(workspaceId, {
        event_date: '2026-08-23',
        entries: [{ position_id: 'pos-asset-1', entry_type: 'commitment', commitment_delta: '100', currency: 'USD' }],
      })).rejects.toThrow(EntryPositionKindMismatchError);
    });

    it('rejects entries on closed positions', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-closed-1',
              entry_type: 'commitment',
              commitment_delta: '100000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(PositionClosedError);
    });

    it('rejects unbalanced commitment transfers (commitment imbalance)', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              counterparty_position_id: 'pos-fund-2',
              entry_type: 'commitment_transfer',
              commitment_delta: '-100000',
              currency: 'USD',
            },
            {
              position_id: 'pos-fund-2',
              counterparty_position_id: 'pos-fund-1',
              entry_type: 'commitment_transfer',
              commitment_delta: '80000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(UnbalancedTransferError);
    });

    it('rejects unbalanced commitment transfers (cash imbalance)', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              counterparty_position_id: 'pos-fund-2',
              entry_type: 'commitment_transfer',
              commitment_delta: '-100000',
              cash_delta: '5000',
              currency: 'USD',
            },
            {
              position_id: 'pos-fund-2',
              counterparty_position_id: 'pos-fund-1',
              entry_type: 'commitment_transfer',
              commitment_delta: '100000',
              cash_delta: '-4000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(UnbalancedTransferError);
    });

    it('accepts balanced two-leg transfers with and without cash', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-08-23',
        entries: [
          {
            position_id: 'pos-fund-1',
            counterparty_position_id: 'pos-fund-2',
            entry_type: 'commitment_transfer',
            commitment_delta: '-100000',
            cash_delta: '5000',
            currency: 'USD',
          },
          {
            position_id: 'pos-fund-2',
            counterparty_position_id: 'pos-fund-1',
            entry_type: 'commitment_transfer',
            commitment_delta: '100000',
            cash_delta: '-5000',
            currency: 'USD',
          },
        ],
      });

      expect(res.entries).toHaveLength(2);
    });

    it('validates funding allocations sum to |cash_delta| and amount > 0', async () => {
      mockFundingSourceRepo.findByIds.mockResolvedValue([
        { id: 'fs-1', workspace_id: workspaceId },
        { id: 'fs-2', workspace_id: workspaceId },
      ]);

      // 1. Allocation sum mismatch
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
              allocations: [
                { funding_source_id: 'fs-1', amount: '600' },
                { funding_source_id: 'fs-2', amount: '300' }, // 900 != 1000
              ],
            },
          ],
        }),
      ).rejects.toThrow(AllocationMismatchError);

      // 2. Amount <= 0
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
              allocations: [
                { funding_source_id: 'fs-1', amount: '1000' },
                { funding_source_id: 'fs-2', amount: '0' },
              ],
            },
          ],
        }),
      ).rejects.toThrow(AllocationMismatchError);

      // 3. Valid allocations match |cash_delta|
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-08-23',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in',
            cash_delta: '-1000',
            currency: 'USD',
            allocations: [
              { funding_source_id: 'fs-1', amount: '600' },
              { funding_source_id: 'fs-2', amount: '400' },
            ],
          },
        ],
      });

      expect(res.allocations).toHaveLength(2);
      expect(res.allocations[0].amount).toBe('600.00000000');
      expect(res.allocations[1].amount).toBe('400.00000000');
    });

    describe('top-level allocation target validation', () => {
      beforeEach(() => {
        mockFundingSourceRepo.findByIds.mockImplementation((_ws: string, ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, workspace_id: workspaceId }))),
        );
      });

      it('rejects explicit out-of-bounds or non-integer entry_index with InvalidEntryShapeError', async () => {
        // Negative index
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              { position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
            ],
            allocations: [
              { entry_index: -1, funding_source_id: 'fs-1', amount: '500' },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);

        // Out-of-bounds index >= entries.length
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              { position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
            ],
            allocations: [
              { entry_index: 1, funding_source_id: 'fs-1', amount: '500' },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);

        // Non-integer index
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              { position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
            ],
            allocations: [
              { entry_index: 0.5 as any, funding_source_id: 'fs-1', amount: '500' },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects unresolvable ledger_entry_id with InvalidEntryShapeError', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              { id: 'ent-1', position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
            ],
            allocations: [
              { ledger_entry_id: 'ent-nonexistent', funding_source_id: 'fs-1', amount: '500' },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('accepts valid entry_index, valid ledger_entry_id, and preserves index-0 default when neither selector is supplied', async () => {
        // Valid entry_index (targeting index 1)
        const res1 = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            { position_id: 'pos-fund-1', entry_type: 'commitment', commitment_delta: '500', cash_delta: '0', currency: 'USD' },
            { position_id: 'pos-fund-2', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
          ],
          allocations: [
            { entry_index: 1, funding_source_id: 'fs-1', amount: '500' },
          ],
        });
        expect(res1.allocations).toHaveLength(1);
        expect(res1.allocations[0].amount).toBe('500.00000000');

        // Valid ledger_entry_id
        const res2 = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            { id: 'custom-ent-1', position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
          ],
          allocations: [
            { ledger_entry_id: 'custom-ent-1', funding_source_id: 'fs-1', amount: '500' },
          ],
        });
        expect(res2.allocations).toHaveLength(1);
        expect(res2.allocations[0].amount).toBe('500.00000000');

        // Neither selector supplied -> maps to entry index 0
        const res3 = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            { position_id: 'pos-fund-1', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
          ],
          allocations: [
            { funding_source_id: 'fs-1', amount: '500' },
          ],
        });
        expect(res3.allocations).toHaveLength(1);
        expect(res3.allocations[0].amount).toBe('500.00000000');
      });

      it('accepts both entry_index and ledger_entry_id when resolving to the same entry', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            { position_id: 'pos-fund-1', entry_type: 'commitment', commitment_delta: '500', cash_delta: '0', currency: 'USD' },
            { id: 'ent-target', position_id: 'pos-fund-2', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
          ],
          allocations: [
            { entry_index: 1, ledger_entry_id: 'ent-target', funding_source_id: 'fs-1', amount: '500' },
          ],
        });
        expect(res.allocations).toHaveLength(1);
        expect(res.allocations[0].amount).toBe('500.00000000');
      });

      it('rejects conflicting entry_index and ledger_entry_id with InvalidEntryShapeError', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              { id: 'ent-0', position_id: 'pos-fund-1', entry_type: 'commitment', commitment_delta: '500', cash_delta: '0', currency: 'USD' },
              { id: 'ent-1', position_id: 'pos-fund-2', entry_type: 'paid_in', cash_delta: '-500', currency: 'USD' },
            ],
            allocations: [
              // entry_index is 0, but ledger_entry_id resolves to index 1 -> conflict
              { entry_index: 0, ledger_entry_id: 'ent-1', funding_source_id: 'fs-1', amount: '500' },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });
    });

    describe('Phase 3 validation 5 position-source consistency rules', () => {
      beforeEach(() => {
        mockFundingSourceRepo.findByIds.mockImplementation((_ws: string, ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, workspace_id: workspaceId }))),
        );
      });

      it('case (a): sourced position + no allocations -> creates exactly one default allocation for |cash_delta|', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-sourced-1',
              entry_type: 'paid_in',
              cash_delta: '-500',
              currency: 'USD',
            },
          ],
        });

        expect(res.allocations).toHaveLength(1);
        expect(res.allocations[0].funding_source_id).toBe('fs-1');
        expect(res.allocations[0].amount).toBe('500.00000000');
      });

      it('case (b): sourced position + explicit allocation matching source for full amount -> accepted verbatim', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-sourced-1',
              entry_type: 'paid_in',
              cash_delta: '-500',
              currency: 'USD',
              allocations: [{ funding_source_id: 'fs-1', amount: '500' }],
            },
          ],
        });

        expect(res.allocations).toHaveLength(1);
        expect(res.allocations[0].funding_source_id).toBe('fs-1');
        expect(res.allocations[0].amount).toBe('500.00000000');
      });

      it('case (c): sourced position + allocation naming different source -> rejects with AllocationSourceMismatchError', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              {
                position_id: 'pos-sourced-1',
                entry_type: 'paid_in',
                cash_delta: '-500',
                currency: 'USD',
                allocations: [{ funding_source_id: 'fs-2', amount: '500' }],
              },
            ],
          }),
        ).rejects.toThrow(AllocationSourceMismatchError);
      });

      it('sourced position + explicit partial amount matching source -> rejects with AllocationSourceMismatchError', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              {
                position_id: 'pos-sourced-1',
                entry_type: 'paid_in',
                cash_delta: '-500',
                currency: 'USD',
                allocations: [{ funding_source_id: 'fs-1', amount: '300' }], // partial amount: 300 != 500
              },
            ],
          }),
        ).rejects.toThrow(AllocationSourceMismatchError);
      });

      it('case (d): sourced position + multi-source allocation split -> rejects with AllocationSourceMismatchError', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              {
                position_id: 'pos-sourced-1',
                entry_type: 'paid_in',
                cash_delta: '-500',
                currency: 'USD',
                allocations: [
                  { funding_source_id: 'fs-1', amount: '300' },
                  { funding_source_id: 'fs-2', amount: '200' },
                ],
              },
            ],
          }),
        ).rejects.toThrow(AllocationSourceMismatchError);
      });

      it('case (e): sourced position + explicit empty array -> triggers default allocation (case a)', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-sourced-1',
              entry_type: 'paid_in',
              cash_delta: '-500',
              currency: 'USD',
              allocations: [],
            },
          ],
        });

        expect(res.allocations).toHaveLength(1);
        expect(res.allocations[0].funding_source_id).toBe('fs-1');
        expect(res.allocations[0].amount).toBe('500.00000000');
      });

      it('case (f): zero-cash guard: commitment entry creates no allocations; explicit allocation on zero-cash throws', async () => {
        // Zero-cash commitment on sourced position -> 0 allocation rows created
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-sourced-1',
              entry_type: 'commitment',
              commitment_delta: '1000',
              cash_delta: '0',
              currency: 'USD',
            },
          ],
        });
        expect(res.allocations).toHaveLength(0);

        // Explicit allocation on zero-cash entry -> rejected
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-08-23',
            entries: [
              {
                position_id: 'pos-sourced-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                cash_delta: '0',
                currency: 'USD',
                allocations: [{ funding_source_id: 'fs-1', amount: '1000' }],
              },
            ],
          }),
        ).rejects.toThrow(AllocationMismatchError);
      });

      it('NULL-source position with no allocations stays unattributed', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1', // holder_source_of_fund_id is null
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        });
        expect(res.allocations).toHaveLength(0);
      });
    });

    it('rejects cross-workspace counterparty, funding source, or source record', async () => {
      mockFundingSourceRepo.findByIds.mockResolvedValue([]); // not found

      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
              allocations: [{ funding_source_id: 'fs-missing', amount: '1000' }],
            },
          ],
        }),
      ).rejects.toThrow(WorkspaceMismatchError);

      mockSourceRecordRepo.findByIds.mockResolvedValue([]);
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-23',
          source_record_id: 'src-missing',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'commitment',
              commitment_delta: '1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });
  });

  describe('reverseEvent', () => {
    it('posts a reversal business event, mirrors entries with negated deltas, mirrors allocations, and marks original reversed without deletion', async () => {
      const originalEvent = {
        id: 'evt-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-20',
        status: 'posted',
        source_record_id: 'src-1',
        created_by: 'user-1',
      };
      const originalEntries = [
        {
          id: 'ent-1',
          position_id: 'pos-fund-1',
          business_event_id: 'evt-orig',
          entry_type: 'paid_in',
          sub_type: null,
          commitment_delta: '0.00000000',
          quantity_delta: '50.00000000',
          cash_delta: '-50000.00000000',
          currency: 'USD',
          fx_rate: null,
          price_per_unit: '1000.00000000',
          counterparty_position_id: null,
          data_status: 'verified',
          source_record_id: 'src-1',
          notes: 'Initial capital call',
        },
      ];
      const originalAllocations = [
        {
          id: 'alloc-1',
          ledger_entry_id: 'ent-1',
          funding_source_id: 'fs-1',
          amount: '50000.00000000',
          created_by: 'user-1',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(originalEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(originalEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(originalAllocations);

      const res = await service.reverseEvent(workspaceId, 'evt-orig', {
        description: 'Reversing erroneous paid-in',
      });

      // Original rows are NOT deleted
      expect(mockAllocationRepo.deleteByLedgerEntryIds).not.toHaveBeenCalled();
      expect(mockLedgerRepo.deleteByBusinessEventId).not.toHaveBeenCalled();
      expect(mockEventRepo.delete).not.toHaveBeenCalled();

      // Original event is marked reversed
      expect(mockEventRepo.markReversed).toHaveBeenCalledWith(workspaceId, 'evt-orig', mockDb);

      // Reversal business event created
      expect(mockEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          description: 'Reversing erroneous paid-in',
          status: 'posted',
          reversal_of_event_id: 'evt-orig',
        }),
        mockDb,
      );

      // Entries mirrored with negated deltas and is_reversal: true
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            position_id: 'pos-fund-1',
            entry_type: 'paid_in',
            is_reversal: true,
            commitment_delta: '0.00000000',
            quantity_delta: '-50.00000000',
            cash_delta: '50000.00000000',
            currency: 'USD',
            price_per_unit: '1000.00000000',
            notes: 'Initial capital call',
          }),
        ]),
        mockDb,
      );

      // Allocations mirrored with positive amount for reversal entry
      expect(mockAllocationRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            funding_source_id: 'fs-1',
            amount: '50000.00000000',
          }),
        ]),
        mockDb,
      );

      expect(res.event.reversal_of_event_id).toBe('evt-orig');
      expect(res.entries).toHaveLength(1);
    });

    it('defaults the reversal date to the original event date when options.event_date is omitted', async () => {
      const origEvent = {
        id: 'evt-2018',
        workspace_id: workspaceId,
        event_date: '2018-05-12',
        status: 'posted',
        description: 'Old 2018 event',
      };
      const origEntries = [
        {
          id: 'ent-2018',
          position_id: 'pos-fund-1',
          business_event_id: 'evt-2018',
          entry_type: 'paid_in',
          commitment_delta: '0',
          quantity_delta: '10',
          cash_delta: '-1000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);

      await service.reverseEvent(workspaceId, 'evt-2018');

      expect(mockEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          event_date: '2018-05-12',
          reversal_of_event_id: 'evt-2018',
        }),
        mockDb,
      );
    });

    it('respects caller-supplied event_date when reversing', async () => {
      const origEvent = {
        id: 'evt-2018-explicit',
        workspace_id: workspaceId,
        event_date: '2018-05-12',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-2018-exp',
          position_id: 'pos-fund-1',
          business_event_id: 'evt-2018-explicit',
          entry_type: 'paid_in',
          commitment_delta: '0',
          quantity_delta: '10',
          cash_delta: '-1000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);

      await service.reverseEvent(workspaceId, 'evt-2018-explicit', {
        event_date: '2026-09-01',
      });

      expect(mockEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          event_date: '2026-09-01',
          reversal_of_event_id: 'evt-2018-explicit',
        }),
        mockDb,
      );
    });

    it('reverses two-legged transfers atomically and passes netting validation', async () => {
      const origEvent = {
        id: 'evt-xfer',
        workspace_id: workspaceId,
        event_date: '2026-08-20',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-leg-1',
          position_id: 'pos-fund-1',
          business_event_id: 'evt-xfer',
          entry_type: 'commitment_transfer',
          commitment_delta: '1000.00000000',
          quantity_delta: '0.00000000',
          cash_delta: '0.00000000',
          currency: 'USD',
          counterparty_position_id: 'pos-fund-2',
        },
        {
          id: 'ent-leg-2',
          position_id: 'pos-fund-2',
          business_event_id: 'evt-xfer',
          entry_type: 'commitment_transfer',
          commitment_delta: '-1000.00000000',
          quantity_delta: '0.00000000',
          cash_delta: '0.00000000',
          currency: 'USD',
          counterparty_position_id: 'pos-fund-1',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);

      const res = await service.reverseEvent(workspaceId, 'evt-xfer');

      expect(res.event.reversal_of_event_id).toBe('evt-xfer');
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            position_id: 'pos-fund-1',
            entry_type: 'commitment_transfer',
            is_reversal: true,
            commitment_delta: '-1000.00000000',
          }),
          expect.objectContaining({
            position_id: 'pos-fund-2',
            entry_type: 'commitment_transfer',
            is_reversal: true,
            commitment_delta: '1000.00000000',
          }),
        ]),
        mockDb,
      );
    });

    it('throws EntityNotFoundError when the event is missing', async () => {
      mockEventRepo.findById.mockResolvedValue(undefined);

      await expect(service.reverseEvent(workspaceId, 'evt-missing')).rejects.toThrow(
        EntityNotFoundError,
      );
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
      expect(mockEventRepo.markReversed).not.toHaveBeenCalled();
    });

    it('rejects reversal of an already-reversed event with EventAlreadyReversedError', async () => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'evt-rev',
        workspace_id: workspaceId,
        status: 'reversed',
      });

      await expect(service.reverseEvent(workspaceId, 'evt-rev')).rejects.toThrow(
        EventAlreadyReversedError,
      );
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
      expect(mockEventRepo.markReversed).not.toHaveBeenCalled();
    });

    it('rejects reversal of a reversal event with CannotReverseReversalError', async () => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'evt-rev-child',
        workspace_id: workspaceId,
        status: 'posted',
        reversal_of_event_id: 'evt-orig',
      });

      await expect(service.reverseEvent(workspaceId, 'evt-rev-child')).rejects.toThrow(
        CannotReverseReversalError,
      );
      expect(mockEventRepo.create).not.toHaveBeenCalled();
      expect(mockEventRepo.markReversed).not.toHaveBeenCalled();
    });
  });

  describe('deleteEvent', () => {
    it('rejects hard deletion of a posted event with CannotDeletePostedEventError', async () => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'evt-posted',
        workspace_id: workspaceId,
        status: 'posted',
      });

      await expect(service.deleteEvent(workspaceId, 'evt-posted')).rejects.toThrow(
        CannotDeletePostedEventError,
      );
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
      expect(mockLedgerRepo.deleteByBusinessEventId).not.toHaveBeenCalled();
    });

    it('rejects hard deletion of a reversed event with CannotDeletePostedEventError', async () => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'evt-reversed',
        workspace_id: workspaceId,
        status: 'reversed',
      });

      await expect(service.deleteEvent(workspaceId, 'evt-reversed')).rejects.toThrow(
        CannotDeletePostedEventError,
      );
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
      expect(mockLedgerRepo.deleteByBusinessEventId).not.toHaveBeenCalled();
    });
  });

  describe('Transactional & Sentinel Executor assertions', () => {
    it('passes sentinel executor to EVERY touched repo method on postEvent without nested tx', async () => {
      mockFundingSourceRepo.findByIds.mockResolvedValue([{ id: 'fs-1', workspace_id: workspaceId }]);

      await service.postEvent(
        workspaceId,
        {
          business_event_id: 'evt-det-1',
          event_date: '2026-08-23',
          source_record_id: 'src-1',
          entries: [
            {
              id: 'ent-det-1',
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-1000',
              currency: 'USD',
              allocations: [{ funding_source_id: 'fs-1', amount: '1000' }],
            },
          ],
        },
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockPositionRepo.findByIds).toHaveBeenCalledWith(workspaceId, ['pos-fund-1'], sentinelExecutor);
      expect(mockSourceRecordRepo.findByIds).toHaveBeenCalledWith(workspaceId, ['src-1'], sentinelExecutor);
      expect(mockFundingSourceRepo.findByIds).toHaveBeenCalledWith(workspaceId, ['fs-1'], sentinelExecutor);
      expect(mockEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt-det-1' }),
        sentinelExecutor,
      );
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'ent-det-1' })]),
        sentinelExecutor,
      );
      expect(mockAllocationRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ funding_source_id: 'fs-1' })]),
        sentinelExecutor,
      );
    });

    it('passes sentinel executor to EVERY touched repo method on reverseEvent', async () => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'evt-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-20',
        status: 'posted',
      });
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue([
        {
          id: 'ent-1',
          position_id: 'pos-fund-1',
          entry_type: 'paid_in',
          commitment_delta: '0',
          quantity_delta: '10',
          cash_delta: '-1000',
          currency: 'USD',
        },
      ]);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);

      await service.reverseEvent(workspaceId, 'evt-orig', undefined, sentinelExecutor);

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockEventRepo.findById).toHaveBeenCalledWith(workspaceId, 'evt-orig', sentinelExecutor);
      expect(mockLedgerRepo.findByBusinessEventId).toHaveBeenCalledWith(workspaceId, 'evt-orig', sentinelExecutor);
      expect(mockAllocationRepo.findByLedgerEntryIds).toHaveBeenCalledWith(workspaceId, ['ent-1'], sentinelExecutor);
      expect(mockEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          reversal_of_event_id: 'evt-orig',
        }),
        sentinelExecutor,
      );
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(
        expect.any(Array),
        sentinelExecutor,
      );
      expect(mockEventRepo.markReversed).toHaveBeenCalledWith(workspaceId, 'evt-orig', sentinelExecutor);
      expect(mockAllocationRepo.deleteByLedgerEntryIds).not.toHaveBeenCalled();
      expect(mockLedgerRepo.deleteByBusinessEventId).not.toHaveBeenCalled();
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('Convenience wrappers', () => {
    it('recordCommitment builds and posts valid commitment entry', async () => {
      const res = await service.recordCommitment(workspaceId, {
        positionId: 'pos-fund-1',
        amount: '500000',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(res.entries[0].commitment_delta).toBe('500000.00000000');
    });

    it('recordPaidIn builds negative cash delta and units', async () => {
      const res = await service.recordPaidIn(workspaceId, {
        positionId: 'pos-fund-1',
        cashAmount: '200000',
        unitsIssued: '200',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(res.entries[0].cash_delta).toBe('-200000.00000000');
      expect(res.entries[0].quantity_delta).toBe('200.00000000');
    });

    it('recordDistribution builds positive cash delta', async () => {
      const res = await service.recordDistribution(workspaceId, {
        positionId: 'pos-fund-1',
        amount: '50000',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(res.entries[0].cash_delta).toBe('50000.00000000');
    });

    it('recordBuy and recordSell on asset positions', async () => {
      const buy = await service.recordBuy(workspaceId, {
        positionId: 'pos-asset-1',
        cashAmount: '1000000',
        quantity: '5000',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(buy.entries[0].cash_delta).toBe('-1000000.00000000');
      expect(buy.entries[0].quantity_delta).toBe('5000.00000000');

      const sell = await service.recordSell(workspaceId, {
        positionId: 'pos-asset-1',
        cashAmount: '1500000',
        quantity: '5000',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(sell.entries[0].cash_delta).toBe('1500000.00000000');
      expect(sell.entries[0].quantity_delta).toBe('-5000.00000000');
    });

    it('recordCommitmentTransfer and recordUnitTransfer create balanced legs', async () => {
      const ct = await service.recordCommitmentTransfer(workspaceId, {
        fromPositionId: 'pos-fund-1',
        toPositionId: 'pos-fund-2',
        amount: '100000',
        cashConsideration: '10000',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(ct.entries).toHaveLength(2);
      expect(ct.entries[0].commitment_delta).toBe('-100000.00000000');
      expect(ct.entries[1].commitment_delta).toBe('100000.00000000');

      const ut = await service.recordUnitTransfer(workspaceId, {
        fromPositionId: 'pos-fund-1',
        toPositionId: 'pos-fund-2',
        units: '500',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(ut.entries).toHaveLength(2);
      expect(ut.entries[0].quantity_delta).toBe('-500.00000000');
      expect(ut.entries[1].quantity_delta).toBe('500.00000000');
    });

    it('recordIncome, recordExpense, recordAdjustment', async () => {
      const inc = await service.recordIncome(workspaceId, {
        positionId: 'pos-fund-1',
        amount: '500',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(inc.entries[0].cash_delta).toBe('500.00000000');

      const exp = await service.recordExpense(workspaceId, {
        positionId: 'pos-fund-1',
        amount: '200',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(exp.entries[0].cash_delta).toBe('-200.00000000');

      const adj = await service.recordAdjustment(workspaceId, {
        positionId: 'pos-fund-1',
        quantityDelta: '10',
        date: '2026-08-23',
        currency: 'USD',
      });
      expect(adj.entries[0].cash_delta).toBe('0.00000000');
      expect(adj.entries[0].quantity_delta).toBe('10.00000000');
    });

    it('listEntriesByPositionIds reads entries and count', async () => {
      mockLedgerRepo.findByPositionIds.mockResolvedValue([{ id: 'ent-1' }]);
      mockLedgerRepo.countByPositionIds.mockResolvedValue(1);

      const result = await service.listEntriesByPositionIds(
        workspaceId,
        ['pos-fund-1'],
        undefined,
        sentinelExecutor,
      );
      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockLedgerRepo.findByPositionIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-fund-1'],
        undefined,
        sentinelExecutor,
      );
      expect(mockLedgerRepo.countByPositionIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-fund-1'],
        sentinelExecutor,
      );
    });
  });

  describe('updateEvent', () => {
    const origEvent = {
      id: 'be-orig-update',
      workspace_id: workspaceId,
      event_date: '2026-08-20',
      description: 'Original event before update',
      status: 'posted' as const,
      reversal_of_event_id: null,
      source_record_id: 'src-1',
      created_by: 'user-1',
    };

    const origEntries = [
      {
        id: 'ent-orig-1',
        position_id: 'pos-fund-1',
        business_event_id: 'be-orig-update',
        entry_type: 'paid_in' as const,
        sub_type: null,
        commitment_delta: '0.00000000',
        quantity_delta: '100.00000000',
        cash_delta: '-100000.00000000',
        currency: 'USD',
        is_reversal: false,
      },
    ];

    const origAllocations = [
      {
        id: 'alloc-orig-1',
        ledger_entry_id: 'ent-orig-1',
        funding_source_id: 'fs-1',
        amount: '100000.00000000',
        created_by: 'user-1',
      },
    ];

    it('mutates the event in place: preserves event id, leaves status as posted, never calls eventRepo.create or markReversed', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);

      const updateInput = {
        event_date: '2026-08-25',
        description: 'Updated event in place',
        source_record_id: 'src-2',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '150',
            cash_delta: '-150000',
            currency: 'USD',
          },
        ],
      };

      const result = await service.updateEvent(
        workspaceId,
        'be-orig-update',
        updateInput,
        { updated_by: 'user-updater' },
      );

      // Mutates in place with same ID and status=posted
      expect(result.event.id).toBe('be-orig-update');
      expect(result.event.status).toBe('posted');
      expect(result.event.description).toBe('Updated event in place');
      expect(result.event.event_date).toBe('2026-08-25');

      // Never creates a second event, never marks reversed
      expect(mockEventRepo.create).not.toHaveBeenCalled();
      expect(mockEventRepo.markReversed).not.toHaveBeenCalled();

      // Calls eventRepo.update with updated_by
      expect(mockEventRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'be-orig-update',
        {
          event_date: '2026-08-25',
          description: 'Updated event in place',
          source_record_id: 'src-2',
          updated_by: 'user-updater',
        },
        mockDb,
      );
    });

    it('deletes old entries and allocations and inserts replacement rows under the same business_event_id', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);

      const updateInput = {
        event_date: '2026-08-25',
        description: 'Replacement entries test',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '200',
            cash_delta: '-200000',
            currency: 'USD',
          },
        ],
      };

      const result = await service.updateEvent(
        workspaceId,
        'be-orig-update',
        updateInput,
      );

      // Old allocations and entries deleted
      expect(mockAllocationRepo.deleteByLedgerEntryIds).toHaveBeenCalledWith(
        ['ent-orig-1'],
        mockDb,
      );
      expect(mockLedgerRepo.deleteByBusinessEventId).toHaveBeenCalledWith(
        workspaceId,
        'be-orig-update',
        mockDb,
      );

      // Replacement entries inserted under same business_event_id
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            business_event_id: 'be-orig-update',
            is_reversal: false,
            quantity_delta: '200.00000000',
            cash_delta: '-200000.00000000',
          }),
        ]),
        mockDb,
      );
      expect(result.entries).toHaveLength(2);
    });

    it('writes a revision row before deleting old rows, with revision_no from nextRevisionNo and faithful snapshot', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);

      const updateInput = {
        event_date: '2026-08-25',
        description: 'Snapshot order test',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-100000',
            currency: 'USD',
          },
        ],
      };

      await service.updateEvent(
        workspaceId,
        'be-orig-update',
        updateInput,
        { updated_by: 'audit-user' },
      );

      // Revision row written with faithful snapshot and nextRevisionNo
      expect(mockRevisionRepo.create).toHaveBeenCalledWith(
        {
          workspace_id: workspaceId,
          business_event_id: 'be-orig-update',
          revision_no: 1,
          snapshot: {
            event: origEvent,
            entries: origEntries,
            allocations: origAllocations,
          },
          changed_by: 'audit-user',
        },
        mockDb,
      );

      // Crucial: revision write happened BEFORE the deletions
      const revisionOrder = mockRevisionRepo.create.mock.invocationCallOrder[0];
      const deleteAllocOrder = mockAllocationRepo.deleteByLedgerEntryIds.mock.invocationCallOrder[0];
      const deleteEntriesOrder = mockLedgerRepo.deleteByBusinessEventId.mock.invocationCallOrder[0];

      expect(revisionOrder).toBeLessThan(deleteAllocOrder);
      expect(revisionOrder).toBeLessThan(deleteEntriesOrder);
    });

    it('writes revision_no 2 on a second update to the same event', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      // nextRevisionNo returns 2 for this second edit
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(2);

      const updateInput = {
        event_date: '2026-08-26',
        description: 'Second edit on event',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '300',
            cash_delta: '-300000',
            currency: 'USD',
          },
        ],
      };

      await service.updateEvent(workspaceId, 'be-orig-update', updateInput);

      expect(mockRevisionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          business_event_id: 'be-orig-update',
          revision_no: 2,
        }),
        mockDb,
      );
    });

    it('regenerates derived cash legs when currency changes (old currency leg gone, new currency leg created)', async () => {
      // Original was a buy on pos-asset-1 with USD, which derived cash_movement on pos-cash-usd-1
      const buyEvent = {
        id: 'be-buy-event',
        workspace_id: workspaceId,
        event_date: '2026-08-20',
        description: 'Original buy in USD',
        status: 'posted' as const,
        reversal_of_event_id: null,
      };
      const buyEntriesUsd = [
        {
          id: 'ent-buy-usd',
          position_id: 'pos-asset-1',
          business_event_id: 'be-buy-event',
          entry_type: 'buy' as const,
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          valuation_delta: '0.00000000',
          cash_delta: '-50000.00000000',
          currency: 'USD',
          is_reversal: false,
        },
        {
          id: 'ent-cash-usd',
          position_id: 'pos-cash-usd-1',
          business_event_id: 'be-buy-event',
          entry_type: 'cash_movement' as const,
          commitment_delta: '0.00000000',
          quantity_delta: '0.00000000',
          valuation_delta: '0.00000000',
          cash_delta: '-50000.00000000',
          currency: 'USD',
          source_ledger_entry_id: 'ent-buy-usd',
          is_reversal: false,
        },
      ];

      mockEventRepo.findById.mockResolvedValue(buyEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(buyEntriesUsd);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);
      mockFundRepo.findByIds.mockResolvedValue([
        { id: 'fund-1', workspace_id: workspaceId, name: 'Fund 1', managed: true, base_currency: 'USD' },
      ]);

      // Now update the buy entry currency from USD to EUR
      const updateInputEur = {
        event_date: '2026-08-20',
        description: 'Updated buy in EUR',
        entries: [
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-45000',
            currency: 'EUR',
          },
        ],
      };

      await service.updateEvent(workspaceId, 'be-buy-event', updateInputEur);

      // Both old USD entries were deleted
      expect(mockLedgerRepo.deleteByBusinessEventId).toHaveBeenCalledWith(
        workspaceId,
        'be-buy-event',
        mockDb,
      );

      // New entries created have: 1 buy entry (EUR) + 1 derived cash leg on pos-cash-eur-1 (EUR)
      const createdEntriesCall = mockLedgerRepo.createMany.mock.calls.find((call: any[]) =>
        call[0]?.some((e: any) => e.business_event_id === 'be-buy-event'),
      );
      expect(createdEntriesCall).toBeDefined();
      const inserted = createdEntriesCall[0];
      expect(inserted).toHaveLength(2);

      const buyEntry = inserted.find((e: any) => e.entry_type === 'buy');
      const cashLeg = inserted.find((e: any) => e.entry_type === 'cash_movement');

      expect(buyEntry.currency).toBe('EUR');
      expect(cashLeg.position_id).toBe('pos-cash-eur-1');
      expect(cashLeg.currency).toBe('EUR');
      expect(cashLeg.cash_delta).toBe('-45000.00000000');
      // No leg on USD cash position
      expect(inserted.some((e: any) => e.position_id === 'pos-cash-usd-1')).toBe(false);
    });

    describe('refusal cases', () => {
      it('throws EntityNotFoundError when event does not exist', async () => {
        mockEventRepo.findById.mockResolvedValue(undefined);

        await expect(
          service.updateEvent(workspaceId, 'be-nonexistent', {
            event_date: '2026-08-25',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(EntityNotFoundError);
      });

      it('refuses to edit a reversed event with EventAlreadyReversedError', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'be-reversed',
          workspace_id: workspaceId,
          status: 'reversed',
        });

        await expect(
          service.updateEvent(workspaceId, 'be-reversed', {
            event_date: '2026-08-25',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrowError(
          /Event be-reversed has been reversed\. The later corrected event is the live one to edit\./,
        );
      });

      it('refuses to edit a reversal event (reversal_of_event_id set) with CannotReverseReversalError', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'be-reversal',
          workspace_id: workspaceId,
          status: 'posted',
          reversal_of_event_id: 'be-original-id',
        });

        await expect(
          service.updateEvent(workspaceId, 'be-reversal', {
            event_date: '2026-08-25',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrowError(
          /A reversal event cannot be edited/,
        );
      });

      it('refuses to edit an event containing is_reversal rows with CannotReverseReversalError', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'be-with-rev-rows',
          workspace_id: workspaceId,
          status: 'posted',
          reversal_of_event_id: null,
        });
        mockLedgerRepo.findByBusinessEventId.mockResolvedValue([
          {
            id: 'ent-rev',
            position_id: 'pos-fund-1',
            entry_type: 'paid_in',
            is_reversal: true,
          },
        ]);

        await expect(
          service.updateEvent(workspaceId, 'be-with-rev-rows', {
            event_date: '2026-08-25',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrowError(
          /A reversal event cannot be edited: event be-with-rev-rows contains reversal entries/,
        );
      });

      it('rejects input with is_reversal: true', async () => {
        mockEventRepo.findById.mockResolvedValue(origEvent);
        mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
        mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);

        await expect(
          service.updateEvent(workspaceId, 'be-orig-update', {
            event_date: '2026-08-25',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'commitment',
                commitment_delta: '1000',
                currency: 'USD',
                is_reversal: true,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });
    });

    it('ensures a validation failure leaves nothing half-written inside the transaction', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);

      // Invalid delta shape in replacement entry
      const badInput = {
        event_date: '2026-08-25',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            cash_delta: '100', // positive cash_delta is invalid for paid_in
            currency: 'USD',
          },
        ],
      };

      await expect(
        service.updateEvent(workspaceId, 'be-orig-update', badInput),
      ).rejects.toThrow(InvalidEntryShapeError);

      // Pre-transaction validation throws before opening a transaction or writing revisions
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockRevisionRepo.create).not.toHaveBeenCalled();
      expect(mockEventRepo.update).not.toHaveBeenCalled();
    });

    it('passes sentinel executor to EVERY touched repo method on updateEvent', async () => {
      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue(origAllocations);
      mockRevisionRepo.nextRevisionNo.mockResolvedValue(1);

      const updateInput = {
        event_date: '2026-08-25',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-100000',
            currency: 'USD',
          },
        ],
      };

      await service.updateEvent(
        workspaceId,
        'be-orig-update',
        updateInput,
        undefined,
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockEventRepo.findById).toHaveBeenCalledWith(workspaceId, 'be-orig-update', sentinelExecutor);
      expect(mockLedgerRepo.findByBusinessEventId).toHaveBeenCalledWith(workspaceId, 'be-orig-update', sentinelExecutor);
      expect(mockAllocationRepo.findByLedgerEntryIds).toHaveBeenCalledWith(workspaceId, ['ent-orig-1'], sentinelExecutor);
      expect(mockRevisionRepo.nextRevisionNo).toHaveBeenCalledWith(workspaceId, 'be-orig-update', sentinelExecutor);
      expect(mockRevisionRepo.create).toHaveBeenCalledWith(expect.any(Object), sentinelExecutor);
      expect(mockAllocationRepo.deleteByLedgerEntryIds).toHaveBeenCalledWith(['ent-orig-1'], sentinelExecutor);
      expect(mockLedgerRepo.deleteByBusinessEventId).toHaveBeenCalledWith(workspaceId, 'be-orig-update', sentinelExecutor);
      expect(mockPositionRepo.findByIds).toHaveBeenCalledWith(workspaceId, ['pos-fund-1'], sentinelExecutor);
      expect(mockLedgerRepo.createMany).toHaveBeenCalledWith(expect.any(Array), sentinelExecutor);
      expect(mockEventRepo.update).toHaveBeenCalledWith(workspaceId, 'be-orig-update', expect.any(Object), sentinelExecutor);
    });
  });

  describe('replaceEvent', () => {
    it('reverses the original event and posts the replacement under a new event id', async () => {
      const origEvent = {
        id: 'be-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-23',
        description: 'Original event',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-orig-1',
          position_id: 'pos-fund-1',
          entry_type: 'paid_in',
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          cash_delta: '-100000.00000000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-fund-1', workspace_id: workspaceId, fund_id: 'fund-1', status: 'open' },
      ]);

      const replacementInput = {
        event_date: '2026-08-23',
        description: 'Corrected event',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '120',
            cash_delta: '-120000',
            currency: 'USD',
          },
        ],
      };

      const result = await service.replaceEvent(
        workspaceId,
        'be-orig',
        replacementInput,
        {
          reversal_description: 'Reversing for correction',
          corrected_business_event_id: 'be-corrected',
        },
      );

      // Original event is marked reversed, NEVER deleted
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
      expect(mockEventRepo.markReversed).toHaveBeenCalledWith(workspaceId, 'be-orig', mockDb);
      expect(result.event.description).toBe('Corrected event');
      expect(result.event.id).toBe('be-corrected');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].quantity_delta).toBe('120.00000000');
    });

    it('threads sentinel executor across both reversal and replacement without nested tx', async () => {
      const origEvent = {
        id: 'be-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-23',
        description: 'Original event',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-orig-1',
          position_id: 'pos-fund-1',
          entry_type: 'paid_in',
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          cash_delta: '-100000.00000000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-fund-1', workspace_id: workspaceId, fund_id: 'fund-1', status: 'open' },
      ]);

      const replacementInput = {
        event_date: '2026-08-23',
        description: 'Replacement with sentinel',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-100000',
            currency: 'USD',
          },
        ],
      };

      await service.replaceEvent(
        workspaceId,
        'be-orig',
        replacementInput,
        undefined,
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockEventRepo.findById).toHaveBeenCalledWith(
        workspaceId,
        'be-orig',
        sentinelExecutor,
      );
      expect(mockEventRepo.markReversed).toHaveBeenCalledWith(
        workspaceId,
        'be-orig',
        sentinelExecutor,
      );
      expect(mockEventRepo.delete).not.toHaveBeenCalled();
    });

    it('uses exactly one outer transaction when no executor is provided', async () => {
      const origEvent = {
        id: 'be-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-23',
        description: 'Original event',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-orig-1',
          position_id: 'pos-fund-1',
          entry_type: 'paid_in',
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          cash_delta: '-100000.00000000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-fund-1', workspace_id: workspaceId, fund_id: 'fund-1', status: 'open' },
      ]);

      const replacementInput = {
        event_date: '2026-08-23',
        description: 'Replacement event',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-100000',
            currency: 'USD',
          },
        ],
      };

      await service.replaceEvent(workspaceId, 'be-orig', replacementInput);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back atomic unit when replacement fails', async () => {
      const origEvent = {
        id: 'be-orig',
        workspace_id: workspaceId,
        event_date: '2026-08-23',
        description: 'Original event',
        status: 'posted',
      };
      const origEntries = [
        {
          id: 'ent-orig-1',
          position_id: 'pos-fund-1',
          entry_type: 'paid_in',
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          cash_delta: '-100000.00000000',
          currency: 'USD',
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-fund-1', workspace_id: workspaceId, fund_id: 'fund-1', status: 'open' },
      ]);

      // Invalid replacement input (e.g. InvalidEntryShapeError)
      const invalidReplacement = {
        event_date: '2026-08-23',
        description: 'Invalid replacement',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: 100 as any, // non-string invalid shape
            currency: 'USD',
          },
        ],
      };

      await expect(
        service.replaceEvent(workspaceId, 'be-orig', invalidReplacement),
      ).rejects.toThrow(InvalidEntryShapeError);

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it('ensures that if corrected-event posting fails after reversal work begins, all operations share the transaction and no mutations survive rollback', async () => {
      // In-memory transactional store to observe rollback
      let dbState = {
        events: new Map<string, any>([
          ['be-orig', { id: 'be-orig', workspace_id: workspaceId, event_date: '2026-08-23', status: 'posted' }],
        ]),
        entries: [
          {
            id: 'ent-orig-1',
            position_id: 'pos-fund-1',
            business_event_id: 'be-orig',
            entry_type: 'paid_in',
            commitment_delta: '0.00000000',
            quantity_delta: '100.00000000',
            cash_delta: '-100000.00000000',
            currency: 'USD',
          },
        ],
      };

      const transactionalExecutor = { __txId: 'tx-replace-atomicity' } as unknown as DbClient;
      const seenExecutors: DbClient[] = [];

      // Transaction harness that snapshots state and restores on failure
      mockDb.transaction.mockImplementationOnce(async (cb: (exec: DbClient) => Promise<any>) => {
        const snapshot = {
          events: new Map(Array.from(dbState.events.entries()).map(([k, v]) => [k, { ...v }])),
          entries: [...dbState.entries.map((e) => ({ ...e }))],
        };
        try {
          return await cb(transactionalExecutor);
        } catch (err) {
          dbState = snapshot; // Rollback
          throw err;
        }
      });

      mockEventRepo.findById.mockImplementation(async (_ws: string, id: string, exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        return dbState.events.get(id);
      });
      mockLedgerRepo.findByBusinessEventId.mockImplementation(async (_ws: string, eventId: string, exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        return dbState.entries.filter((e) => e.business_event_id === eventId);
      });
      mockEventRepo.create.mockImplementation(async (data: any, exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        const event = { ...data, id: data.id ?? 'evt-rev-auto' };
        dbState.events.set(event.id, event);
        return event;
      });
      mockLedgerRepo.createMany.mockImplementation(async (entries: any[], exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        dbState.entries.push(...entries);
        return entries;
      });
      mockEventRepo.markReversed.mockImplementation(async (_ws: string, id: string, exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        const ev = dbState.events.get(id);
        if (ev) ev.status = 'reversed';
      });

      // Replacement references a closed position, causing postEvent to fail inside the transaction
      // AFTER reverseEvent has executed.
      mockPositionRepo.findByIds.mockImplementation(async (_ws: string, ids: string[], exec?: DbClient) => {
        if (exec) seenExecutors.push(exec);
        return ids.map((id) => ({
          id,
          workspace_id: workspaceId,
          fund_id: 'fund-1',
          status: 'closed', // Will trigger PositionClosedError inside postEvent
        }));
      });

      const replacementInput = {
        event_date: '2026-08-23',
        description: 'Corrected event on closed position',
        entries: [
          {
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            commitment_delta: '0.00000000',
            quantity_delta: '100.00000000',
            cash_delta: '-100000.00000000',
            currency: 'USD',
          },
        ],
      };

      await expect(
        service.replaceEvent(workspaceId, 'be-orig', replacementInput),
      ).rejects.toThrow(PositionClosedError);

      // Verify that every repository call inside replaceEvent received the exact transactional executor
      expect(seenExecutors.length).toBeGreaterThanOrEqual(4);
      for (const exec of seenExecutors) {
        expect(exec).toBe(transactionalExecutor);
      }

      // Verify atomicity rollback: no reversal event or entries survive, and original status remains 'posted'
      expect(dbState.events.size).toBe(1);
      expect(dbState.events.get('be-orig')?.status).toBe('posted');
      expect(dbState.entries).toHaveLength(1);
      expect(dbState.entries[0].id).toBe('ent-orig-1');
    });
  });

  describe('paid-in adjustment accounting', () => {
    it('posts only one non-cash entry, without a generated cash leg', async () => {
      const result = await service.postEvent(workspaceId, {
        event_date: '2022-12-31',
        entries: [{ position_id: 'pos-fund-1', entry_type: 'adjustment', sub_type: 'paid_in_writeoff',
          valuation_delta: '-914781.37', currency: 'CNY' }],
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ valuation_delta: '-914781.37000000',
        cash_delta: '0.00000000', commitment_delta: '0.00000000',
        quantity_delta: '0.00000000' });
    });

    it('rejects paid-in adjustments on cash entries', async () => {
      await expect(service.postEvent(workspaceId, {
        event_date: '2022-12-31', entries: [{ position_id: 'pos-fund-1',
          entry_type: 'paid_in', cash_delta: '-100', valuation_delta: '-10', currency: 'CNY' }],
      })).rejects.toThrow();
    });

    it('reverses the paid-in adjustment without reversing any cash', async () => {
      mockEventRepo.findById.mockResolvedValue({ id: 'evt-orig', workspace_id: workspaceId,
        event_date: '2022-12-31', status: 'posted' });
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue([{ id: 'ent-1',
        position_id: 'pos-fund-1', business_event_id: 'evt-orig', entry_type: 'adjustment', sub_type: 'paid_in_writeoff',
        entry_date: '2022-12-31', valuation_delta: '-914781.37000000',
        cash_delta: '0', commitment_delta: '0', quantity_delta: '0', currency: 'CNY' }]);
      mockAllocationRepo.findByLedgerEntryIds.mockResolvedValue([]);
      const result = await service.reverseEvent(workspaceId, 'evt-orig');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ valuation_delta: '914781.37000000',
        cash_delta: '0.00000000' });
    });
  });

  describe('valuation_delta non-cash accounting', () => {
    it('recordAdjustment accepts valuationDelta and sets valuation_delta on entry', async () => {
      const res = await service.recordAdjustment(workspaceId, {
        positionId: 'pos-fund-1',
        date: '2022-12-31',
        valuationDelta: '-914781.37000000',
        subType: 'profit_loss_writeoff',
        currency: 'CNY',
        notes: 'Non-cash writeoff test',
      });

      expect(res.event.id).toBe('evt-1');
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]).toMatchObject({
        entry_type: 'adjustment',
        sub_type: 'profit_loss_writeoff',
        cash_delta: '0.00000000',
        valuation_delta: '-914781.37000000',
        quantity_delta: '0.00000000',
        commitment_delta: '0.00000000',
      });
    });

    it('rejects valuation_delta !== 0 on non-adjustment entry types', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-08-28',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-100000.00000000',
              valuation_delta: '50000.00000000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });
  });

  describe('cash_movement validations and forms (Phase 3)', () => {
    it('rejects cash_movement with zero cash_delta', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '0',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects cash_movement with non-zero commitment or quantity or valuation delta', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              commitment_delta: '500',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              quantity_delta: '10',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);

      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              valuation_delta: '100',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects cash_movement posted to non-cash positions', async () => {
      // 1. Fund position
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(EntryPositionKindMismatchError);

      // 2. Asset position where asset_kind is not 'cash' (e.g. private_equity)
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(EntryPositionKindMismatchError);
    });

    it('rejects cash_movement if entry currency does not match cash asset currency', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              currency: 'EUR', // cash asset is USD
            },
          ],
        }),
      ).rejects.toThrow(InvalidCurrencyError);
    });

    it('rejects cash_movement with funding allocations (entry-level or top-level)', async () => {
      // Entry-level allocations
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              currency: 'USD',
              allocations: [{ funding_source_id: 'fs-1', amount: '1000' }],
            },
          ],
        }),
      ).rejects.toThrow(AllocationMismatchError);

      // Top-level allocations targeting cash_movement
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '1000',
              currency: 'USD',
            },
          ],
          allocations: [
            { entry_index: 0, funding_source_id: 'fs-1', amount: '1000' },
          ],
        }),
      ).rejects.toThrow(AllocationMismatchError);
    });

    describe('Form 1: Mirrored leg', () => {
      beforeEach(() => {
        const managedFunds = [
          { id: 'fund-1', workspace_id: workspaceId, name: 'Fund 1', managed: true, base_currency: 'USD' },
          { id: 'fund-2', workspace_id: workspaceId, name: 'Fund 2', managed: true, base_currency: 'USD' },
        ];
        mockFundRepo.findByIds.mockImplementation((_ws: string, ids: string[]) =>
          Promise.resolve(managedFunds.filter((f) => ids.includes(f.id))),
        );
        mockFundRepo.findById.mockImplementation((_ws: string, id: string) =>
          Promise.resolve(managedFunds.find((f) => f.id === id)),
        );
      });

      it('successfully posts mirrored leg using primary_entry_index, generating authoritative IDs and persisting source_ledger_entry_id', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          source_record_id: 'src-1',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-5000',
              currency: 'USD',
              data_status: 'needs_verification',
              source_record_id: 'src-1',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              cash_delta: '5000',
              currency: 'USD',
              primary_entry_index: 0,
            },
          ],
        });

        expect(res.entries).toHaveLength(2);
        const primaryLeg = res.entries[0];
        const cashLeg = res.entries[1];
        expect(primaryLeg.id).toBeDefined();
        expect(cashLeg.id).toBeDefined();
        expect(cashLeg.id).not.toBe(primaryLeg.id);
        expect(cashLeg.source_ledger_entry_id).toBe(primaryLeg.id);
        expect(cashLeg.data_status).toBe('needs_verification');
        expect(cashLeg.source_record_id).toBe('src-1');
        expect(cashLeg.cash_delta).toBe('5000.00000000');
        expect(cashLeg.commitment_delta).toBe('0.00000000');
        expect(cashLeg.quantity_delta).toBe('0.00000000');
      });

      it('supports source_entry_index as an alias for primary_entry_index', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              cash_delta: '-5000',
              currency: 'USD',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              cash_delta: '5000',
              currency: 'USD',
              source_entry_index: 0,
            },
          ],
        });

        expect(res.entries[1].source_ledger_entry_id).toBe(res.entries[0].id);
      });

      it('rejects caller-supplied persisted source_ledger_entry_id', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                source_ledger_entry_id: '00000000-0000-0000-0000-000000000001',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects missing pairing reference for non-transfer non-opening cash_movement', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects out-of-range primary_entry_index', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 5,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);

        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: -1,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects mirrored leg self-reference', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects non-primary entry reference (pointing to another cash_movement)', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                sub_type: 'opening_balance',
                cash_delta: '5000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects ambiguous pairing reference if primary_entry_index and source_entry_index conflict', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                cash_delta: '-5000',
                currency: 'USD',
              },
              {
                position_id: 'pos-fund-2',
                entry_type: 'paid_in',
                cash_delta: '-5000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 0,
                source_entry_index: 1,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects duplicate (primary_entry_index, position_id)', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                cash_delta: '-5000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '2500',
                currency: 'USD',
                primary_entry_index: 0,
              },
              {
                position_id: 'pos-cash-usd-1', // duplicate pair!
                entry_type: 'cash_movement',
                cash_delta: '2500',
                currency: 'USD',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects mirrored leg if supplied currency conflicts with primary entry currency', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-01',
            source_record_id: 'src-top',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                entry_date: '2026-08-20',
                currency: 'USD',
                data_status: 'verified',
                source_record_id: 'src-primary',
                cash_delta: '-3000',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                entry_date: '2026-09-10', // conflicting date
                currency: 'EUR', // conflicting currency -> must be rejected
                data_status: 'needs_verification', // conflicting status
                source_record_id: 'src-conflicting', // conflicting source record
                cash_delta: '3000',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidCurrencyError);
      });

      it('rejects explicit mirrored leg whose currency differs from its primary through postEvent naming both currencies', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-01',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                entry_date: '2026-08-20',
                currency: 'USD',
                cash_delta: '-3000',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                currency: 'EUR',
                cash_delta: '3000',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(/EUR.*USD|USD.*EUR/);
      });

      it('hard-copies mirrored metadata (entry_date, data_status, source_record_id) overwriting conflicting values when currency matches', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-01',
          source_record_id: 'src-top',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              entry_date: '2026-08-20',
              currency: 'USD',
              data_status: 'verified',
              source_record_id: 'src-primary',
              cash_delta: '-3000',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              entry_date: '2026-09-10', // conflicting date
              currency: 'USD', // matching currency
              data_status: 'needs_verification', // conflicting status
              source_record_id: 'src-conflicting', // conflicting source record
              cash_delta: '3000',
              primary_entry_index: 0,
            },
          ],
        });

        const cashLeg = res.entries[1];
        expect(cashLeg.entry_date).toBe('2026-08-20');
        expect(cashLeg.currency).toBe('USD');
        expect(cashLeg.data_status).toBe('verified');
        expect(cashLeg.source_record_id).toBe('src-primary');
        expect(cashLeg.source_ledger_entry_id).toBe(res.entries[0].id);
      });

      it('defaults currency from primary when mirrored leg does not supply one', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-01',
          source_record_id: 'src-top',
          entries: [
            {
              position_id: 'pos-fund-1',
              entry_type: 'paid_in',
              entry_date: '2026-08-20',
              currency: 'USD',
              data_status: 'verified',
              source_record_id: 'src-primary',
              cash_delta: '-3000',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              cash_delta: '3000',
              primary_entry_index: 0,
            } as any,
          ],
        });

        const cashLeg = res.entries[1];
        expect(cashLeg.currency).toBe('USD');
      });

      it('rejects mirrored leg if primary entry currency does not match cash position currency', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                cash_delta: '-5000',
                currency: 'EUR',
              },
              {
                position_id: 'pos-cash-usd-1', // asset currency is USD, but primary is EUR
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidCurrencyError);
      });

      it('rejects mirrored leg if counterparty_position_id is also set', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                cash_delta: '-5000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '5000',
                currency: 'USD',
                primary_entry_index: 0,
                counterparty_position_id: 'pos-cash-eur-1',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });
    });

    describe('Form 2: FX transfer', () => {
      it('successfully posts paired FX transfer legs on positions with same holder fund', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              id: 'ent-fx-usd',
              position_id: 'pos-cash-usd-1',
              counterparty_position_id: 'pos-cash-eur-1',
              entry_type: 'cash_movement',
              cash_delta: '-1000',
              currency: 'USD',
            },
            {
              id: 'ent-fx-eur',
              position_id: 'pos-cash-eur-1',
              counterparty_position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              cash_delta: '920',
              currency: 'EUR',
            },
          ],
        });

        expect(res.entries).toHaveLength(2);
        expect(res.entries[0].counterparty_position_id).toBe('pos-cash-eur-1');
        expect(res.entries[1].counterparty_position_id).toBe('pos-cash-usd-1');
      });

      it('rejects FX transfer without matching sibling leg', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                counterparty_position_id: 'pos-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(UnbalancedTransferError);
      });

      it('rejects FX transfer if legs belong to different holder funds', async () => {
        // pos-cash-usd-fund2 has holder_fund_id: 'fund-2', whereas pos-cash-eur-1 has 'fund-1'
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-fund2',
                counterparty_position_id: 'pos-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-eur-1',
                counterparty_position_id: 'pos-cash-usd-fund2',
                entry_type: 'cash_movement',
                cash_delta: '920',
                currency: 'EUR',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects FX transfer between an investor cash position and a fund cash position', async () => {
        // pos-inv-cash-usd-1 (investor inv-1) and pos-cash-eur-1 (fund fund-1)
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-inv-cash-usd-1',
                counterparty_position_id: 'pos-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-eur-1',
                counterparty_position_id: 'pos-inv-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '920',
                currency: 'EUR',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects FX transfer if legs belong to different holder investors', async () => {
        const openInvestor2CashPositionEur = {
          id: 'pos-inv2-cash-eur-1',
          workspace_id: workspaceId,
          fund_id: null,
          asset_id: 'asset-cash-eur',
          holder_investor_id: 'inv-2',
          holder_fund_id: null,
          holder_source_of_fund_id: null,
          status: 'open',
        };
        mockPositionRepo.findByIds.mockImplementationOnce((_ws: string, ids: string[]) => {
          return Promise.resolve([openInvestorCashPositionUsd, openInvestor2CashPositionEur].filter((p) => ids.includes(p.id)));
        });

        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-inv-cash-usd-1',
                counterparty_position_id: 'pos-inv2-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-inv2-cash-eur-1',
                counterparty_position_id: 'pos-inv-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '920',
                currency: 'EUR',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects FX transfer if currencies are the same', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                counterparty_position_id: 'pos-cash-usd-fund2',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-fund2',
                counterparty_position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '1000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });

      it('rejects FX transfer if sibling has primary_entry_index or source_ledger_entry_id', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-fund-1',
                entry_type: 'paid_in',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-usd-1',
                counterparty_position_id: 'pos-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-eur-1',
                counterparty_position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '920',
                currency: 'EUR',
                primary_entry_index: 0,
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);

        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                counterparty_position_id: 'pos-cash-eur-1',
                entry_type: 'cash_movement',
                cash_delta: '-1000',
                currency: 'USD',
              },
              {
                position_id: 'pos-cash-eur-1',
                counterparty_position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '920',
                currency: 'EUR',
                source_ledger_entry_id: '00000000-0000-0000-0000-000000000001',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });
    });

    describe('Form 3: Opening balance', () => {
      it('successfully posts opening balance cash movement', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              sub_type: 'opening_balance',
              cash_delta: '100000',
              currency: 'USD',
            },
          ],
        });

        expect(res.entries).toHaveLength(1);
        expect(res.entries[0].sub_type).toBe('opening_balance');
        expect(res.entries[0].source_ledger_entry_id).toBeNull();
        expect(res.entries[0].counterparty_position_id).toBeNull();
      });

      it('rejects standalone cash movement without opening_balance sub_type', async () => {
        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-03',
            entries: [
              {
                position_id: 'pos-cash-usd-1',
                entry_type: 'cash_movement',
                cash_delta: '100000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(InvalidEntryShapeError);
      });
    });

    describe('Reversals with cash_movement', () => {
      it('reverses event with mirrored cash_movement cleanly', async () => {
        const origEvent = {
          id: 'be-with-cash',
          workspace_id: workspaceId,
          event_date: '2026-09-01',
          status: 'posted',
          description: 'Original event with cash leg',
        };
        const origEntries = [
          {
            id: 'ent-orig-primary',
            position_id: 'pos-fund-1',
            entry_type: 'paid_in' as const,
            sub_type: null,
            is_reversal: false,
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            valuation_delta: '0.00000000',
            cash_delta: '-5000.00000000',
            currency: 'USD',
            counterparty_position_id: null,
            source_ledger_entry_id: null,
            data_status: 'verified' as const,
          },
          {
            id: 'ent-orig-cash',
            position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement' as const,
            sub_type: null,
            is_reversal: false,
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            valuation_delta: '0.00000000',
            cash_delta: '5000.00000000',
            currency: 'USD',
            counterparty_position_id: null,
            source_ledger_entry_id: 'ent-orig-primary',
            data_status: 'verified' as const,
          },
        ];

        mockEventRepo.findById.mockResolvedValue(origEvent);
        mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

        const res = await service.reverseEvent(workspaceId, 'be-with-cash');
        expect(res.event.status).toBe('posted');
        expect(res.entries).toHaveLength(2);

        const revPrimary = res.entries.find(
          (e) => e.position_id === 'pos-fund-1',
        )!;
        const revCash = res.entries.find(
          (e) => e.position_id === 'pos-cash-usd-1',
        )!;

        expect(revPrimary.cash_delta).toBe('5000.00000000');
        expect(revPrimary.is_reversal).toBe(true);

        expect(revCash.cash_delta).toBe('-5000.00000000');
        expect(revCash.is_reversal).toBe(true);
        expect(revCash.source_ledger_entry_id).toBe(revPrimary.id);
      });

      it('reverses FX transfer cleanly', async () => {
        const origEvent = {
          id: 'be-with-fx',
          workspace_id: workspaceId,
          event_date: '2026-09-01',
          status: 'posted',
          description: 'Original FX transfer',
        };
        const origEntries = [
          {
            id: 'ent-fx-1',
            position_id: 'pos-cash-usd-1',
            counterparty_position_id: 'pos-cash-eur-1',
            entry_type: 'cash_movement' as const,
            sub_type: null,
            is_reversal: false,
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            valuation_delta: '0.00000000',
            cash_delta: '-1000.00000000',
            currency: 'USD',
            source_ledger_entry_id: null,
            data_status: 'verified' as const,
          },
          {
            id: 'ent-fx-2',
            position_id: 'pos-cash-eur-1',
            counterparty_position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement' as const,
            sub_type: null,
            is_reversal: false,
            commitment_delta: '0.00000000',
            quantity_delta: '0.00000000',
            valuation_delta: '0.00000000',
            cash_delta: '920.00000000',
            currency: 'EUR',
            source_ledger_entry_id: null,
            data_status: 'verified' as const,
          },
        ];

        mockEventRepo.findById.mockResolvedValue(origEvent);
        mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

        const res = await service.reverseEvent(workspaceId, 'be-with-fx');
        expect(res.entries).toHaveLength(2);

        const rev1 = res.entries.find(
          (e) => e.position_id === 'pos-cash-usd-1',
        )!;
        const rev2 = res.entries.find(
          (e) => e.position_id === 'pos-cash-eur-1',
        )!;

        expect(rev1.cash_delta).toBe('1000.00000000');
        expect(rev2.cash_delta).toBe('-920.00000000');
        expect(rev1.counterparty_position_id).toBe('pos-cash-eur-1');
        expect(rev2.counterparty_position_id).toBe('pos-cash-usd-1');
      });
    });
  });

  describe('Phase 4: role-based cash-leg posting (RFC §4)', () => {
    beforeEach(() => {
      // Configure fund-1 as managed = true for Phase 4 tests
      const managedFunds = [
        { id: 'fund-1', workspace_id: workspaceId, name: 'Fund 1', managed: true, base_currency: 'USD' },
        { id: 'fund-2', workspace_id: workspaceId, name: 'Fund 2', managed: true, base_currency: 'USD' },
        { id: 'fund-unmanaged', workspace_id: workspaceId, name: 'Unmanaged Fund', managed: false, base_currency: 'USD' },
      ];
      mockFundRepo.findByIds.mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(managedFunds.filter((f) => ids.includes(f.id))),
      );
      mockFundRepo.findById.mockImplementation((_ws: string, id: string) =>
        Promise.resolve(managedFunds.find((f) => f.id === id)),
      );
    });

    it('derives mirrored cash leg in the same event and links via source_ledger_entry_id', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Buy investment',
        source_record_id: 'src-1',
        entries: [
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-50000',
            currency: 'USD',
          },
        ],
      });

      // Primary entry + derived cash leg = 2 entries
      expect(res.entries).toHaveLength(2);

      const primary = res.entries[0];
      const cashLeg = res.entries[1];

      expect(primary.entry_type).toBe('buy');
      expect(primary.cash_delta).toBe('-50000.00000000');

      expect(cashLeg.entry_type).toBe('cash_movement');
      expect(cashLeg.position_id).toBe('pos-cash-usd-1');
      expect(cashLeg.cash_delta).toBe('-50000.00000000'); // +(-50000) = -50000
      expect(cashLeg.source_ledger_entry_id).toBe(primary.id); // Same-event ID linkage
      expect(cashLeg.entry_date).toBe('2026-09-03');
      expect(cashLeg.currency).toBe('USD');
      expect(cashLeg.data_status).toBe('verified');
      expect(cashLeg.source_record_id).toBe('src-1');
      expect(cashLeg.commitment_delta).toBe('0.00000000');
      expect(cashLeg.quantity_delta).toBe('0.00000000');
      expect(cashLeg.valuation_delta).toBe('0.00000000');
      expect(cashLeg.sub_type).toBeNull();
      expect(cashLeg.counterparty_position_id).toBeNull();

      // Allocations are NOT copied to cash leg
      expect(res.allocations).toHaveLength(0);
    });

    it('provisions cash position exactly once when multiple entries touch the same fund and currency', async () => {
      const getOrCreateSpy = vi.spyOn(service, 'getOrCreateCashPosition');
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Two buys in same fund',
        entries: [
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-10000',
            currency: 'USD',
          },
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-20000',
            currency: 'USD',
          },
        ],
      });

      // 2 primaries + 2 derived cash legs = 4 entries
      expect(res.entries).toHaveLength(4);

      const cashLeg1 = res.entries[2];
      const cashLeg2 = res.entries[3];

      expect(cashLeg1.position_id).toBe('pos-cash-usd-1');
      expect(cashLeg2.position_id).toBe('pos-cash-usd-1');
      expect(cashLeg1.source_ledger_entry_id).toBe(res.entries[0].id);
      expect(cashLeg2.source_ledger_entry_id).toBe(res.entries[1].id);
      expect(cashLeg1.cash_delta).toBe('-10000.00000000');
      expect(cashLeg2.cash_delta).toBe('-20000.00000000');

      // Assert exactly one helper/create attempt for (fund-1, USD)
      expect(getOrCreateSpy).toHaveBeenCalledTimes(1);
      expect(getOrCreateSpy).toHaveBeenCalledWith(
        workspaceId,
        { kind: 'fund', id: 'fund-1' },
        'USD',
        expect.anything(),
      );
    });

    it('provisions cash position exactly once per distinct (fund, currency) in a multi-entry multi-fund event', async () => {
      const getOrCreateSpy = vi.spyOn(service, 'getOrCreateCashPosition');
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Multi-fund multi-currency batch',
        entries: [
          {
            position_id: 'pos-asset-1', // Fund 1
            entry_type: 'buy',
            cash_delta: '-10000',
            currency: 'USD',
          },
          {
            position_id: 'pos-asset-1', // Fund 1
            entry_type: 'buy',
            cash_delta: '-20000',
            currency: 'USD',
          },
          {
            position_id: 'pos-asset-1', // Fund 1
            entry_type: 'buy',
            cash_delta: '-8000',
            currency: 'EUR',
          },
          {
            position_id: 'pos-m2m-1-2', // Fund 1 holds Fund 2
            entry_type: 'paid_in',
            cash_delta: '-30000',
            currency: 'USD',
          },
        ],
      });

      // Distinct pairs: (fund-1, USD), (fund-1, EUR), (fund-2, USD) -> exactly 3 calls
      expect(getOrCreateSpy).toHaveBeenCalledTimes(3);
    });

    it('routes legs to correct positions in a multi-currency event', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Multi-currency buys',
        entries: [
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-10000',
            currency: 'USD',
          },
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-8000',
            currency: 'EUR',
          },
        ],
      });

      expect(res.entries).toHaveLength(4);

      const usdLeg = res.entries.find(
        (e) => e.entry_type === 'cash_movement' && e.currency === 'USD',
      )!;
      const eurLeg = res.entries.find(
        (e) => e.entry_type === 'cash_movement' && e.currency === 'EUR',
      )!;

      expect(usdLeg.position_id).toBe('pos-cash-usd-1');
      expect(usdLeg.cash_delta).toBe('-10000.00000000');
      expect(usdLeg.source_ledger_entry_id).toBe(res.entries[0].id);

      expect(eurLeg.position_id).toBe('pos-cash-eur-1');
      expect(eurLeg.cash_delta).toBe('-8000.00000000');
      expect(eurLeg.source_ledger_entry_id).toBe(res.entries[1].id);
    });

    it('suppresses duplicate generation when explicit valid mirrored leg is supplied (idempotency)', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Buy with explicit mirrored cash leg',
        entries: [
          {
            position_id: 'pos-asset-1',
            entry_type: 'buy',
            cash_delta: '-50000',
            currency: 'USD',
          },
          {
            position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '-50000',
            currency: 'USD',
          },
        ],
      });

      // Exactly 2 entries: 1 primary + 1 explicit leg (no duplicate derived leg!)
      expect(res.entries).toHaveLength(2);
      expect(res.entries[0].entry_type).toBe('buy');
      expect(res.entries[1].entry_type).toBe('cash_movement');
      expect(res.entries[1].position_id).toBe('pos-cash-usd-1');
      expect(res.entries[1].source_ledger_entry_id).toBe(res.entries[0].id);
    });

    it('managed-to-managed FoF entry: one valid explicit leg suppresses only that role and generates the other', async () => {
      // 1. Explicit leg for holder fund-1: suppresses fund-1 leg, generates fund-2 instrument leg
      const res1 = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'M2M paid_in with explicit holder leg',
        entries: [
          {
            position_id: 'pos-m2m-1-2',
            entry_type: 'paid_in',
            cash_delta: '-50000',
            currency: 'USD',
          },
          // Explicit leg on Fund 1 cash position
          {
            position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '-50000',
            currency: 'USD',
          },
        ],
      });

      // Exactly 3 entries: primary + explicit leg on Fund 1 + generated leg on Fund 2
      expect(res1.entries).toHaveLength(3);
      const primary1 = res1.entries[0];
      const explicitLeg1 = res1.entries[1];
      const generatedLeg1 = res1.entries[2];

      expect(primary1.entry_type).toBe('paid_in');
      expect(explicitLeg1.position_id).toBe('pos-cash-usd-1');
      expect(explicitLeg1.cash_delta).toBe('-50000.00000000');
      expect(explicitLeg1.source_ledger_entry_id).toBe(primary1.id);

      expect(generatedLeg1.position_id).toBe('pos-cash-usd-fund2');
      expect(generatedLeg1.cash_delta).toBe('50000.00000000');
      expect(generatedLeg1.source_ledger_entry_id).toBe(primary1.id);
      expect(generatedLeg1.commitment_delta).toBe('0.00000000');
      expect(generatedLeg1.quantity_delta).toBe('0.00000000');
      expect(generatedLeg1.valuation_delta).toBe('0.00000000');

      // 2. Explicit leg for instrument fund-2: suppresses fund-2 leg, generates fund-1 holder leg
      const res2 = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'M2M paid_in with explicit instrument leg',
        entries: [
          {
            position_id: 'pos-m2m-1-2',
            entry_type: 'paid_in',
            cash_delta: '-50000',
            currency: 'USD',
          },
          // Explicit leg on Fund 2 cash position
          {
            position_id: 'pos-cash-usd-fund2',
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '50000',
            currency: 'USD',
          },
        ],
      });

      expect(res2.entries).toHaveLength(3);
      const primary2 = res2.entries[0];
      const explicitLeg2 = res2.entries[1];
      const generatedLeg2 = res2.entries[2];

      expect(explicitLeg2.position_id).toBe('pos-cash-usd-fund2');
      expect(explicitLeg2.cash_delta).toBe('50000.00000000');
      expect(explicitLeg2.source_ledger_entry_id).toBe(primary2.id);

      expect(generatedLeg2.position_id).toBe('pos-cash-usd-1');
      expect(generatedLeg2.cash_delta).toBe('-50000.00000000');
      expect(generatedLeg2.source_ledger_entry_id).toBe(primary2.id);
    });

    it('rejects explicit leg with wrong sign with InvalidEntryShapeError', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'buy',
              cash_delta: '-50000',
              currency: 'USD',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              primary_entry_index: 0,
              cash_delta: '50000', // wrong sign: buy outflow requires -50000
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects explicit leg with wrong magnitude with InvalidEntryShapeError', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'buy',
              cash_delta: '-50000',
              currency: 'USD',
            },
            {
              position_id: 'pos-cash-usd-1',
              entry_type: 'cash_movement',
              primary_entry_index: 0,
              cash_delta: '-40000', // wrong magnitude: expected -50000
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects explicit leg referencing non-canonical cash position with InvalidEntryShapeError', async () => {
      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'buy',
              cash_delta: '-50000',
              currency: 'USD',
            },
            {
              position_id: 'pos-asset-1', // not a cash position
              entry_type: 'cash_movement',
              primary_entry_index: 0,
              cash_delta: '-50000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(EntryPositionKindMismatchError);
    });

    it('excludes instrument fund from cash legs on commitment_transfer between LPs', async () => {
      const res = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        description: 'Commitment transfer between LPs with cash consideration',
        entries: [
          {
            position_id: 'pos-fund-1',
            counterparty_position_id: 'pos-fund-2',
            entry_type: 'commitment_transfer',
            commitment_delta: '-100000',
            cash_delta: '20000', // giver receives cash
            currency: 'USD',
          },
          {
            position_id: 'pos-fund-2',
            counterparty_position_id: 'pos-fund-1',
            entry_type: 'commitment_transfer',
            commitment_delta: '100000',
            cash_delta: '-20000', // receiver pays cash
            currency: 'USD',
          },
        ],
      });

      // No cash legs derived for fund-1: cash moves holder-to-holder
      expect(res.entries).toHaveLength(2);
      expect(res.entries.every((e) => e.entry_type === 'commitment_transfer')).toBe(true);
    });

    it('rejects with WorkspaceMismatchError if a referenced fund is absent in workspace', async () => {
      mockFundRepo.findByIds.mockResolvedValueOnce([
        // Only return fund-1, omitting fund-2
        { id: 'fund-1', workspace_id: workspaceId, name: 'Fund 1', managed: true, base_currency: 'USD' },
      ]);

      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-m2m-1-2', // references both fund-1 and fund-2
              entry_type: 'paid_in',
              cash_delta: '-10000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('reverses event with derived cash legs cleanly, linking reversal leg to reversal primary', async () => {
      const origPrimaryId = 'ent-orig-primary-1';
      const origCashLegId = 'ent-orig-cash-leg-1';

      const origEvent = {
        id: 'be-with-derived-leg',
        workspace_id: workspaceId,
        event_date: '2026-09-03',
        description: 'Original event with leg',
        status: 'posted',
        source_record_id: 'src-1',
        created_by: null,
      };

      const origEntries = [
        {
          id: origPrimaryId,
          position_id: 'pos-asset-1',
          business_event_id: 'be-with-derived-leg',
          entry_date: '2026-09-03',
          entry_type: 'buy' as const,
          sub_type: null,
          is_reversal: false,
          commitment_delta: '0.00000000',
          quantity_delta: '100.00000000',
          valuation_delta: '0.00000000',
          cash_delta: '-50000.00000000',
          currency: 'USD',
          source_ledger_entry_id: null,
          data_status: 'verified' as const,
        },
        {
          id: origCashLegId,
          position_id: 'pos-cash-usd-1',
          business_event_id: 'be-with-derived-leg',
          entry_date: '2026-09-03',
          entry_type: 'cash_movement' as const,
          sub_type: null,
          is_reversal: false,
          commitment_delta: '0.00000000',
          quantity_delta: '0.00000000',
          valuation_delta: '0.00000000',
          cash_delta: '-50000.00000000',
          currency: 'USD',
          source_ledger_entry_id: origPrimaryId,
          data_status: 'verified' as const,
        },
      ];

      mockEventRepo.findById.mockResolvedValue(origEvent);
      mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

      const res = await service.reverseEvent(workspaceId, 'be-with-derived-leg');
      expect(res.entries).toHaveLength(2);

      const revPrimary = res.entries.find((e) => e.entry_type === 'buy')!;
      const revCashLeg = res.entries.find((e) => e.entry_type === 'cash_movement')!;

      expect(revPrimary.is_reversal).toBe(true);
      expect(revPrimary.cash_delta).toBe('50000.00000000');
      expect(revPrimary.quantity_delta).toBe('-100.00000000');

      expect(revCashLeg.is_reversal).toBe(true);
      expect(revCashLeg.cash_delta).toBe('50000.00000000');
      // Crucial: reversal cash leg must link to the REVERSAL primary entry, not the original!
      expect(revCashLeg.source_ledger_entry_id).toBe(revPrimary.id);
      expect(revCashLeg.source_ledger_entry_id).not.toBe(origPrimaryId);
    });

    it('ensures opening-balance and FX transfer forms do not derive recursive legs', async () => {
      // 1. Opening balance
      const obRes = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        entries: [
          {
            position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement',
            sub_type: 'opening_balance',
            cash_delta: '100000',
            currency: 'USD',
          },
        ],
      });
      expect(obRes.entries).toHaveLength(1);
      expect(obRes.entries[0].entry_type).toBe('cash_movement');

      // 2. FX transfer
      const fxRes = await service.postEvent(workspaceId, {
        event_date: '2026-09-03',
        entries: [
          {
            position_id: 'pos-cash-usd-1',
            counterparty_position_id: 'pos-cash-eur-1',
            entry_type: 'cash_movement',
            cash_delta: '-1000',
            currency: 'USD',
          },
          {
            position_id: 'pos-cash-eur-1',
            counterparty_position_id: 'pos-cash-usd-1',
            entry_type: 'cash_movement',
            cash_delta: '920',
            currency: 'EUR',
          },
        ],
      });
      expect(fxRes.entries).toHaveLength(2);
    });

    it('preserves transaction rollback on failure', async () => {
      mockLedgerRepo.createMany.mockRejectedValueOnce(
        new Error('Database write failure'),
      );

      await expect(
        service.postEvent(workspaceId, {
          event_date: '2026-09-03',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'buy',
              cash_delta: '-1000',
              currency: 'USD',
            },
          ],
        }),
      ).rejects.toThrow('Database write failure');

      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it('major callers: recordBuy, recordSell, and recordPaidIn automatically gain cash legs', async () => {
      // 1. recordBuy
      const buyRes = await service.recordBuy(workspaceId, {
        positionId: 'pos-asset-1',
        cashAmount: '50000',
        quantity: '500',
        date: '2026-09-03',
        currency: 'USD',
      });
      expect(buyRes.entries).toHaveLength(2);
      expect(buyRes.entries[0].entry_type).toBe('buy');
      expect(buyRes.entries[1].entry_type).toBe('cash_movement');
      expect(buyRes.entries[1].cash_delta).toBe('-50000.00000000');

      // 2. recordSell with divestment:cash_in_fund
      const sellRes = await service.recordSell(workspaceId, {
        positionId: 'pos-asset-1',
        cashAmount: '70000',
        quantity: '500',
        date: '2026-09-03',
        currency: 'USD',
        subType: 'divestment:cash_in_fund',
      });
      expect(sellRes.entries).toHaveLength(2);
      expect(sellRes.entries[0].entry_type).toBe('sell');
      expect(sellRes.entries[1].entry_type).toBe('cash_movement');
      expect(sellRes.entries[1].cash_delta).toBe('70000.00000000');

      // 3. recordPaidIn on managed fund
      const paidInRes = await service.recordPaidIn(workspaceId, {
        positionId: 'pos-fund-1',
        cashAmount: '120000',
        unitsIssued: '1200',
        date: '2026-09-03',
        currency: 'USD',
      });
      expect(paidInRes.entries).toHaveLength(2);
      expect(paidInRes.entries[0].entry_type).toBe('paid_in');
      expect(paidInRes.entries[1].entry_type).toBe('cash_movement');
      expect(paidInRes.entries[1].cash_delta).toBe('120000.00000000');
    });

    describe('Phase 2 fund-only cash enforcement', () => {
      // 1. investor holder rejected on post / repost / reverse
      describe('investor holder cash rejection', () => {
        it('rejects postEvent pairing cash_movement with investor holder', async () => {
          await expect(
            service.postEvent(workspaceId, {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-inv-cash-usd-1',
                  entry_type: 'cash_movement',
                  sub_type: 'opening_balance',
                  cash_delta: '100000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects updateEvent repost pairing cash_movement with investor holder', async () => {
          const origEvent = {
            id: 'be-to-update-inv',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Valid event to update',
          };
          const origEntries = [
            {
              id: 'ent-orig-buy-1',
              position_id: 'pos-asset-1',
              business_event_id: 'be-to-update-inv',
              entry_date: '2026-09-04',
              entry_type: 'buy' as const,
              sub_type: null,
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '10.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '-10000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.updateEvent(workspaceId, 'be-to-update-inv', {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-inv-cash-usd-1',
                  entry_type: 'cash_movement',
                  sub_type: 'opening_balance',
                  cash_delta: '10000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects updateEvent when original entries contain investor cash movement', async () => {
          const origEvent = {
            id: 'be-with-legacy-inv-cash',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Legacy event with investor cash',
          };
          const origEntries = [
            {
              id: 'ent-legacy-inv-cash',
              position_id: 'pos-inv-cash-usd-1',
              business_event_id: 'be-with-legacy-inv-cash',
              entry_date: '2026-09-04',
              entry_type: 'cash_movement' as const,
              sub_type: 'opening_balance',
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '0.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '50000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.updateEvent(workspaceId, 'be-with-legacy-inv-cash', {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-asset-1',
                  entry_type: 'buy',
                  cash_delta: '-10000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects reverseEvent when event contains cash_movement on investor cash position', async () => {
          const origEvent = {
            id: 'be-inv-cash-rev',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Legacy event with investor cash',
          };
          const origEntries = [
            {
              id: 'ent-inv-cash-rev-1',
              position_id: 'pos-inv-cash-usd-1',
              business_event_id: 'be-inv-cash-rev',
              entry_date: '2026-09-04',
              entry_type: 'cash_movement' as const,
              sub_type: 'opening_balance',
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '0.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '10000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.reverseEvent(workspaceId, 'be-inv-cash-rev'),
          ).rejects.toThrow(IneligibleCashHolderError);
        });
      });

      // 2. unmanaged fund holder rejected on post / repost / reverse
      describe('unmanaged fund holder cash rejection', () => {
        it('rejects postEvent pairing cash_movement with unmanaged fund holder', async () => {
          await expect(
            service.postEvent(workspaceId, {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-unmanaged-cash-usd',
                  entry_type: 'cash_movement',
                  sub_type: 'opening_balance',
                  cash_delta: '100000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects updateEvent repost pairing cash_movement with unmanaged fund holder', async () => {
          const origEvent = {
            id: 'be-to-update-unmanaged',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Valid event to update',
          };
          const origEntries = [
            {
              id: 'ent-orig-buy-unm',
              position_id: 'pos-asset-1',
              business_event_id: 'be-to-update-unmanaged',
              entry_date: '2026-09-04',
              entry_type: 'buy' as const,
              sub_type: null,
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '10.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '-10000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.updateEvent(workspaceId, 'be-to-update-unmanaged', {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-unmanaged-cash-usd',
                  entry_type: 'cash_movement',
                  sub_type: 'opening_balance',
                  cash_delta: '10000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects updateEvent when original entries contain unmanaged fund cash movement', async () => {
          const origEvent = {
            id: 'be-with-legacy-unmanaged-cash',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Legacy event with unmanaged fund cash',
          };
          const origEntries = [
            {
              id: 'ent-legacy-unm-cash',
              position_id: 'pos-unmanaged-cash-usd',
              business_event_id: 'be-with-legacy-unmanaged-cash',
              entry_date: '2026-09-04',
              entry_type: 'cash_movement' as const,
              sub_type: 'opening_balance',
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '0.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '50000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.updateEvent(workspaceId, 'be-with-legacy-unmanaged-cash', {
              event_date: '2026-09-04',
              entries: [
                {
                  position_id: 'pos-asset-1',
                  entry_type: 'buy',
                  cash_delta: '-10000',
                  currency: 'USD',
                },
              ],
            }),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it('rejects reverseEvent when event contains cash_movement on unmanaged fund cash position', async () => {
          const origEvent = {
            id: 'be-unmanaged-cash-rev',
            workspace_id: workspaceId,
            event_date: '2026-09-04',
            status: 'posted',
            description: 'Legacy event with unmanaged fund cash',
          };
          const origEntries = [
            {
              id: 'ent-unm-cash-rev-1',
              position_id: 'pos-unmanaged-cash-usd',
              business_event_id: 'be-unmanaged-cash-rev',
              entry_date: '2026-09-04',
              entry_type: 'cash_movement' as const,
              sub_type: 'opening_balance',
              is_reversal: false,
              commitment_delta: '0.00000000',
              quantity_delta: '0.00000000',
              valuation_delta: '0.00000000',
              cash_delta: '10000.00000000',
              currency: 'USD',
              counterparty_position_id: null,
              source_ledger_entry_id: null,
              data_status: 'verified' as const,
            },
          ];

          mockEventRepo.findById.mockResolvedValue(origEvent);
          mockLedgerRepo.findByBusinessEventId.mockResolvedValue(origEntries);

          await expect(
            service.reverseEvent(workspaceId, 'be-unmanaged-cash-rev'),
          ).rejects.toThrow(IneligibleCashHolderError);
        });
      });

      // 3. a rejected batch writes nothing and provisions no cash position
      it('ensures a rejected batch writes nothing and provisions no cash position', async () => {
        const getOrCreateSpy = vi.spyOn(service, 'getOrCreateCashPosition');
        const createManySpy = vi.spyOn(mockLedgerRepo, 'createMany');
        const posCreateSpy = vi.spyOn(mockPositionRepo, 'create');

        await expect(
          service.postEvent(workspaceId, {
            event_date: '2026-09-04',
            description: 'Batch with valid buy and invalid cash movement',
            entries: [
              {
                position_id: 'pos-asset-1',
                entry_type: 'buy',
                cash_delta: '-10000',
                currency: 'USD',
              },
              {
                position_id: 'pos-inv-cash-usd-1',
                entry_type: 'cash_movement',
                sub_type: 'opening_balance',
                cash_delta: '10000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(IneligibleCashHolderError);

        expect(getOrCreateSpy).not.toHaveBeenCalled();
        expect(createManySpy).not.toHaveBeenCalled();
        expect(posCreateSpy).not.toHaveBeenCalled();
      });

      // 4. a managed-fund sale with no stated treatment now DOES credit fund cash
      it('credits fund cash on managed-fund sale with no stated treatment (sub_type: null)', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-04',
          description: 'Managed fund sale without explicit treatment',
          entries: [
            {
              position_id: 'pos-asset-1', // held by managed fund-1
              entry_type: 'sell',
              sub_type: null,
              cash_delta: '75000',
              currency: 'USD',
            },
          ],
        });

        expect(res.entries).toHaveLength(2);
        expect(res.entries[0].entry_type).toBe('sell');
        expect(res.entries[1].entry_type).toBe('cash_movement');
        expect(res.entries[1].position_id).toBe('pos-cash-usd-1');
        expect(res.entries[1].cash_delta).toBe('75000.00000000');
        expect(res.entries[1].source_ledger_entry_id).toBe(res.entries[0].id);
      });

      // 5. the instrument-side leg for a managed invested fund still fires
      it('fires instrument-side cash leg for managed invested fund while excluding investor holder leg', async () => {
        const getOrCreateSpy = vi.spyOn(service, 'getOrCreateCashPosition');
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-04',
          description: 'Investor pays in to managed fund',
          entries: [
            {
              position_id: 'pos-lp-only-managed-1', // inv-lp-only holds LP stake in fund-1 (managed = true)
              entry_type: 'paid_in',
              cash_delta: '-50000',
              currency: 'USD',
            },
          ],
        });

        // 1 primary entry + 1 instrument-side cash leg for fund-1 (no investor cash leg)
        expect(res.entries).toHaveLength(2);
        expect(res.entries[0].entry_type).toBe('paid_in');
        expect(res.entries[0].position_id).toBe('pos-lp-only-managed-1');
        expect(res.entries[1].entry_type).toBe('cash_movement');
        expect(res.entries[1].position_id).toBe('pos-cash-usd-1');
        expect(res.entries[1].cash_delta).toBe('50000.00000000');

        expect(getOrCreateSpy).toHaveBeenCalledWith(
          workspaceId,
          { kind: 'fund', id: 'fund-1' },
          'USD',
          expect.anything(),
        );
      });

      // Test 1: managed sale with no stated treatment resolves treatment to cash_in_fund, credits fund cash by 100 AND contributes 0 to distributed proceeds
      it('persists resolved proceeds treatment on managed-fund sale with no stated treatment: increases fund cash by 100 and contributes 0 to distributed proceeds', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-04',
          entries: [
            {
              position_id: 'pos-asset-1',
              entry_type: 'sell',
              cash_delta: '100',
              quantity_delta: '-10',
              currency: 'USD',
              sub_type: null, // No stated treatment
            },
          ],
        });

        expect(res.entries).toHaveLength(2);
        const [saleEntry, cashLeg] = res.entries;

        // 1. Primary entry has resolved treatment persisted to sub_type (NOT null!)
        expect(saleEntry.entry_type).toBe('sell');
        expect(saleEntry.position_id).toBe('pos-asset-1');
        expect(saleEntry.cash_delta).toBe('100.00000000');
        expect(saleEntry.sub_type).toBe('divestment:cash_in_fund');

        // 2. Fund cash increases by 100
        expect(cashLeg.entry_type).toBe('cash_movement');
        expect(cashLeg.position_id).toBe('pos-cash-usd-1');
        expect(cashLeg.cash_delta).toBe('100.00000000');

        // 3. Aggregate / balance calculation: retained proceeds equals sale amount (100),
        // so distributed proceeds is exactly 0 (cash_sum + contributed_sum - retained_proceeds_sum = 0)
        // rather than overstating distributed proceeds by 100.
        const isRetained =
          (saleEntry.entry_type === 'sell' || saleEntry.entry_type === 'redemption' || saleEntry.entry_type === 'distribution') &&
          (saleEntry.sub_type === 'divestment:cash_in_fund' || saleEntry.sub_type === 'cash_in_fund');
        const retainedProceeds = isRetained ? Number(saleEntry.cash_delta) : 0;
        const cashSum = Number(saleEntry.cash_delta);
        const contributedSum = 0;
        const distributedProceeds = cashSum + contributedSum - retainedProceeds;

        expect(retainedProceeds).toBe(100);
        expect(distributedProceeds).toBe(0);
      });

      // 6. transfers still excluded from instrument-side legs
      it('excludes instrument fund from cash legs on commitment_transfer and unit_transfer', async () => {
        const res = await service.postEvent(workspaceId, {
          event_date: '2026-09-04',
          entries: [
            {
              position_id: 'pos-fund-1',
              counterparty_position_id: 'pos-fund-2',
              entry_type: 'commitment_transfer',
              commitment_delta: '-50000',
              currency: 'USD',
            },
            {
              position_id: 'pos-fund-2',
              counterparty_position_id: 'pos-fund-1',
              entry_type: 'commitment_transfer',
              commitment_delta: '50000',
              currency: 'USD',
            },
          ],
        });

        expect(res.entries).toHaveLength(2);
        expect(res.entries.every((e) => e.entry_type === 'commitment_transfer')).toBe(true);
      });

      // 7. repost rollback preserves original entries on rejection
      it('repost rollback preserves original entries on rejection', async () => {
        const originalEntries = [
          {
            id: 'ent-kept-1',
            position_id: 'pos-asset-1',
            business_event_id: 'be-rollback-test',
            entry_date: '2026-09-04',
            entry_type: 'buy' as const,
            sub_type: null,
            is_reversal: false,
            commitment_delta: '0.00000000',
            quantity_delta: '10.00000000',
            valuation_delta: '0.00000000',
            cash_delta: '-10000.00000000',
            currency: 'USD',
            counterparty_position_id: null,
            source_ledger_entry_id: null,
            data_status: 'verified' as const,
          },
        ];

        let dbEntries = [...originalEntries];
        mockLedgerRepo.findByBusinessEventId.mockImplementation(async () => [...dbEntries]);
        mockLedgerRepo.deleteByBusinessEventId.mockImplementation(async () => {
          dbEntries = [];
        });

        // Transaction simulator with rollback on error
        mockDb.transaction.mockImplementation(async (cb: any) => {
          const snapshot = [...dbEntries];
          try {
            return await cb(mockDb);
          } catch (err) {
            dbEntries = snapshot;
            throw err;
          }
        });

        mockEventRepo.findById.mockResolvedValue({
          id: 'be-rollback-test',
          workspace_id: workspaceId,
          event_date: '2026-09-04',
          status: 'posted',
        });

        await expect(
          service.updateEvent(workspaceId, 'be-rollback-test', {
            event_date: '2026-09-04',
            entries: [
              {
                position_id: 'pos-inv-cash-usd-1', // Ineligible cash holder
                entry_type: 'cash_movement',
                sub_type: 'opening_balance',
                cash_delta: '10000',
                currency: 'USD',
              },
            ],
          }),
        ).rejects.toThrow(IneligibleCashHolderError);

        // Verify original entries remain intact after transaction rollback
        expect(dbEntries).toHaveLength(1);
        expect(dbEntries[0].id).toBe('ent-kept-1');
      });
    });
  });
});

describe('FlLedgerService.deleteAssetWithLedger', () => {
  const ws = 'ws-del-1';
  const executor = { __sentinel: 'tx-del' } as unknown as DbClient;
  let calls: string[];
  let ledgerRepo: {
    findEventIdsTouchingPositionIds: ReturnType<typeof vi.fn>;
    findEventIdsDerivedFromEventIds: ReturnType<typeof vi.fn>;
    deleteByBusinessEventIds: ReturnType<typeof vi.fn>;
  };
  let eventRepo: { deleteByIds: ReturnType<typeof vi.fn> };
  let positionRepo: { findByAssetIds: ReturnType<typeof vi.fn> };
  let assetRepo: { findById: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let service: FlLedgerService;

  beforeEach(() => {
    calls = [];
    ledgerRepo = {
      findEventIdsTouchingPositionIds: vi.fn().mockResolvedValue(['be-buy', 'be-val']),
      findEventIdsDerivedFromEventIds: vi
        .fn()
        .mockResolvedValueOnce(['be-cash-pair'])
        .mockResolvedValueOnce([]),
      deleteByBusinessEventIds: vi.fn().mockImplementation(async () => {
        calls.push('entries');
        return 5;
      }),
    };
    eventRepo = {
      deleteByIds: vi.fn().mockImplementation(async () => {
        calls.push('events');
        return 3;
      }),
    };
    positionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([{ id: 'pos-1' }, { id: 'pos-2' }]),
    };
    assetRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'asset-1',
        asset_kind: 'equity',
        instrument_terms: {},
      }),
      delete: vi.fn().mockImplementation(async () => {
        calls.push('asset');
      }),
    };
    service = new FlLedgerService(
      {} as never,
      ledgerRepo as never,
      eventRepo as never,
      {} as never,
      positionRepo as never,
      {} as never,
      {} as never,
      assetRepo as never,
      {} as never,
    );
  });

  it('deletes every touching and derived event, then the asset, and returns counts', async () => {
    const result = await service.deleteAssetWithLedger(ws, 'asset-1', executor);

    expect(positionRepo.findByAssetIds).toHaveBeenCalledWith(ws, ['asset-1'], executor);
    expect(ledgerRepo.findEventIdsTouchingPositionIds).toHaveBeenCalledWith(
      ws,
      ['pos-1', 'pos-2'],
      executor,
    );
    expect(ledgerRepo.findEventIdsDerivedFromEventIds).toHaveBeenNthCalledWith(
      1,
      ws,
      ['be-buy', 'be-val'],
      executor,
    );
    expect(ledgerRepo.findEventIdsDerivedFromEventIds).toHaveBeenNthCalledWith(
      2,
      ws,
      ['be-cash-pair'],
      executor,
    );
    const expectedEvents = ['be-buy', 'be-val', 'be-cash-pair'];
    expect(ledgerRepo.deleteByBusinessEventIds).toHaveBeenCalledWith(ws, expectedEvents, executor);
    expect(eventRepo.deleteByIds).toHaveBeenCalledWith(ws, expectedEvents, executor);
    expect(assetRepo.delete).toHaveBeenCalledWith(ws, 'asset-1', executor);
    expect(calls).toEqual(['entries', 'events', 'asset']);
    expect(result).toEqual({ entries: 5, events: 3, positions: 2 });
  });

  it('stops expanding when derived events are already in the set', async () => {
    ledgerRepo.findEventIdsDerivedFromEventIds.mockReset().mockResolvedValue(['be-buy']);
    await service.deleteAssetWithLedger(ws, 'asset-1', executor);
    expect(ledgerRepo.findEventIdsDerivedFromEventIds).toHaveBeenCalledTimes(1);
    expect(ledgerRepo.deleteByBusinessEventIds).toHaveBeenCalledWith(
      ws,
      ['be-buy', 'be-val'],
      executor,
    );
  });

  it('throws EntityNotFoundError and deletes nothing when the asset is missing', async () => {
    assetRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteAssetWithLedger(ws, 'missing', executor)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    expect(ledgerRepo.deleteByBusinessEventIds).not.toHaveBeenCalled();
    expect(assetRepo.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a system cash asset', async () => {
    assetRepo.findById.mockResolvedValueOnce({
      id: 'cash-usd',
      asset_kind: 'cash',
      instrument_terms: { system_cash: true, currency: 'USD' },
    });
    await expect(service.deleteAssetWithLedger(ws, 'cash-usd', executor)).rejects.toBeInstanceOf(
      InvalidMasterDataError,
    );
    expect(positionRepo.findByAssetIds).not.toHaveBeenCalled();
    expect(assetRepo.delete).not.toHaveBeenCalled();
  });

  it('deletes an asset with no positions without touching the ledger', async () => {
    positionRepo.findByAssetIds.mockResolvedValueOnce([]);
    ledgerRepo.findEventIdsTouchingPositionIds.mockResolvedValueOnce([]);
    const result = await service.deleteAssetWithLedger(ws, 'asset-1', executor);
    expect(ledgerRepo.findEventIdsDerivedFromEventIds).not.toHaveBeenCalled();
    expect(assetRepo.delete).toHaveBeenCalledWith(ws, 'asset-1', executor);
    expect(result.positions).toBe(0);
  });
});
