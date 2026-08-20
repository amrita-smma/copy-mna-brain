import { describe, it, expect } from 'vitest';
import {
  assetRowToHolding,
  assetTypeToHoldingType,
  buildAssetCreatePayload,
  computeFundHistory,
  fundRowToFund,
  holdingToAssetUpdateInput,
  holdingTypeToAssetType,
  quarterEndLabel,
  quarterToPayload,
  trailingQuarterEnds,
  txnRowToTxn,
  txnToPayload,
  valuationRowToQuarter,
} from './adapters';
import type { Tables } from '@/lib/repositories';
import type { HoldingType } from './types';

type AssetRow = Tables<'fund_assets'>;
type TxnRow = Tables<'fund_asset_transactions'>;
type ValuationRow = Tables<'fund_asset_valuations'>;

const BASE_ASSET: AssetRow = {
  id: 'asset-1',
  workspace_id: 'w1',
  asset_type: 'direct_investment',
  asset_name: 'Acme Robotics',
  english_name: null,
  legal_name: 'Acme Robotics Pte Ltd',
  country: 'Singapore',
  funding_source: 'Series B',
  investment_type: 'Direct Investment',
  entry_date: '2023-01-15',
  maturity_date: null,
  commitment_amount: null,
  stake_pct: 12.5,
  sector: 'Robotics',
  sub_sector: null,
  investment_currency: 'USD',
  report_currency: 'USD',
  investment_description: 'Series B lead investment.',
  key_rights: 'Board seat',
  subscription_fee_amount: 1000,
  mgmt_fee_rate_pct: 2,
  carry_rate_pct: 20,
  legal_fees_amount: 15000,
  type_details: { instrumentType: 'equity', investingEntity: 'Acme SPV LP', reportDate: '2026-06-30', prefReturnRatePct: 8 },
  status: 'active',
  current_price_per_share: 12.5,
  share_count: 50000,
  gross_moic: 1.35,
  gross_irr: 0.09,
  dpi: 0.1,
  invested_capital_amount: 500000,
  net_distribution_amount: 50000,
  fmv_amount: null,
  is_manually_overridden: false,
  metrics_computed_at: null,
  ai_opinion_verdict: null,
  ai_opinion_summary: null,
  ai_opinion_status: null,
  ai_opinion_updated_at: null,
  ai_opinion_confidence: null,
  ai_opinion_data_gaps: null,
  created_by: null,
  updated_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('assetTypeToHoldingType / holdingTypeToAssetType', () => {
  const cases: Array<[HoldingType, AssetRow['asset_type'], string | undefined]> = [
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
    expect(assetTypeToHoldingType(backend.assetType, backend.instrumentType ? { instrumentType: backend.instrumentType } : {})).toBe(tp);
  });

  it('defaults an instrumentType-less direct_investment to Equity', () => {
    expect(assetTypeToHoldingType('direct_investment', {})).toBe('Equity');
    expect(assetTypeToHoldingType('direct_investment', null)).toBe('Equity');
  });
});

