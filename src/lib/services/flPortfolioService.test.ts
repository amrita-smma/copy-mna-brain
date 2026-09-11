import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlPortfolioService } from './flPortfolioService';
import type { DbClient } from '@/lib/repositories';

describe('FlPortfolioService', () => {
  let mockDb: any;
  let mockFundRepo: any;
  let mockAssetRepo: any;
  let mockPositionRepo: any;
  let mockInvestorRepo: any;
  let mockFundingSourceRepo: any;
  let mockBusinessEventRepo: any;
  let mockLedgerEntryRepo: any;
  let mockAllocationRepo: any;
  let mockValuationRepo: any;
  let mockBalanceService: any;
  let service: FlPortfolioService;

  beforeEach(() => {
    mockDb = {};
    mockFundRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockAssetRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockPositionRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockInvestorRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockFundingSourceRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockBusinessEventRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockLedgerEntryRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockAllocationRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockValuationRepo = {
      findByWorkspaceId: vi.fn(),
    };
    mockBalanceService = {
      getPositionBalances: vi.fn(),
      getPositionValues: vi.fn(),
    };

    service = new FlPortfolioService(
      mockDb,
      mockFundRepo,
      mockAssetRepo,
      mockPositionRepo,
      mockInvestorRepo,
      mockFundingSourceRepo,
      mockBusinessEventRepo,
      mockLedgerEntryRepo,
      mockAllocationRepo,
      mockValuationRepo,
      mockBalanceService,
    );
  });

  it('assembles complete workspace portfolio in fixed query count', async () => {
    const workspaceId = 'ws-1';

    const funds = [
      { id: 'f-1', name: 'Fund One', managed: true },
      { id: 'f-2', name: 'Target Fund', managed: false },
    ];
    const assets = [{ id: 'a-1', name: 'Acme Corp' }];
    const investors = [{ id: 'inv-1', name: 'Alice LP' }];
    const fundingSources = [{ id: 'fs-1', name: 'Alice Bank' }];
    const positions = [
      {
        id: 'pos-1',
        workspace_id: workspaceId,
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        fund_id: 'f-1',
        asset_id: null,
        holder_source_of_fund_id: null,
        status: 'open',
      },
      {
        id: 'pos-2',
        workspace_id: workspaceId,
        holder_investor_id: null,
        holder_fund_id: 'f-1',
        fund_id: null,
        asset_id: 'a-1',
        holder_source_of_fund_id: 'fs-1',
        status: 'open',
      },
    ];
    const businessEvents = [
      {
        id: 'be-1',
        description: 'Capital call',
        event_date: '2026-01-15',
      },
    ];
    const ledgerEntries = [
      {
        id: 'le-1',
        position_id: 'pos-1',
        business_event_id: 'be-1',
        entry_date: '2026-01-15',
        entry_type: 'paid_in',
        cash_delta: '-100000.00000000',
      },
    ];
    const allocations = [
      {
        id: 'alloc-1',
        ledger_entry_id: 'le-1',
        funding_source_id: 'fs-1',
        amount: '100000.00000000',
      },
    ];
    const valuations = [
      {
        id: 'val-1',
        asset_id: 'a-1',
        as_of_date: '2026-03-31',
        market_value: '5000000.00000000',
      },
    ];

    const balances = [
      {
        position_id: 'pos-1',
        committed: '500000.00000000',
        contributed: '100000.00000000',
        unfunded: '400000.00000000',
        quantity: '100.00000000',
        cash_total: '-100000.00000000',
        distributed: '0.00000000',
      },
      {
        position_id: 'pos-2',
        committed: '0.00000000',
        contributed: '0.00000000',
        unfunded: '0.00000000',
        quantity: '50.00000000',
        cash_total: '-200000.00000000',
        distributed: '0.00000000',
      },
    ];

    const positionValues = [
      {
        position_id: 'pos-1',
        value: '100000.00000000',
        method: 'capital_account_statement',
      },
      {
        position_id: 'pos-2',
        value: '250000.00000000',
        method: 'at_cost',
      },
    ];

    mockFundRepo.findByWorkspaceId.mockResolvedValue(funds);
    mockAssetRepo.findByWorkspaceId.mockResolvedValue(assets);
    mockPositionRepo.findByWorkspaceId.mockResolvedValue(positions);
    mockInvestorRepo.findByWorkspaceId.mockResolvedValue(investors);
    mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue(fundingSources);
    mockBusinessEventRepo.findByWorkspaceId.mockResolvedValue(businessEvents);
    mockLedgerEntryRepo.findByWorkspaceId.mockResolvedValue(ledgerEntries);
    mockAllocationRepo.findByWorkspaceId.mockResolvedValue(allocations);
    mockValuationRepo.findByWorkspaceId.mockResolvedValue(valuations);
    mockBalanceService.getPositionBalances.mockResolvedValue(balances);
    mockBalanceService.getPositionValues.mockResolvedValue(positionValues);

    const result = await service.getPortfolio(workspaceId, '2026-03-31');

    // Verify fixed query count: 1 call per repo/service, never in loop
    expect(mockFundRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockAssetRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockPositionRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockInvestorRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockFundingSourceRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockBusinessEventRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockLedgerEntryRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockAllocationRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockValuationRepo.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockBalanceService.getPositionBalances).toHaveBeenCalledTimes(1);
    expect(mockBalanceService.getPositionValues).toHaveBeenCalledTimes(1);

    // Verify portfolio categorization and enrichment
    expect(result.as_of_date).toBe('2026-03-31');
    expect(result.managed_funds).toEqual([funds[0]]);
    expect(result.external_funds).toEqual([funds[1]]);
    expect(result.assets).toEqual(assets);
    expect(result.investors).toEqual(investors);
    expect(result.funding_sources).toEqual(fundingSources);

    // Check enriched positions
    expect(result.positions).toHaveLength(2);
    expect(result.positions[0].holder_investor).toEqual(investors[0]);
    expect(result.positions[0].fund).toEqual(funds[0]);
    expect(result.positions[0].balance).toEqual(balances[0]);
    expect(result.positions[0].current_value).toBe('100000.00000000');
    expect(result.positions[0].valuation_method).toBe(
      'capital_account_statement',
    );
    expect(result.positions[0].holder_source_of_fund_id).toBeNull();
    expect(result.positions[0].funding_source).toBeNull();

    expect(result.positions[1].holder_fund).toEqual(funds[0]);
    expect(result.positions[1].asset).toEqual(assets[0]);
    expect(result.positions[1].balance).toEqual(balances[1]);
    expect(result.positions[1].current_value).toBe('250000.00000000');
    expect(result.positions[1].valuation_method).toBe('at_cost');
    expect(result.positions[1].holder_source_of_fund_id).toBe('fs-1');
    expect(result.positions[1].funding_source).toEqual(fundingSources[0]);

    // Check enriched entries
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].event).toEqual(businessEvents[0]);
    expect(result.entries[0].allocations).toEqual(allocations);
  });

  it('threads executor sentinel across all queries and balance service', async () => {
    const workspaceId = 'ws-1';
    const sentinel = { _tag: 'executor-sentinel' } as unknown as DbClient;

    mockFundRepo.findByWorkspaceId.mockResolvedValue([]);
    mockAssetRepo.findByWorkspaceId.mockResolvedValue([]);
    mockPositionRepo.findByWorkspaceId.mockResolvedValue([]);
    mockInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
    mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);
    mockBusinessEventRepo.findByWorkspaceId.mockResolvedValue([]);
    mockLedgerEntryRepo.findByWorkspaceId.mockResolvedValue([]);
    mockAllocationRepo.findByWorkspaceId.mockResolvedValue([]);
    mockValuationRepo.findByWorkspaceId.mockResolvedValue([]);
    mockBalanceService.getPositionBalances.mockResolvedValue([]);
    mockBalanceService.getPositionValues.mockResolvedValue([]);

    await service.getPortfolio(workspaceId, null, sentinel);

    expect(mockFundRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockAssetRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockPositionRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockInvestorRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockFundingSourceRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockBusinessEventRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockLedgerEntryRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockAllocationRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockValuationRepo.findByWorkspaceId).toHaveBeenCalledWith(
      workspaceId,
      sentinel,
    );
    expect(mockBalanceService.getPositionBalances).toHaveBeenCalledWith(
      workspaceId,
      [],
      null,
      sentinel,
    );
    expect(mockBalanceService.getPositionValues).toHaveBeenCalledWith(
      workspaceId,
      [],
      null,
      sentinel,
    );
  });

  it('returns an internally consistent as-of read model without future positions, entries, events, allocations, or marks', async () => {
    const workspaceId = 'ws-1';
    const pastPosition = {
      id: 'pos-past', workspace_id: workspaceId, holder_investor_id: null,
      holder_fund_id: 'fund-1', asset_id: 'asset-1', fund_id: null,
      holder_source_of_fund_id: null, opened_at: '2026-01-01', status: 'open',
    };
    const futurePosition = { ...pastPosition, id: 'pos-future', opened_at: '2026-04-01' };
    const pastEvent = { id: 'event-past', workspace_id: workspaceId, event_date: '2026-03-01' };
    const futureEvent = { id: 'event-future', workspace_id: workspaceId, event_date: '2026-04-01' };
    const pastEntry = { id: 'entry-past', position_id: pastPosition.id, business_event_id: pastEvent.id, entry_date: '2026-03-01' };
    const futureEntry = { id: 'entry-future', position_id: pastPosition.id, business_event_id: futureEvent.id, entry_date: '2026-04-01' };
    const pastAllocation = { id: 'allocation-past', ledger_entry_id: pastEntry.id };
    const futureAllocation = { id: 'allocation-future', ledger_entry_id: futureEntry.id };

    mockFundRepo.findByWorkspaceId.mockResolvedValue([{ id: 'fund-1', managed: true }]);
    mockAssetRepo.findByWorkspaceId.mockResolvedValue([{ id: 'asset-1', name: 'Asset' }]);
    mockPositionRepo.findByWorkspaceId.mockResolvedValue([pastPosition, futurePosition]);
    mockInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
    mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);
    mockBusinessEventRepo.findByWorkspaceId.mockResolvedValue([pastEvent, futureEvent]);
    mockLedgerEntryRepo.findByWorkspaceId.mockResolvedValue([pastEntry, futureEntry]);
    mockAllocationRepo.findByWorkspaceId.mockResolvedValue([pastAllocation, futureAllocation]);
    mockValuationRepo.findByWorkspaceId.mockResolvedValue([
      { id: 'valuation-past', asset_id: 'asset-1', as_of_date: '2026-03-31' },
      { id: 'valuation-future', asset_id: 'asset-1', as_of_date: '2026-04-30' },
    ]);
    mockBalanceService.getPositionBalances.mockResolvedValue([]);
    mockBalanceService.getPositionValues.mockResolvedValue([]);

    const result = await service.getPortfolio(workspaceId, '2026-03-31');

    expect(mockBalanceService.getPositionBalances).toHaveBeenCalledWith(
      workspaceId, [pastPosition.id], '2026-03-31', undefined,
    );
    expect(result.positions.map((position) => position.id)).toEqual([pastPosition.id]);
    expect(result.business_events).toEqual([pastEvent]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].allocations).toEqual([pastAllocation]);
    expect(result.valuations.map((valuation) => valuation.id)).toEqual(['valuation-past']);
  });

  describe('fund cash summary in portfolio read model', () => {
    const workspaceId = 'ws-cash-summary';
    const fundId = 'fund-1';
    let portfolioService: FlPortfolioService;

    beforeEach(() => {
      portfolioService = new FlPortfolioService(
        mockDb,
        mockFundRepo,
        mockAssetRepo,
        mockPositionRepo,
        mockInvestorRepo,
        mockFundingSourceRepo,
        mockBusinessEventRepo,
        mockLedgerEntryRepo,
        mockAllocationRepo,
        mockValuationRepo,
        mockBalanceService,
      );

      mockFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: fundId, name: 'Fund 1', managed: true, base_currency: 'USD' },
      ]);
      mockAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: 'asset-inv', asset_kind: 'equity' },
        { id: 'asset-cash-usd', asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
        { id: 'asset-cash-eur', asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
      ]);
      mockPositionRepo.findByWorkspaceId.mockResolvedValue([
        {
          id: 'pos-inv',
          workspace_id: workspaceId,
          holder_fund_id: fundId,
          asset_id: 'asset-inv',
          status: 'open',
          opened_at: '2024-01-01',
        },
        {
          id: 'pos-cash-usd',
          workspace_id: workspaceId,
          holder_fund_id: fundId,
          asset_id: 'asset-cash-usd',
          status: 'open',
          opened_at: '2024-01-01',
        },
      ]);
      mockInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
      mockFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);
      mockBusinessEventRepo.findByWorkspaceId.mockResolvedValue([]);
      mockLedgerEntryRepo.findByWorkspaceId.mockResolvedValue([
        {
          id: 'entry-inv',
          position_id: 'pos-inv',
          currency: 'USD',
          entry_date: '2024-06-01',
        },
        {
          id: 'entry-cash-usd',
          position_id: 'pos-cash-usd',
          currency: 'USD',
          entry_date: '2025-01-15',
        },
      ]);
      mockAllocationRepo.findByWorkspaceId.mockResolvedValue([]);
      mockValuationRepo.findByWorkspaceId.mockResolvedValue([]);
      mockBalanceService.getPositionBalances.mockResolvedValue([
        {
          position_id: 'pos-inv',
          committed: '0.00000000',
          contributed: '100000.00000000',
          unfunded: '0.00000000',
          quantity: '10.00000000',
          cash_total: '0.00000000',
          distributed: '0.00000000',
          retained_proceeds: '50000.00000000',
          asset_kind: 'equity',
        },
        {
          position_id: 'pos-cash-usd',
          committed: '0.00000000',
          contributed: '0.00000000',
          unfunded: '0.00000000',
          quantity: '0.00000000',
          cash_total: '25000.00000000',
          distributed: '0.00000000',
          retained_proceeds: '0.00000000',
          asset_kind: 'cash',
        },
      ]);
      mockBalanceService.getPositionValues.mockResolvedValue([
        { position_id: 'pos-inv', value: '120000.00000000', method: 'fmv' },
        { position_id: 'pos-cash-usd', value: '25000.00000000', method: 'cash_par' },
      ]);
    });

    it('calculates per-currency cash balances and reporting total for single currency', async () => {
      const portfolio = await portfolioService.getPortfolio(workspaceId);

      const summary = portfolio.fund_cash_summaries?.[fundId];
      expect(summary).toBeDefined();
      expect(summary?.reporting_total_available).toBe(true);
      expect(summary?.reporting_total).toBe('25000.00000000');
      expect(summary?.fx_status).toBe('available');
      expect(summary?.cash_balances).toEqual([
        { currency: 'USD', amount: '25000.00000000' },
      ]);
    });

    it('flags pending_fx when multi-currency cash positions exist and leaves reporting_total null', async () => {
      mockPositionRepo.findByWorkspaceId.mockResolvedValue([
        {
          id: 'pos-cash-usd',
          workspace_id: workspaceId,
          holder_fund_id: fundId,
          asset_id: 'asset-cash-usd',
          status: 'open',
          opened_at: '2024-01-01',
        },
        {
          id: 'pos-cash-eur',
          workspace_id: workspaceId,
          holder_fund_id: fundId,
          asset_id: 'asset-cash-eur',
          status: 'open',
          opened_at: '2024-01-01',
        },
      ]);
      mockBalanceService.getPositionBalances.mockResolvedValue([
        {
          position_id: 'pos-cash-usd',
          cash_total: '25000.00000000',
          asset_kind: 'cash',
        },
        {
          position_id: 'pos-cash-eur',
          cash_total: '10000.00000000',
          asset_kind: 'cash',
        },
      ]);

      const portfolio = await portfolioService.getPortfolio(workspaceId);

      const summary = portfolio.fund_cash_summaries?.[fundId];
      expect(summary).toBeDefined();
      expect(summary?.reporting_total_available).toBe(false);
      expect(summary?.reporting_total).toBeNull();
      expect(summary?.fx_status).toBe('pending_fx');
      expect(summary?.cash_balances).toEqual([
        { currency: 'EUR', amount: '10000.00000000' },
        { currency: 'USD', amount: '25000.00000000' },
      ]);
    });
  });
});
