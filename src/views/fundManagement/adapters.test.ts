import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as adapters from './adapters';
import {
  assetTypeToHoldingType,
  buildAssetCreatePayload,
  buildEntityFromPortfolio,
  buildFundFromPortfolio,
  buildFundLpHolders,
  buildOrphanAssetFund,
  computeFundExposure,
  computeFundHistory,
  filterEntityInvestors,
  flEntryToTxn,
  flPositionToHolding,
  flValuationToQuarter,
  fromDisplayMillionsToString,
  fromM,
  holdingTypeToAssetType,
  quarterEndLabel,
  quarterToValuationInput,
  toDisplayMillions,
  toM,
  trailingQuarterEnds,
  txnToLedgerEntryInput,
} from './adapters';
import type { Tables } from '@/lib/repositories';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger';
import type { HoldingType, Txn, Investor, FundExposure } from './types';
import { EntitySummaryTable } from './EntitySummaryTable';
import { TooltipProvider } from '@/components/ui/tooltip';

describe('assetTypeToHoldingType / holdingTypeToAssetType', () => {
  const cases: Array<[HoldingType, string, string | undefined]> = [
    ['Equity', 'direct_investment', 'equity'],
    ['Obligation', 'direct_investment', 'obligation'],
    ['Shares', 'direct_investment', 'shares'],
    ['Cash', 'cash', undefined],
    ['Fund of funds', 'fund_of_funds', undefined],
  ];

  it.each(cases)('round-trips %s <-> %s/%s', (tp, assetType, instrumentType) => {
    const backend = holdingTypeToAssetType(tp);
    expect(backend.assetType).toBe(assetType);
    expect(backend.instrumentType).toBe(instrumentType);
    expect(
      assetTypeToHoldingType(
        backend.assetType,
        backend.instrumentType ? { instrumentType: backend.instrumentType } : {},
      ),
    ).toBe(tp);
  });

  it('defaults an instrumentType-less direct_investment to Equity', () => {
    expect(assetTypeToHoldingType('direct_investment', {})).toBe('Equity');
    expect(assetTypeToHoldingType('direct_investment', null)).toBe('Equity');
  });
});

describe('buildAssetCreatePayload', () => {
  // Money (`kind: 'money'`) fields now hold a raw currency amount from
  // CurrencyInput; buildAssetCreatePayload converts them to the domain's
  // millions at the boundary (÷1e6). Non-money numeric fields are unchanged.
  it('maps Equity fields and converts the invested-capital figure to millions', () => {
    const payload = buildAssetCreatePayload('Equity', {
      name: 'Acme Robotics',
      sector: 'Robotics',
      geo: 'Singapore',
      dealType: 'Majority',
      dt: '2026-01-15',
      cost: '500000',
      entryEV: '40000000',
      revenue: '8000000',
      ebitda: '1200000',
    });
    expect(payload.input).toMatchObject({
      assetType: 'direct_investment',
      assetName: 'Acme Robotics',
      sector: 'Robotics',
      country: 'Singapore',
      entryDate: '2026-01-15',
    });
    expect(payload.input.typeDetails).toMatchObject({
      instrumentType: 'equity',
      dealType: 'Majority',
      entryEV: 40,
      revenue: 8,
      ebitda: 1.2,
    });
    // Raw $500,000 in → 0.5 (millions); the dialog multiplies back by 1e6.
    expect(payload.investedM).toBe(0.5);
    expect(payload.txnDate).toBe('2026-01-15');
    expect(payload.navM).toBeUndefined();
  });

  it('maps Direct Investments to a direct_investment (equity) with entity + source', () => {
    const payload = buildAssetCreatePayload('Direct Investments', {
      name: 'Acme Robotics',
      cost: '2000000',
      investingEntity: 'Startech Growth Fund 1',
      fundingSource: 'Retained earnings',
    });
    expect(payload.input).toMatchObject({
      assetType: 'direct_investment',
      assetName: 'Acme Robotics',
      fundingSource: 'Retained earnings',
    });
    expect(payload.input.typeDetails).toMatchObject({
      instrumentType: 'equity',
      investingEntity: 'Startech Growth Fund 1',
    });
    expect(payload.investedM).toBe(2);
  });

  it('falls back to "New holding" when no name field was entered', () => {
    const payload = buildAssetCreatePayload('Equity', {});
    expect(payload.input.assetName).toBe('New holding');
    expect(payload.investedM).toBeNull();
  });

  it('collects the optional english name for a direct investment', () => {
    const payload = buildAssetCreatePayload('Direct Investments', {
      name: '株式会社アクメ',
      englishName: 'Acme Robotics',
    });
    expect(payload.input.assetName).toBe('株式会社アクメ');
    expect(payload.input.englishName).toBe('Acme Robotics');
  });

  it('leaves the english name null when it was not entered', () => {
    expect(buildAssetCreatePayload('Direct Investments', { name: 'Acme' }).input.englishName).toBeNull();
    expect(buildAssetCreatePayload('Fund of funds', { targetFund: 'Meridian III' }).input.englishName).toBeNull();
  });

  it('collects the optional english name for a fund-of-funds position', () => {
    const payload = buildAssetCreatePayload('Fund of funds', {
      targetFund: 'メリディアン・グロース III',
      englishName: 'Meridian Growth Partners III',
    });
    expect(payload.input.assetName).toBe('メリディアン・グロース III');
    expect(payload.input.englishName).toBe('Meridian Growth Partners III');
  });

  it('maps Obligation fields to legal_name-as-issuer and maturity_date', () => {
    const payload = buildAssetCreatePayload('Obligation', {
      issuer: 'Acme Holdco',
      noteType: 'Bridge loan',
      principal: '1500000',
      coupon: '9',
      maturity: '2028-01-01',
    });
    expect(payload.input).toMatchObject({
      assetType: 'direct_investment',
      assetName: 'Acme Holdco',
      maturityDate: '2028-01-01',
    });
    expect(payload.input.typeDetails).toMatchObject({
      instrumentType: 'obligation',
      noteType: 'Bridge loan',
      coupon: 9,
      principal: 1.5,
    });
    expect(payload.investedM).toBe(1.5);
  });

  it('maps Fund of funds fields, converting commitment to raw dollars but leaving investedM/navM in millions', () => {
    const payload = buildAssetCreatePayload('Fund of funds', {
      targetFund: 'Meridian Growth Partners III',
      commit: '2000000',
      calledFoF: '1200000',
      nav: '1400000',
    });
    expect(payload.input).toMatchObject({
      assetType: 'fund_of_funds',
      assetName: 'Meridian Growth Partners III',
      commitmentAmount: 2_000_000,
    });
    expect(payload.input.typeDetails).toMatchObject({ targetFundName: 'Meridian Growth Partners III' });
    expect(payload.investedM).toBe(1.2);
    expect(payload.navM).toBe(1.4);
  });

  it('maps Cash and Shares fields', () => {
    const cash = buildAssetCreatePayload('Cash', { name: 'Reserve', institution: 'DBS', cost: '300000', yieldPct: '4' });
    expect(cash.input).toMatchObject({ assetType: 'cash', assetName: 'Reserve' });
    expect(cash.input.typeDetails).toMatchObject({ institution: 'DBS', yieldPct: 4 });
    expect(cash.investedM).toBe(0.3);

    const shares = buildAssetCreatePayload('Shares', {
      name: 'PublicCo',
      exchange: 'NASDAQ',
      ticker: 'PUBC',
      sharesK: '10',
      cost: '200000',
    });
    expect(shares.input).toMatchObject({ assetType: 'direct_investment', assetName: 'PublicCo' });
    expect(shares.input.typeDetails).toMatchObject({ instrumentType: 'shares', exchange: 'NASDAQ', ticker: 'PUBC', sharesOutstanding: 10 });
    expect(shares.investedM).toBe(0.2);
  });
});

describe('trailingQuarterEnds / quarterEndLabel', () => {
  it('returns the 4 trailing completed quarter-ends, oldest first, when "now" is mid-quarter', () => {
    // 2026-07-09 is in Q3'26 (Jul-Sep); the most recently *completed*
    // quarter is Q2'26 (ending 2026-06-30).
    const ends = trailingQuarterEnds(4, new Date(2026, 6, 9));
    expect(ends).toEqual(['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']);
  });

  it('steps back a full year across the Jan 1 boundary', () => {
    const ends = trailingQuarterEnds(4, new Date(2026, 0, 15)); // mid Q1'26
    expect(ends).toEqual(['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']);
  });

  it('includes the just-completed quarter when "now" is exactly on a quarter boundary', () => {
    const ends = trailingQuarterEnds(1, new Date(2026, 5, 30)); // exactly Q2'26's last day
    expect(ends).toEqual(['2026-06-30']);
  });

  it('formats an ISO date as a "Qn\'YY" label', () => {
    expect(quarterEndLabel('2026-06-30')).toBe("Q2'26");
    expect(quarterEndLabel('2025-12-31')).toBe("Q4'25");
    expect(quarterEndLabel('2025-01-01')).toBe("Q1'25");
  });
});

describe('computeFundHistory', () => {
  const quarterEnds = ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'];

  it('sums cumulative invested capital and latest-valuation-as-of across all assets, per quarter', () => {
    const perAsset = [
      {
        txns: [
          { entry_type: 'buy', entry_date: '2023-01-15', cash_delta: '-500000' },
          { entry_type: 'buy', entry_date: '2026-01-01', cash_delta: '-100000' },
        ],
        valuations: [
          { as_of_date: '2026-06-30', market_value: '700000' },
          { as_of_date: '2025-12-31', market_value: '600000' },
        ],
      },
      {
        txns: [{ entry_type: 'buy', entry_date: '2024-01-01', cash_delta: '-200000' }],
        valuations: [{ as_of_date: '2025-09-30', market_value: '210000' }],
      },
    ];

    const hist = computeFundHistory(perAsset as any, 10_000_000, quarterEnds);

    // Commitment: flat line at the fund's current commitment, in millions.
    expect(hist.committed).toEqual([10, 10, 10, 10]);

    // Invested (contributions with txn_date <= quarter end), in millions:
    expect(hist.called).toEqual([0.7, 0.7, 0.8, 0.8]);

    // Unrealized (latest valuation with as_of_date <= quarter end), in millions:
    expect(hist.fmv).toEqual([0.21, 0.81, 0.81, 0.91]);
  });

  it('returns a flat zero commitment line when the fund has no commitment set', () => {
    const hist = computeFundHistory([], null, quarterEnds);
    expect(hist.committed).toEqual([0, 0, 0, 0]);
    expect(hist.called).toEqual([0, 0, 0, 0]);
    expect(hist.fmv).toEqual([0, 0, 0, 0]);
  });

  it('keeps retained-sale cash (and its reversal) out of history FMV: only valuations move it', () => {
    const perAsset = [
      {
        txns: [
          { entry_type: 'buy', entry_date: '2025-01-01', cash_delta: '-1000000' },
          // Original retained divestment
          {
            entry_type: 'sell',
            entry_date: '2025-06-01',
            cash_delta: '600000',
            sub_type: 'divestment:cash_in_fund',
          },
          // Reversal of the retained divestment
          {
            entry_type: 'sell',
            entry_date: '2025-07-01',
            cash_delta: '-600000',
            sub_type: 'divestment:cash_in_fund',
          },
          // Repost as distributed divestment
          {
            entry_type: 'sell',
            entry_date: '2025-07-01',
            cash_delta: '600000',
            sub_type: null,
          },
        ],
        valuations: [
          { as_of_date: '2025-06-30', market_value: '500000' },
          { as_of_date: '2025-09-30', market_value: '500000' },
        ],
      },
    ];

    const hist = computeFundHistory(perAsset as any, 10_000_000, ['2025-06-30', '2025-09-30']);

    // Unrealized MV is holdings-only: the 600k of retained cash never appears in it.
    expect(hist.fmv[0]).toBe(0.5);
    expect(hist.fmv[1]).toBe(0.5);
  });

  it('correctly offsets invested capital history when a buy entry is reversed and reposted', () => {
    const perAsset = [
      {
        txns: [
          // Original buy 500k
          { entry_type: 'buy', entry_date: '2025-06-01', cash_delta: '-500000' },
          // Reversal of buy (+500k cash delta)
          { entry_type: 'buy', entry_date: '2025-07-01', cash_delta: '500000' },
          // Corrected buy 400k
          { entry_type: 'buy', entry_date: '2025-07-01', cash_delta: '-400000' },
        ],
        valuations: [],
      },
    ];

    const hist = computeFundHistory(perAsset as any, 10_000_000, ['2025-06-30', '2025-09-30']);

    // As of 2025-06-30: 500k called (0.5M)
    expect(hist.called[0]).toBe(0.5);

    // As of 2025-09-30: 500k - 500k + 400k = 400k called (0.4M), NOT 1.4M
    expect(hist.called[1]).toBe(0.4);
  });

  it('leaves retained FoF divestment cash out of historical FMV: it sums holding valuations only', () => {
    const perAsset = [
      {
        txns: [
          { entry_type: 'buy', entry_date: '2025-01-15', cash_delta: '-2000000' },
          {
            entry_type: 'distribution',
            entry_date: '2025-06-15',
            cash_delta: '500000',
            sub_type: 'divestment:cash_in_fund',
          },
        ],
        valuations: [
          { as_of_date: '2025-06-30', market_value: '1800000' },
          { as_of_date: '2025-09-30', market_value: '1800000' },
        ],
      },
      {
        txns: [
          { entry_type: 'buy', entry_date: '2025-01-15', cash_delta: '-1000000' },
          {
            entry_type: 'distribution',
            entry_date: '2025-09-01',
            cash_delta: '300000',
            sub_type: 'cash_in_fund',
          },
        ],
        valuations: [
          { as_of_date: '2025-06-30', market_value: '1000000' },
          { as_of_date: '2025-09-30', market_value: '800000' },
        ],
      },
    ];

    const hist = computeFundHistory(perAsset as any, 10_000_000, ['2025-06-30', '2025-09-30']);

    // As of 2025-06-30: Asset 1 (1.8M) + Asset 2 (1.0M) = 2.8M — the 0.5M retained cash is not FMV
    expect(hist.fmv[0]).toBe(2.8);

    // As of 2025-09-30: Asset 1 (1.8M) + Asset 2 (0.8M) = 2.6M
    expect(hist.fmv[1]).toBe(2.6);
  });
});

