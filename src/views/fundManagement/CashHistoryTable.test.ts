import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CashHistoryTable } from './CashHistoryTable';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger/types';
import type { Tables } from '@/lib/repositories';

describe('CashHistoryTable (fund-only cash movements)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const posCashFund1: FlPortfolioPosition = {
    id: 'pos-cash-fund1',
    workspace_id: 'ws-1',
    holder_investor_id: null,
    holder_fund_id: 'fund-1',
    asset_id: 'asset-cash-fund1',
    fund_id: null,
    holder_source_of_fund_id: null,
    status: 'open',
    opened_at: '2025-01-01',
    closed_at: null,
    notes: null,
    created_by: null,
    created_at: '',
    updated_at: '',
    current_value: '3000000',
    valuation_method: 'cash_par',
    balance: {
      position_id: 'pos-cash-fund1',
      commitment: '0',
      drawn_commitment: '0',
      quantity: '0',
      contributed_capital: '0',
      distributed_capital: '0',
      committed: '0',
      contributed: '0',
      unfunded: '0',
      cash_total: '3000000',
      distributed: '0',
      retained_proceeds: '0',
      asset_kind: 'cash',
    },
    asset: {
      id: 'asset-cash-fund1',
      workspace_id: 'ws-1',
      name: 'USD Cash Fund1',
      canonical_name: 'usd cash fund1',
      legal_name: null,
      english_name: null,
      asset_kind: 'cash',
      country: null,
      sector: null,
      sub_sector: null,
      instrument_terms: { currency: 'USD' },
      description: null,
      created_by: null,
      updated_by: null,
      created_at: '',
      updated_at: '',
    },
    fund: null,
    holder_investor: null,
    holder_fund: {
      id: 'fund-1',
      name: 'Managed Fund Alpha',
      workspace_id: 'ws-1',
      canonical_name: 'managed fund alpha',
      legal_name: null,
      english_name: null,
      registration_no: null,
      managed: true,
      ownership_basis: 'commitment',
      base_currency: 'USD',
      vintage_year: 2024,
      fund_life_years: 10,
      status: 'investing',
      mgmt_fee_rate: null,
      carry_rate: null,
      preferred_return_rate: null,
      description: null,
      created_by: null,
      updated_by: null,
      created_at: '',
      updated_at: '',
    } as unknown as Tables<'fl_funds'>,
    funding_source: null,
  };

  const posCashFund2: FlPortfolioPosition = {
    ...posCashFund1,
    id: 'pos-cash-fund2',
    holder_fund_id: 'fund-2',
    asset: {
      ...posCashFund1.asset!,
      id: 'asset-cash-fund2',
      name: 'USD Cash Fund2',
    },
    holder_fund: {
      ...posCashFund1.holder_fund!,
      id: 'fund-2',
      name: 'Managed Fund Beta',
    } as unknown as Tables<'fl_funds'>,
  };

  const entryFund1: FlPortfolioLedgerEntry = {
    id: 'e-fund1-1',
    position_id: 'pos-cash-fund1',
    business_event_id: null,
    entry_date: '2025-01-15',
    entry_type: 'paid_in',
    price_per_unit: null,
    fx_rate: null,
    currency: 'USD',
    commitment_delta: '0',
    quantity_delta: '0',
    cash_delta: '3000000.00000000',
    source_ledger_entry_id: null,
    source_record_id: null,
    counterparty_position_id: null,
    is_reversal: false,
    data_status: 'verified',
    sub_type: 'opening_balance',
    notes: 'Capital call deposit Fund1',
    created_at: '',
    created_by: null,
    event: null,
    allocations: [],
  };

  const entryFund2: FlPortfolioLedgerEntry = {
    ...entryFund1,
    id: 'e-fund2-1',
    position_id: 'pos-cash-fund2',
    cash_delta: '2000000.00000000',
    notes: 'Capital call deposit Fund2',
  };

  const allPositions = [posCashFund1, posCashFund2];
  const allEntries = [entryFund1, entryFund2];

  it("1. holder.kind === 'fund' selects that fund's cash positions and renders statement", () => {
    const html = renderToStaticMarkup(
      React.createElement(CashHistoryTable, {
        holder: { kind: 'fund', id: 'fund-1', name: 'Managed Fund Alpha' },
        positions: allPositions,
        entries: allEntries,
      }),
    );

    expect(html).toContain('data-testid="cash-history-container-fund-fund-1"');
    expect(html).toContain('Managed Fund Alpha');
    expect(html).toContain('Capital call deposit Fund1');
    expect(html).toContain('3,000,000.00');

    // Does NOT select fund-2 positions
    expect(html).not.toContain('Capital call deposit Fund2');
    expect(html).not.toContain('2,000,000.00');
  });

  it("2. Two funds' statements do not bleed into each other", () => {
    const html1 = renderToStaticMarkup(
      React.createElement(CashHistoryTable, {
        holder: { kind: 'fund', id: 'fund-1', name: 'Managed Fund Alpha' },
        positions: allPositions,
        entries: allEntries,
      }),
    );

    const html2 = renderToStaticMarkup(
      React.createElement(CashHistoryTable, {
        holder: { kind: 'fund', id: 'fund-2', name: 'Managed Fund Beta' },
        positions: allPositions,
        entries: allEntries,
      }),
    );

    // Fund 1 contains only its data
    expect(html1).toContain('Capital call deposit Fund1');
    expect(html1).toContain('3,000,000.00');
    expect(html1).not.toContain('Capital call deposit Fund2');
    expect(html1).not.toContain('2,000,000.00');

    // Fund 2 contains only its data
    expect(html2).toContain('Capital call deposit Fund2');
    expect(html2).toContain('2,000,000.00');
    expect(html2).not.toContain('Capital call deposit Fund1');
    expect(html2).not.toContain('3,000,000.00');
  });

  it('3. A statement renders for a fund with negative balance and stays negative', () => {
    const posCashNegative: FlPortfolioPosition = {
      ...posCashFund1,
      id: 'pos-cash-negative',
      holder_fund_id: 'fund-neg',
      current_value: '-500000',
      balance: {
        ...posCashFund1.balance!,
        position_id: 'pos-cash-negative',
        cash_total: '-500000',
      },
    };

    const entryInflow: FlPortfolioLedgerEntry = {
      ...entryFund1,
      id: 'e-inflow',
      position_id: 'pos-cash-negative',
      entry_date: '2025-01-01',
      entry_type: 'paid_in',
      cash_delta: '100000.00000000',
      sub_type: 'opening_balance',
      notes: 'Initial cash',
    };

    const entryOutflow: FlPortfolioLedgerEntry = {
      ...entryFund1,
      id: 'e-outflow',
      position_id: 'pos-cash-negative',
      entry_date: '2025-02-01',
      entry_type: 'distribution',
      cash_delta: '-600000.00000000',
      sub_type: null,
      notes: 'Unfunded capital outflow',
    };

    const html = renderToStaticMarkup(
      React.createElement(CashHistoryTable, {
        holder: { kind: 'fund', id: 'fund-neg', name: 'Negative Fund' },
        positions: [posCashNegative],
        entries: [entryInflow, entryOutflow],
      }),
    );

    // The statement renders (not empty, not error)
    expect(html).not.toContain('data-testid="cash-history-empty"');
    expect(html).not.toContain('data-testid="cash-history-error"');
    expect(html).toContain('Unfunded capital outflow');

    // Running balance is negative: −500,000.00
    // Must NOT be zeroed, suppressed, or positive
    expect(html).toContain('−500,000.00');
    // Closing balance in header must also display negative
    expect(html).toContain('USD −500,000.00');
  });
});