describe('fundRowToFund', () => {
  it('maps rollups and derives calledPct from commitment/called', () => {
    const fund = fundRowToFund({
      id: 'f1',
      workspace_id: 'w1',
      name: 'Direct Investments',
      description: null,
      vintage_year: 2023,
      commitment_size_amount: 5_000_000,
      status: 'investing',
      base_currency: 'USD',
      called_amount: 500_000,
      fmv_amount: 625_000,
      realized_amount: 50_000,
      dpi: 0.1,
      tvpi: 1.35,
      irr: 0.09,
      metrics_computed_at: null,
      created_by: null,
      updated_by: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    // size/called are in millions (the UI's own convention, ported from the mockup).
    expect(fund).toMatchObject({ id: 'f1', n: 'Direct Investments', size: 5, called: 0.5, calledPct: 10, st: 'Investing', h: [] });
  });

  it('capitalizes harvesting status', () => {
    const fund = fundRowToFund({ ...BASE_FUND_ROW(), status: 'harvesting' });
    expect(fund.st).toBe('Harvesting');
  });

  it('does not divide by zero when commitment is unset', () => {
    const fund = fundRowToFund({ ...BASE_FUND_ROW(), commitment_size_amount: null });
    expect(fund.calledPct).toBe(0);
  });
});

function BASE_FUND_ROW(): Tables<'funds'> {
  return {
    id: 'f1',
    workspace_id: 'w1',
    name: 'Fund',
    description: null,
    vintage_year: null,
    commitment_size_amount: 1000,
    status: 'investing',
    base_currency: 'USD',
    called_amount: null,
    fmv_amount: null,
    realized_amount: null,
    dpi: null,
    tvpi: null,
    irr: null,
    metrics_computed_at: null,
    created_by: null,
    updated_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('assetRowToHolding + holdingToAssetUpdateInput round trip', () => {
  it('round-trips every field the UI actually edits (Legal/Business/Fee tabs)', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);

    // Fields the Explore-verified mutation surface actually writes.
    expect(holding.inv?.legalName).toBe('Acme Robotics Pte Ltd');
    expect(holding.inv?.entity).toBe('Acme SPV LP');
    expect(holding.d?.geo).toBe('Singapore');
    expect(holding.investType).toBe('Direct Investment');
    expect(holding.dt).toBe('2023-01-15');
    expect(holding.inv?.fundingSource).toBe('Series B');
    expect(holding.inv?.stakePct).toBe(12.5);
    expect(holding.inv?.reportDate).toBe('2026-06-30');
    expect(holding.inv?.investCcy).toBe('USD');
    expect(holding.inv?.ccy).toBe('USD');
    expect(holding.inv?.description).toBe('Series B lead investment.');
    expect(holding.inv?.keyRights).toBe('Board seat');
    expect(holding.inv?.mgmtFeeRate).toBe(2);
    expect(holding.inv?.prefReturnRate).toBe(8);
    expect(holding.inv?.carryRate).toBe(20);
    expect(holding.inv?._cur).toBe(12.5);

    const payload = holdingToAssetUpdateInput(holding);
    expect(payload).toMatchObject({
      legalName: 'Acme Robotics Pte Ltd',
      country: 'Singapore',
      fundingSource: 'Series B',
      investmentType: 'Direct Investment',
      entryDate: '2023-01-15',
      stakePct: 12.5,
      investmentCurrency: 'USD',
      reportCurrency: 'USD',
      investmentDescription: 'Series B lead investment.',
      keyRights: 'Board seat',
      mgmtFeeRatePct: 2,
      carryRatePct: 20,
      currentPricePerShare: 12.5,
    });
    expect(payload.typeDetails).toMatchObject({
      instrumentType: 'equity',
      investingEntity: 'Acme SPV LP',
      reportDate: '2026-06-30',
      prefReturnRatePct: 8,
    });
  });

  it('preserves an explicit null (a cleared field) rather than dropping it as undefined', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);
    holding.inv!.legalName = null;
    const payload = holdingToAssetUpdateInput(holding);
    // null must survive so the PATCH route's `!== undefined` check still fires.
    expect(payload.legalName).toBeNull();
    expect(payload.legalName).not.toBeUndefined();
  });

  it('round-trips the english name for an asset recorded under a non-English name', () => {
    const holding = assetRowToHolding(
      { ...BASE_ASSET, asset_name: '株式会社アクメ', english_name: 'Acme Robotics' },
      [],
      [],
    );
    expect(holding.n).toBe('株式会社アクメ');
    expect(holding.englishName).toBe('Acme Robotics');

    const payload = holdingToAssetUpdateInput(holding);
    expect(payload.assetName).toBe('株式会社アクメ');
    expect(payload.englishName).toBe('Acme Robotics');
  });

  it('leaves englishName undefined when no english name is stored', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);
    expect(holding.englishName).toBeUndefined();
  });

  it('clearing the english name sends null (not undefined), so the PATCH route actually clears it', () => {
    const holding = assetRowToHolding({ ...BASE_ASSET, english_name: 'Acme Robotics' }, [], []);
    holding.englishName = undefined;
    const payload = holdingToAssetUpdateInput(holding);
    expect(payload.englishName).toBeNull();
    expect(payload.englishName).not.toBeUndefined();
  });

  it('clearing the country field actually clears it, instead of falling back to the stale initial value', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);
    expect(holding.d?.geo).toBe('Singapore');
    holding.d!.geo = null;
    const payload = holdingToAssetUpdateInput(holding);
    expect(payload.country).toBeNull();
  });

  it('clearing the entry date sends null (not undefined), so the PATCH route actually clears it', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);
    holding.dt = '';
    const payload = holdingToAssetUpdateInput(holding);
    expect(payload.entryDate).toBeNull();
    expect(payload.entryDate).not.toBeUndefined();
  });

  it('round-trips fund-of-funds type_details fields not modeled elsewhere in the UI (fundManagerName/fundLifeYears)', () => {
    const fof = assetRowToHolding(
      {
        ...BASE_ASSET,
        asset_type: 'fund_of_funds',
        type_details: {
          targetFundName: 'Meridian Growth Partners III',
          fundManagerName: 'Meridian Capital',
          fundLifeYears: 10,
        },
      },
      [],
      [],
    );
    expect(fof.d?.fundManagerName).toBe('Meridian Capital');
    expect(fof.d?.fundLifeYears).toBe(10);

    // Editing an unrelated field (e.g. legal name) must not silently drop
    // fundManagerName/fundLifeYears from the rebuilt type_details blob.
    fof.inv!.legalName = 'Renamed';
    const payload = holdingToAssetUpdateInput(fof);
    expect(payload.typeDetails).toMatchObject({
      targetFundName: 'Meridian Growth Partners III',
      fundManagerName: 'Meridian Capital',
      fundLifeYears: 10,
    });
  });

  it('derives fmv from gross_moic/invested_capital/net_distribution when there is invested capital', () => {
    const holding = assetRowToHolding(BASE_ASSET, [], []);
    // totalValueGross = 1.35 * 500000 = 675000; fmv = 675000 - 50000 = 625000 raw dollars -> 0.625M
    expect(holding.fmv).toBe(0.625);
  });

  it('falls back to the latest valuation snapshot when invested capital is zero', () => {
    const asset = { ...BASE_ASSET, invested_capital_amount: 0, gross_moic: 0 };
    const valuation: ValuationRow = { ...BASE_VALUATION(), market_value_amount: 2_100_000 };
    const holding = assetRowToHolding(asset, [], [valuation]);
    expect(holding.fmv).toBe(2.1);
  });

  it('gives Obligation/Shares holdings no .inv (matches the generic read-only branch)', () => {
    const obligation = assetRowToHolding(
      { ...BASE_ASSET, type_details: { instrumentType: 'obligation' } },
      [],
      [],
    );
    expect(obligation.tp).toBe('Obligation');
    expect(obligation.inv).toBeUndefined();

    const shares = assetRowToHolding(
      { ...BASE_ASSET, type_details: { instrumentType: 'shares' } },
      [],
      [],
    );
    expect(shares.tp).toBe('Shares');
    expect(shares.inv).toBeUndefined();
  });

  it('gives Cash a transaction ledger (.inv) so it rolls up from transactions', () => {
    const cash = assetRowToHolding({ ...BASE_ASSET, asset_type: 'cash', type_details: {} }, [], []);
    expect(cash.tp).toBe('Cash');
    expect(cash.inv).toBeDefined();
    expect(cash.inv?.txns).toEqual([]);
    // Manual override buffers round-trip through the invested/fmv columns.
    expect(cash.inv?._investedCapitalAmount).toBe(BASE_ASSET.invested_capital_amount ?? undefined);
  });
});

