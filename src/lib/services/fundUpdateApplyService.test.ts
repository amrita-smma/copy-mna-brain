import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import type { ParsedAsset } from '@/lib/fund_updates';

function sampleAsset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: 'GOTO',
    name: 'GOTO Group',
    legalName: 'PT GoTo',
    country: 'Indonesia',
    investmentTypeLabel: 'Direct Investments',
    assetType: 'direct_investment',
    fund: 'Others',
    entity: 'Asia Star Fund Ltd',
    fundingSource: 'DCA',
    fundingSourceRaw: 'DCA',
    entryDate: '2021-01-01',
    stakePct: 1,
    commitmentAmount: null,
    dealType: null,
    mgmtFeeRatePct: null,
    sector: 'VC',
    subSector: 'DI',
    instrument: 'Common equity',
    sharesOutstanding: 100,
    sourceRef: 'S009',
    vintageYear: 2021,
    valuations: [
      {
        asOfDate: '2026-03-31',
        periodLabel: 'Q1 2026',
        marketValue: 100,
        pricePerShare: 1,
        sharesOutstanding: 100,
        shareholdingPct: 1,
        investedCapitalCum: 50,
        grossMoic: 2,
        grossXirr: null,
        valuationMethod: 'stock_market_price',
        notes: null,
      },
    ],
    currentPricePerShare: 1,
    txns: [
      {
        date: '2021-01-01',
        type: 'contribution',
        subTypeLabel: null,
        pricePerShare: 1,
        shareCount: 50,
        valueAmount: 50,
        currency: 'USD',
        fxRate: null,
        notes: null,
      },
    ],
    ...overrides,
  };
}

