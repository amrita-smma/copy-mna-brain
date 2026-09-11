import type {
  DbClient,
  FlAllocationRepository,
  FlAssetRepository,
  FlBusinessEventRepository,
  FlFundingSourceRepository,
  FlFundRepository,
  FlInvestorRepository,
  FlLedgerEntryRepository,
  FlPositionRepository,
  FlValuationRepository,
  Tables,
} from '@/lib/repositories';
import type { FlBalanceService, PositionBalances } from './flBalanceService';
import {
  computeFundCashSummary,
  type FundCashSummary,
} from '@/lib/fundLedger/fundCashSummary';

export interface FlPortfolioPosition {
  id: string;
  workspace_id: string;
  holder_investor_id: string | null;
  holder_fund_id: string | null;
  fund_id: string | null;
  asset_id: string | null;
  holder_source_of_fund_id: string | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  balance?: PositionBalances;
  current_value: string;
  valuation_method: string | null;
  holder_investor: Tables<'fl_investors'> | null;
  holder_fund: Tables<'fl_funds'> | null;
  fund: Tables<'fl_funds'> | null;
  asset: Tables<'fl_assets'> | null;
  funding_source: Tables<'fl_funding_sources'> | null;
}

export interface FlPortfolioLedgerEntry {
  id: string;
  position_id: string;
  business_event_id: string | null;
  entry_date: string;
  entry_type:
    | 'commitment'
    | 'paid_in'
    | 'distribution'
    | 'redemption'
    | 'buy'
    | 'sell'
    | 'commitment_transfer'
    | 'unit_transfer'
    | 'income'
    | 'expense'
    | 'adjustment'
    | 'cash_movement';
  sub_type: string | null;
  is_reversal: boolean;
  commitment_delta: string;
  quantity_delta: string;
  valuation_delta?: string;
  cash_delta: string;
  currency: string;
  fx_rate: string | null;
  price_per_unit: string | null;
  counterparty_position_id: string | null;
  data_status: 'verified' | 'needs_verification';
  source_record_id: string | null;
  source_ledger_entry_id?: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  event: Tables<'fl_business_events'> | null;
  allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  reversal_date?: string | null;
}

export interface FlPortfolioReadModel {
  as_of_date: string | null;
  funds: Tables<'fl_funds'>[];
  managed_funds: Tables<'fl_funds'>[];
  external_funds: Tables<'fl_funds'>[];
  assets: Tables<'fl_assets'>[];
  investors: Tables<'fl_investors'>[];
  funding_sources: Tables<'fl_funding_sources'>[];
  positions: FlPortfolioPosition[];
  balances: PositionBalances[];
  entries: FlPortfolioLedgerEntry[];
  business_events: Tables<'fl_business_events'>[];
  valuations: Tables<'fl_valuations'>[];
  fund_cash_summaries?: Record<string, FundCashSummary>;
}

export class FlPortfolioService {
  constructor(
    private readonly db: DbClient,
    private readonly fundRepo: FlFundRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly investorRepo: FlInvestorRepository,
    private readonly fundingSourceRepo: FlFundingSourceRepository,
    private readonly businessEventRepo: FlBusinessEventRepository,
    private readonly ledgerEntryRepo: FlLedgerEntryRepository,
    private readonly allocationRepo: FlAllocationRepository,
    private readonly valuationRepo: FlValuationRepository,
    private readonly balanceService: FlBalanceService,
  ) {}

