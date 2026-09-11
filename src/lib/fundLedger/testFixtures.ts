/**
 * A small but complete portfolio read model for the fund-ledger tests.
 *
 * Covers the cases the page has to get right rather than just the happy path:
 * a fund holding another fund, a position with a declared source of fund and
 * one without, a multi-source allocation split, a two-legged transfer, a
 * reversal pair, a row flagged `needs_verification`, and a non-cash write-off.
 */

import type {
  FlPortfolioLedgerEntry,
  FlPortfolioPosition,
  FlPortfolioReadModel,
} from '@/lib/services/flPortfolioService';
import type { Tables } from '@/lib/repositories';

const WORKSPACE_ID = 'ws-1';
const NOW = '2026-01-01T00:00:00.000Z';

function investor(
  id: string,
  name: string,
  investorType: 'individual' | 'institution' | 'internal_entity' = 'institution',
): Tables<'fl_investors'> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name,
    legal_name: null,
    investor_type: investorType,
    country: null,
    parent_investor_id: null,
    notes: null,
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
  } as Tables<'fl_investors'>;
}

function fund(id: string, name: string, managed: boolean): Tables<'fl_funds'> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name,
    legal_name: null,
    registration_no: null,
    managed,
    ownership_basis: managed ? 'units' : 'capital_account',
    base_currency: 'USD',
    vintage_year: 2018,
    fund_life_years: null,
    status: 'investing',
    mgmt_fee_rate: null,
    carry_rate: null,
    preferred_return_rate: null,
    description: null,
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
  } as Tables<'fl_funds'>;
}

function asset(
  id: string,
  name: string,
  assetKind: 'equity' | 'loan' = 'equity',
  sector: string | null = 'Digital finance',
): Tables<'fl_assets'> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name,
    legal_name: null,
    english_name: null,
    asset_kind: assetKind,
    country: null,
    sector,
    sub_sector: null,
    instrument_terms: {},
    description: null,
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
  } as Tables<'fl_assets'>;
}

function fundingSource(
  id: string,
  name: string,
  sourceType: string | null,
): Tables<'fl_funding_sources'> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name,
    source_type: sourceType,
    owner_investor_id: null,
    currency: 'USD',
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
  } as Tables<'fl_funding_sources'>;
}

function businessEvent(
  id: string,
  eventDate: string,
  description: string,
  status: 'posted' | 'reversed' = 'posted',
  reversalOf: string | null = null,
): Tables<'fl_business_events'> {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    event_date: eventDate,
    description,
    status,
    reversal_of_event_id: reversalOf,
    source_record_id: null,
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
  } as Tables<'fl_business_events'>;
}

export const INVESTORS = {
  smma: investor('inv-smma', 'PT Sinar Mas Multiartha Tbk'),
  programs: investor('inv-prog', 'DCA / NIC Programs', 'internal_entity'),
  coinvest: investor('inv-coin', 'Co-invest Partners'),
  meranti: investor('inv-mer', 'Meranti Global Investment Ltd', 'internal_entity'),
};

export const FUNDS = {
  startech: fund('fund-star', 'Startech Growth Fund VCC', true),
  f1982: fund('fund-1982', '1982 Fund I', false),
};

export const ASSETS = {
  akulaku: asset('asset-aku', 'Akulaku'),
  goto: asset('asset-goto', 'GOTO Group', 'equity', 'Ride-hailing'),
  mythic: asset('asset-myth', 'Mythic Protocol', 'loan', 'Web3 gaming'),
};

export const SOURCES = {
  dca: fundingSource('src-dca', 'DCA', 'Internal treasury'),
  nic: fundingSource('src-nic', 'NIC', 'Programme allocation'),
  aldiracita: fundingSource('src-ald', 'Aldiracita', 'External partner'),
  hawthorn: fundingSource('src-haw', 'Hawthorn', 'Group entity'),
};