describe('flEntryToTxn', () => {
  it('maps buy entry to Buy Txn with positive scaled value and shares', () => {
    const txn = flEntryToTxn({
      id: 'e1',
      position_id: 'p1',
      business_event_id: 'bev1',
      entry_date: '2026-03-15',
      entry_type: 'buy',
      sub_type: null,
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '50000',
      cash_delta: '-500000',
      currency: 'USD',
      fx_rate: '1.25',
      price_per_unit: '10',
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Initial purchase',
      created_by: null,
      created_at: '2026-03-15T00:00:00Z',
      event: null,
      allocations: [
        {
          id: 'al1',
          ledger_entry_id: 'e1',
          funding_source_id: 'fs-1',
          amount: '500000',
          created_by: null,
          created_at: '',
        },
      ],
    });

    expect(txn.id).toBe('e1');
    expect(txn.type).toBe('Buy');
    expect(txn.value).toBe(0.5); // 500k / 1e6
    expect(txn.shares).toBe(0.05); // 50k / 1e6
    expect(txn.pps).toBe(10);
    expect(txn.ppsCurrency).toBe('USD');
    expect(txn.fx).toBe('1.25');
    expect(txn.notes).toBe('Initial purchase');
    expect(txn.fundingSourceId).toBe('fs-1');
    expect(txn.isGenerated).toBe(false);
  });

  it('maps sell entry to Sell Txn', () => {
    const txn = flEntryToTxn({
      id: 'e2',
      position_id: 'p1',
      business_event_id: null,
      entry_date: '2026-06-01',
      entry_type: 'sell',
      sub_type: null,
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '-20000',
      cash_delta: '400000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: '20',
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Partial divestment',
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
      event: null,
      allocations: [],
    });

    expect(txn.type).toBe('Sell');
    expect(txn.value).toBe(0.4);
    expect(txn.shares).toBe(0.02);
    expect(txn.pps).toBe(20);
  });

  it('maps income entry to Other Txn with Interest income label and handles reversals', () => {
    const txn = flEntryToTxn({
      id: 'e3',
      position_id: 'p1',
      business_event_id: null,
      entry_date: '2026-04-01',
      entry_type: 'income',
      sub_type: null,
      is_reversal: true,
      commitment_delta: '0',
      quantity_delta: '0',
      cash_delta: '15000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: null,
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: null,
      created_by: null,
      created_at: '2026-04-01T00:00:00Z',
      event: null,
      allocations: [],
    });

    expect(txn.type).toBe('Other');
    expect(txn.entryType).toBe('income');
    expect(txn.label).toBe('Interest income');
    expect(txn.isGenerated).toBe(false);
    expect(txn.isReversal).toBe(true);
    expect(txn.value).toBe(-0.015);
  });

  it('displays a paid-in adjustment without turning it into cash', () => {
    const txn = flEntryToTxn({
      id: 'e-adjustment', position_id: 'p1', business_event_id: 'bev-adjustment',
      entry_date: '2022-12-31', entry_type: 'adjustment', sub_type: 'paid_in_writeoff',
      is_reversal: false, commitment_delta: '0', quantity_delta: '0',
      valuation_delta: '-914781.37', cash_delta: '0', currency: 'CNY', fx_rate: null,
      price_per_unit: null, counterparty_position_id: null, data_status: 'verified',
      source_record_id: 'src-33', notes: '损益核销', created_by: null, created_at: '',
      event: null, allocations: [],
    });
    expect(txn.type).toBe('Other');
    expect(txn.value).toBeCloseTo(0.91478137);
    expect(txn.rawCashDelta).toBe('0');
    expect(txn.rawValuationDelta).toBe('0');
    expect(txn.rawPaidInAdjustmentDelta).toBe('-914781.37');
  });

  it('shows a zero-cash valuation adjustment using its valuation delta', () => {
    const txn = flEntryToTxn({
      id: 'e-adjustment', position_id: 'p1', business_event_id: 'bev-adjustment',
      entry_date: '2022-12-31', entry_type: 'adjustment', sub_type: 'profit_loss_writeoff',
      is_reversal: false, commitment_delta: '0', quantity_delta: '0',
      valuation_delta: '-914781.37', cash_delta: '0', currency: 'CNY', fx_rate: null,
      price_per_unit: null, counterparty_position_id: null, data_status: 'verified',
      source_record_id: 'src-33', notes: '损益核销', created_by: null, created_at: '',
      event: null, allocations: [],
    });

    expect(txn.type).toBe('Other');
    expect(txn.label).toBe('profit_loss_writeoff');
    expect(txn.value).toBeCloseTo(0.91478137);
    expect(txn.rawCashDelta).toBe('0');
    expect(txn.rawValuationDelta).toBe('-914781.37');
    expect(txn.rawValue).toBe('914781.37000000');
  });

  it('maps expense entry to Other Txn preserving signed rawCashDelta and magnitude value', () => {
    const expenseTxn = flEntryToTxn({
      id: 'e-actual-expense',
      position_id: 'p1',
      business_event_id: 'bev-expense',
      entry_date: '2024-02-01',
      entry_type: 'expense',
      sub_type: 'Expenses',
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '0',
      valuation_delta: '0',
      cash_delta: '-5000000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: null,
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: 'src-exp',
      notes: 'Audit and legal expenses',
      created_by: null,
      created_at: '',
      event: null,
      allocations: [],
    });

    expect(expenseTxn.type).toBe('Other');
    expect(expenseTxn.entryType).toBe('expense');
    expect(expenseTxn.label).toBe('Expenses');
    expect(expenseTxn.value).toBe(5); // magnitude preserved
    expect(expenseTxn.rawCashDelta).toBe('-5000000'); // signed raw cash delta preserved
  });

  it('preserves position identity and every funding allocation', () => {
    const txn = flEntryToTxn({
      id: 'e-multi', position_id: 'position-exact', business_event_id: 'event-1',
      entry_date: '2026-04-01', entry_type: 'buy', sub_type: null,
      is_reversal: false, commitment_delta: '0', quantity_delta: '0',
      cash_delta: '-600', currency: 'USD', fx_rate: null, price_per_unit: null,
      counterparty_position_id: null, data_status: 'verified', source_record_id: null,
      notes: null, created_by: null, created_at: '', event: null,
      allocations: [
        { id: 'a1', ledger_entry_id: 'e-multi', funding_source_id: 'fs-1', amount: '100', created_by: null, created_at: '' },
        { id: 'a2', ledger_entry_id: 'e-multi', funding_source_id: 'fs-2', amount: '200', created_by: null, created_at: '' },
        { id: 'a3', ledger_entry_id: 'e-multi', funding_source_id: 'fs-3', amount: '300', created_by: null, created_at: '' },
      ],
    });

    expect(txn.positionId).toBe('position-exact');
    expect(txn.allocations).toEqual([
      { fundingSourceId: 'fs-1', amount: '100' },
      { fundingSourceId: 'fs-2', amount: '200' },
      { fundingSourceId: 'fs-3', amount: '300' },
    ]);
  });

  it('maps paid_in, distribution, and redemption correctly without collapsing to Other', () => {
    const paidInTxn = flEntryToTxn({
      id: 'e-fof-1',
      position_id: 'p-fof-1',
      business_event_id: null,
      entry_date: '2026-02-01',
      entry_type: 'paid_in',
      sub_type: 'capital_call',
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '0',
      cash_delta: '-1000000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: null,
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Quarterly capital call',
      created_by: null,
      created_at: '2026-02-01T00:00:00Z',
      event: null,
      allocations: [],
    });
    expect(paidInTxn.type).toBe('Buy');
    expect(paidInTxn.entryType).toBe('paid_in');
    expect(paidInTxn.value).toBe(1);

    const distTxn = flEntryToTxn({
      id: 'e-fof-2',
      position_id: 'p-fof-1',
      business_event_id: null,
      entry_date: '2026-07-01',
      entry_type: 'distribution',
      sub_type: 'dividend',
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '0',
      cash_delta: '300000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: null,
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Dividend payout',
      created_by: null,
      created_at: '2026-07-01T00:00:00Z',
      event: null,
      allocations: [],
    });
    expect(distTxn.type).toBe('Sell');
    expect(distTxn.entryType).toBe('distribution');
    expect(distTxn.value).toBe(0.3);

    const redTxn = flEntryToTxn({
      id: 'e-fof-3',
      position_id: 'p-fof-1',
      business_event_id: null,
      entry_date: '2026-09-01',
      entry_type: 'redemption',
      sub_type: null,
      is_reversal: false,
      commitment_delta: '0',
      quantity_delta: '-500',
      cash_delta: '500000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: '1000',
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: null,
      created_by: null,
      created_at: '2026-09-01T00:00:00Z',
      event: null,
      allocations: [],
    });
    expect(redTxn.type).toBe('Sell');
    expect(redTxn.entryType).toBe('redemption');
    expect(redTxn.value).toBe(0.5);
  });
});

describe('flValuationToQuarter', () => {
  it('maps an fl_valuations record to Quarter domain model', () => {
    const quarter = flValuationToQuarter({
      id: 'v1',
      asset_id: 'a1',
      fund_id: null,
      position_id: null,
      as_of_date: '2026-06-30',
      valuation_method: 'comparables',
      currency: 'USD',
      market_value: '2500000',
      gross_value: '1500000',
      net_value: '2500000',
      price_per_unit: '25',
      units_outstanding: '100000',
      data_status: 'verified',
      source_record_id: null,
      notes: 'Mid-year mark',
      created_by: null,
      updated_by: null,
      created_at: '2026-06-30T00:00:00Z',
      updated_at: '2026-06-30T00:00:00Z',
    });

    expect(quarter.id).toBe('v1');
    expect(quarter.asOfDate).toBe('2026-06-30');
    expect(quarter.q).toBe("Q2'26");
    expect(quarter.mv).toBe(2.5);
    expect(quarter.cost).toBe(1.5);
    expect(quarter.pps).toBe(25);
    expect(quarter.sharesOut).toBe(0.1);
    expect(quarter.ppsCurrency).toBe('USD');
    expect(quarter.notes).toBe('Mid-year mark');
  });

  it('extracts structured source_meta (stake, moic, xirr, period) and cleans user notes', () => {
    const quarter = flValuationToQuarter({
      id: 'v2',
      asset_id: 'a1',
      fund_id: null,
      position_id: null,
      as_of_date: '2026-03-31',
      valuation_method: 'other',
      currency: 'USD',
      market_value: '5000000',
      gross_value: null,
      net_value: '5000000',
      price_per_unit: null,
      units_outstanding: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Audited quarterly mark | source_meta: {"period_label":"Q1 2026","shareholding_pct":12.5,"gross_moic":2.5,"gross_xirr":0.28}',
      created_by: null,
      updated_by: null,
      created_at: '2026-03-31T00:00:00Z',
      updated_at: '2026-03-31T00:00:00Z',
    });

    expect(quarter.q).toBe('Q1 2026');
    expect(quarter.shPct).toBe(12.5);
    expect(quarter.moic).toBe(2.5);
    expect(quarter.xirr).toBe(0.28);
    expect(quarter.notes).toBe('Audited quarterly mark');
  });

  it('preserves the complete note when source_meta is not valid JSON', () => {
    const quarter = flValuationToQuarter({
      id: 'v-bad-meta', asset_id: 'a1', fund_id: null, position_id: null,
      as_of_date: '2026-03-31', valuation_method: 'other', currency: 'USD',
      market_value: '1', gross_value: null, net_value: null, price_per_unit: null,
      units_outstanding: null, data_status: 'verified', source_record_id: null,
      notes: 'User wrote source_meta: not-json and more text', created_by: null,
      updated_by: null, created_at: '2026-03-31T00:00:00Z', updated_at: '2026-03-31T00:00:00Z',
    });
    expect(quarter.notes).toBe('User wrote source_meta: not-json and more text');
    expect(quarter.shPct).toBeNull();
  });
});

