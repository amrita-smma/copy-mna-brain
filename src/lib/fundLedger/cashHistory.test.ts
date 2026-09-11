import { describe, expect, it } from 'vitest';
import { buildCashHistoryRows, resolveCashPositionCurrency } from './cashHistory';
import { computeFundCashSummary } from './fundCashSummary';
import { flEq } from '@/lib/services/flDecimal';

describe('cashHistory - buildCashHistoryRows', () => {
  it('handles empty input gracefully', () => {
    expect(buildCashHistoryRows([], [])).toEqual([]);
    expect(buildCashHistoryRows(null as any, [])).toEqual([]);
    expect(buildCashHistoryRows([], null as any)).toEqual([]);
  });

  it('runs the balance in posting order when two movements share a date', () => {
    // Same day, opposite signs: ordered the wrong way round the running balance
    // dips negative halfway down even though the account never went overdrawn.
    const cashPositions = [
      {
        id: 'pos-cash-usd',
        holder_fund_id: 'fund-1',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
    ];

    // 'zz-in' sorts after 'aa-out' by id, so only created_at can order these
    // the way they were actually posted.
    const entries = [
      {
        id: 'aa-out',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-03-01',
        cash_delta: '-300000.00000000',
        currency: 'USD',
        created_at: '2024-03-01T15:00:00.000Z',
      },
      {
        id: 'zz-in',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-03-01',
        cash_delta: '500000.00000000',
        currency: 'USD',
        created_at: '2024-03-01T09:00:00.000Z',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, {
      positions: cashPositions,
    });

    expect(result[0].rows.map((row) => row.id)).toEqual(['zz-in', 'aa-out']);
    expect(result[0].rows.map((row) => row.runningBalance)).toEqual([
      '500000.00000000',
      '200000.00000000',
    ]);
    expect(result[0].closingBalance).toBe('200000.00000000');
  });

  it('opens with the opening balance even when it was backfilled after that day\u2019s movements', () => {
    const cashPositions = [
      {
        id: 'pos-cash-usd',
        holder_fund_id: 'fund-1',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
    ];

    const entries = [
      {
        id: 'mov-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-01-01',
        cash_delta: '-100000.00000000',
        currency: 'USD',
        created_at: '2024-01-02T09:00:00.000Z',
      },
      {
        id: 'open-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        entry_date: '2024-01-01',
        cash_delta: '1000000.00000000',
        currency: 'USD',
        // Typed in a month later, once someone reconciled the account.
        created_at: '2024-02-01T09:00:00.000Z',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, {
      positions: cashPositions,
    });

    expect(result[0].rows.map((row) => row.id)).toEqual(['open-1', 'mov-1']);
    expect(result[0].rows.map((row) => row.runningBalance)).toEqual([
      '1000000.00000000',
      '900000.00000000',
    ]);
  });

  it('calculates single currency running balance and verifies stable sort and closing balance', () => {
    const cashPositions = [
      {
        id: 'pos-cash-usd',
        holder_fund_id: 'fund-1',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
    ];

    const entries = [
      {
        id: 'prim-buy-1',
        position_id: 'pos-asset-1',
        entry_type: 'buy',
        entry_date: '2024-02-01',
        cash_delta: '-400000.00000000',
        currency: 'USD',
      },
      {
        id: 'leg-buy-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-02-01',
        cash_delta: '-400000.00000000',
        currency: 'USD',
        source_ledger_entry_id: 'prim-buy-1',
        notes: 'Asset purchase leg',
      },
      {
        id: 'leg-open-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        entry_date: '2024-01-01',
        cash_delta: '1000000.00000000',
        currency: 'USD',
      },
    ];

    const positions = [
      ...cashPositions,
      {
        id: 'pos-asset-1',
        holder_fund_id: 'fund-1',
        asset: { name: 'Acme Corp', asset_kind: 'equity' },
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, { positions });

    expect(result).toHaveLength(1);
    expect(result[0].currency).toBe('USD');
    expect(result[0].closingBalance).toBe('600000.00000000');
    expect(result[0].rows).toHaveLength(2);

    // Verify ordering: 2024-01-01 comes before 2024-02-01
    expect(result[0].rows[0].id).toBe('leg-open-1');
    expect(result[0].rows[0].date).toBe('2024-01-01');
    expect(result[0].rows[0].typeLabel).toBe('Opening balance');
    expect(result[0].rows[0].detail).toBe('Opening balance');
    expect(result[0].rows[0].amount).toBe('1000000.00000000');
    expect(result[0].rows[0].runningBalance).toBe('1000000.00000000');
    expect(result[0].rows[0].isOpeningBalance).toBe(true);

    expect(result[0].rows[1].id).toBe('leg-buy-1');
    expect(result[0].rows[1].date).toBe('2024-02-01');
    expect(result[0].rows[1].typeLabel).toBe('Buy');
    expect(result[0].rows[1].detail).toBe('Buy · Acme Corp');
    expect(result[0].rows[1].amount).toBe('-400000.00000000');
    expect(result[0].rows[1].runningBalance).toBe('600000.00000000');
    expect(result[0].rows[1].notes).toBe('Asset purchase leg');

    // Reconcile with computeFundCashSummary
    const summary = computeFundCashSummary({
      fund: { id: 'fund-1', base_currency: 'USD' },
      positions: cashPositions,
      entries,
    });
    expect(summary.cash_balances[0].amount).toBe(result[0].closingBalance);
  });

  it('keeps two currencies separate without mixing balances or totals', () => {
    const cashPositions = [
      {
        id: 'pos-cash-usd',
        holder_fund_id: 'fund-1',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
      {
        id: 'pos-cash-eur',
        holder_fund_id: 'fund-1',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
      },
    ];

    const entries = [
      {
        id: 'ent-usd-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        entry_date: '2024-01-01',
        cash_delta: '2000000.00000000',
        currency: 'USD',
      },
      {
        id: 'ent-usd-2',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-03-01',
        cash_delta: '-500000.00000000',
        currency: 'USD',
      },
      {
        id: 'ent-eur-1',
        position_id: 'pos-cash-eur',
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        entry_date: '2024-02-01',
        cash_delta: '800000.00000000',
        currency: 'EUR',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries);

    expect(result).toHaveLength(2);
    // Alphabetical order: EUR, USD
    expect(result[0].currency).toBe('EUR');
    expect(result[0].closingBalance).toBe('800000.00000000');
    expect(result[0].rows).toHaveLength(1);
    expect(result[0].rows[0].runningBalance).toBe('800000.00000000');

    expect(result[1].currency).toBe('USD');
    expect(result[1].closingBalance).toBe('1500000.00000000');
    expect(result[1].rows).toHaveLength(2);
    expect(result[1].rows[0].runningBalance).toBe('2000000.00000000');
    expect(result[1].rows[1].runningBalance).toBe('1500000.00000000');

    // Check with computeFundCashSummary
    const summary = computeFundCashSummary({
      fund: { id: 'fund-1', base_currency: 'USD' },
      positions: cashPositions,
      entries,
    });
    expect(summary.cash_balances).toEqual([
      { currency: 'EUR', amount: '800000.00000000' },
      { currency: 'USD', amount: '1500000.00000000' },
    ]);
    expect(result[0].closingBalance).toBe(summary.cash_balances[0].amount);
    expect(result[1].closingBalance).toBe(summary.cash_balances[1].amount);
  });

  it('shows reversal rows and nets the original to zero', () => {
    const cashPositions = [
      {
        id: 'pos-cash-usd',
        holder_fund_id: 'fund-1',
        currency: 'USD',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
    ];

    const entries = [
      {
        id: 'prim-1',
        position_id: 'pos-inv-1',
        entry_type: 'paid_in',
        entry_date: '2024-01-10',
        cash_delta: '-100000.00000000',
        currency: 'USD',
      },
      {
        id: 'leg-orig-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-01-10',
        cash_delta: '100000.00000000',
        currency: 'USD',
        source_ledger_entry_id: 'prim-1',
        is_reversal: false,
      },
      {
        id: 'leg-rev-1',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        entry_date: '2024-01-15',
        cash_delta: '-100000.00000000',
        currency: 'USD',
        source_ledger_entry_id: 'prim-1',
        is_reversal: true,
      },
    ];

    const positions = [
      ...cashPositions,
      {
        id: 'pos-inv-1',
        holder_investor: { name: 'Alpha Capital' },
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, { positions });

    expect(result).toHaveLength(1);
    expect(result[0].closingBalance).toBe('0.00000000');
    expect(result[0].rows).toHaveLength(2);

    expect(result[0].rows[0].isReversal).toBe(false);
    expect(result[0].rows[0].amount).toBe('100000.00000000');
    expect(result[0].rows[0].runningBalance).toBe('100000.00000000');

    // Reversal row is kept, not hidden
    expect(result[0].rows[1].isReversal).toBe(true);
    expect(result[0].rows[1].amount).toBe('-100000.00000000');
    expect(result[0].rows[1].runningBalance).toBe('0.00000000');

    // Summary agrees
    const summary = computeFundCashSummary({
      fund: { id: 'fund-1', base_currency: 'USD' },
      positions: cashPositions,
      entries,
    });
    expect(summary.cash_balances[0].amount).toBe('0.00000000');
    expect(result[0].closingBalance).toBe(summary.cash_balances[0].amount);
  });

  it('correctly derives opening balance row', () => {
    const cashPositions = [
      {
        id: 'pos-cash-1',
        currency: 'USD',
      },
    ];

    const entries = [
      {
        id: 'leg-open-1',
        position_id: 'pos-cash-1',
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        entry_date: '2023-12-31',
        cash_delta: '5000000.00000000',
        currency: 'USD',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries);

    expect(result[0].rows[0]).toMatchObject({
      id: 'leg-open-1',
      date: '2023-12-31',
      typeLabel: 'Opening balance',
      detail: 'Opening balance',
      isOpeningBalance: true,
      amount: '5000000.00000000',
      runningBalance: '5000000.00000000',
    });
  });

  it('gracefully falls back when primary entry or names cannot be resolved', () => {
    const cashPositions = [
      {
        id: 'pos-cash-1',
        currency: 'USD',
      },
    ];

    const entries = [
      {
        id: 'leg-orphan',
        position_id: 'pos-cash-1',
        entry_type: 'cash_movement',
        entry_date: '2024-01-05',
        cash_delta: '25000.00000000',
        currency: 'USD',
        source_ledger_entry_id: 'non-existent-primary',
      },
      {
        id: 'prim-unnamed',
        position_id: 'pos-mystery',
        entry_type: 'buy',
        entry_date: '2024-01-06',
        cash_delta: '-10000.00000000',
        currency: 'USD',
      },
      {
        id: 'leg-unnamed',
        position_id: 'pos-cash-1',
        entry_type: 'cash_movement',
        entry_date: '2024-01-06',
        cash_delta: '-10000.00000000',
        currency: 'USD',
        source_ledger_entry_id: 'prim-unnamed',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries);

    expect(result[0].rows).toHaveLength(2);
    // Missing primary falls back to 'Cash movement'
    expect(result[0].rows[0].typeLabel).toBe('Cash movement');
    expect(result[0].rows[0].detail).toBe('Cash movement');

    // Missing asset name falls back to primary entry type 'Buy'
    expect(result[0].rows[1].typeLabel).toBe('Buy');
    expect(result[0].rows[1].detail).toBe('Buy');
  });

  it('formats primary details for various entry types (Buy, Paid-in, Sell retained, Distribution, Expense)', () => {
    const cashPositions = [{ id: 'pos-cash', currency: 'USD' }];

    const positions = [
      { id: 'pos-asset-buy', asset: { name: 'TechCo' } },
      { id: 'pos-asset-sell', asset: { name: 'OldCo' } },
      { id: 'pos-inv-pi', holder_investor: { name: 'LP Jane' } },
      { id: 'pos-inv-dist', holder_investor: { name: 'LP Bob' } },
    ];

    const entries = [
      {
        id: 'prim-pi',
        position_id: 'pos-inv-pi',
        entry_type: 'paid_in',
        entry_date: '2024-01-01',
      },
      {
        id: 'leg-pi',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-01',
        cash_delta: '100000',
        source_ledger_entry_id: 'prim-pi',
      },
      {
        id: 'prim-buy',
        position_id: 'pos-asset-buy',
        entry_type: 'buy',
        entry_date: '2024-01-02',
      },
      {
        id: 'leg-buy',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-02',
        cash_delta: '-50000',
        source_ledger_entry_id: 'prim-buy',
      },
      {
        id: 'prim-sell-retained',
        position_id: 'pos-asset-sell',
        entry_type: 'sell',
        sub_type: 'cash_in_fund',
        entry_date: '2024-01-03',
      },
      {
        id: 'leg-sell-retained',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-03',
        cash_delta: '75000',
        source_ledger_entry_id: 'prim-sell-retained',
      },
      {
        id: 'prim-dist',
        position_id: 'pos-inv-dist',
        entry_type: 'distribution',
        entry_date: '2024-01-04',
      },
      {
        id: 'leg-dist',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-04',
        cash_delta: '-20000',
        source_ledger_entry_id: 'prim-dist',
      },
      {
        id: 'prim-exp',
        position_id: 'pos-cash',
        entry_type: 'expense',
        sub_type: 'audit_fee',
        entry_date: '2024-01-05',
      },
      {
        id: 'leg-exp',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-05',
        cash_delta: '-5000',
        source_ledger_entry_id: 'prim-exp',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, { positions });
    const rows = result[0].rows;

    expect(rows[0].detail).toBe('Paid-in ← LP Jane');
    expect(rows[1].detail).toBe('Buy · TechCo');
    expect(rows[2].detail).toBe('Sell (retained) · OldCo');
    expect(rows[3].detail).toBe('Distribution → LP Bob');
    expect(rows[4].detail).toBe('Expense · audit_fee');
  });

  it('describes FX transfer legs and names the counterparty currency', () => {
    const cashPositions = [
      { id: 'pos-cash-usd', currency: 'USD' },
      { id: 'pos-cash-eur', currency: 'EUR' },
    ];

    const entries = [
      {
        id: 'leg-fx-usd',
        position_id: 'pos-cash-usd',
        entry_type: 'cash_movement',
        counterparty_position_id: 'pos-cash-eur',
        entry_date: '2024-03-01',
        cash_delta: '-1000',
        currency: 'USD',
      },
      {
        id: 'leg-fx-eur',
        position_id: 'pos-cash-eur',
        counterparty_position_id: 'pos-cash-usd',
        entry_date: '2024-03-01',
        cash_delta: '920',
        currency: 'EUR',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries);

    const eurGroup = result.find((g) => g.currency === 'EUR');
    const usdGroup = result.find((g) => g.currency === 'USD');

    expect(usdGroup?.rows[0].typeLabel).toBe('FX transfer');
    expect(usdGroup?.rows[0].detail).toBe('FX transfer · EUR');

    expect(eurGroup?.rows[0].typeLabel).toBe('FX transfer');
    expect(eurGroup?.rows[0].detail).toBe('FX transfer · USD');
  });

  it('filters rows according to asOfDate', () => {
    const cashPositions = [
      {
        id: 'pos-cash',
        holder_fund_id: 'fund-1',
        currency: 'USD',
        asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
      },
    ];
    const entries = [
      {
        id: 'ent-1',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-01',
        cash_delta: '100',
        currency: 'USD',
      },
      {
        id: 'ent-2',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-02-01',
        cash_delta: '200',
        currency: 'USD',
      },
      {
        id: 'ent-3',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-03-01',
        cash_delta: '300',
        currency: 'USD',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, {
      asOfDate: '2024-02-15',
    });

    expect(result[0].rows).toHaveLength(2);
    expect(result[0].rows.map((r) => r.id)).toEqual(['ent-1', 'ent-2']);
    expect(result[0].closingBalance).toBe('300.00000000');

    // Reconcile with computeFundCashSummary
    const summary = computeFundCashSummary({
      fund: { id: 'fund-1', base_currency: 'USD' },
      positions: cashPositions,
      entries,
      asOfDate: '2024-02-15',
    });
    expect(result[0].closingBalance).toBe(summary.cash_balances[0].amount);
  });

  it('for fund 南京金光紫金 the closing running balance is CNY 30,494,255.65 matching cash summary', () => {
    const fund = {
      id: 'fund-nanjing-jinguang',
      name: '南京金光紫金股权投资基金（有限合伙企业）',
      base_currency: 'CNY',
    };

    const cashPosition = {
      id: 'pos-nanjing-cash-cny',
      holder_fund_id: fund.id,
      currency: 'CNY',
      asset: {
        id: 'asset-cash-cny',
        name: 'Cash (CNY)',
        asset_kind: 'cash',
        instrument_terms: { currency: 'CNY' },
      },
    };

    const portfolioPositions = [
      cashPosition,
      {
        id: 'pos-asset-zl',
        holder_fund_id: fund.id,
        asset: { id: 'asset-zl', name: '中联网仓科技有限公司', asset_kind: 'equity' },
      },
      {
        id: 'pos-inv-lp',
        holder_investor: { id: 'inv-lp', name: '南京市紫金科技投资集团' },
      },
    ];

    // Fixture totaling exactly CNY 30,494,255.65:
    // 1. Initial Paid-in capital: +50,000,000.00
    // 2. Buy asset 1 (Initial investment): -30,000,000.00
    // 3. Buy asset 1 (Follow-on investment): -20,000,000.00
    // 4. Follow-on Paid-in capital: +20,000,000.00
    // 5. Divestment exit (Sell retained in fund): +10,494,255.65
    // Sum = 50M - 30M - 20M + 20M + 10,494,255.65 = 30,494,255.65 CNY
    const entries = [
      {
        id: 'prim-pi-1',
        position_id: 'pos-inv-lp',
        entry_type: 'paid_in',
        entry_date: '2021-06-18',
        cash_delta: '-50000000.00000000',
        currency: 'CNY',
      },
      {
        id: 'leg-pi-1',
        position_id: 'pos-nanjing-cash-cny',
        entry_type: 'cash_movement',
        entry_date: '2021-06-18',
        cash_delta: '50000000.00000000',
        currency: 'CNY',
        source_ledger_entry_id: 'prim-pi-1',
      },
      {
        id: 'prim-buy-1',
        position_id: 'pos-asset-zl',
        entry_type: 'buy',
        entry_date: '2021-09-15',
        cash_delta: '-30000000.00000000',
        currency: 'CNY',
      },
      {
        id: 'leg-buy-1',
        position_id: 'pos-nanjing-cash-cny',
        entry_type: 'cash_movement',
        entry_date: '2021-09-15',
        cash_delta: '-30000000.00000000',
        currency: 'CNY',
        source_ledger_entry_id: 'prim-buy-1',
      },
      {
        id: 'prim-buy-2',
        position_id: 'pos-asset-zl',
        entry_type: 'buy',
        entry_date: '2022-03-20',
        cash_delta: '-20000000.00000000',
        currency: 'CNY',
      },
      {
        id: 'leg-buy-2',
        position_id: 'pos-nanjing-cash-cny',
        entry_type: 'cash_movement',
        entry_date: '2022-03-20',
        cash_delta: '-20000000.00000000',
        currency: 'CNY',
        source_ledger_entry_id: 'prim-buy-2',
      },
      {
        id: 'prim-pi-2',
        position_id: 'pos-inv-lp',
        entry_type: 'paid_in',
        entry_date: '2022-08-10',
        cash_delta: '-20000000.00000000',
        currency: 'CNY',
      },
      {
        id: 'leg-pi-2',
        position_id: 'pos-nanjing-cash-cny',
        entry_type: 'cash_movement',
        entry_date: '2022-08-10',
        cash_delta: '20000000.00000000',
        currency: 'CNY',
        source_ledger_entry_id: 'prim-pi-2',
      },
      {
        id: 'prim-sell-1',
        position_id: 'pos-asset-zl',
        entry_type: 'sell',
        sub_type: 'cash_in_fund',
        entry_date: '2023-11-28',
        cash_delta: '10494255.65000000',
        currency: 'CNY',
      },
      {
        id: 'leg-sell-1',
        position_id: 'pos-nanjing-cash-cny',
        entry_type: 'cash_movement',
        entry_date: '2023-11-28',
        cash_delta: '10494255.65000000',
        currency: 'CNY',
        source_ledger_entry_id: 'prim-sell-1',
      },
    ];

    const result = buildCashHistoryRows([cashPosition], entries, {
      positions: portfolioPositions,
    });

    expect(result).toHaveLength(1);
    expect(result[0].currency).toBe('CNY');
    expect(result[0].closingBalance).toBe('30494255.65000000');
    expect(flEq(result[0].closingBalance, '30494255.65')).toBe(true);
    expect(result[0].rows).toHaveLength(5);

    // Verify row details
    expect(result[0].rows[0].detail).toBe('Paid-in ← 南京市紫金科技投资集团');
    expect(result[0].rows[1].detail).toBe('Buy · 中联网仓科技有限公司');
    expect(result[0].rows[2].detail).toBe('Buy · 中联网仓科技有限公司');
    expect(result[0].rows[3].detail).toBe('Paid-in ← 南京市紫金科技投资集团');
    expect(result[0].rows[4].detail).toBe('Sell (retained) · 中联网仓科技有限公司');

    // Assert it strictly agrees with computeFundCashSummary
    const summary = computeFundCashSummary({
      fund,
      positions: [cashPosition],
      entries,
    });
    expect(summary.cash_balances).toHaveLength(1);
    expect(summary.cash_balances[0].currency).toBe('CNY');
    expect(summary.cash_balances[0].amount).toBe('30494255.65000000');
    expect(result[0].closingBalance).toBe(summary.cash_balances[0].amount);
  });

  it('distinguishes instrument-side and holder-side (FoF) entry directions in detail column (FIX 1)', () => {
    const cashPositions = [{ id: 'pos-cash', currency: 'USD' }];

    const positions = [
      // Instrument-side (LP investor positions)
      { id: 'pos-lp-1', holder_investor: { name: 'LP Alpha' }, holder_investor_id: 'lp-alpha' },
      { id: 'pos-lp-2', holder_investor: { name: 'LP Beta' }, holder_investor_id: 'lp-beta' },
      // Holder-side FoF positions (our fund holds a position in target fund)
      {
        id: 'pos-fof-1',
        holder_fund_id: 'our-fund',
        fund_id: 'target-fund-1',
        fund: { name: 'Target Fund 1' },
      },
      {
        id: 'pos-fof-2',
        holder_fund_id: 'our-fund',
        fund_id: 'target-fund-2',
        fund: { name: 'Target Fund 2' },
      },
      // Holder-side Asset positions (our fund holds an equity asset)
      {
        id: 'pos-asset-1',
        holder_fund_id: 'our-fund',
        asset_id: 'asset-1',
        asset: { name: 'Acme Corp', asset_kind: 'equity' },
      },
      // Unnamed FoF position for fallback testing
      {
        id: 'pos-fof-unnamed',
        holder_fund_id: 'our-fund',
        fund_id: 'target-unnamed',
      },
      // Unnamed LP position for fallback testing
      {
        id: 'pos-lp-unnamed',
        holder_investor_id: 'inv-unnamed',
      },
    ];

    const entries = [
      // 1. Instrument paid_in: Paid-in ← <investor name>
      {
        id: 'prim-lp-pi',
        position_id: 'pos-lp-1',
        entry_type: 'paid_in',
        entry_date: '2024-01-01',
      },
      {
        id: 'leg-lp-pi',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-01',
        cash_delta: '100000',
        source_ledger_entry_id: 'prim-lp-pi',
      },
      // 2. Instrument distribution: Distribution → <investor name>
      {
        id: 'prim-lp-dist',
        position_id: 'pos-lp-1',
        entry_type: 'distribution',
        entry_date: '2024-01-02',
      },
      {
        id: 'leg-lp-dist',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-02',
        cash_delta: '-20000',
        source_ledger_entry_id: 'prim-lp-dist',
      },
      // 3. Instrument redemption: Redemption → <investor name>
      {
        id: 'prim-lp-red',
        position_id: 'pos-lp-2',
        entry_type: 'redemption',
        entry_date: '2024-01-03',
      },
      {
        id: 'leg-lp-red',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-03',
        cash_delta: '-15000',
        source_ledger_entry_id: 'prim-lp-red',
      },
      // 4. Holder, FoF position paid_in: Investment → <target fund name>
      {
        id: 'prim-fof-pi',
        position_id: 'pos-fof-1',
        entry_type: 'paid_in',
        entry_date: '2024-01-04',
      },
      {
        id: 'leg-fof-pi',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-04',
        cash_delta: '-50000',
        source_ledger_entry_id: 'prim-fof-pi',
      },
      // 5. Holder, FoF position distribution: Distribution ← <target fund name>
      {
        id: 'prim-fof-dist',
        position_id: 'pos-fof-1',
        entry_type: 'distribution',
        entry_date: '2024-01-05',
      },
      {
        id: 'leg-fof-dist',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-05',
        cash_delta: '30000',
        source_ledger_entry_id: 'prim-fof-dist',
      },
      // 6. Holder, FoF position redemption: Redemption ← <target fund name>
      {
        id: 'prim-fof-red',
        position_id: 'pos-fof-2',
        entry_type: 'redemption',
        entry_date: '2024-01-06',
      },
      {
        id: 'leg-fof-red',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-06',
        cash_delta: '25000',
        source_ledger_entry_id: 'prim-fof-red',
      },
      // 7. Holder, asset position buy: Buy · <asset>
      {
        id: 'prim-ast-buy',
        position_id: 'pos-asset-1',
        entry_type: 'buy',
        entry_date: '2024-01-07',
      },
      {
        id: 'leg-ast-buy',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-07',
        cash_delta: '-40000',
        source_ledger_entry_id: 'prim-ast-buy',
      },
      // 8. Holder, asset position sell: Sell · <asset> & Sell (retained) · <asset>
      {
        id: 'prim-ast-sell-ret',
        position_id: 'pos-asset-1',
        entry_type: 'sell',
        sub_type: 'cash_in_fund',
        entry_date: '2024-01-08',
      },
      {
        id: 'leg-ast-sell-ret',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-08',
        cash_delta: '60000',
        source_ledger_entry_id: 'prim-ast-sell-ret',
      },
      {
        id: 'prim-ast-sell-plain',
        position_id: 'pos-asset-1',
        entry_type: 'sell',
        entry_date: '2024-01-09',
      },
      {
        id: 'leg-ast-sell-plain',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-09',
        cash_delta: '10000',
        source_ledger_entry_id: 'prim-ast-sell-plain',
      },
      // Fallback FoF and LP rows
      {
        id: 'prim-fof-unnamed',
        position_id: 'pos-fof-unnamed',
        entry_type: 'paid_in',
        entry_date: '2024-01-10',
      },
      {
        id: 'leg-fof-unnamed',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-10',
        cash_delta: '-10000',
        source_ledger_entry_id: 'prim-fof-unnamed',
      },
      {
        id: 'prim-lp-unnamed',
        position_id: 'pos-lp-unnamed',
        entry_type: 'paid_in',
        entry_date: '2024-01-11',
      },
      {
        id: 'leg-lp-unnamed',
        position_id: 'pos-cash',
        entry_type: 'cash_movement',
        entry_date: '2024-01-11',
        cash_delta: '5000',
        source_ledger_entry_id: 'prim-lp-unnamed',
      },
    ];

    const result = buildCashHistoryRows(cashPositions, entries, { positions });
    const rows = result[0].rows;

    // Type pills keep entry type
    expect(rows[0].typeLabel).toBe('Paid-in');
    expect(rows[1].typeLabel).toBe('Distribution');
    expect(rows[2].typeLabel).toBe('Redemption');
    expect(rows[3].typeLabel).toBe('Paid-in');
    expect(rows[4].typeLabel).toBe('Distribution');
    expect(rows[5].typeLabel).toBe('Redemption');
    expect(rows[6].typeLabel).toBe('Buy');
    expect(rows[7].typeLabel).toBe('Sell');
    expect(rows[8].typeLabel).toBe('Sell');

    // Direction-aware details
    expect(rows[0].detail).toBe('Paid-in ← LP Alpha');
    expect(rows[1].detail).toBe('Distribution → LP Alpha');
    expect(rows[2].detail).toBe('Redemption → LP Beta');
    expect(rows[3].detail).toBe('Investment → Target Fund 1');
    expect(rows[4].detail).toBe('Distribution ← Target Fund 1');
    expect(rows[5].detail).toBe('Redemption ← Target Fund 2');
    expect(rows[6].detail).toBe('Buy · Acme Corp');
    expect(rows[7].detail).toBe('Sell (retained) · Acme Corp');
    expect(rows[8].detail).toBe('Sell · Acme Corp');

    // Fallbacks when name cannot be resolved
    expect(rows[9].detail).toBe('Investment');
    expect(rows[10].detail).toBe('Paid-in');
  });
});