function position(
  id: string,
  parts: Partial<FlPortfolioPosition> & {
    holder_investor?: Tables<'fl_investors'> | null;
    holder_fund?: Tables<'fl_funds'> | null;
    fund?: Tables<'fl_funds'> | null;
    asset?: Tables<'fl_assets'> | null;
    funding_source?: Tables<'fl_funding_sources'> | null;
  },
): FlPortfolioPosition {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    holder_investor_id: parts.holder_investor?.id ?? null,
    holder_fund_id: parts.holder_fund?.id ?? null,
    fund_id: parts.fund?.id ?? null,
    asset_id: parts.asset?.id ?? null,
    holder_source_of_fund_id: parts.funding_source?.id ?? null,
    status: parts.status ?? 'open',
    opened_at: parts.opened_at ?? '2018-01-15',
    closed_at: null,
    notes: null,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    current_value: '0',
    valuation_method: null,
    holder_investor: parts.holder_investor ?? null,
    holder_fund: parts.holder_fund ?? null,
    fund: parts.fund ?? null,
    asset: parts.asset ?? null,
    funding_source: parts.funding_source ?? null,
  } as FlPortfolioPosition;
}

/** SMMA's participation in Startech — no declared source of fund. */
export const POS_SMMA_STARTECH = position('pos-smma-star', {
  holder_investor: INVESTORS.smma,
  fund: FUNDS.startech,
});

/** The programs' participation in Startech, funded from NIC. */
export const POS_PROGRAMS_STARTECH = position('pos-prog-star', {
  holder_investor: INVESTORS.programs,
  fund: FUNDS.startech,
  funding_source: SOURCES.nic,
  opened_at: '2018-03-02',
});

/** Co-invest Partners' participation — the far leg of both transfers. */
export const POS_COINVEST_STARTECH = position('pos-coin-star', {
  holder_investor: INVESTORS.coinvest,
  fund: FUNDS.startech,
  opened_at: '2019-02-11',
});

/** A fund holding another fund — same mechanics as an investor doing it. */
export const POS_STARTECH_1982 = position('pos-star-1982', {
  holder_fund: FUNDS.startech,
  fund: FUNDS.f1982,
  funding_source: SOURCES.nic,
  opened_at: '2021-12-10',
});

/** Meranti's Akulaku holding — jointly funded, so the split lives on the entry. */
export const POS_MERANTI_AKULAKU = position('pos-mer-aku', {
  holder_investor: INVESTORS.meranti,
  asset: ASSETS.akulaku,
  opened_at: '2021-09-20',
});

/** Meranti's GOTO holding, funded from DCA. */
export const POS_MERANTI_GOTO = position('pos-mer-goto', {
  holder_investor: INVESTORS.meranti,
  asset: ASSETS.goto,
  funding_source: SOURCES.dca,
  opened_at: '2018-01-22',
});

/** A loan position, for the non-cash and income cases. */
export const POS_MERANTI_MYTHIC = position('pos-mer-myth', {
  holder_investor: INVESTORS.meranti,
  asset: ASSETS.mythic,
  funding_source: SOURCES.hawthorn,
  opened_at: '2023-02-14',
});

export const EVENTS = {
  commitment: businessEvent('ev-commit', '2018-01-15', 'Commitment — SMMA to Startech'),
  gotoBuy: businessEvent('ev-goto-buy', '2018-01-22', 'Investment — GOTO Group Series E'),
  call4: businessEvent('ev-call4', '2021-06-30', 'Capital call #4 — Startech'),
  akulakuBuy: businessEvent('ev-aku-buy', '2021-09-20', 'Investment — Akulaku Series D'),
  subscription1982: businessEvent('ev-1982', '2021-12-10', 'Subscription — 1982 Fund I'),
  commitTransfer: businessEvent(
    'ev-commit-xfer',
    '2024-03-31',
    'Commitment transfer — Co-invest to SMMA',
  ),
  distribution: businessEvent('ev-dist', '2025-06-30', 'Distribution — Startech H1 2025'),
  income: businessEvent('ev-income', '2025-09-30', 'Interest — Mythic Protocol loan'),
  feeWrong: businessEvent('ev-fee-bad', '2026-03-31', "Q1'26 management fee — wrong position", 'reversed'),
  feeReversal: businessEvent(
    'ev-fee-rev',
    '2026-04-02',
    "Reversal — Q1'26 management fee",
    'posted',
    'ev-fee-bad',
  ),
  writeOff: businessEvent('ev-writeoff', '2026-03-31', 'Write-down — Akulaku'),
};