describe('V2 flPositionToHolding and buildFundFromPortfolio', () => {
  it('maps an equity position with ledger entries and valuations to a Holding', () => {
    const pos = {
      id: 'p1',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: null,
      asset_id: 'a1',
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      current_value: '600000',
      valuation_method: 'comparables',
      balance: {
        position_id: 'p1',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '50000',
        contributed_capital: '500000',
        distributed_capital: '50000',
        cash_balance: '-450000',
        net_invested: '450000',
        current_value: '600000',
        committed: '0',
        contributed: '500000',
        unfunded: '0',
        cash_total: '-450000',
        distributed: '50000',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a1',
        workspace_id: 'w1',
        name: 'Tech Co',
        canonical_name: 'tech co',
        legal_name: 'Tech Co LLC',
        english_name: 'Tech Co English',
        asset_kind: 'equity' as const,
        country: 'USA',
        sector: 'Tech',
        sub_sector: null,
        instrument_terms: {
          investmentCurrency: 'USD',
          reportCurrency: 'USD',
          stakePct: 15,
          legacy: { investmentType: 'Direct Investment', keyRights: 'Board seat' },
        },
        description: 'Tech portfolio investment',
        created_by: null,
        updated_by: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
      funding_source: null,
    };

    const entries = [
      {
        id: 'e1',
        position_id: 'p1',
        business_event_id: 'ev1',
        entry_date: '2025-01-15',
        entry_type: 'buy' as const,
        sub_type: null,
        is_reversal: false,
        commitment_delta: '0',
        quantity_delta: '50000',
        cash_delta: '-500000',
        currency: 'USD',
        fx_rate: null,
        price_per_unit: '10',
        counterparty_position_id: null,
        data_status: 'verified' as const,
        source_record_id: null,
        notes: 'Initial buy',
        created_by: null,
        created_at: '2025-01-15T00:00:00Z',
        event: null,
        allocations: [{ id: 'al1', ledger_entry_id: 'e1', funding_source_id: 'fs1', amount: '500000', created_by: null, created_at: '' }],
      },
    ];

    const valuations = [
      {
        id: 'v1',
        asset_id: 'a1',
        fund_id: null,
        position_id: null,
        as_of_date: '2025-06-30',
        valuation_method: 'comparables' as const,
        currency: 'USD',
        market_value: '600000',
        price_per_unit: '12',
        units_outstanding: '50000',
        gross_value: '500000',
        net_value: '600000',
        data_status: 'verified' as const,
        source_record_id: null,
        notes: 'Q2 mark',
        created_by: null,
        updated_by: null,
        created_at: '2025-06-30T00:00:00Z',
        updated_at: '2025-06-30T00:00:00Z',
      },
    ];

    const holding = flPositionToHolding(pos, entries, valuations);
    expect(holding.id).toBe('a1');
    expect(holding.n).toBe('Tech Co');
    expect(holding.englishName).toBe('Tech Co English');
    expect(holding.tp).toBe('Equity');
    expect(holding.cost).toBe(0.5); // 500k / 1e6
    expect(holding.fmv).toBe(0.6); // 600k / 1e6
    expect(holding.real).toBe(0.05); // 50k / 1e6
    expect(holding.inv?.txns).toHaveLength(1);
    expect(holding.inv?.txns[0].type).toBe('Buy');
    expect(holding.inv?.txns[0].value).toBe(0.5);
    expect(holding.inv?.txns[0].shares).toBe(0.05);
    expect(holding.inv?.quarterly).toHaveLength(1);
    expect(holding.inv?.quarterly[0].mv).toBe(0.6);
  });

  it('maps loan, listed security, cash, fund of funds, and closed statuses in flPositionToHolding', () => {
    const loanPos = {
      id: 'p-loan',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: null,
      asset_id: 'a-loan',
      holder_source_of_fund_id: null,
      status: 'closed' as const,
      opened_at: '2024-01-01',
      closed_at: '2025-01-01',
      notes: null,
      created_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      current_value: '0',
      valuation_method: null,
      balance: null,
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a-loan',
        workspace_id: 'w1',
        name: 'Bridge Note',
        canonical_name: 'bridge note',
        legal_name: 'Bridge Note LLC',
        english_name: null,
        asset_kind: 'loan' as const,
        country: 'USA',
        sector: null,
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      funding_source: null,
    };
    const loanHolding = flPositionToHolding(loanPos, [], []);
    expect(loanHolding.tp).toBe('Obligation');
    expect(loanHolding.st).toBe('Exited');

    const sharesPos = {
      ...loanPos,
      id: 'p-shares',
      status: 'open' as const,
      asset: { ...loanPos.asset, asset_kind: 'listed_security' as const },
    };
    expect(flPositionToHolding(sharesPos, [], []).tp).toBe('Shares');

    const cashPos = {
      ...loanPos,
      id: 'p-cash',
      status: 'open' as const,
      asset: { ...loanPos.asset, asset_kind: 'cash' as const },
    };
    expect(flPositionToHolding(cashPos, [], []).tp).toBe('Cash');

    const fofPos = {
      id: 'p-fof',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: 'target-f1',
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      current_value: '1000000',
      valuation_method: null,
      balance: null,
      holder_investor: null,
      holder_fund: null,
      fund: {
        id: 'target-f1',
        workspace_id: 'w1',
        name: 'Target Fund I',
        canonical_name: 'target fund i',
        legal_name: 'Target Fund I LP',
        english_name: null,
        registration_no: null,
        managed: false,
        ownership_basis: 'commitment' as const,
        base_currency: 'USD',
        vintage_year: 2023,
        fund_life_years: 10,
        status: 'investing' as const,
        mgmt_fee_rate: '0.02',
        carry_rate: '0.20',
        preferred_return_rate: '0.08',
        description: 'External venture fund',
        created_by: null,
        updated_by: null,
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      },
      asset: null,
      funding_source: null,
    };
    const fofHolding = flPositionToHolding(fofPos, [], []);
    expect(fofHolding.tp).toBe('Fund of funds');
    const assetFof = flPositionToHolding({
      ...loanPos,
      asset: { ...loanPos.asset, asset_kind: 'equity', instrument_terms: { investmentTypeLabel: 'Fund of Funds' } },
    }, [], []);
    expect(assetFof.tp).toBe('Fund of funds');
    expect(assetFof.targetKind).toBe('asset');
    expect(fofHolding.targetKind).toBe('fund');

    expect(fofHolding.n).toBe('Target Fund I');
    expect(fofHolding.inv?.mgmtFeeRate).toBe(2);
    expect(fofHolding.inv?.carryRate).toBe(20);
  });

  it('populates fundingSourceId from FlPortfolioPosition in flPositionToHolding', () => {
    const pos = {
      id: 'p2',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: null,
      asset_id: 'a2',
      holder_source_of_fund_id: 'fs-888',
      status: 'open' as const,
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      current_value: '100000',
      valuation_method: 'at_cost',
      balance: {
        position_id: 'p2',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '10000',
        contributed_capital: '100000',
        distributed_capital: '0',
        cash_balance: '-100000',
        net_invested: '100000',
        current_value: '100000',
        committed: '0',
        contributed: '100000',
        unfunded: '0',
        cash_total: '-100000',
        distributed: '0',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a2',
        workspace_id: 'w1',
        name: 'Funded Co',
        canonical_name: 'funded co',
        legal_name: 'Funded Co LLC',
        english_name: null,
        asset_kind: 'equity' as const,
        country: 'USA',
        sector: 'Tech',
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
      funding_source: {
        id: 'fs-888',
        workspace_id: 'w1',
        name: 'Credit Facility A',
        canonical_name: 'credit facility a',
        source_type: 'credit_facility',
        owner_investor_id: null,
        currency: 'USD',
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    };

    const holding = flPositionToHolding(pos, [], []);
    expect(holding.fundingSourceId).toBe('fs-888');
    expect(holding.d?.fundingSource).toBe('Credit Facility A');
    expect(holding.d?.fundingSourceId).toBe('fs-888');
    expect(holding.inv?.fundingSource).toBe('Credit Facility A');
    expect(holding.inv?.fundingSourceId).toBe('fs-888');
  });

  it('buildFundFromPortfolio rolls up fund metrics from positions and entries', () => {
    const fundRow = {
      id: 'f1',
      workspace_id: 'w1',
      name: 'Growth Fund I',
      canonical_name: 'growth fund i',
      legal_name: 'Growth Fund I LP',
      english_name: null,
      registration_no: null,
      managed: true,
      ownership_basis: 'commitment' as const,
      base_currency: 'USD',
      vintage_year: 2024,
      fund_life_years: 10,
      status: 'investing' as const,
      mgmt_fee_rate: '0.02',
      carry_rate: '0.20',
      preferred_return_rate: '0.08',
      description: 'Primary fund',
      created_by: null,
      updated_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const lpPos = {
      id: 'lp1',
      workspace_id: 'w1',
      holder_investor_id: 'inv1',
      holder_fund_id: null,
      fund_id: 'f1',
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      current_value: '0',
      valuation_method: null,
      balance: {
        position_id: 'lp1',
        currency: 'USD',
        commitment: '10000000',
        drawn_commitment: '2000000',
        quantity: '0',
        contributed_capital: '0',
        distributed_capital: '0',
        cash_balance: '-2000000',
        net_invested: '2000000',
        current_value: '0',
        committed: '10000000',
        contributed: '0',
        unfunded: '8000000',
        cash_total: '-2000000',
        distributed: '0',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: null,
      funding_source: null,
    };

    const portPos = {
      id: 'p1',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: null,
      asset_id: 'a1',
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-06-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-06-01T00:00:00Z',
      updated_at: '2024-06-01T00:00:00Z',
      current_value: '3000000',
      valuation_method: 'comparables',
      balance: {
        position_id: 'p1',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '100000',
        contributed_capital: '2000000',
        distributed_capital: '500000',
        cash_balance: '-1500000',
        net_invested: '1500000',
        current_value: '3000000',
        committed: '0',
        contributed: '2000000',
        unfunded: '0',
        cash_total: '-1500000',
        distributed: '500000',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a1',
        workspace_id: 'w1',
        name: 'Asset Alpha',
        canonical_name: 'asset alpha',
        legal_name: 'Asset Alpha LLC',
        english_name: null,
        asset_kind: 'equity' as const,
        country: 'US',
        sector: 'Healthcare',
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2024-06-01T00:00:00Z',
        updated_at: '2024-06-01T00:00:00Z',
      },
      funding_source: null,
    };

    const fund = buildFundFromPortfolio(fundRow, [lpPos, portPos], [], []);
    expect(fund.id).toBe('f1');
    expect(fund.size).toBe(10); // 10M
    expect(fund.called).toBe(2); // 2M
    expect(fund.calledPct).toBe(20);
    expect(fund.fmv).toBe(3); // 3M
    expect(fund.real).toBe(0.5); // 0.5M
    expect(fund.tvpi).toBe(1.75); // (3M + 0.5M) / 2M
    expect(fund.dpi).toBe(0.25); // 0.5M / 2M
    expect(fund.valuationCoverage).toBe('complete');
    expect(fund.h).toHaveLength(1);
    expect(fund.h[0].n).toBe('Asset Alpha');
  });

  it('treats valuation_method === null as unavailable valuation in flPositionToHolding', () => {
    const unvaluedPos = {
      id: 'p-unvalued',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f1',
      fund_id: null,
      asset_id: 'a-unvalued',
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-06-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-06-01T00:00:00Z',
      updated_at: '2024-06-01T00:00:00Z',
      current_value: '0',
      valuation_method: null,
      balance: {
        position_id: 'p-unvalued',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '100',
        contributed_capital: '1000000',
        distributed_capital: '200000',
        cash_balance: '-800000',
        net_invested: '800000',
        current_value: '0',
        committed: '0',
        contributed: '1000000',
        unfunded: '0',
        cash_total: '-800000',
        distributed: '200000',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a-unvalued',
        workspace_id: 'w1',
        name: 'Unvalued Seed Co',
        canonical_name: 'unvalued seed co',
        legal_name: 'Unvalued Seed Co Inc',
        english_name: null,
        asset_kind: 'equity' as const,
        country: 'US',
        sector: 'Tech',
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2024-06-01T00:00:00Z',
        updated_at: '2024-06-01T00:00:00Z',
      },
      funding_source: null,
    };

    const holding = flPositionToHolding(unvaluedPos, [], []);
    expect(holding.cost).toBe(1); // 1M
    expect(holding.fmv).toBeNull();
    expect(holding.real).toBe(0.2); // 0.2M
    expect(holding.moic).toBeNull();
    expect(holding.valuationMethod).toBeNull();
    expect(holding.valuationCoverage).toBe('partial');
  });

  it('marks fund valuationCoverage as partial and makes tvpi null when holdings lack valuation while dpi remains computable', () => {
    const fundRow = {
      id: 'f-mixed',
      workspace_id: 'w1',
      name: 'Mixed Fund',
      canonical_name: 'mixed fund',
      legal_name: null,
      english_name: null,
      registration_no: null,
      managed: true,
      ownership_basis: 'commitment' as const,
      base_currency: 'USD',
      vintage_year: 2024,
      fund_life_years: 10,
      status: 'investing' as const,
      mgmt_fee_rate: null,
      carry_rate: null,
      preferred_return_rate: null,
      description: null,
      created_by: null,
      updated_by: null,
      created_at: '',
      updated_at: '',
    };

    const lpPos = {
      id: 'lp-m',
      workspace_id: 'w1',
      holder_investor_id: 'inv1',
      holder_fund_id: null,
      fund_id: 'f-mixed',
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '0',
      valuation_method: null,
      balance: {
        position_id: 'lp-m',
        currency: 'USD',
        commitment: '10000000',
        drawn_commitment: '5000000',
        quantity: '0',
        contributed_capital: '0',
        distributed_capital: '0',
        cash_balance: '-5000000',
        net_invested: '5000000',
        current_value: '0',
        committed: '10000000',
        contributed: '0',
        unfunded: '5000000',
        cash_total: '-5000000',
        distributed: '0',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: null,
      funding_source: null,
    };

    const valuedPos = {
      id: 'p-val',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f-mixed',
      fund_id: null,
      asset_id: 'a-val',
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '4000000',
      valuation_method: 'comparables',
      balance: {
        position_id: 'p-val',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '100',
        contributed_capital: '2000000',
        distributed_capital: '1000000',
        cash_balance: '-1000000',
        net_invested: '1000000',
        current_value: '4000000',
        committed: '0',
        contributed: '2000000',
        unfunded: '0',
        cash_total: '-1000000',
        distributed: '1000000',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a-val',
        workspace_id: 'w1',
        name: 'Valued Asset',
        canonical_name: 'valued asset',
        legal_name: 'Valued Asset LLC',
        english_name: null,
        asset_kind: 'equity' as const,
        country: 'US',
        sector: 'Health',
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      },
      funding_source: null,
    };

    const unvaluedPos = {
      id: 'p-unval',
      workspace_id: 'w1',
      holder_investor_id: null,
      holder_fund_id: 'f-mixed',
      fund_id: null,
      asset_id: 'a-unval',
      holder_source_of_fund_id: null,
      status: 'open' as const,
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '0',
      valuation_method: null,
      balance: {
        position_id: 'p-unval',
        currency: 'USD',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '100',
        contributed_capital: '3000000',
        distributed_capital: '500000',
        cash_balance: '-2500000',
        net_invested: '2500000',
        current_value: '0',
        committed: '0',
        contributed: '3000000',
        unfunded: '0',
        cash_total: '-2500000',
        distributed: '500000',
      },
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'a-unval',
        workspace_id: 'w1',
        name: 'Unvalued Asset',
        canonical_name: 'unvalued asset',
        legal_name: 'Unvalued Asset LLC',
        english_name: null,
        asset_kind: 'equity' as const,
        country: 'US',
        sector: 'Tech',
        sub_sector: null,
        instrument_terms: {},
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      },
      funding_source: null,
    };

    const fund = buildFundFromPortfolio(fundRow, [lpPos, valuedPos, unvaluedPos], [], []);
    expect(fund.valuationCoverage).toBe('partial');
    expect(fund.called).toBe(5); // 5M
    expect(fund.fmv).toBe(4); // 4M (sum of available valued holdings)
    expect(fund.real).toBe(1.5); // 1M + 0.5M = 1.5M
    expect(fund.tvpi).toBeNull(); // TVPI is unavailable when valuation coverage is partial
    expect(fund.dpi).toBe(0.3); // 1.5M / 5M = 0.3 (DPI remains computable)
  });

  it('maps harvesting and liquidated fund statuses in buildFundFromPortfolio', () => {
    const harvestingFund = buildFundFromPortfolio(
      {
        id: 'f-harv',
        workspace_id: 'w1',
        name: 'Harv Fund',
        canonical_name: 'harv fund',
        legal_name: null,
        english_name: null,
        registration_no: null,
        managed: true,
        ownership_basis: 'commitment',
        base_currency: 'USD',
        vintage_year: null,
        fund_life_years: null,
        status: 'harvesting',
        mgmt_fee_rate: null,
        carry_rate: null,
        preferred_return_rate: null,
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      },
      [],
      [],
      [],
    );
    expect(harvestingFund.st).toBe('Harvesting');

    const liquidatedFund = buildFundFromPortfolio(
      {
        id: 'f-liq',
        workspace_id: 'w1',
        name: 'Liq Fund',
        canonical_name: 'liq fund',
        legal_name: null,
        english_name: null,
        registration_no: null,
        managed: true,
        ownership_basis: 'commitment',
        base_currency: 'USD',
        vintage_year: null,
        fund_life_years: null,
        status: 'liquidated',
        mgmt_fee_rate: null,
        carry_rate: null,
        preferred_return_rate: null,
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      },
      [],
      [],
      [],
    );
    expect(liquidatedFund.st).toBe('Liquidated');
  });

  describe('txnToLedgerEntryInput and quarterToValuationInput', () => {
    it('converts a buy Txn to LedgerEntryInput with negative cash and positive qty', () => {
      const input = txnToLedgerEntryInput(
        {
          date: '2026-03-01',
          type: 'Buy',
          value: 1.5, // 1.5M = 1,500,000
          shares: 0.1, // 0.1M = 100,000
          pps: 15,
          ppsCurrency: 'USD',
          fundingSourceId: 'fs-1',
          notes: 'Series B',
        },
        'pos-1',
      );

      expect(input.position_id).toBe('pos-1');
      expect(input.entry_type).toBe('buy');
      expect(input.cash_delta).toBe('-1500000');
      expect(input.quantity_delta).toBe('100000');
      expect(input.currency).toBe('USD');
      expect(input.price_per_unit).toBe('15');
      expect(input.allocations).toEqual([{ funding_source_id: 'fs-1', amount: '1500000' }]);
    });

    it('converts a sell Txn to LedgerEntryInput with positive cash and negative qty', () => {
      const input = txnToLedgerEntryInput(
        {
          date: '2026-06-01',
          type: 'Sell',
          value: 2.0, // 2M
          shares: 0.05, // 50k
          pps: 40,
        },
        'pos-1',
      );

      expect(input.entry_type).toBe('sell');
      expect(input.cash_delta).toBe('2000000');
      expect(input.quantity_delta).toBe('-50000');
    });

    it('converts a value-only buy without manufacturing quantity', () => {
      const input = txnToLedgerEntryInput(
        { date: '2026-03-01', type: 'Buy', value: 1.5, shares: null },
        'position-value-only',
      );
      expect(input.cash_delta).toBe('-1500000');
      expect(input.quantity_delta).toBe('0');
    });

    it('converts a sell Txn with cash_in_fund to LedgerEntryInput with sub_type divestment:cash_in_fund', () => {
      const input = txnToLedgerEntryInput(
        {
          date: '2026-06-01',
          type: 'Sell',
          value: 2.0, // 2M
          shares: 0.05, // 50k
          pps: 40,
          sellProceedsDestination: 'cash_in_fund',
        },
        'pos-1',
      );

      expect(input.entry_type).toBe('sell');
      expect(input.sub_type).toBe('divestment:cash_in_fund');
      expect(input.cash_delta).toBe('2000000');
      expect(input.quantity_delta).toBe('-50000');
    });

    it('converts a sell Txn with distributed_to_investor to LedgerEntryInput with sub_type divestment:distributed_to_investor', () => {
      const input = txnToLedgerEntryInput(
        {
          date: '2026-06-01',
          type: 'Sell',
          value: 2.0,
          shares: 0.05,
          pps: 40,
          sellProceedsDestination: 'distributed_to_investor',
        },
        'pos-1',
      );

      expect(input.entry_type).toBe('sell');
      expect(input.sub_type).toBe('divestment:distributed_to_investor');
    });

    it('converts flEntryToTxn with divestment:cash_in_fund to sellProceedsDestination cash_in_fund', () => {
      const txn = flEntryToTxn({
        id: 'e1',
        entry_date: '2026-06-01',
        entry_type: 'sell',
        sub_type: 'divestment:cash_in_fund',
        cash_delta: '2000000',
        quantity_delta: '-50000',
        price_per_unit: '40',
        currency: 'USD',
        position_id: 'p1',
      } as never);

      expect(txn.type).toBe('Sell');
      expect(txn.sellProceedsDestination).toBe('cash_in_fund');
      expect(txn.value).toBe(2);
      expect(txn.shares).toBe(0.05);
    });

    it('converts flEntryToTxn without explicit treatment to sellProceedsDestination null (plain Sell)', () => {
      const txn = flEntryToTxn({
        id: 'e2',
        entry_date: '2026-06-01',
        entry_type: 'sell',
        sub_type: null,
        cash_delta: '2000000',
        quantity_delta: '-50000',
        price_per_unit: '40',
        currency: 'USD',
        position_id: 'p1',
      } as never);

      expect(txn.type).toBe('Sell');
      expect(txn.sellProceedsDestination).toBeNull();
    });

    it('converts flEntryToTxn with distributed_to_investor to sellProceedsDestination distributed_to_investor', () => {
      const txn = flEntryToTxn({
        id: 'e2',
        entry_date: '2026-06-01',
        entry_type: 'sell',
        sub_type: 'divestment:distributed_to_investor',
        cash_delta: '2000000',
        quantity_delta: '-50000',
        price_per_unit: '40',
        currency: 'USD',
        position_id: 'p1',
      } as never);

      expect(txn.type).toBe('Sell');
      expect(txn.sellProceedsDestination).toBe('distributed_to_investor');
    });

    it('buildFundFromPortfolio keeps retained sell proceeds out of fmv and real/dpi but counts them in TVPI', () => {
      const fundRow = {
        id: 'f-retained',
        workspace_id: 'w1',
        name: 'Retained Fund',
        canonical_name: 'retained fund',
        legal_name: null,
        english_name: null,
        registration_no: null,
        managed: true,
        ownership_basis: 'commitment' as const,
        base_currency: 'USD',
        vintage_year: 2024,
        fund_life_years: 10,
        status: 'investing' as const,
        mgmt_fee_rate: null,
        carry_rate: null,
        preferred_return_rate: null,
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      };

      const lpPos = {
        id: 'lp-1',
        workspace_id: 'w1',
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        fund_id: 'f-retained',
        asset_id: null,
        holder_source_of_fund_id: null,
        status: 'open' as const,
        opened_at: '2024-01-01',
        closed_at: null,
        notes: null,
        created_by: null,
        created_at: '',
        updated_at: '',
        current_value: '0',
        valuation_method: null,
        balance: {
          position_id: 'lp-1',
          currency: 'USD',
          commitment: '10000000', // 10M
          drawn_commitment: '5000000', // 5M called
          quantity: '0',
          contributed_capital: '0',
          distributed_capital: '0',
          cash_balance: '-5000000',
          net_invested: '5000000',
          current_value: '0',
          committed: '10000000',
          contributed: '0',
          unfunded: '5000000',
          cash_total: '-5000000',
          distributed: '0',
          retained_proceeds: '0',
        },
        holder_investor: null,
        holder_fund: null,
        fund: null,
        asset: null,
        funding_source: null,
      };

      const portPos = {
        id: 'p-ret',
        workspace_id: 'w1',
        holder_investor_id: null,
        holder_fund_id: 'f-retained',
        fund_id: null,
        asset_id: 'a-1',
        holder_source_of_fund_id: null,
        status: 'open' as const,
        opened_at: '2024-01-01',
        closed_at: null,
        notes: null,
        created_by: null,
        created_at: '',
        updated_at: '',
        current_value: '3000000', // 3M remaining FMV
        valuation_method: 'comparables',
        balance: {
          position_id: 'p-ret',
          currency: 'USD',
          commitment: '0',
          drawn_commitment: '0',
          quantity: '50',
          contributed_capital: '5000000',
          distributed_capital: '0', // retained proceeds are excluded from distributions
          cash_balance: '-3000000',
          net_invested: '3000000',
          current_value: '3000000',
          committed: '0',
          contributed: '5000000',
          unfunded: '0',
          cash_total: '-3000000',
          distributed: '0',
          retained_proceeds: '2000000', // 2M retained in fund (cash_in_fund)
        },
        holder_investor: null,
        holder_fund: null,
        fund: null,
        asset: {
          id: 'a-1',
          workspace_id: 'w1',
          name: 'Growth Asset',
          canonical_name: 'growth asset',
          legal_name: 'Growth Asset LLC',
          english_name: null,
          asset_kind: 'equity' as const,
          country: 'US',
          sector: 'Tech',
          sub_sector: null,
          instrument_terms: {},
          description: null,
          created_by: null,
          updated_by: null,
          created_at: '',
          updated_at: '',
        },
          funding_source: null,
      };

      const cashPos = {
        id: 'p-cash',
        workspace_id: 'w1',
        holder_investor_id: null,
        holder_fund_id: 'f-retained',
        fund_id: null,
        asset_id: 'a-cash',
        holder_source_of_fund_id: null,
        status: 'open' as const,
        opened_at: '2024-01-01',
        closed_at: null,
        notes: null,
        created_by: null,
        created_at: '',
        updated_at: '',
        current_value: '2000000',
        valuation_method: 'cash_par',
        balance: {
          position_id: 'p-cash',
          currency: 'USD',
          commitment: '0',
          drawn_commitment: '0',
          quantity: '0',
          contributed_capital: '0',
          distributed_capital: '0',
          cash_balance: '2000000',
          net_invested: '0',
          current_value: '2000000',
          committed: '0',
          contributed: '0',
          unfunded: '0',
          cash_total: '2000000',
          distributed: '0',
          retained_proceeds: '0',
          asset_kind: 'cash',
        },
        holder_investor: null,
        holder_fund: null,
        fund: null,
        asset: {
          id: 'a-cash',
          workspace_id: 'w1',
          name: 'USD Cash',
          canonical_name: 'usd cash',
          legal_name: null,
          english_name: null,
          registration_no: null,
          asset_kind: 'cash' as const,
          country: 'US',
          sector: 'Cash',
          sub_sector: null,
          instrument_terms: { currency: 'USD' },
          description: null,
          created_by: null,
          updated_by: null,
          created_at: '',
          updated_at: '',
        },
        funding_source: null,
      };

      const fund = buildFundFromPortfolio(fundRow, [lpPos, portPos, cashPos as any], [], []);
      expect(fund.called).toBe(5); // 5M
      expect(fund.fmv).toBe(3); // Unrealized MV = 3M remaining holdings; the 2M cash is not FMV
      expect(fund.rawNav).toBe('5000000.00000000'); // NAV = 3M holdings + 2M cash
      expect(fund.real).toBe(0); // 0M distributed to LPs
      expect(fund.dpi).toBe(0); // 0 / 5 = 0.00x
      expect(fund.tvpi).toBe(1); // TVPI unchanged: (3M holdings + 2M cash + 0M) / 5M = 1.00x
    });

    it('converts an income/other Txn to LedgerEntryInput', () => {
      const input = txnToLedgerEntryInput(
        {
          date: '2026-06-01',
          type: 'Other',
          label: 'Interest income',
          value: 0.05, // 50k
        },
        'pos-1',
      );

      expect(input.entry_type).toBe('income');
      expect(input.cash_delta).toBe('50000');
      expect(input.quantity_delta).toBe('0');
      expect(input.sub_type).toBe('Interest income');
    });

    it('converts a Quarter to RecordValuationInput', () => {
      const input = quarterToValuationInput(
        {
          asOfDate: '2026-06-30',
          q: "Q2'26",
          mv: 5.0, // 5M
          cost: 3.0, // 3M
          pps: 25,
          sharesOut: 0.2, // 200k
          notes: 'Quarterly review',
        },
        { asset_id: 'asset-1' },
      );

      expect(input.asset_id).toBe('asset-1');
      expect(input.as_of_date).toBe('2026-06-30');
      expect(input.market_value).toBe('5000000');
      expect(input.gross_value).toBe('3000000');
      expect(input.price_per_unit).toBe('25');
      expect(input.units_outstanding).toBe('200000');
    });
  });

  describe('Decimal-Safe Boundary & Precision Regression Tests (MAX_SAFE_INTEGER)', () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991.
    // 9007199254740992001 is greater than Number.MAX_SAFE_INTEGER and would lose precision
    // if parsed as a JavaScript Number/float.
    const HUGE_CASH_DELTA = '-9007199254740992001.12345678';
    const HUGE_POSITIVE_CASH = '9007199254740992001.12345678';
    const HUGE_QTY_DELTA = '9007199254740992001.87654321';
    const HUGE_PPS = '9007199254740992001.55555555';

    it('retains exact raw money and quantity values exceeding Number.MAX_SAFE_INTEGER through flEntryToTxn and txnToLedgerEntryInput', () => {
      const entry: FlPortfolioLedgerEntry = {
        id: 'entry-huge-1',
        position_id: 'pos-huge-1',
        business_event_id: null,
        entry_date: '2026-01-15',
        entry_type: 'buy',
        sub_type: null,
        commitment_delta: '0.00000000',
        cash_delta: HUGE_CASH_DELTA,
        quantity_delta: HUGE_QTY_DELTA,
        price_per_unit: HUGE_PPS,
        currency: 'USD',
        fx_rate: '1.00000000',
        counterparty_position_id: null,
        data_status: 'verified',
        source_record_id: null,
        notes: 'Huge transaction',
        created_by: null,
        created_at: '2026-01-15T00:00:00Z',
        event: null,
        is_reversal: false,
        allocations: [
          {
            id: 'allocation-huge-1',
            ledger_entry_id: 'entry-huge-1',
            funding_source_id: 'fs-1',
            amount: HUGE_POSITIVE_CASH,
            created_by: null,
            created_at: '2026-01-15T00:00:00Z',
          },
        ],
      };

      const txn = flEntryToTxn(entry);

      // Verify raw string fields preserved without float loss on Txn model
      expect(txn.rawCashDelta).toBe(HUGE_CASH_DELTA);
      expect(txn.rawQuantityDelta).toBe(HUGE_QTY_DELTA);
      expect(txn.rawValue).toBe(HUGE_POSITIVE_CASH);
      expect(txn.rawShares).toBe(HUGE_QTY_DELTA);
      expect(txn.rawPricePerUnit).toBe(HUGE_PPS);

      // Convert back to LedgerEntryInput
      const input = txnToLedgerEntryInput(txn, 'pos-huge-1');

      // Verify exact raw strings returned to API layer
      expect(input.cash_delta).toBe(HUGE_CASH_DELTA);
      expect(input.quantity_delta).toBe(HUGE_QTY_DELTA);
      expect(input.price_per_unit).toBe(HUGE_PPS);
      expect(input.allocations?.[0]?.amount).toBe(HUGE_POSITIVE_CASH);
    });

    it('retains exact raw valuation marks exceeding Number.MAX_SAFE_INTEGER through flValuationToQuarter and quarterToValuationInput', () => {
      const valRow: Tables<'fl_valuations'> = {
        id: 'val-huge-1',
        asset_id: 'asset-huge-1',
        fund_id: null,
        position_id: null,
        as_of_date: '2026-06-30',
        valuation_method: 'other',
        currency: 'USD',
        market_value: HUGE_POSITIVE_CASH,
        gross_value: HUGE_POSITIVE_CASH,
        net_value: HUGE_POSITIVE_CASH,
        units_outstanding: HUGE_QTY_DELTA,
        price_per_unit: HUGE_PPS,
        data_status: 'verified',
        notes: 'Quarter mark',
        source_record_id: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-06-30T00:00:00Z',
        updated_at: '2026-06-30T00:00:00Z',
      };

      const quarter = flValuationToQuarter(valRow);

      // Verify raw fields preserved on Quarter model
      expect(quarter.rawMarketValue).toBe(HUGE_POSITIVE_CASH);
      expect(quarter.rawGrossValue).toBe(HUGE_POSITIVE_CASH);
      expect(quarter.rawNetValue).toBe(HUGE_POSITIVE_CASH);
      expect(quarter.rawUnitsOutstanding).toBe(HUGE_QTY_DELTA);
      expect(quarter.rawPricePerUnit).toBe(HUGE_PPS);

      // Convert back to RecordValuationInput
      const valInput = quarterToValuationInput(quarter, {
        asset_id: 'asset-huge-1',
      });

      expect(valInput.market_value).toBe(HUGE_POSITIVE_CASH);
      expect(valInput.gross_value).toBe(HUGE_POSITIVE_CASH);
      expect(valInput.net_value).toBe(HUGE_POSITIVE_CASH);
      expect(valInput.units_outstanding).toBe(HUGE_QTY_DELTA);
      expect(valInput.price_per_unit).toBe(HUGE_PPS);
    });

    it('preserves exact raw balance strings exceeding Number.MAX_SAFE_INTEGER in flPositionToHolding and buildFundFromPortfolio', () => {
      const hugeCost = '9007199254740992001.00000000';
      const hugeDist = '9007199254740992002.00000000';
      const hugeFmv = '9007199254740992003.00000000';

      const pos: FlPortfolioPosition = {
        id: 'pos-huge-port',
        workspace_id: 'ws-1',
        holder_fund_id: 'fund-1',
        holder_investor_id: null,
        asset_id: 'asset-1',
        fund_id: null,
        opened_at: '2026-01-01',
        status: 'open',
        notes: null,
        holder_source_of_fund_id: null,
        closed_at: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        balance: {
          position_id: 'pos-huge-port',
          committed: '0.00000000',
          contributed: hugeCost,
          unfunded: '0.00000000',
          commitment: '0.00000000',
          drawn_commitment: '0.00000000',
          quantity: '0.00000000',
          cash_total: '0.00000000',
          contributed_capital: hugeCost,
          distributed: hugeDist,
          distributed_capital: hugeDist,
          retained_proceeds: '0.00000000',
        },
        current_value: hugeFmv,
        valuation_method: 'other',
        holder_investor: null,
        holder_fund: null,
        fund: null,
        asset: null,
          funding_source: null,
      };

      const holding = flPositionToHolding(pos, [], []);
      expect(holding.rawCost).toBe(hugeCost);
      expect(holding.rawReal).toBe(hugeDist);
      expect(holding.rawFmv).toBe(hugeFmv);

      const fundRow: Tables<'fl_funds'> = {
        id: 'fund-1',
        workspace_id: 'ws-1',
        name: 'Huge Fund',
        canonical_name: 'huge fund',
        legal_name: null,
        english_name: null,
        registration_no: null,
        managed: false,
        vintage_year: 2026,
        fund_life_years: null,
        base_currency: 'USD',
        status: 'investing',
        ownership_basis: 'units',
        carry_rate: null,
        mgmt_fee_rate: null,
        preferred_return_rate: null,
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const fund = buildFundFromPortfolio(fundRow, [pos], [], []);
      expect(fund.rawFmv).toBe(hugeFmv);
      expect(fund.rawReal).toBe(hugeDist);
    });

    it('central presentation helpers convert to/from display millions accurately with exact decimal arithmetic', () => {
      // toDisplayMillions
      expect(toDisplayMillions('1000000.00000000')).toBe(1);
      expect(toDisplayMillions('1500000.00000000')).toBe(1.5);
      expect(toDisplayMillions('9007199254740992000000')).toBe(9007199254740992);
      expect(toDisplayMillions(null)).toBeNull();
      expect(toDisplayMillions(undefined)).toBeUndefined();

      // fromDisplayMillionsToString
      expect(fromDisplayMillionsToString(1.5)).toBe('1500000');
      expect(fromDisplayMillionsToString('1.5')).toBe('1500000');
      expect(fromDisplayMillionsToString('9007199254.740992001')).toBe('9007199254740992.001');
      expect(fromDisplayMillionsToString(null)).toBeNull();
      expect(fromDisplayMillionsToString(undefined)).toBeUndefined();

      // Aliases toM / fromM
      expect(toM('2500000')).toBe(2.5);
      expect(fromM(2.5)).toBe(2500000);
    });

    it('maps english_name in buildFundFromPortfolio and flPositionToHolding for assets and target funds', () => {
      const fundRow: Tables<'fl_funds'> = {
        id: 'fund-1',
        workspace_id: 'ws-1',
        name: '南京一期基金',
        canonical_name: '南京一期基金',
        legal_name: '南京一期基金（有限合伙）',
        english_name: 'Nanjing Fund I',
        registration_no: null,
        managed: true,
        vintage_year: 2024,
        fund_life_years: null,
        base_currency: 'CNY',
        status: 'investing',
        ownership_basis: 'commitment',
        carry_rate: null,
        mgmt_fee_rate: null,
        preferred_return_rate: null,
        description: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const fund = buildFundFromPortfolio(fundRow, [], [], []);
      expect(fund.n).toBe('南京一期基金');
      expect(fund.englishName).toBe('Nanjing Fund I');
      expect(fund.legalName).toBe('南京一期基金（有限合伙）');

      const directPos: FlPortfolioPosition = {
        id: 'pos-direct',
        workspace_id: 'ws-1',
        fund_id: null,
        holder_fund_id: 'fund-1',
        asset_id: 'asset-1',
        holder_investor_id: null,
        holder_source_of_fund_id: null,
        status: 'open',
        opened_at: '2026-01-01',
        closed_at: null,
        valuation_method: 'stock_market_price',
        current_value: '1000000.00000000',
        notes: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        holder_investor: null,
        holder_fund: null,
        funding_source: null,
        asset: {
          id: 'asset-1',
          name: '南京微纳',
          canonical_name: '南京微纳',
          legal_name: '南京微纳科技有限公司',
          english_name: 'Nanjing Micro-Nano',
          asset_kind: 'equity',
          workspace_id: 'ws-1',
          country: 'China',
          sector: 'Tech',
          sub_sector: null,
          description: null,
          instrument_terms: {},
          created_by: null,
          updated_by: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        fund: null,
        balance: {
          position_id: 'pos-direct',
          contributed_capital: '500000.00000000',
          distributed_capital: '0.00000000',
          quantity: '100.00000000',
          commitment: '0.00000000',
          drawn_commitment: '0.00000000',
          retained_proceeds: '0.00000000',
          committed: '0.00000000',
          contributed: '500000.00000000',
          unfunded: '0.00000000',
          cash_total: '-500000.00000000',
          distributed: '0.00000000',
        },
      };

      const directHolding = flPositionToHolding(directPos, [], []);
      expect(directHolding.n).toBe('南京微纳');
      expect(directHolding.englishName).toBe('Nanjing Micro-Nano');

      const fofPos: FlPortfolioPosition = {
        id: 'pos-fof',
        workspace_id: 'ws-1',
        fund_id: 'target-fund-1',
        holder_fund_id: 'fund-1',
        asset_id: null,
        holder_investor_id: null,
        holder_source_of_fund_id: null,
        status: 'open',
        opened_at: '2026-01-01',
        closed_at: null,
        valuation_method: 'stock_market_price',
        current_value: '2000000.00000000',
        notes: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        holder_investor: null,
        holder_fund: null,
        funding_source: null,
        asset: null,
        fund: {
          id: 'target-fund-1',
          name: '南京生物基金',
          canonical_name: '南京生物基金',
          legal_name: '南京生物产业投资基金',
          english_name: 'Nanjing Bio Fund',
          registration_no: null,
          managed: false,
          vintage_year: 2025,
          fund_life_years: null,
          base_currency: 'CNY',
          status: 'investing',
          ownership_basis: 'units',
          carry_rate: null,
          mgmt_fee_rate: null,
          preferred_return_rate: null,
          description: null,
          workspace_id: 'ws-1',
          created_by: null,
          updated_by: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        balance: {
          position_id: 'pos-fof',
          contributed_capital: '1000000.00000000',
          distributed_capital: '0.00000000',
          quantity: '0.00000000',
          commitment: '0.00000000',
          drawn_commitment: '0.00000000',
          retained_proceeds: '0.00000000',
          committed: '0.00000000',
          contributed: '1000000.00000000',
          unfunded: '0.00000000',
          cash_total: '-1000000.00000000',
          distributed: '0.00000000',
        },
      };

      const fofHolding = flPositionToHolding(fofPos, [], []);
      expect(fofHolding.n).toBe('南京生物基金');
      expect(fofHolding.englishName).toBe('Nanjing Bio Fund');
    });
  });

  describe('Append-only reversals: historical asOf vs current effective views', () => {
    const originalEntry: FlPortfolioLedgerEntry = {
      id: 'ent-orig',
      position_id: 'pos-1',
      business_event_id: 'evt-1',
      entry_date: '2026-01-15',
      entry_type: 'buy',
      sub_type: null,
      is_reversal: false,
      commitment_delta: '0.00000000',
      quantity_delta: '1000.00000000',
      cash_delta: '-500000.00000000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: '500.00000000',
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Initial buy',
      created_by: null,
      created_at: '2026-01-15T00:00:00Z',
      event: {
        id: 'evt-1',
        workspace_id: 'ws-1',
        event_date: '2026-01-15',
        status: 'reversed',
        description: 'Original buy event',
        source_record_id: null,
        reversal_of_event_id: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-01-15T00:00:00Z',
        updated_at: '2026-05-20T00:00:00Z',
      },
      allocations: [],
      reversal_date: '2026-05-20',
    };

    const reversalEntry: FlPortfolioLedgerEntry = {
      id: 'ent-rev',
      position_id: 'pos-1',
      business_event_id: 'evt-rev',
      entry_date: '2026-05-20',
      entry_type: 'buy',
      sub_type: null,
      is_reversal: true,
      commitment_delta: '0.00000000',
      quantity_delta: '-1000.00000000',
      cash_delta: '500000.00000000',
      currency: 'USD',
      fx_rate: null,
      price_per_unit: '500.00000000',
      counterparty_position_id: null,
      data_status: 'verified',
      source_record_id: null,
      notes: 'Initial buy',
      created_by: null,
      created_at: '2026-05-20T00:00:00Z',
      event: {
        id: 'evt-rev',
        workspace_id: 'ws-1',
        event_date: '2026-05-20',
        status: 'posted',
        description: 'Reversal of evt-1',
        source_record_id: null,
        reversal_of_event_id: 'evt-1',
        created_by: null,
        updated_by: null,
        created_at: '2026-05-20T00:00:00Z',
        updated_at: '2026-05-20T00:00:00Z',
      },
      allocations: [],
    };

    const allEntries = [originalEntry, reversalEntry];

    it('FIX 5: does not export dead helpers effectiveLedgerEntries, asOfLedgerEntries, or effectiveLedgerEntriesAsOf', () => {
      expect((adapters as any).effectiveLedgerEntries).toBeUndefined();
      expect((adapters as any).asOfLedgerEntries).toBeUndefined();
      expect((adapters as any).effectiveLedgerEntriesAsOf).toBeUndefined();
    });

    it('computeFundHistory shows original invested capital before reversal date, and net zero after reversal date', () => {
      const perAsset = [
        {
          txns: allEntries,
          valuations: [],
        },
      ];

      // Quarter ends spanning across the reversal date (2026-05-20)
      const quarters = ['2026-03-31', '2026-06-30'];
      const history = computeFundHistory(perAsset, '1000000.00000000', quarters);

      expect(history.called).toHaveLength(2);

      // Q1 2026 (2026-03-31): Reversal has not occurred yet. Original buy of 500k = 0.5M called
      expect(history.called[0]).toBe(0.5);

      // Q2 2026 (2026-06-30): Reversal occurred on 2026-05-20. Original + reversal net to 0.0M called
      expect(history.called[1]).toBe(0);
    });

    it('flPositionToHolding retains all entries in inv.txns so transaction tables display original and reversal history', () => {
      const pos: FlPortfolioPosition = {
        id: 'pos-1',
        workspace_id: 'ws-1',
        holder_investor_id: null,
        holder_fund_id: 'fund-1',
        fund_id: null,
        asset_id: 'asset-1',
        holder_source_of_fund_id: null,
        status: 'open',
        opened_at: '2026-01-01',
        closed_at: null,
        notes: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        current_value: null,
        valuation_method: null,
        balance: null,
        holder_investor: null,
        holder_fund: null,
        asset: {
          id: 'asset-1',
          name: 'Target Asset',
          asset_type: 'direct_operating_company',
          instrument_terms: {},
          workspace_id: 'ws-1',
        } as never,
        fund: null,
        funding_source: null,
      };

      const holding = flPositionToHolding(pos, allEntries, []);
      expect(holding.inv?.txns).toHaveLength(2);

      const [tOrig, tRev] = holding.inv!.txns;
      expect(tOrig.id).toBe('ent-orig');
      expect(tOrig.isReversedOriginal).toBe(true);
      expect(tOrig.reversalDate).toBe('2026-05-20');
      expect(tOrig.isReversal).toBe(false);

      expect(tRev.id).toBe('ent-rev');
      expect(tRev.isReversal).toBe(true);
      expect(tRev.isReversedOriginal).toBe(false);

      // As-of before reversal date: original is NOT considered reversed
      const holdingBefore = flPositionToHolding(pos, allEntries, [], '2026-03-31');
      expect(holdingBefore.inv?.txns[0].isReversedOriginal).toBe(false);

      // As-of on or after reversal date: original is considered reversed
      const holdingAfter = flPositionToHolding(pos, allEntries, [], '2026-05-20');
      expect(holdingAfter.inv?.txns[0].isReversedOriginal).toBe(true);
    });
  });

  describe('Cash Positions and Consumers (Rows 4 & 5)', () => {
    const fundRow: Tables<'fl_funds'> = {
      id: 'fund-cash-1',
      workspace_id: 'ws-1',
      name: 'Cash Fund I',
      canonical_name: 'cash fund i',
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

    const lpPos: FlPortfolioPosition = {
      id: 'pos-lp-1',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-1',
      holder_fund_id: null,
      fund_id: 'fund-cash-1',
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2024-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      current_value: '0.00000000',
      valuation_method: null,
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: null,
      funding_source: null,
      balance: {
        position_id: 'pos-lp-1',
        asset_kind: null,
        contributed_capital: '0.00000000',
        distributed_capital: '0.00000000',
        quantity: '0.00000000',
        commitment: '10000000.00000000', // 10M
        drawn_commitment: '5000000.00000000', // 5M called
        retained_proceeds: '0.00000000',
        committed: '10000000.00000000',
        contributed: '0.00000000',
        unfunded: '5000000.00000000',
        cash_total: '-5000000.00000000',
        distributed: '0.00000000',
      },
    };

    const invPos: FlPortfolioPosition = {
      id: 'pos-company-1',
      workspace_id: 'ws-1',
      holder_investor_id: null,
      holder_fund_id: 'fund-cash-1',
      fund_id: null,
      asset_id: 'asset-co-1',
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2024-02-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-02-01T00:00:00Z',
      updated_at: '2024-02-01T00:00:00Z',
      current_value: '6000000.00000000',
      valuation_method: 'at_cost',
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'asset-co-1',
        name: 'Acme Corp',
        canonical_name: 'acme corp',
        asset_kind: 'equity',
        instrument_terms: { currency: 'USD' },
        workspace_id: 'ws-1',
        created_at: '2024-02-01T00:00:00Z',
        updated_at: '2024-02-01T00:00:00Z',
      } as any,
      funding_source: null,
      balance: {
        position_id: 'pos-company-1',
        asset_kind: 'equity',
        contributed_capital: '4000000.00000000',
        distributed_capital: '1000000.00000000', // 1M distributed
        quantity: '1000.00000000',
        commitment: '0.00000000',
        drawn_commitment: '0.00000000',
        retained_proceeds: '500000.00000000', // 0.5M legacy retained proceeds
        committed: '0.00000000',
        contributed: '4000000.00000000',
        unfunded: '0.00000000',
        cash_total: '-3000000.00000000',
        distributed: '1000000.00000000',
      },
    };

    const cashPos: FlPortfolioPosition = {
      id: 'pos-cash-usd',
      workspace_id: 'ws-1',
      holder_investor_id: null,
      holder_fund_id: 'fund-cash-1',
      fund_id: null,
      asset_id: 'asset-cash-usd',
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      current_value: '2000000.00000000', // 2M cash at par
      valuation_method: 'cash_par',
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: {
        id: 'asset-cash-usd',
        name: 'USD Cash',
        canonical_name: 'usd cash',
        asset_kind: 'cash',
        instrument_terms: { currency: 'USD' },
        workspace_id: 'ws-1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      } as any,
      funding_source: null,
      balance: {
        position_id: 'pos-cash-usd',
        asset_kind: 'cash',
        contributed_capital: '0.00000000',
        distributed_capital: '0.00000000', // Must be 0
        quantity: '0.00000000',
        commitment: '0.00000000',
        drawn_commitment: '0.00000000',
        retained_proceeds: '0.00000000',
        committed: '0.00000000',
        contributed: '0.00000000',
        unfunded: '0.00000000',
        cash_total: '2000000.00000000',
        distributed: '0.00000000',
      },
    };

    const valuations = [
      {
        id: 'val-1',
        workspace_id: 'ws-1',
        position_id: 'pos-company-1',
        asset_id: 'asset-co-1',
        fund_id: null,
        as_of_date: '2025-01-01',
        market_value: '6000000.00000000',
        valuation_method: 'at_cost',
      } as any,
    ];

    it('Row 4: buildFundFromPortfolio excludes cash from holdings, DPI and Unrealized MV, but keeps it in NAV for TVPI', () => {
      const fund = buildFundFromPortfolio(
        fundRow,
        [lpPos, invPos, cashPos],
        [],
        valuations,
        '2025-01-01',
      );

      // Cash position is excluded from holdings
      expect(fund.h).toHaveLength(1);
      expect(fund.h[0].id).toBe('asset-co-1');
      expect(fund.h[0].positionId).toBe('pos-company-1');

      // Valuation coverage check does not include cash
      expect(fund.valuationCoverage).toBe('complete');

      // DPI sums only investment position distributions (1M), excluding cash position
      expect(fund.real).toBe(1); // 1M
      expect(fund.dpi).toBe(0.2); // 1M / 5M called = 0.20

      // Unrealized MV = holding FMV (6M) only — the 2M cash balance never enters it
      expect(fund.fmv).toBe(6);
      expect(fund.rawFmv).toBe('6000000.00000000');
      // The cash balance is still reported on its own line
      expect(fund.cashBalance).toBe(2);
      expect(fund.rawCashBalance).toBe('2000000.00000000');

      // TVPI unchanged: NAV = 6M holdings + 2M cash (NOT + 0.5M legacy retained); (8M + 1M) / 5M = 1.8x
      expect(fund.rawNav).toBe('8000000.00000000');
      expect(fund.tvpi).toBe(1.8);
    });

    it('Row 4: buildFundFromPortfolio has FMV = holdings FMV when fund has no cash positions', () => {
      const fund = buildFundFromPortfolio(
        fundRow,
        [lpPos, invPos],
        [],
        valuations,
        '2025-01-01',
      );

      expect(fund.fmv).toBe(6);
      expect(fund.real).toBe(1);
      expect(fund.dpi).toBe(0.2);
      expect(fund.cashBalances).toEqual([]);
      expect(fund.cashBalance).toBe(0);
    });

    it('shows no Unrealized MV ("—") when no holding is valued, even when the fund holds cash', () => {
      const unvaluedPos = { ...invPos, current_value: null, valuation_method: null };
      const fund = buildFundFromPortfolio(
        fundRow,
        [lpPos, unvaluedPos, cashPos],
        [],
        [],
        '2025-01-01',
      );

      expect(fund.h[0].fmv).toBeNull();
      expect(fund.fmv).toBeNull();
      expect(fund.rawFmv).toBeNull();
      expect(fund.valuationCoverage).toBe('partial');
      // Cash is still there — just not dressed up as market value
      expect(fund.cashBalance).toBe(2);
      expect(fund.tvpi).toBeNull();
    });

    it('Row 5: computeFundHistory tracks holding valuations only, ignoring cash across quarter ends', () => {
      const perAsset = [
        {
          txns: [
            {
              entry_type: 'sell',
              sub_type: 'cash_in_fund',
              cash_delta: '500000.00000000',
              entry_date: '2024-09-30',
            },
          ],
          valuations: [
            { as_of_date: '2024-09-30', market_value: '5000000.00000000' },
            { as_of_date: '2024-12-31', market_value: '5000000.00000000' },
            { as_of_date: '2025-03-31', market_value: '6000000.00000000' },
          ],
        },
      ];

      const quarterEnds = ['2024-09-30', '2024-12-31', '2025-03-31'];
      const hist = computeFundHistory(perAsset, '10000000', quarterEnds);

      // The retained 0.5M sale proceeds are cash, not FMV: history moves only on valuations
      expect(hist.fmv).toEqual([5, 5, 6]);
    });
  });

  describe('buildFundFromPortfolio with pending_fx', () => {
    it('sets fmv, tvpi, and rawCashBalance to null when fund is active but pending_fx', () => {
      const fundRow: any = {
        id: 'fund-multi',
        name: 'Multi-Currency Fund',
        base_currency: 'USD',
        status: 'investing',
        vintage_year: 2024,
      };

      const portPositions: any[] = [
        {
          id: 'pos-inv-1',
          holder_fund_id: 'fund-multi',
          current_value: '10000000.00000000',
          balance: {
            position_id: 'pos-inv-1',
            asset_kind: 'equity',
            contributed: '8000000.00000000',
            retained_proceeds: '500000.00000000',
          },
          asset: { asset_kind: 'equity' },
        },
        {
          id: 'pos-cash-usd',
          holder_fund_id: 'fund-multi',
          balance: {
            position_id: 'pos-cash-usd',
            asset_kind: 'cash',
            cash_total: '1000000.00000000',
          },
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
        },
        {
          id: 'pos-cash-eur',
          holder_fund_id: 'fund-multi',
          balance: {
            position_id: 'pos-cash-eur',
            asset_kind: 'cash',
            cash_total: '500000.00000000',
          },
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'EUR' } },
        },
      ];

      const fund = buildFundFromPortfolio(
        fundRow,
        portPositions,
        [],
        [],
        '2025-03-31',
      );

      expect(fund.fxStatus).toBe('pending_fx');
      expect(fund.reportingTotalAvailable).toBe(false);
      // No holding is valued, so Unrealized MV is "—"; NAV (holdings + cash) and TVPI
      // stay null while cash is pending FX — never a nominal multi-currency sum.
      expect(fund.fmv).toBeNull();
      expect(fund.rawFmv).toBeNull();
      expect(fund.rawNav).toBeNull();
      expect(fund.tvpi).toBeNull();
      expect(fund.cashBalance).toBeNull();
      expect(fund.rawCashBalance).toBeNull();
      // Per-currency cash balances preserved
      expect(fund.cashBalances).toEqual([
        { currency: 'EUR', amount: '500000.00000000' },
        { currency: 'USD', amount: '1000000.00000000' },
      ]);
    });
  });

  describe('buildFundFromPortfolio with incomplete_negative cash', () => {
    it('falls back to holdings-only FMV and sets cashStatus to incomplete_negative when cash is negative', () => {
      const fundRow: any = {
        id: 'fund-neg-cash',
        name: 'Meranti 2',
        base_currency: 'USD',
        status: 'investing',
        vintage_year: 2024,
      };

      const portPositions: any[] = [
        {
          id: 'pos-inv-1',
          holder_fund_id: 'fund-neg-cash',
          current_value: '50000000.00000000',
          valuation_method: 'mark',
          balance: {
            position_id: 'pos-inv-1',
            asset_kind: 'equity',
            contributed: '40000000.00000000',
          },
          asset: { asset_kind: 'equity' },
        },
        {
          id: 'pos-cash-usd-neg',
          holder_fund_id: 'fund-neg-cash',
          balance: {
            position_id: 'pos-cash-usd-neg',
            asset_kind: 'cash',
            cash_total: '-132366322.58000000',
          },
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'USD' } },
        },
      ];

      const fund = buildFundFromPortfolio(
        fundRow,
        portPositions,
        [],
        [],
        '2025-03-31',
      );

      expect(fund.cashStatus).toBe('incomplete_negative');
      expect(fund.reportingTotalAvailable).toBe(false);
      // Total FMV falls back to holdings-only (50M), NOT null and NOT negative!
      expect(fund.fmv).toBe(50);
      expect(fund.rawFmv).toBe('50000000.00000000');
      // Cash balance is null on fund level
      expect(fund.cashBalance).toBeNull();
      expect(fund.rawCashBalance).toBeNull();
      // Per-currency cash balances stay available for diagnostics and statement view
      expect(fund.cashBalances).toEqual([
        { currency: 'USD', amount: '-132366322.58000000' },
      ]);
    });

    it('keeps a positive cash balance out of Unrealized MV but in NAV', () => {
      const fundRow: any = {
        id: 'fund-nanjing',
        name: 'Fund A',
        base_currency: 'CNY',
        status: 'investing',
        vintage_year: 2023,
      };

      const portPositions: any[] = [
        {
          id: 'pos-inv-nanjing',
          holder_fund_id: 'fund-nanjing',
          current_value: '100000000.00000000',
          valuation_method: 'mark',
          balance: {
            position_id: 'pos-inv-nanjing',
            asset_kind: 'equity',
            contributed: '80000000.00000000',
          },
          asset: { asset_kind: 'equity' },
        },
        {
          id: 'pos-cash-nanjing',
          holder_fund_id: 'fund-nanjing',
          balance: {
            position_id: 'pos-cash-nanjing',
            asset_kind: 'cash',
            cash_total: '30494255.65000000',
          },
          asset: { asset_kind: 'cash', instrument_terms: { currency: 'CNY' } },
        },
      ];

      const fund = buildFundFromPortfolio(
        fundRow,
        portPositions,
        [],
        [],
        '2025-03-31',
      );

      expect(fund.cashStatus).toBe('ok');
      expect(fund.reportingTotalAvailable).toBe(true);
      expect(fund.rawFmv).toBe('100000000.00000000');
      expect(fund.fmv).toBe(100);
      expect(fund.rawNav).toBe('130494255.65000000');
      expect(fund.cashBalance).toBeCloseTo(30.49, 2);
      expect(fund.cashBalances).toEqual([
        { currency: 'CNY', amount: '30494255.65000000' },
      ]);
    });
    });
  });

  describe('buildEntityFromPortfolio', () => {
    const investorRow = {
      id: 'inv-startech-growth',
      workspace_id: 'ws-1',
      name: 'Startech Growth Entity',
      canonical_name: 'startech growth entity',
      legal_name: 'Startech Growth Entity LLC',
      english_name: 'Startech Growth Entity',
      investor_type: 'institutional',
      parent_investor_id: 'inv-startech-group',
      created_at: '',
      updated_at: '',
    } as unknown as Tables<'fl_investors'>;

    const parentRow = {
      id: 'inv-startech-group',
      name: 'Startech Group',
    };

    const asset1 = {
      id: 'a-techcorp',
      name: 'TechCorp',
      canonical_name: 'techcorp',
      asset_kind: 'direct_investment' as const,
      instrument_terms: { currency: 'USD' },
      country: 'US',
      sector: 'Technology',
    } as any;

    const pos1: FlPortfolioPosition = {
      id: 'p-techcorp-growth',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-startech-growth',
      holder_fund_id: null,
      asset_id: 'a-techcorp',
      fund_id: null,
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '2500000',
      valuation_method: 'fair_value',
      balance: {
        position_id: 'p-techcorp-growth',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '1000',
        contributed_capital: '1000000',
        distributed_capital: '200000',
        committed: '0',
        contributed: '1000000',
        unfunded: '0',
        cash_total: '0',
        distributed: '200000',
        retained_proceeds: '0',
        asset_kind: 'direct_investment',
      },
      asset: asset1,
      fund: null,
      holder_investor: investorRow,
      holder_fund: null,
      funding_source: null,
    };

    const cashPos: FlPortfolioPosition = {
      id: 'p-cash-growth',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-startech-growth',
      holder_fund_id: null,
      asset_id: 'a-cash',
      fund_id: null,
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '500000',
      valuation_method: 'cash_par',
      balance: {
        position_id: 'p-cash-growth',
        commitment: '0',
        drawn_commitment: '0',
        quantity: '0',
        contributed_capital: '0',
        distributed_capital: '0',
        committed: '0',
        contributed: '0',
        unfunded: '0',
        cash_total: '500000',
        distributed: '0',
        retained_proceeds: '0',
        asset_kind: 'cash',
      },
      asset: {
        id: 'a-cash',
        name: 'USD Cash',
        asset_kind: 'cash' as const,
        instrument_terms: { currency: 'USD' },
      } as any,
      fund: null,
      holder_investor: investorRow,
      holder_fund: null,
      funding_source: null,
    };

    it('1. buildEntityFromPortfolio returns the entity asset holdings and excludes cash positions', () => {
      const entity = buildEntityFromPortfolio(
        investorRow,
        [pos1, cashPos],
        [],
        [],
        null,
        parentRow,
      );

      expect(entity.id).toBe('inv-startech-growth');
      expect(entity.n).toBe('Startech Growth Entity');
      expect(entity.groupName).toBe('Startech Group');
      expect(entity.groupId).toBe('inv-startech-group');

      // Holdings includes TechCorp, excludes Cash
      expect(entity.holdings).toHaveLength(1);
      expect(entity.holdings![0].n).toBe('TechCorp');
      expect(entity.holdings![0].cost).toBe(1); // 1M
      expect(entity.holdings![0].fmv).toBe(2.5); // 2.5M
    });

    it('2. It attributes only that entity positions — two entities holding the same asset do not bleed', () => {
      const otherInvestorRow = {
        id: 'inv-other',
        workspace_id: 'ws-1',
        name: 'Other Investor',
        parent_investor_id: null,
      } as unknown as Tables<'fl_investors'>;

      const posOther: FlPortfolioPosition = {
        ...pos1,
        id: 'p-techcorp-other',
        holder_investor_id: 'inv-other',
        current_value: '6000000',
        balance: {
          ...pos1.balance!,
          position_id: 'p-techcorp-other',
          contributed_capital: '3000000',
        },
      };

      const allPositions = [pos1, posOther];

      const entity1 = buildEntityFromPortfolio(investorRow, allPositions, [], []);
      const entity2 = buildEntityFromPortfolio(otherInvestorRow, allPositions, [], []);

      expect(entity1.holdings).toHaveLength(1);
      expect(entity1.holdings![0].cost).toBe(1);
      expect(entity1.holdings![0].fmv).toBe(2.5);

      expect(entity2.holdings).toHaveLength(1);
      expect(entity2.holdings![0].cost).toBe(3);
      expect(entity2.holdings![0].fmv).toBe(6);
    });

    it('3. Entities are grouped by groupName, and an ungrouped entity lands in the trailing section', () => {
      const ungroupedInvestor = {
        id: 'inv-solo',
        workspace_id: 'ws-1',
        name: 'Solo Entity',
        parent_investor_id: null,
      } as unknown as Tables<'fl_investors'>;

      const entityGrouped = buildEntityFromPortfolio(investorRow, [pos1], [], [], null, parentRow);
      const entityUngrouped = buildEntityFromPortfolio(ungroupedInvestor, [], [], []);

      expect(entityGrouped.groupName).toBe('Startech Group');
      expect(entityUngrouped.groupName).toBeNull();
    });

    it('4. Regression: buildFundFromPortfolio output is unchanged', () => {
      const fundRow = {
        id: 'fund-1',
        workspace_id: 'ws-1',
        name: 'Test Fund',
        canonical_name: 'test fund',
        vintage_year: 2024,
        status: 'investing',
        description: null,
        legal_name: null,
        english_name: null,
        registration_no: null,
        created_by: null,
        updated_by: null,
        created_at: '',
        updated_at: '',
      } as unknown as Tables<'fl_funds'>;

      const fundPos: FlPortfolioPosition = {
        ...pos1,
        id: 'p-techcorp-fund',
        holder_investor_id: null,
        holder_fund_id: 'fund-1',
      };

      const fund = buildFundFromPortfolio(fundRow, [fundPos], [], []);
      expect(fund.id).toBe('fund-1');
      expect(fund.n).toBe('Test Fund');
      expect(fund.h).toHaveLength(1);
      expect(fund.h[0].n).toBe('TechCorp');
    });

    it('5. An entity with LP stakes and direct holdings preserves both when merged', () => {
      const entity = buildEntityFromPortfolio(investorRow, [pos1], [], []);
      const merged = {
        ...entity,
        stakes: { 'fund-1': 5.0 },
        invested: { 'fund-1': 3.0 },
        distributed: { 'fund-1': 1.0 },
      };

      expect(merged.holdings).toHaveLength(1);
      expect(merged.holdings![0].n).toBe('TechCorp');
      expect(merged.stakes['fund-1']).toBe(5.0);
      expect(merged.invested['fund-1']).toBe(3.0);
      expect(merged.distributed['fund-1']).toBe(1.0);
    });

    const unmanagedFund = {
      id: 'fund-fof-1',
      workspace_id: 'ws-1',
      name: 'External FoF Fund',
      canonical_name: 'external fof fund',
      managed: false,
      base_currency: 'USD',
      ownership_basis: 'units',
      status: 'investing',
      created_at: '',
      updated_at: '',
    } as unknown as Tables<'fl_funds'>;

    const fofPos: FlPortfolioPosition = {
      id: 'p-fof-growth',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-startech-growth',
      holder_fund_id: null,
      asset_id: null,
      fund_id: 'fund-fof-1',
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '3000000',
      valuation_method: 'fair_value',
      balance: {
        position_id: 'p-fof-growth',
        commitment: '5000000',
        drawn_commitment: '2000000',
        quantity: '0',
        contributed_capital: '2000000',
        distributed_capital: '100000',
        committed: '5000000',
        contributed: '2000000',
        unfunded: '3000000',
        cash_total: '0',
        distributed: '100000',
        retained_proceeds: '0',
        asset_kind: 'fund',
      },
      asset: null,
      fund: unmanagedFund,
      holder_investor: investorRow,
      holder_fund: null,
      funding_source: null,
    };

    const managedFund = {
      id: 'fund-managed-1',
      workspace_id: 'ws-1',
      name: 'Managed Alpha Fund',
      canonical_name: 'managed alpha fund',
      managed: true,
      base_currency: 'USD',
      ownership_basis: 'commitment',
      status: 'investing',
      created_at: '',
      updated_at: '',
    } as unknown as Tables<'fl_funds'>;

    const managedStakePos: FlPortfolioPosition = {
      id: 'p-managed-stake',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-startech-growth',
      holder_fund_id: null,
      asset_id: null,
      fund_id: 'fund-managed-1',
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '4000000',
      valuation_method: 'fair_value',
      balance: {
        position_id: 'p-managed-stake',
        commitment: '10000000',
        drawn_commitment: '5000000',
        quantity: '0',
        contributed_capital: '5000000',
        distributed_capital: '500000',
        committed: '10000000',
        contributed: '5000000',
        unfunded: '5000000',
        cash_total: '0',
        distributed: '500000',
        retained_proceeds: '0',
        asset_kind: 'fund',
      },
      asset: null,
      fund: managedFund,
      holder_investor: investorRow,
      holder_fund: null,
      funding_source: null,
    };

    const unresolvablePos: FlPortfolioPosition = {
      id: 'p-unresolved',
      workspace_id: 'ws-1',
      holder_investor_id: 'inv-startech-growth',
      holder_fund_id: null,
      asset_id: null,
      fund_id: 'fund-nonexistent',
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2025-01-01',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '1000000',
      valuation_method: 'fair_value',
      balance: {
        position_id: 'p-unresolved',
        commitment: '1000000',
        drawn_commitment: '1000000',
        quantity: '0',
        contributed_capital: '1000000',
        distributed_capital: '0',
        committed: '1000000',
        contributed: '1000000',
        unfunded: '0',
        cash_total: '0',
        distributed: '0',
        retained_proceeds: '0',
      },
      asset: null,
      fund: null,
      holder_investor: investorRow,
      holder_fund: null,
      funding_source: null,
    };

    it('1. An entity position in an unmanaged fund is a holding (FoF)', () => {
      const entity = buildEntityFromPortfolio(investorRow, [fofPos], [], []);

      expect(entity.holdings).toHaveLength(1);
      expect(entity.holdings![0].n).toBe('External FoF Fund');
      expect(entity.holdings![0].tp).toBe('Fund of funds');
      expect(entity.holdings![0].cost).toBe(2);
      expect(entity.holdings![0].fmv).toBe(3);
      expect(entity.rawCost).toBe('2000000.00000000');
      expect(entity.rawFmv).toBe('3000000.00000000');
    });

    it('2. REGRESSION: an entity position in a managed fund is NOT a holding, and does not contribute to the entity\'s invested / market-value totals', () => {
      const entity = buildEntityFromPortfolio(investorRow, [managedStakePos], [], []);

      expect(entity.holdings).toHaveLength(0);
      expect(entity.rawCost).toBe('0.00000000');
      expect(entity.rawFmv).toBe('0.00000000');
      expect(entity.rawReal).toBe('0.00000000');
    });

    it('3. A non-cash asset position is a holding; a cash position is not', () => {
      const entity = buildEntityFromPortfolio(
        investorRow,
        [pos1, cashPos],
        [],
        [],
        null,
        parentRow,
      );

      expect(entity.holdings).toHaveLength(1);
      expect(entity.holdings![0].n).toBe('TechCorp');
      expect(entity.holdings![0].cost).toBe(1);
      expect(entity.holdings![0].fmv).toBe(2.5);
      expect(entity.holdings!.some((h) => h.n === 'USD Cash')).toBe(false);
    });

    it('4. An entity with both a managed-fund stake and a direct asset reports only the asset as a holding, while its stakes for that fund are unchanged', () => {
      const entity = buildEntityFromPortfolio(investorRow, [pos1, managedStakePos], [], []);
      const merged = {
        ...entity,
        stakes: { 'fund-managed-1': 10.0 },
        invested: { 'fund-managed-1': 5.0 },
        distributed: { 'fund-managed-1': 0.5 },
      };

      expect(merged.holdings).toHaveLength(1);
      expect(merged.holdings![0].n).toBe('TechCorp');
      expect(merged.holdings![0].cost).toBe(1);
      expect(merged.holdings![0].fmv).toBe(2.5);
      expect(merged.rawCost).toBe('1000000.00000000');
      expect(merged.stakes['fund-managed-1']).toBe(10.0);
      expect(merged.invested['fund-managed-1']).toBe(5.0);
      expect(merged.distributed['fund-managed-1']).toBe(0.5);
    });

    it('5. A position whose fund cannot be resolved is surfaced as disclosure-only and excluded from sums', () => {
      const entity = buildEntityFromPortfolio(investorRow, [unresolvablePos], [], []);

      expect(entity.holdings).toHaveLength(1);
      expect(entity.holdings![0].displayOnly).toBe(true);
      expect(entity.holdings![0].disclosure).toBe('unresolved_target');
      expect(entity.holdings![0].fmv).toBeNull();
      expect(entity.holdings![0].cost).toBe(1);
      expect(entity.rawCost).toBe('0.00000000');
    });

    it('Resolves unmanaged funds via allFunds parameter even if not attached to position', () => {
      const entity = buildEntityFromPortfolio(
        investorRow,
        [{ ...unresolvablePos, fund_id: 'fund-fof-1' }],
        [],
        [],
        null,
        null,
        [unmanagedFund],
      );

      expect(entity.holdings).toHaveLength(1);
      expect(entity.holdings![0].n).toBe('External FoF Fund');
      expect(entity.holdings![0].tp).toBe('Fund of funds');
    });
  });

  describe('filterEntityInvestors (Bug 2)', () => {
    it('An investor that is another investor parent_investor_id is excluded from the entity rows', () => {
      const parentInvestor = {
        id: 'group-meranti-1',
        name: 'Meranti 1',
        parent_investor_id: null,
        investor_type: 'internal_entity',
      };
      const childInvestor = {
        id: 'child-1',
        name: 'PT Sinar Mas Multiartha Tbk',
        parent_investor_id: 'group-meranti-1',
        investor_type: 'institution',
      };

      const result = filterEntityInvestors([parentInvestor, childInvestor]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('child-1');
    });

    it('A grouped (child) investor is still included', () => {
      const parentInvestor = {
        id: 'group-startech',
        name: 'Startech Growth Fund 1',
        parent_investor_id: null,
        investor_type: 'internal_entity',
      };
      const childInvestor = {
        id: 'child-entity',
        name: 'Startech Sub 1',
        parent_investor_id: 'group-startech',
        investor_type: 'corporate',
      };

      const result = filterEntityInvestors([parentInvestor, childInvestor]);
      expect(result.some((r) => r.id === 'child-entity')).toBe(true);
    });

    it('An internal_entity investor that parents nobody is still included', () => {
      const internalBalanceSheet = {
        id: 'internal-solo',
        name: 'Internal Balance Sheet Holdco',
        parent_investor_id: null,
        investor_type: 'internal_entity',
      };
      const regularEntity = {
        id: 'regular-lp',
        name: 'Regular LP',
        parent_investor_id: null,
        investor_type: 'individual',
      };

      const result = filterEntityInvestors([internalBalanceSheet, regularEntity]);
      expect(result.map((r) => r.id)).toEqual(['internal-solo', 'regular-lp']);
    });

    it('filters domain Investor objects using groupId when applicable', () => {
      const groupInvestor: Partial<Investor> = {
        id: 'group-others',
        n: 'Others',
        type: 'internal_entity',
        groupId: null,
      };
      const childInvestor: Partial<Investor> = {
        id: 'child-smg',
        n: 'SMG Management Ltd',
        type: 'institution',
        groupId: 'group-others',
      };

      const result = filterEntityInvestors([groupInvestor as Investor, childInvestor as Investor]);
      expect(result.map((r) => r.id)).toEqual(['child-smg']);
    });

    it('excludes parents and keeps a childless internal entity', () => {
      const parentGroup = {
        id: 'group-startech',
        name: 'Startech Growth Fund 1',
        parent_investor_id: null,
        investor_type: 'internal_entity',
      };
      const childEntity = {
        id: 'child-1',
        name: 'Startech Sub 1',
        parent_investor_id: 'group-startech',
        investor_type: 'corporate',
      };
      const childlessInternalEntity = {
        id: 'internal-childless',
        name: 'Internal Treasury Holdco',
        parent_investor_id: null,
        investor_type: 'internal_entity',
      };

      const result = filterEntityInvestors([
        parentGroup,
        childEntity,
        childlessInternalEntity,
      ]);
      expect(result.map((r) => r.id)).toEqual(['child-1', 'internal-childless']);
    });
  });


  describe('EntitySummaryTable markup fixes (Bugs 1 & 3)', () => {
    const mockGrouped: Investor = {
      id: 'inv-grouped',
      n: 'Grouped Entity',
      type: 'institution',
      groupName: 'Meranti 1',
      groupId: 'group-meranti-1',
      stakes: {},
      holdings: [],
    };

    const mockUngrouped: Investor = {
      id: 'inv-ungrouped',
      n: 'Ungrouped Entity',
      type: 'individual',
      groupName: null,
      groupId: null,
      stakes: {},
      holdings: [],
    };

    it('renders a placeholder w-8 border-b border-r cell on ungrouped rows when groups exist', () => {
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(EntitySummaryTable, {
            funds: [],
            investors: [mockGrouped, mockUngrouped],
          }),
        ),
      );

      // The placeholder cell on ungrouped rows should match the group band width and border
      expect(html).toContain('<td class="w-8 border-b border-r"></td>');
      // The header cell should also have w-8 border-b border-r to align columns
      expect(html).toContain(
        '<th class="w-8 border-b border-r bg-muted/50 p-0 text-center text-[11px] font-medium text-muted-foreground"></th>',
      );
    });

    it('renders group band cell with relative positioning and an absolutely positioned overflow-hidden label', () => {
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(EntitySummaryTable, {
            funds: [],
            investors: [mockGrouped, mockUngrouped],
          }),
        ),
      );

      // Group band cell has relative, w-8, border-b, border-r
      expect(html).toContain('relative w-8 border-b border-r bg-muted/30');
      // Inner wrapper is absolute inset-0 and overflow-hidden to decouple label height from row height
      expect(html).toContain('absolute inset-0 flex items-center justify-center overflow-hidden');
    });

    it('automatically excludes pure group parents passed into EntitySummaryTable', () => {
      const mockParentGroup: Investor = {
        id: 'group-meranti-1',
        n: 'Meranti 1',
        type: 'internal_entity',
        groupName: null,
        groupId: null,
        stakes: {},
        holdings: [],
      };

      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(EntitySummaryTable, {
            funds: [],
            investors: [mockParentGroup, mockGrouped, mockUngrouped],
          }),
        ),
      );

      // The table should report 2 entities (grouped child + ungrouped), excluding the parent group
      expect(html).toContain('2 entities');
    });
  });

  describe('Phase A: Fund/Asset visibility gates: data + calc layer', () => {
    const assetA = {
      id: 'a-1',
      name: 'Alpha Co',
      english_name: 'Alpha Company',
      asset_kind: 'direct_investment',
      instrument_terms: { instrumentType: 'equity' },
      created_at: '2025-01-01T00:00:00Z',
    } as unknown as Tables<'fl_assets'>;

    const assetB = {
      id: 'a-2',
      name: 'Beta Loan',
      english_name: null,
      asset_kind: 'loan',
      instrument_terms: {},
      created_at: '2025-02-01T00:00:00Z',
    } as unknown as Tables<'fl_assets'>;

    const cashAsset = {
      id: 'a-cash',
      name: 'USD Cash',
      asset_kind: 'cash',
      instrument_terms: {},
      created_at: '2025-01-01T00:00:00Z',
    } as unknown as Tables<'fl_assets'>;

    it('buildOrphanAssetFund returns null when every non-cash asset is held in positions', () => {
      const pos: FlPortfolioPosition = {
        id: 'p-1',
        asset_id: 'a-1',
        holder_fund_id: 'f-1',
      } as any;
      const orphanFund = buildOrphanAssetFund([assetA], [pos]);
      expect(orphanFund).toBeNull();
    });

    it('buildOrphanAssetFund excludes cash assets and returns null if only cash assets are unheld', () => {
      const orphanFund = buildOrphanAssetFund([cashAsset], []);
      expect(orphanFund).toBeNull();
    });

    it('buildOrphanAssetFund builds synthetic unassigned fund with displayOnly: true, disclosure: no_holder, and fmv: null', () => {
      const pos: FlPortfolioPosition = {
        id: 'p-1',
        asset_id: 'a-1',
        holder_fund_id: 'f-1',
      } as any;
      const orphanFund = buildOrphanAssetFund([assetA, assetB, cashAsset], [pos]);
      expect(orphanFund).not.toBeNull();
      expect(orphanFund!.id).toBe('unassigned');
      expect(orphanFund!.n).toBe('Unassigned Assets');
      expect(orphanFund!.displayOnly).toBe(true);
      expect(orphanFund!.disclosure).toBe('no_holder');
      expect(orphanFund!.fmv).toBeNull();
      expect(orphanFund!.real).toBe(0);
      expect(orphanFund!.dpi).toBe(0);
      expect(orphanFund!.tvpi).toBeNull();
      expect(orphanFund!.irr).toBe(0);
      expect(orphanFund!.st).toBe('Unlinked');

      expect(orphanFund!.h).toHaveLength(1);
      const h = orphanFund!.h[0];
      expect(h.id).toBe('a-2');
      expect(h.n).toBe('Beta Loan');
      expect(h.tp).toBe('Obligation');
      expect(h.cost).toBe(0);
      expect(h.fmv).toBeNull();
      expect(h.real).toBe(0);
      expect(h.moic).toBeNull();
      expect(h.st).toBe('Unlinked');
      expect(h.displayOnly).toBe(true);
      expect(h.disclosure).toBe('no_holder');
      expect(h.positionId).toBeUndefined();
      expect(h.positionIds).toBeUndefined();
    });

    it('buildFundFromPortfolio sets displayOnly and disclosure when disclosure param is provided', () => {
      const fundRow = {
        id: 'f-ext',
        name: 'External Fund',
        vintage_year: 2024,
        status: 'investing',
        managed: false,
      } as any;

      const normalFund = buildFundFromPortfolio(fundRow, [], [], []);
      expect(normalFund.displayOnly).toBeUndefined();
      expect(normalFund.disclosure).toBeUndefined();

      const externalFund = buildFundFromPortfolio(fundRow, [], [], [], null, undefined, 'external_fund');
      expect(externalFund.displayOnly).toBe(true);
      expect(externalFund.disclosure).toBe('external_fund');

      const liquidatedFund = buildFundFromPortfolio(fundRow, [], [], [], null, undefined, 'liquidated_fund');
      expect(liquidatedFund.displayOnly).toBe(true);
      expect(liquidatedFund.disclosure).toBe('liquidated_fund');
    });

    it('buildEntityFromPortfolio unresolved target holding does not change entity-level sums', () => {
      const investorRow = {
        id: 'inv-1',
        name: 'Test Entity',
      } as any;
      const realPos: FlPortfolioPosition = {
        id: 'p-real',
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        asset_id: 'a-1',
        asset: { id: 'a-1', name: 'Real Asset', asset_kind: 'direct_investment' } as any,
        status: 'open',
        current_value: '5000000',
        valuation_method: 'fair_value',
        balance: {
          contributed_capital: '4000000',
          distributed_capital: '1000000',
        } as any,
      } as any;
      const unresolvedPos: FlPortfolioPosition = {
        id: 'p-unres',
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        fund_id: 'fund-missing',
        status: 'open',
        balance: {
          contributed_capital: '2000000',
          distributed_capital: '500000',
        } as any,
      } as any;

      const entityWithout = buildEntityFromPortfolio(investorRow, [realPos], [], []);
      const entityWith = buildEntityFromPortfolio(investorRow, [realPos, unresolvedPos], [], []);

      expect(entityWithout.holdings).toHaveLength(1);
      expect(entityWith.holdings).toHaveLength(2);

      // Real holding is first
      expect(entityWith.holdings![0].id).toBe('a-1');
      expect(entityWith.holdings![0].displayOnly).toBeUndefined();

      // Unresolved target is second
      expect(entityWith.holdings![1].id).toBe('fund-missing');
      expect(entityWith.holdings![1].displayOnly).toBe(true);
      expect(entityWith.holdings![1].disclosure).toBe('unresolved_target');
      expect(entityWith.holdings![1].fmv).toBeNull();
      expect(entityWith.holdings![1].moic).toBeNull();
      expect(entityWith.holdings![1].cost).toBe(2);
      expect(entityWith.holdings![1].real).toBe(0.5);

      // Entity level sums remain byte-identical
      expect(entityWith.rawCost).toBe(entityWithout.rawCost);
      expect(entityWith.rawFmv).toBe(entityWithout.rawFmv);
      expect(entityWith.rawReal).toBe(entityWithout.rawReal);
      expect(entityWith.valuationCoverage).toBe(entityWithout.valuationCoverage);
      expect(entityWith.valuationCoverage).toBe('complete');
    });
  });

  describe('Phase B: External fund exposure metrics', () => {
    const extFundRow: Tables<'fl_funds'> = {
      id: 'f-ext-1',
      name: '南京视不可挡',
      english_name: 'Unstoppable Nanjing',
      vintage_year: 2023,
      status: 'investing',
      managed: false,
      base_currency: 'CNY',
    } as any;

    const mgrFundRow1: Tables<'fl_funds'> = {
      id: 'f-mgr-1',
      name: '南京金光紫金',
      english_name: 'Nanjing Jinguang Zijin',
      vintage_year: 2021,
      status: 'investing',
      managed: true,
      base_currency: 'CNY',
    } as any;

    const mgrFundRow2: Tables<'fl_funds'> = {
      id: 'f-mgr-2',
      name: 'Apex Growth Fund II',
      vintage_year: 2022,
      status: 'investing',
      managed: true,
      base_currency: 'CNY',
    } as any;

    it('1. A managed: false fund with one inbound position held by a managed fund gets ourPosition with right invested/fmv/realized/moic/dpi and heldBy', () => {
      // 20M invested, 25M FMV, 5M realized -> MOIC = 1.5, DPI = 0.25
      const inboundPos: FlPortfolioPosition = {
        id: 'pos-inbound-1',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '25000000',
        balance: {
          contributed_capital: '20000000',
          distributed_capital: '5000000',
        } as any,
      } as any;

      const externalFund = buildFundFromPortfolio(
        extFundRow,
        [inboundPos],
        [],
        [],
        null,
        undefined,
        'external_fund',
      );

      expect(externalFund.ourPosition).toBeDefined();
      expect(externalFund.ourPosition).toEqual({
        invested: 20,
        fmv: 25,
        realized: 5,
        moic: 1.5,
        dpi: 0.25,
        heldBy: ['南京金光紫金'],
        pendingFx: false,
        currency: 'CNY',
      });
    });

    it('2. Two inbound positions from two different managed funds aggregate, and heldBy lists both', () => {
      const pos1: FlPortfolioPosition = {
        id: 'pos-inbound-1',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '15000000',
        balance: {
          contributed_capital: '10000000',
          distributed_capital: '2000000',
        } as any,
      } as any;

      const pos2: FlPortfolioPosition = {
        id: 'pos-inbound-2',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow2.id,
        holder_fund: mgrFundRow2,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '30000000',
        balance: {
          contributed_capital: '20000000',
          distributed_capital: '4000000',
        } as any,
      } as any;

      const externalFund = buildFundFromPortfolio(
        extFundRow,
        [pos1, pos2],
        [],
        [],
        null,
        undefined,
        'external_fund',
      );

      expect(externalFund.ourPosition).toBeDefined();
      expect(externalFund.ourPosition).toEqual({
        invested: 30,
        fmv: 45,
        realized: 6,
        moic: 1.7, // (45 + 6) / 30 = 51 / 30 = 1.7
        dpi: 0.2,  // 6 / 30 = 0.2
        heldBy: ['南京金光紫金', 'Apex Growth Fund II'],
        pendingFx: false,
        currency: 'CNY',
      });
    });

    it('3. Mixed currencies across inbound positions => pendingFx: true and every money field null', () => {
      const pos1: FlPortfolioPosition = {
        id: 'pos-ccy-1',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '10000000',
        balance: {
          contributed_capital: '10000000',
          distributed_capital: '2000000',
        } as any,
      } as any;

      const pos2: FlPortfolioPosition = {
        id: 'pos-ccy-2',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow2.id,
        holder_fund: mgrFundRow2,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '5000000',
        balance: {
          contributed_capital: '5000000',
          distributed_capital: '1000000',
        } as any,
      } as any;

      const entryPos1: FlPortfolioLedgerEntry = {
        id: 'e-pos-1',
        position_id: 'pos-ccy-1',
        currency: 'CNY',
        entry_date: '2026-01-01',
      } as any;
      const entryPos2: FlPortfolioLedgerEntry = {
        id: 'e-pos-2',
        position_id: 'pos-ccy-2',
        currency: 'USD',
        entry_date: '2026-01-01',
      } as any;

      const externalFund = buildFundFromPortfolio(
        extFundRow,
        [pos1, pos2],
        [entryPos1, entryPos2],
        [],
        null,
        undefined,
        'external_fund',
      );

      expect(externalFund.ourPosition).toBeDefined();
      expect(externalFund.ourPosition).toEqual({
        invested: null,
        fmv: null,
        realized: null,
        moic: null,
        dpi: null,
        heldBy: ['南京金光紫金', 'Apex Growth Fund II'],
        pendingFx: true,
        currency: null,
      });

      // Also verify when currency mismatch comes from ledger entries
      const pos3: FlPortfolioPosition = {
        id: 'pos-entry-ccy',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '10000000',
        balance: {
          contributed_capital: '10000000',
          distributed_capital: '0',
        } as any,
      } as any;
      const entry1: FlPortfolioLedgerEntry = {
        id: 'e-1',
        position_id: 'pos-entry-ccy',
        currency: 'CNY',
        entry_date: '2026-01-01',
      } as any;
      const entry2: FlPortfolioLedgerEntry = {
        id: 'e-2',
        position_id: 'pos-entry-ccy',
        currency: 'EUR',
        entry_date: '2026-02-01',
      } as any;

      const fundMultiEntry = buildFundFromPortfolio(
        extFundRow,
        [pos3],
        [entry1, entry2],
        [],
        null,
        undefined,
        'external_fund',
      );
      expect(fundMultiEntry.ourPosition?.pendingFx).toBe(true);
      expect(fundMultiEntry.ourPosition?.currency).toBeNull();
      expect(fundMultiEntry.ourPosition?.invested).toBeNull();
      expect(fundMultiEntry.ourPosition?.fmv).toBeNull();
      expect(fundMultiEntry.ourPosition?.realized).toBeNull();
      expect(fundMultiEntry.ourPosition?.moic).toBeNull();
      expect(fundMultiEntry.ourPosition?.dpi).toBeNull();
    });

    it('4. An unvalued inbound position => fmv: null and moic: null, while invested still reports', () => {
      const unvaluedPos: FlPortfolioPosition = {
        id: 'pos-unvalued',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        fund: extFundRow,
        status: 'open',
        valuation_method: null,
        current_value: '0',
        balance: {
          contributed_capital: '10000000',
          distributed_capital: '2000000',
        } as any,
      } as any;

      const externalFund = buildFundFromPortfolio(
        extFundRow,
        [unvaluedPos],
        [],
        [],
        null,
        undefined,
        'external_fund',
      );

      expect(externalFund.ourPosition).toBeDefined();
      expect(externalFund.ourPosition).toEqual({
        invested: 10,
        fmv: null,
        realized: 2,
        moic: null,
        dpi: 0.2, // 2 / 10 = 0.2
        heldBy: ['南京金光紫金'],
        pendingFx: false,
        currency: 'CNY',
      });
    });

    it('5. Regression: the returned Fund.h for the external fund stays empty, and the holder managed fund h still contains the inbound position exactly once', () => {
      const inboundPos: FlPortfolioPosition = {
        id: 'pos-inbound',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '25000000',
        balance: {
          contributed_capital: '20000000',
          distributed_capital: '5000000',
        } as any,
      } as any;

      const allPositions = [inboundPos];

      // Build external fund row
      const externalFund = buildFundFromPortfolio(
        extFundRow,
        allPositions,
        [],
        [],
        null,
        undefined,
        'external_fund',
      );

      // External fund's holdings array MUST be empty
      expect(externalFund.h).toEqual([]);

      // Build holder managed fund row
      const managedFund = buildFundFromPortfolio(
        mgrFundRow1,
        allPositions,
        [],
        [],
      );

      // Managed fund's holdings array MUST contain the inbound position exactly once
      expect(managedFund.h).toHaveLength(1);
      expect(managedFund.h[0].positionId).toBe('pos-inbound');
      expect(managedFund.h[0].id).toBe(extFundRow.id);
    });

    it('6. A managed fund row is unchanged and has ourPosition === undefined', () => {
      const inboundPos: FlPortfolioPosition = {
        id: 'pos-inbound',
        fund_id: extFundRow.id,
        holder_fund_id: mgrFundRow1.id,
        holder_fund: mgrFundRow1,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '25000000',
        balance: {
          contributed_capital: '20000000',
          distributed_capital: '5000000',
        } as any,
      } as any;

      // Managed fund call (no disclosure or null disclosure)
      const managedFund = buildFundFromPortfolio(
        mgrFundRow1,
        [inboundPos],
        [],
        [],
      );
      expect(managedFund.ourPosition).toBeUndefined();

      // Liquidated fund disclosure
      const liquidatedFund = buildFundFromPortfolio(
        extFundRow,
        [inboundPos],
        [],
        [],
        null,
        undefined,
        'liquidated_fund',
      );
      expect(liquidatedFund.ourPosition).toBeUndefined();
    });

    it('supports inbound positions held by an investor entity', () => {
      const investorHolder = {
        id: 'inv-entity-1',
        name: 'Angel Holding Corp',
      };
      const investorPos: FlPortfolioPosition = {
        id: 'pos-inv-inbound',
        fund_id: extFundRow.id,
        holder_investor_id: investorHolder.id,
        holder_investor: investorHolder as any,
        holder_fund_id: null,
        holder_fund: null,
        fund: extFundRow,
        status: 'open',
        valuation_method: 'fair_value',
        current_value: '8000000',
        balance: {
          contributed_capital: '5000000',
          distributed_capital: '1000000',
        } as any,
      } as any;

      const externalFund = buildFundFromPortfolio(
        extFundRow,
        [investorPos],
        [],
        [],
        null,
        undefined,
        'external_fund',
      );

      expect(externalFund.ourPosition).toBeDefined();
      expect(externalFund.ourPosition?.heldBy).toEqual(['Angel Holding Corp']);
      expect(externalFund.ourPosition?.invested).toBe(5);
      expect(externalFund.ourPosition?.fmv).toBe(8);
      expect(externalFund.ourPosition?.realized).toBe(1);
      expect(externalFund.ourPosition?.moic).toBe(1.8);
      expect(externalFund.ourPosition?.dpi).toBe(0.2);
    });
  });

