import { describe, expect, it } from 'vitest';
import { computeFundCashSummary } from './fundCashSummary';
import type { Tables } from '@/lib/repositories';

describe('fundCashSummary - computeFundCashSummary', () => {
  const fund: Tables<'fl_funds'> = {
    id: 'fund-1',
    workspace_id: 'ws-1',
    name: 'Fund I',
    canonical_name: 'fund i',
    legal_name: null,
    english_name: null,
    registration_no: null,
    fund_life_years: null,
    vintage_year: 2024,
    status: 'investing',
    managed: true,
    base_currency: 'USD',
    ownership_basis: 'commitment',
    mgmt_fee_rate: null,
    carry_rate: null,
    preferred_return_rate: null,
    description: null,
    created_by: null,
    updated_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  it('returns empty cash balances and zero reporting total when fund has no cash positions', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-inv-1',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'equity' },
          balance: {
            position_id: 'pos-inv-1',
            cash_total: '0.00000000',
            retained_proceeds: '500.00000000',
          },
        },
      ],
      entries: [],
    });

    expect(summary.fund_id).toBe('fund-1');
    expect(summary.cash_balances).toEqual([]);
    expect(summary.reporting_total).toBe('0.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
  });

  it('calculates cash balance for a single cash position in base currency', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-1',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: {
            position_id: 'pos-cash-1',
            cash_total: '1500000.00000000',
          },
        },
      ],
      entries: [],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'USD', amount: '1500000.00000000' },
    ]);
    expect(summary.reporting_total).toBe('1500000.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
  });

  it('aggregates multiple cash positions in the same currency', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-1',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: {
            position_id: 'pos-cash-1',
            cash_total: '1000000.00000000',
          },
        },
        {
          id: 'pos-cash-2',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: {
            position_id: 'pos-cash-2',
            cash_total: '500000.00000000',
          },
        },
      ],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'USD', amount: '1500000.00000000' },
    ]);
    expect(summary.reporting_total).toBe('1500000.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
  });

  it('sets pending_fx and null reporting_total for multi-currency funds with non-zero balances', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-usd',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: {
            position_id: 'pos-cash-usd',
            cash_total: '2000000.00000000',
          },
        },
        {
          id: 'pos-cash-eur',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
          balance: {
            position_id: 'pos-cash-eur',
            cash_total: '500000.00000000',
          },
        },
      ],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'EUR', amount: '500000.00000000' },
      { currency: 'USD', amount: '2000000.00000000' },
    ]);
    expect(summary.reporting_total).toBeNull();
    expect(summary.reporting_total_available).toBe(false);
    expect(summary.fx_status).toBe('pending_fx');
  });

  it('treats multi-currency with 0 in foreign currency as available base currency', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-usd',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: {
            position_id: 'pos-cash-usd',
            cash_total: '2000000.00000000',
          },
        },
        {
          id: 'pos-cash-eur',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
          balance: {
            position_id: 'pos-cash-eur',
            cash_total: '0.00000000',
          },
        },
      ],
    });

    expect(summary.reporting_total).toBe('2000000.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
  });

  it('derives balance from entries with asOfDate filtering when balanceMap is not supplied', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-usd',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
        },
      ],
      entries: [
        { position_id: 'pos-cash-usd', currency: 'USD', entry_date: '2025-01-01', cash_delta: '1000.00000000' },
        { position_id: 'pos-cash-usd', currency: 'USD', entry_date: '2025-02-01', cash_delta: '500.00000000' },
        { position_id: 'pos-cash-usd', currency: 'USD', entry_date: '2025-04-01', cash_delta: '300.00000000' },
      ],
      asOfDate: '2025-03-01',
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'USD', amount: '1500.00000000' },
    ]);
    expect(summary.reporting_total).toBe('1500.00000000');
  });

  it('only sums cash positions belonging to the target fund', () => {
    const summary = computeFundCashSummary({
      fund,
      positions: [
        {
          id: 'pos-cash-fund-1',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-fund-1', cash_total: '1000.00000000' },
        },
        {
          id: 'pos-cash-fund-2',
          holder_fund_id: 'fund-2',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-fund-2', cash_total: '9000.00000000' },
        },
      ],
    });

    expect(summary.reporting_total).toBe('1000.00000000');
  });

  it('handles all-zero foreign-currency position without nulling reporting total (FIX 3)', () => {
    const cnyFund = { ...fund, id: 'fund-cny', base_currency: 'CNY' };
    const summary = computeFundCashSummary({
      fund: cnyFund,
      positions: [
        {
          id: 'pos-cash-usd-zero',
          holder_fund_id: 'fund-cny',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-usd-zero', cash_total: '0.00000000' },
        },
      ],
      entries: [],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'USD', amount: '0.00000000' },
    ]);
    expect(summary.reporting_total).toBe('0.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
  });

  it('marks non-zero foreign-currency position as pending_fx with null reporting total (FIX 3)', () => {
    const cnyFund = { ...fund, id: 'fund-cny', base_currency: 'CNY' };
    const summary = computeFundCashSummary({
      fund: cnyFund,
      positions: [
        {
          id: 'pos-cash-usd-nonzero',
          holder_fund_id: 'fund-cny',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-usd-nonzero', cash_total: '500000.00000000' },
        },
      ],
      entries: [],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'USD', amount: '500000.00000000' },
    ]);
    expect(summary.reporting_total).toBeNull();
    expect(summary.reporting_total_available).toBe(false);
    expect(summary.fx_status).toBe('pending_fx');
  });

  it('allows available total when foreign position is zero and base position is non-zero (FIX 3)', () => {
    const cnyFund = { ...fund, id: 'fund-cny', base_currency: 'CNY' };
    const summary = computeFundCashSummary({
      fund: cnyFund,
      positions: [
        {
          id: 'pos-cash-cny',
          holder_fund_id: 'fund-cny',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'CNY' } },
          balance: { position_id: 'pos-cash-cny', cash_total: '2000000.00000000' },
        },
        {
          id: 'pos-cash-usd-zero',
          holder_fund_id: 'fund-cny',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-usd-zero', cash_total: '0.00000000' },
        },
      ],
      entries: [],
    });

    expect(summary.cash_balances).toEqual([
      { currency: 'CNY', amount: '2000000.00000000' },
      { currency: 'USD', amount: '0.00000000' },
    ]);
    expect(summary.reporting_total).toBe('2000000.00000000');
    expect(summary.reporting_total_available).toBe(true);
    expect(summary.fx_status).toBe('available');
    expect(summary.cash_status).toBe('ok');
  });

  describe('negative cash balance guard (incomplete data)', () => {
    it('marks fund with one negative currency balance as incomplete_negative with reporting_total null', () => {
      const summary = computeFundCashSummary({
        fund,
        positions: [
          {
            id: 'pos-cash-neg',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-neg', cash_total: '-132366322.58000000' },
          },
        ],
        entries: [],
      });

      expect(summary.cash_status).toBe('incomplete_negative');
      expect(summary.reporting_total).toBeNull();
      expect(summary.reporting_total_available).toBe(false);
      expect(summary.fx_status).toBe('available');
      // Per-currency cash balances stay available for diagnostics and statement view
      expect(summary.cash_balances).toEqual([
        { currency: 'USD', amount: '-132366322.58000000' },
      ]);
    });

    it('marks fund with two currencies where only one is negative as incomplete_negative', () => {
      const summary = computeFundCashSummary({
        fund,
        positions: [
          {
            id: 'pos-cash-usd-pos',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-usd-pos', cash_total: '5000000.00000000' },
          },
          {
            id: 'pos-cash-eur-neg',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
            balance: { position_id: 'pos-cash-eur-neg', cash_total: '-2000000.00000000' },
          },
        ],
        entries: [],
      });

      expect(summary.cash_status).toBe('incomplete_negative');
      expect(summary.reporting_total).toBeNull();
      expect(summary.reporting_total_available).toBe(false);
      expect(summary.fx_status).toBe('pending_fx');
      expect(summary.cash_balances).toEqual([
        { currency: 'EUR', amount: '-2000000.00000000' },
        { currency: 'USD', amount: '5000000.00000000' },
      ]);
    });

    it('preserves cash_status ok for zero balance funds', () => {
      const summary = computeFundCashSummary({
        fund,
        positions: [
          {
            id: 'pos-cash-zero',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-zero', cash_total: '0.00000000' },
          },
        ],
        entries: [],
      });

      expect(summary.cash_status).toBe('ok');
      expect(summary.reporting_total).toBe('0.00000000');
      expect(summary.reporting_total_available).toBe(true);
    });

    it('preserves cash_status ok for positive balance funds', () => {
      const summary = computeFundCashSummary({
        fund,
        positions: [
          {
            id: 'pos-cash-pos',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-pos', cash_total: '30494255.65000000' },
          },
        ],
        entries: [],
      });

      expect(summary.cash_status).toBe('ok');
      expect(summary.reporting_total).toBe('30494255.65000000');
      expect(summary.reporting_total_available).toBe(true);
    });
  });

  describe('investor entity cash summary', () => {
    it('returns the same per-currency figures an investor holder would given equivalent positions', () => {
      const fundSummary = computeFundCashSummary({
        fund: { id: 'fund-1', base_currency: 'USD' },
        positions: [
          {
            id: 'pos-cash-usd-fund',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-usd-fund', cash_total: '5000000.00000000' },
          },
          {
            id: 'pos-cash-eur-fund',
            holder_fund_id: 'fund-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
            balance: { position_id: 'pos-cash-eur-fund', cash_total: '2000000.00000000' },
          },
        ],
      });

      const invSummary = computeFundCashSummary({
        holder: { kind: 'investor', id: 'inv-1', base_currency: 'USD' },
        positions: [
          {
            id: 'pos-cash-usd-inv',
            holder_investor_id: 'inv-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-usd-inv', cash_total: '5000000.00000000' },
          },
          {
            id: 'pos-cash-eur-inv',
            holder_investor_id: 'inv-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
            balance: { position_id: 'pos-cash-eur-inv', cash_total: '2000000.00000000' },
          },
        ],
      });

      expect(invSummary.cash_balances).toEqual(fundSummary.cash_balances);
      expect(invSummary.fx_status).toBe(fundSummary.fx_status);
      expect(invSummary.cash_status).toBe(fundSummary.cash_status);
      expect(invSummary.reporting_total).toBe(fundSummary.reporting_total);
    });

    it('withholds negative entity cash balance and marks cash_status incomplete_negative', () => {
      const summary = computeFundCashSummary({
        holder: { kind: 'investor', id: 'inv-1', base_currency: 'USD' },
        positions: [
          {
            id: 'pos-cash-usd-inv',
            holder_investor_id: 'inv-1',
            asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
            balance: { position_id: 'pos-cash-usd-inv', cash_total: '-150000.00000000' },
          },
        ],
      });

      expect(summary.cash_status).toBe('incomplete_negative');
      expect(summary.reporting_total).toBeNull();
      expect(summary.reporting_total_available).toBe(false);
      expect(summary.cash_balances).toEqual([
        { currency: 'USD', amount: '-150000.00000000' },
      ]);
    });

    it('ensures two entities cash accounts do not bleed into each other', () => {
      const positions = [
        {
          id: 'pos-cash-inv-1',
          holder_investor_id: 'inv-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-inv-1', cash_total: '1000000.00000000' },
        },
        {
          id: 'pos-cash-inv-2',
          holder_investor_id: 'inv-2',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-inv-2', cash_total: '4000000.00000000' },
        },
        {
          id: 'pos-cash-fund-1',
          holder_fund_id: 'fund-1',
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
          balance: { position_id: 'pos-cash-fund-1', cash_total: '9000000.00000000' },
        },
      ];

      const inv1Summary = computeFundCashSummary({
        holder: { kind: 'investor', id: 'inv-1', base_currency: 'USD' },
        positions,
      });

      const inv2Summary = computeFundCashSummary({
        holder: { kind: 'investor', id: 'inv-2', base_currency: 'USD' },
        positions,
      });

      const fund1Summary = computeFundCashSummary({
        fund: { id: 'fund-1', base_currency: 'USD' },
        positions,
      });

      expect(inv1Summary.cash_balances).toEqual([{ currency: 'USD', amount: '1000000.00000000' }]);
      expect(inv1Summary.reporting_total).toBe('1000000.00000000');

      expect(inv2Summary.cash_balances).toEqual([{ currency: 'USD', amount: '4000000.00000000' }]);
      expect(inv2Summary.reporting_total).toBe('4000000.00000000');

      expect(fund1Summary.cash_balances).toEqual([{ currency: 'USD', amount: '9000000.00000000' }]);
      expect(fund1Summary.reporting_total).toBe('9000000.00000000');
    });
  });
});