function entry(
  id: string,
  parts: Partial<FlPortfolioLedgerEntry> & {
    position_id: string;
    entry_date: string;
    entry_type: FlPortfolioLedgerEntry['entry_type'];
    event: Tables<'fl_business_events'>;
  },
): FlPortfolioLedgerEntry {
  return {
    id,
    position_id: parts.position_id,
    business_event_id: parts.event.id,
    entry_date: parts.entry_date,
    entry_type: parts.entry_type,
    sub_type: parts.sub_type ?? null,
    is_reversal: parts.is_reversal ?? false,
    commitment_delta: parts.commitment_delta ?? '0',
    quantity_delta: parts.quantity_delta ?? '0',
    valuation_delta: parts.valuation_delta ?? '0',
    cash_delta: parts.cash_delta ?? '0',
    currency: parts.currency ?? 'USD',
    fx_rate: parts.fx_rate ?? '1',
    price_per_unit: parts.price_per_unit ?? null,
    counterparty_position_id: parts.counterparty_position_id ?? null,
    data_status: parts.data_status ?? 'verified',
    source_record_id: null,
    notes: parts.notes ?? null,
    created_by: null,
    created_at: NOW,
    event: parts.event,
    allocations: parts.allocations ?? [],
  } as FlPortfolioLedgerEntry;
}

function allocation(
  id: string,
  ledgerEntryId: string,
  fundingSourceId: string,
  amount: string,
): Tables<'fl_ledger_entry_funding_allocations'> {
  return {
    id,
    ledger_entry_id: ledgerEntryId,
    funding_source_id: fundingSourceId,
    amount,
    created_by: null,
    created_at: NOW,
  } as Tables<'fl_ledger_entry_funding_allocations'>;
}