describe('managed fund LPs held by another managed fund (MB-569)', () => {
  const fundRowOf = (id: string, name: string, managed: boolean): Tables<'fl_funds'> =>
    ({
      id,
      workspace_id: 'w1',
      name,
      canonical_name: name,
      legal_name: null,
      english_name: null,
      registration_no: null,
      managed,
      ownership_basis: managed ? 'commitment' : 'capital_account',
      base_currency: 'CNY',
      vintage_year: 2024,
      fund_life_years: null,
      status: 'investing',
      mgmt_fee_rate: null,
      carry_rate: null,
      preferred_return_rate: null,
      description: null,
      created_by: null,
      updated_by: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }) as unknown as Tables<'fl_funds'>;
  const huaian = fundRowOf('f-hua', '淮安熙和', true);
  const yuesheng = fundRowOf('f-yue', '月升星繁', true);
  const external = fundRowOf('f-ext', '紫东天使', false);

  const positionOf = (
    id: string,
    holder: { investor?: string; fund?: Tables<'fl_funds'> },
    target: Tables<'fl_funds'>,
    commitment: string,
    drawn: string,
  ): FlPortfolioPosition =>
    ({
      id,
      workspace_id: 'w1',
      holder_investor_id: holder.investor ?? null,
      holder_fund_id: holder.fund?.id ?? null,
      fund_id: target.id,
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '2024-09-06',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '2024-09-06T00:00:00Z',
      updated_at: '2024-09-06T00:00:00Z',
      current_value: '0',
      valuation_method: null,
      balance: {
        position_id: id,
        currency: 'CNY',
        commitment,
        drawn_commitment: drawn,
        quantity: '0',
        contributed_capital: drawn,
        distributed_capital: '0',
        cash_balance: `-${drawn}`,
        net_invested: drawn,
        current_value: '0',
        committed: commitment,
        contributed: drawn,
        unfunded: '0',
        cash_total: `-${drawn}`,
        distributed: '0',
      },
      holder_investor: null,
      holder_fund: holder.fund ?? null,
      fund: target,
      asset: null,
      funding_source: null,
    }) as unknown as FlPortfolioPosition;

  // 月升星繁 committed 95.5M to 淮安熙和 and paid in 29M; an outside LP committed 75M and paid 14M.
  const fundHeld = positionOf('pos-yue-hua', { fund: yuesheng }, huaian, '95500000', '29000000');
  const outsideLp = positionOf('pos-jinhu-hua', { investor: 'inv-jinhu' }, huaian, '75000000', '14000000');
  const externalFof = positionOf('pos-yue-ext', { fund: yuesheng }, external, '0', '6400000');
  const positions = [fundHeld, outsideLp, externalFof];

  it('counts the fund-held position in the managed target\'s size and called capital', () => {
    const fund = buildFundFromPortfolio(huaian, positions, [], []);
    expect(fund.size).toBe(170.5);
    expect(fund.called).toBe(43);
    expect(fund.calledPct).toBeCloseTo((43 / 170.5) * 100, 6);
  });

  it('keeps the inbound holding out of the target fund\'s own holdings', () => {
    const fund = buildFundFromPortfolio(huaian, positions, [], []);
    expect(fund.h).toEqual([]);
  });

  it('keeps the fund-held position as the holder fund\'s fund-of-funds holding, not its LP capital', () => {
    const holder = buildFundFromPortfolio(yuesheng, positions, [], []);
    expect(holder.size).toBe(0);
    expect(holder.h.map((h) => h.id)).toEqual(expect.arrayContaining(['f-hua']));
  });

  it('does not count a managed fund\'s position in an external fund as that fund\'s LP capital', () => {
    const fund = buildFundFromPortfolio(external, positions, [], []);
    expect(fund.size).toBe(0);
    expect(fund.called).toBe(0);
  });

  it('lists the holder fund on the managed target\'s LP list', () => {
    const lps = buildFundLpHolders(positions, [huaian, yuesheng, external]);
    expect(lps).toEqual([
      expect.objectContaining({
        id: 'f-yue',
        n: '月升星繁',
        type: 'fund',
        stakes: { 'f-hua': 95.5 },
        invested: { 'f-hua': 29 },
      }),
    ]);
  });

  it('lists no fund LPs when only investors hold funds (Startech shape)', () => {
    expect(buildFundLpHolders([outsideLp], [huaian])).toEqual([]);
  });
});