describe('FundUpdateApplyService', () => {
  let fundRepo: { findAll: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  let fundAssetRepo: {
    findAll: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let txnRepo: {
    findByFundAssetIds: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let valuationRepo: {
    findByFundAssetIds: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  let holdingEntityRepo: { findAll: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  let fundSourceRepo: { findAll: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  let fundMetricsService: { recomputeAsset: ReturnType<typeof vi.fn> };
  let service: FundUpdateApplyService;

  beforeEach(() => {
    fundRepo = {
      findAll: vi.fn().mockResolvedValue([{ id: 'fund-others', name: 'Others' }]),
      insert: vi.fn().mockImplementation(async ({ name }) => ({ id: `fund-${name}`, name })),
    };
    fundAssetRepo = {
      findAll: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'asset-new' }),
    };
    txnRepo = {
      findByFundAssetIds: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({}),
    };
    valuationRepo = {
      findByFundAssetIds: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    };
    holdingEntityRepo = {
      findAll: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'he-1', name: 'Asia Star Fund Ltd' }),
    };
    fundSourceRepo = {
      findAll: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'fs-1', name: 'DCA' }),
    };
    fundMetricsService = { recomputeAsset: vi.fn().mockResolvedValue(undefined) };

    service = new FundUpdateApplyService(
      fundRepo as never,
      fundAssetRepo as never,
      txnRepo as never,
      valuationRepo as never,
      holdingEntityRepo as never,
      fundSourceRepo as never,
      fundMetricsService as never,
    );
  });

  it('marks unmatched assets as new', async () => {
    const review = await service.buildReview([sampleAsset()]);
    expect(review).toHaveLength(1);
    expect(review[0].status).toBe('new');
    expect(review[0].missing_txn_count).toBe(1);
    expect(review[0].missing_valuation_count).toBe(1);
  });

  it('marks identical existing assets as unchanged', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      {
        id: 'asset-1',
        asset_name: 'GOTO Group',
        type_details: { sheetCode: 'GOTO', sourceRef: 'S009' },
      },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      {
        fund_asset_id: 'asset-1',
        txn_date: '2021-01-01',
        txn_type: 'contribution',
        value_amount: 50,
        share_count: 50,
        price_per_share: 1,
      },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([
      { fund_asset_id: 'asset-1', as_of_date: '2026-03-31' },
    ]);

    const review = await service.buildReview([sampleAsset()]);
    expect(review[0].status).toBe('unchanged');
    expect(review[0].matched_asset_id).toBe('asset-1');
    expect(review[0].missing_txn_count).toBe(0);
  });

  it('only proposes missing txns/valuations for matched assets', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-1', asset_name: 'GOTO Group', type_details: { sheetCode: 'GOTO' } },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      {
        fund_asset_id: 'asset-1',
        txn_date: '2021-01-01',
        txn_type: 'contribution',
        value_amount: 50,
        share_count: 50,
        price_per_share: 1,
      },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([]);

    const review = await service.buildReview([sampleAsset()]);
    expect(review[0].status).toBe('add_missing');
    expect(review[0].missing_txn_count).toBe(0);
    expect(review[0].missing_valuation_count).toBe(1);
  });

  it('creates new assets and inserts ledger on apply', async () => {
    fundRepo.findAll.mockResolvedValue([
      { id: 'fund-others', name: 'Others' },
      { id: 'f1', name: 'Startech Growth Fund 1' },
      { id: 'f2', name: 'Startech Growth Fund 2' },
      { id: 'f3', name: 'Startech Growth Fund 3' },
      { id: 'f4', name: 'Startech Growth Fund 4' },
      { id: 'f5', name: 'Startech Growth Fund 5' },
      { id: 'm1', name: 'Meranti 1' },
      { id: 'm2', name: 'Meranti 2' },
    ]);

    const result = await service.applySelected([sampleAsset()], ['GOTO']);
    expect(result.created_assets).toBe(1);
    expect(result.txns_inserted).toBe(1);
    expect(result.valuations_upserted).toBe(1);
    expect(fundAssetRepo.insert).toHaveBeenCalled();
    expect(fundMetricsService.recomputeAsset).toHaveBeenCalledWith('asset-new');
  });

  it('skips unchanged assets on apply', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-1', asset_name: 'GOTO Group', type_details: { sheetCode: 'GOTO' } },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      {
        fund_asset_id: 'asset-1',
        txn_date: '2021-01-01',
        txn_type: 'contribution',
        value_amount: 50,
        share_count: 50,
        price_per_share: 1,
      },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([
      { fund_asset_id: 'asset-1', as_of_date: '2026-03-31' },
    ]);
    fundRepo.findAll.mockResolvedValue([
      { id: 'fund-others', name: 'Others' },
      { id: 'f1', name: 'Startech Growth Fund 1' },
      { id: 'f2', name: 'Startech Growth Fund 2' },
      { id: 'f3', name: 'Startech Growth Fund 3' },
      { id: 'f4', name: 'Startech Growth Fund 4' },
      { id: 'f5', name: 'Startech Growth Fund 5' },
      { id: 'm1', name: 'Meranti 1' },
      { id: 'm2', name: 'Meranti 2' },
    ]);

    const result = await service.applySelected([sampleAsset()], ['GOTO']);
    expect(result.skipped).toBe(1);
    expect(result.created_assets).toBe(0);
    expect(txnRepo.insert).not.toHaveBeenCalled();
  });

  it('applies only selected missing txns when selection is provided', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-1', asset_name: 'GOTO Group', type_details: { sheetCode: 'GOTO' } },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      {
        fund_asset_id: 'asset-1',
        txn_date: '2021-01-01',
        txn_type: 'contribution',
        value_amount: 50,
        share_count: 50,
        price_per_share: 1,
      },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([]);
    fundRepo.findAll.mockResolvedValue([
      { id: 'fund-others', name: 'Others' },
      { id: 'f1', name: 'Startech Growth Fund 1' },
      { id: 'f2', name: 'Startech Growth Fund 2' },
      { id: 'f3', name: 'Startech Growth Fund 3' },
      { id: 'f4', name: 'Startech Growth Fund 4' },
      { id: 'f5', name: 'Startech Growth Fund 5' },
      { id: 'm1', name: 'Meranti 1' },
      { id: 'm2', name: 'Meranti 2' },
    ]);

    const extraTxn = {
      date: '2022-06-01',
      type: 'contribution' as const,
      subTypeLabel: null,
      pricePerShare: 2,
      shareCount: 25,
      valueAmount: 50,
      currency: 'USD',
      fxRate: null,
      notes: null,
    };
    const asset = sampleAsset({
      txns: [
        {
          date: '2021-01-01',
          type: 'contribution',
          subTypeLabel: null,
          pricePerShare: 1,
          shareCount: 50,
          valueAmount: 50,
          currency: 'USD',
          fxRate: null,
          notes: null,
        },
        extraTxn,
      ],
    });

    const result = await service.applySelected([asset], ['GOTO'], [
      { asset_code: 'GOTO', txns: [extraTxn], valuations: asset.valuations },
    ]);
    expect(result.updated_assets).toBe(1);
    expect(result.txns_inserted).toBe(1);
    expect(txnRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('sorts review assets by status then code', async () => {
    const review = await service.buildReview([
      sampleAsset({ code: 'ZZZZ', name: 'Z Co' }),
      sampleAsset({ code: 'AAAA', name: 'A Co' }),
    ]);
    expect(review.map((r) => r.code)).toEqual(['AAAA', 'ZZZZ']);
  });
});