  async getPortfolio(
    workspaceId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<FlPortfolioReadModel> {
    const effectiveAsOf = asOfDate ?? null;

    // Fixed Query Round 1: Fetch all workspace master data and transactions in parallel
    const [
      funds,
      assets,
      positions,
      investors,
      fundingSources,
      businessEvents,
      ledgerEntries,
      allocations,
      valuations,
    ] = await Promise.all([
      this.fundRepo.findByWorkspaceId(workspaceId, executor),
      this.assetRepo.findByWorkspaceId(workspaceId, executor),
      this.positionRepo.findByWorkspaceId(workspaceId, executor),
      this.investorRepo.findByWorkspaceId(workspaceId, executor),
      this.fundingSourceRepo.findByWorkspaceId(workspaceId, executor),
      this.businessEventRepo.findByWorkspaceId(workspaceId, executor),
      this.ledgerEntryRepo.findByWorkspaceId(workspaceId, executor),
      this.allocationRepo.findByWorkspaceId(workspaceId, executor),
      this.valuationRepo.findByWorkspaceId(workspaceId, executor),
    ]);

    // The API read model is used directly by reporting/UI. Do not expose
    // future positions, entries, events, or marks when an as-of date is set;
    // otherwise downstream adapters can accidentally reconstruct today from
    // future source data even though balances themselves are date-aware.
    const visiblePositions = effectiveAsOf
      ? positions.filter((position) => !position.opened_at || position.opened_at <= effectiveAsOf)
      : positions;
    const visibleBusinessEvents = effectiveAsOf
      ? businessEvents.filter((event) => event.event_date <= effectiveAsOf)
      : businessEvents;
    const visibleLedgerEntries = effectiveAsOf
      ? ledgerEntries.filter((entry) => entry.entry_date <= effectiveAsOf)
      : ledgerEntries;
    const visibleEntryIds = new Set(visibleLedgerEntries.map((entry) => entry.id));
    const visibleAllocations = allocations.filter((allocation) => visibleEntryIds.has(allocation.ledger_entry_id));
    const visibleValuations = effectiveAsOf
      ? valuations.filter((valuation) => valuation.as_of_date <= effectiveAsOf)
      : valuations;
    const positionIds = visiblePositions.map((p) => p.id);

    // Fixed Query Round 2: Batched position balances and position valuations
    const [balances, positionValues] = await Promise.all([
      this.balanceService.getPositionBalances(
        workspaceId,
        positionIds,
        effectiveAsOf,
        executor,
      ),
      this.balanceService.getPositionValues(
        workspaceId,
        positions,
        effectiveAsOf,
        executor,
      ),
    ]);

    // Build memory maps for O(1) correlation
    const investorMap = new Map<string, Tables<'fl_investors'>>();
    for (const inv of investors) {
      investorMap.set(inv.id, inv);
    }

    const fundMap = new Map<string, Tables<'fl_funds'>>();
    for (const fund of funds) {
      fundMap.set(fund.id, fund);
    }

    const assetMap = new Map<string, Tables<'fl_assets'>>();
    for (const asset of assets) {
      assetMap.set(asset.id, asset);
    }

    const fundingSourceMap = new Map<string, Tables<'fl_funding_sources'>>();
    for (const fs of fundingSources) {
      fundingSourceMap.set(fs.id, fs);
    }

    const eventMap = new Map<string, Tables<'fl_business_events'>>();
    for (const ev of visibleBusinessEvents) {
      eventMap.set(ev.id, ev);
    }

    const balanceMap = new Map<string, PositionBalances>();
    for (const bal of balances) {
      balanceMap.set(bal.position_id, bal);
    }

    const valueMap = new Map<
      string,
      { value: string; method: string | null }
    >();
    for (const val of positionValues) {
      valueMap.set(val.position_id, val);
    }

    const allocationsByEntryId = new Map<
      string,
      Tables<'fl_ledger_entry_funding_allocations'>[]
    >();
    for (const alloc of visibleAllocations) {
      const list = allocationsByEntryId.get(alloc.ledger_entry_id) ?? [];
      list.push(alloc);
      allocationsByEntryId.set(alloc.ledger_entry_id, list);
    }

    // Assemble enriched positions
    const enrichedPositions: FlPortfolioPosition[] = visiblePositions.map((pos) => {
      const bal = balanceMap.get(pos.id);
      const val = valueMap.get(pos.id);
      const holderSourceOfFundId = pos.holder_source_of_fund_id ?? null;

      return {
        ...pos,
        holder_source_of_fund_id: holderSourceOfFundId,
        balance: bal,
        current_value: val?.value ?? '0.00000000',
        valuation_method: val?.method ?? null,
        holder_investor: pos.holder_investor_id
          ? investorMap.get(pos.holder_investor_id) ?? null
          : null,
        holder_fund: pos.holder_fund_id
          ? fundMap.get(pos.holder_fund_id) ?? null
          : null,
        fund: pos.fund_id ? fundMap.get(pos.fund_id) ?? null : null,
        asset: pos.asset_id ? assetMap.get(pos.asset_id) ?? null : null,
        funding_source: holderSourceOfFundId
          ? fundingSourceMap.get(holderSourceOfFundId) ?? null
          : null,
      };
    });

    const reversalDateByOriginalEventId = new Map<string, string>();
    for (const ev of businessEvents) {
      if (ev.reversal_of_event_id) {
        reversalDateByOriginalEventId.set(ev.reversal_of_event_id, ev.event_date);
      }
    }

    // Assemble enriched ledger entries
    const enrichedEntries: FlPortfolioLedgerEntry[] = visibleLedgerEntries.map(
      (entry) => {
        let ev = entry.business_event_id
          ? eventMap.get(entry.business_event_id) ?? null
          : null;
        const entryAllocs = allocationsByEntryId.get(entry.id) ?? [];
        const reversalDate = entry.business_event_id
          ? reversalDateByOriginalEventId.get(entry.business_event_id) ?? null
          : null;

        if (ev && ev.status === 'reversed' && effectiveAsOf && reversalDate && effectiveAsOf < reversalDate) {
          ev = { ...ev, status: 'posted' };
        }

        return {
          ...entry,
          event: ev,
          allocations: entryAllocs,
          reversal_date: reversalDate,
        };
      },
    );

    const managedFunds = funds.filter((f) => f.managed);
    const externalFunds = funds.filter((f) => !f.managed);

    const fundCashSummaries: Record<string, FundCashSummary> = {};
    for (const fund of funds) {
      fundCashSummaries[fund.id] = computeFundCashSummary({
        fund,
        positions: enrichedPositions,
        balances,
        entries: visibleLedgerEntries,
        asOfDate: effectiveAsOf,
      });
    }

    return {
      as_of_date: effectiveAsOf,
      funds,
      managed_funds: managedFunds,
      external_funds: externalFunds,
      assets,
      investors,
      funding_sources: fundingSources,
      positions: enrichedPositions,
      balances,
      entries: enrichedEntries,
      business_events: visibleBusinessEvents,
      valuations: visibleValuations,
      fund_cash_summaries: fundCashSummaries,
    };
  }
}