export const ENTRIES = {
  /** $50M pledged. No money moves. */
  commitment: entry('le-commit', {
    position_id: POS_SMMA_STARTECH.id,
    entry_date: '2018-01-15',
    entry_type: 'commitment',
    sub_type: 'initial',
    commitment_delta: '50000000',
    event: EVENTS.commitment,
  }),
  /** $43.78M out, 9.5M shares in, funded from the position's declared DCA pool. */
  gotoBuy: entry('le-goto-buy', {
    position_id: POS_MERANTI_GOTO.id,
    entry_date: '2018-01-22',
    entry_type: 'buy',
    sub_type: 'initial',
    quantity_delta: '9500000',
    cash_delta: '-43780000',
    price_per_unit: '4.608',
    event: EVENTS.gotoBuy,
  }),
  /** A capital call actually paid: cash out, units in, one row. */
  paidIn: entry('le-call4', {
    position_id: POS_SMMA_STARTECH.id,
    entry_date: '2021-06-30',
    entry_type: 'paid_in',
    sub_type: 'capital_call',
    quantity_delta: '12000000',
    cash_delta: '-12000000',
    price_per_unit: '1',
    event: EVENTS.call4,
  }),
  /** Jointly funded — the split lives on the entry and must add up to the cash. */
  akulakuBuy: entry('le-aku-buy', {
    position_id: POS_MERANTI_AKULAKU.id,
    entry_date: '2021-09-20',
    entry_type: 'buy',
    quantity_delta: '2210000',
    cash_delta: '-6630000',
    price_per_unit: '3',
    event: EVENTS.akulakuBuy,
    allocations: [
      allocation('al-1', 'le-aku-buy', SOURCES.aldiracita.id, '4000000'),
      allocation('al-2', 'le-aku-buy', SOURCES.hawthorn.id, '2630000'),
    ],
  }),
  /** A fund subscribing to another fund. Source came from the spreadsheet wrong. */
  subscription1982: entry('le-1982', {
    position_id: POS_STARTECH_1982.id,
    entry_date: '2021-12-10',
    entry_type: 'paid_in',
    cash_delta: '-2000000',
    data_status: 'needs_verification',
    notes: 'Sheet totals disagree with the transaction rows by $12k.',
    event: EVENTS.subscription1982,
  }),
  /** Leg one of the commitment transfer: Co-invest gives up $5M of pledge. */
  transferGive: entry('le-xfer-give', {
    position_id: POS_COINVEST_STARTECH.id,
    entry_date: '2024-03-31',
    entry_type: 'commitment_transfer',
    sub_type: 'secondary',
    commitment_delta: '-5000000',
    cash_delta: '5150000',
    counterparty_position_id: POS_SMMA_STARTECH.id,
    event: EVENTS.commitTransfer,
  }),
  /** Leg two: SMMA receives it, paying a 3% premium. The two cancel. */
  transferTake: entry('le-xfer-take', {
    position_id: POS_SMMA_STARTECH.id,
    entry_date: '2024-03-31',
    entry_type: 'commitment_transfer',
    sub_type: 'secondary',
    commitment_delta: '5000000',
    cash_delta: '-5150000',
    counterparty_position_id: POS_COINVEST_STARTECH.id,
    event: EVENTS.commitTransfer,
  }),
  /** Cash paid back out of the fund. */
  distribution: entry('le-dist', {
    position_id: POS_SMMA_STARTECH.id,
    entry_date: '2025-06-30',
    entry_type: 'distribution',
    sub_type: 'income',
    cash_delta: '3200000',
    event: EVENTS.distribution,
  }),
  /** Loan coupon — money in, no units. */
  income: entry('le-income', {
    position_id: POS_MERANTI_MYTHIC.id,
    entry_date: '2025-09-30',
    entry_type: 'income',
    sub_type: 'loan_interest',
    cash_delta: '25000',
    event: EVENTS.income,
  }),
  /** The fee charged to the wrong position. */
  feeWrong: entry('le-fee-bad', {
    position_id: POS_STARTECH_1982.id,
    entry_date: '2026-03-31',
    entry_type: 'expense',
    sub_type: 'mgmt_fee',
    cash_delta: '-418000',
    event: EVENTS.feeWrong,
  }),
  /** Its reversal: same row, every delta mirrored. The original stays. */
  feeReversal: entry('le-fee-rev', {
    position_id: POS_STARTECH_1982.id,
    entry_date: '2026-04-02',
    entry_type: 'expense',
    sub_type: 'mgmt_fee',
    cash_delta: '418000',
    is_reversal: true,
    event: EVENTS.feeReversal,
  }),
  /** Shares written off. No cash, so cash-flow returns are untouched. */
  writeOff: entry('le-writeoff', {
    position_id: POS_MERANTI_AKULAKU.id,
    entry_date: '2026-03-31',
    entry_type: 'adjustment',
    sub_type: 'write_off',
    quantity_delta: '-330000',
    event: EVENTS.writeOff,
  }),
};

/** The whole fixture as the API returns it. */
export function buildTestPortfolio(
  overrides: Partial<FlPortfolioReadModel> = {},
): FlPortfolioReadModel {
  return {
    as_of_date: null,
    funds: [FUNDS.startech, FUNDS.f1982],
    managed_funds: [FUNDS.startech],
    external_funds: [FUNDS.f1982],
    assets: [ASSETS.akulaku, ASSETS.goto, ASSETS.mythic],
    investors: [INVESTORS.smma, INVESTORS.programs, INVESTORS.coinvest, INVESTORS.meranti],
    funding_sources: [SOURCES.dca, SOURCES.nic, SOURCES.aldiracita, SOURCES.hawthorn],
    positions: [
      POS_SMMA_STARTECH,
      POS_PROGRAMS_STARTECH,
      POS_COINVEST_STARTECH,
      POS_STARTECH_1982,
      POS_MERANTI_AKULAKU,
      POS_MERANTI_GOTO,
      POS_MERANTI_MYTHIC,
    ],
    balances: [],
    entries: Object.values(ENTRIES),
    business_events: Object.values(EVENTS),
    valuations: [],
    ...overrides,
  } as FlPortfolioReadModel;
}