function BASE_VALUATION(): ValuationRow {
  return {
    id: 'val-1',
    fund_asset_id: 'asset-1',
    as_of_date: '2026-06-30',
    period_label: 'Q2 2026',
    valuation_method: 'comparables',
    currency: 'USD',
    market_value_amount: 625_000,
    price_per_share: 12.5,
    shares_outstanding: 50_000,
    shareholding_pct: 12.5,
    invested_capital_cum_amount: 500_000,
    net_distribution_amount: 50_000,
    gross_moic: 1.35,
    dpi: 0.1,
    gross_xirr: 0.09,
    notes: 'note',
    created_by: null,
    updated_by: null,
    created_at: '2026-06-30T00:00:00Z',
    updated_at: '2026-06-30T00:00:00Z',
  };
}

describe('Txn round trip', () => {
  const cases: Array<[TxnRow['txn_type'], string]> = [
    ['contribution', 'Buy'],
    ['divestment', 'Sell'],
    ['other', 'Other'],
  ];

  it.each(cases)('%s <-> %s', (txnType, uiType) => {
    const row: TxnRow = { ...BASE_TXN(), txn_type: txnType };
    const txn = txnRowToTxn(row);
    expect(txn.type).toBe(uiType);
    const payload = txnToPayload(txn);
    expect(payload.txnType).toBe(txnType);
  });

  it('reads legacy distribution rows as Sell', () => {
    const row: TxnRow = { ...BASE_TXN(), txn_type: 'distribution' as TxnRow['txn_type'] };
    const txn = txnRowToTxn(row);
    expect(txn.type).toBe('Sell');
  });

  it('reads an unrecognised backend txn_type as Other', () => {
    const row: TxnRow = { ...BASE_TXN(), txn_type: 'unknown_future_type' as TxnRow['txn_type'] };
    const txn = txnRowToTxn(row);
    expect(txn.type).toBe('Other');
  });

  it('folds interest_income/return_of_capital into Other with a recognizable label, and round-trips the label back to the same backend type', () => {
    const interest = txnRowToTxn({ ...BASE_TXN(), txn_type: 'interest_income' });
    expect(interest.type).toBe('Other');
    expect(interest.label).toBe('Interest income');
    expect(txnToPayload(interest).txnType).toBe('interest_income');

    const returnOfCapital = txnRowToTxn({ ...BASE_TXN(), txn_type: 'return_of_capital' });
    expect(returnOfCapital.label).toBe('Return of capital');
    expect(txnToPayload(returnOfCapital).txnType).toBe('return_of_capital');
  });

  it('respects a custom sub_type_label over the humanized default', () => {
    const row = txnRowToTxn({ ...BASE_TXN(), txn_type: 'other', sub_type_label: 'Warrant exercise' });
    expect(row.label).toBe('Warrant exercise');
    expect(txnToPayload(row).txnType).toBe('other');
    expect(txnToPayload(row).subTypeLabel).toBe('Warrant exercise');
  });

  it('round-trips core numeric fields (value/shares scaled in millions, pps unscaled)', () => {
    const txn = txnRowToTxn(BASE_TXN());
    expect(txn).toMatchObject({ date: '2023-01-15', pps: 10, shares: 0.05, value: 0.5 });
    const payload = txnToPayload(txn);
    expect(payload).toMatchObject({ txnDate: '2023-01-15', pricePerShare: 10, shareCount: 50_000, valueAmount: 500_000 });
  });

  it('omits txnCurrency (undefined, not null) so editing a transaction never clobbers its existing currency', () => {
    // txn_currency was 'USD' at the source; the UI has no field for it.
    const txn = txnRowToTxn({ ...BASE_TXN(), txn_currency: 'USD' });
    const payload = txnToPayload(txn);
    expect(payload.txnCurrency).toBeUndefined();
  });

  it('round-trips sell_proceeds_destination on divestment transactions', () => {
    const cashInFundRow: TxnRow = {
      ...BASE_TXN(),
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
    };
    const cashInFundTxn = txnRowToTxn(cashInFundRow);
    expect(cashInFundTxn.sellProceedsDestination).toBe('cash_in_fund');
    expect(txnToPayload(cashInFundTxn).sellProceedsDestination).toBe('cash_in_fund');

    const distributedRow: TxnRow = {
      ...BASE_TXN(),
      txn_type: 'divestment',
      sell_proceeds_destination: 'distributed_to_investor',
    };
    const distributedTxn = txnRowToTxn(distributedRow);
    expect(distributedTxn.sellProceedsDestination).toBe('distributed_to_investor');
    expect(txnToPayload(distributedTxn).sellProceedsDestination).toBe('distributed_to_investor');
  });

  it('normalizes sellProceedsDestination to null for non-divestment transactions in txnToPayload', () => {
    const buyTxn: TxnRow = {
      ...BASE_TXN(),
      txn_type: 'contribution',
      sell_proceeds_destination: null,
    };
    const txn = txnRowToTxn(buyTxn);
    // Even if somehow populated on a Buy txn, payload forces null
    txn.sellProceedsDestination = 'cash_in_fund';
    const payload = txnToPayload(txn);
    expect(payload.txnType).toBe('contribution');
    expect(payload.sellProceedsDestination).toBeNull();
  });

  it('maps internal_transfer to Other with Retained sale proceeds label, sets isGenerated and sourceDivestmentTxnId', () => {
    const transferRow: TxnRow = {
      ...BASE_TXN(),
      txn_type: 'internal_transfer',
      sub_type_label: 'Retained sale proceeds',
      source_divestment_txn_id: 'sale-txn-123',
      value_amount: 300_000,
    };
    const txn = txnRowToTxn(transferRow);
    expect(txn.type).toBe('Other');
    expect(txn.label).toBe('Retained sale proceeds');
    expect(txn.isGenerated).toBe(true);
    expect(txn.sourceDivestmentTxnId).toBe('sale-txn-123');
    expect(txn.value).toBe(0.3);

    // txnToPayload never outputs internal_transfer or sourceDivestmentTxnId
    const payload = txnToPayload(txn);
    expect(payload.txnType).toBe('other');
    expect((payload as unknown as Record<string, unknown>).sourceDivestmentTxnId).toBeUndefined();
  });
});

function BASE_TXN(): TxnRow {
  return {
    id: 'txn-1',
    fund_asset_id: 'asset-1',
    fund_id: 'fund-1',
    holding_entity_id: 'entity-1',
    funding_source_id: 'source-1',
    txn_date: '2023-01-15',
    txn_type: 'contribution',
    sub_type_label: null,
    price_per_share: 10,
    share_count: 50_000,
    value_amount: 500_000,
    txn_currency: 'USD',
    fx_rate: 1,
    sell_proceeds_destination: null,
    source_divestment_txn_id: null,
    notes: 'Initial investment',
    created_by: null,
    updated_by: null,
    created_at: '2023-01-15T00:00:00Z',
    updated_at: '2023-01-15T00:00:00Z',
  };
}

describe('Quarter round trip', () => {
  it('maps a valuation row to a Quarter and back to an upsert payload', () => {
    const quarter = valuationRowToQuarter(BASE_VALUATION());
    expect(quarter).toMatchObject({
      id: 'val-1',
      asOfDate: '2026-06-30',
      q: 'Q2 2026',
      mv: 0.625,
      pps: 12.5,
      sharesOut: 0.05,
      shPct: 12.5,
      moic: 1.35,
      xirr: 9, // gross_xirr 0.09 (fraction) -> 9 (percentage number)
    });
    const payload = quarterToPayload(quarter, quarter.asOfDate!);
    expect(payload).toMatchObject({
      asOfDate: '2026-06-30',
      periodLabel: 'Q2 2026',
      marketValueAmount: 625_000,
      pricePerShare: 12.5,
      sharesOutstanding: 50_000,
      shareholdingPct: 12.5,
      grossMoic: 1.35,
      grossXirr: 0.09,
    });
  });

  it('falls back to the as_of_date as the label when no period_label is set', () => {
    const quarter = valuationRowToQuarter({ ...BASE_VALUATION(), period_label: null });
    expect(quarter.q).toBe('2026-06-30');
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
          { ...BASE_TXN(), txn_type: 'contribution' as const, txn_date: '2023-01-15', value_amount: 500_000 },
          { ...BASE_TXN(), txn_type: 'contribution' as const, txn_date: '2026-01-01', value_amount: 100_000 },
        ],
        valuations: [
          { ...BASE_VALUATION(), as_of_date: '2026-06-30', market_value_amount: 700_000 },
          { ...BASE_VALUATION(), as_of_date: '2025-12-31', market_value_amount: 600_000 },
        ],
      },
      {
        txns: [{ ...BASE_TXN(), txn_type: 'contribution' as const, txn_date: '2024-01-01', value_amount: 200_000 }],
        valuations: [{ ...BASE_VALUATION(), as_of_date: '2025-09-30', market_value_amount: 210_000 }],
      },
    ];

    const hist = computeFundHistory(perAsset, 10_000_000, quarterEnds);

    // Commitment: flat line at the fund's current commitment, in millions.
    expect(hist.committed).toEqual([10, 10, 10, 10]);

    // Invested (contributions with txn_date <= quarter end), in millions:
    // Q3'25 / Q4'25 (ends 2025-09-30 / 2025-12-31): asset1's 500k (2023) +
    // asset2's 200k (2024) = 0.7 — asset1's 2026-01-01 contribution is later.
    // Q1'26 / Q2'26 (ends 2026-03-31 / 2026-06-30): 2026-01-01 <= both, so
    // asset1's second contribution now counts too = 0.8.
    expect(hist.called).toEqual([0.7, 0.7, 0.8, 0.8]);

    // Unrealized (latest valuation with as_of_date <= quarter end), in millions:
    // Q3'25: asset1 has no valuation yet (0) + asset2's 210k = 0.21
    // Q4'25: asset1's 600k lands + asset2's 210k (no newer one) = 0.81
    // Q1'26: unchanged = 0.81
    // Q2'26: asset1's 700k supersedes 600k + asset2's 210k = 0.91
    expect(hist.fmv).toEqual([0.21, 0.81, 0.81, 0.91]);
  });

  it('returns a flat zero commitment line when the fund has no commitment set', () => {
    const hist = computeFundHistory([], null, quarterEnds);
    expect(hist.committed).toEqual([0, 0, 0, 0]);
    expect(hist.called).toEqual([0, 0, 0, 0]);
    expect(hist.fmv).toEqual([0, 0, 0, 0]);
  });
});
