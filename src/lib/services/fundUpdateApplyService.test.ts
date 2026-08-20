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
      findAll: vi.fn().mockResolvedValue([
        { id: 'fund-others', name: 'Others' },
        { id: 'f1', name: 'Startech Growth Fund 1' },
        { id: 'f2', name: 'Startech Growth Fund 2' },
        { id: 'f3', name: 'Startech Growth Fund 3' },
        { id: 'f4', name: 'Startech Growth Fund 4' },
        { id: 'f5', name: 'Startech Growth Fund 5' },
        { id: 'm1', name: 'Meranti 1' },
        { id: 'm2', name: 'Meranti 2' },
      ]),
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

  describe('v1 apply vs legacy behavior', () => {
    it('throws in v1 apply when proposed asset has unresolved fund reference', async () => {
      const asset = sampleAsset({ fund: '' });
      await expect(
        service.applySelected([asset], ['GOTO'], undefined, { isV1: true }),
      ).rejects.toThrow('unresolved fund reference');
    });

    it('throws in v1 apply when proposed asset has unresolved currency', async () => {
      const asset = sampleAsset({
        fund: 'Fund A',
        txns: [
          {
            date: '2021-01-01',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 1,
            shareCount: 50,
            valueAmount: 50,
            currency: '', // Missing currency
            fxRate: null,
            notes: null,
          },
        ],
      });
      await expect(
        service.applySelected([asset], ['GOTO'], undefined, { isV1: true }),
      ).rejects.toThrow('unresolved currency');
    });

    it('preserves CNY currency in v1 apply without synthesizing USD', async () => {
      const asset = sampleAsset({
        fund: 'China Fund I',
        txns: [
          {
            date: '2021-01-01',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 1,
            shareCount: 50,
            valueAmount: 50,
            currency: 'CNY',
            fxRate: null,
            notes: null,
          },
        ],
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, { isV1: true });
      expect(result.created_assets).toBe(1);
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          investment_currency: 'CNY',
          report_currency: 'CNY',
        }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          txn_currency: 'CNY',
        }),
      );
    });

    it('preserves legacy fallback to Others and USD when isV1 is false/omitted', async () => {
      const asset = sampleAsset({
        fund: '',
        txns: [
          {
            date: '2021-01-01',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 1,
            shareCount: 50,
            valueAmount: 50,
            currency: '', // Missing currency
            fxRate: null,
            notes: null,
          },
        ],
      });

      const result = await service.applySelected([asset], ['GOTO']);
      expect(result.created_assets).toBe(1);
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          investment_currency: 'USD',
          report_currency: 'USD',
        }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: 'fund-others',
          txn_currency: 'USD',
        }),
      );
    });
  });

  describe('buildFullReview & catalog matching', () => {
    it('marks unmatched names as new with matched_id null and lists them in unique catalogs', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([]);

      const asset = sampleAsset({
        fund: 'Startech Fund VI',
        entity: 'New Holding Corp',
        fundingSource: 'Direct Wire',
      });

      const fullReview = await service.buildFullReview([asset]);

      expect(fullReview.assets).toHaveLength(1);
      expect(fullReview.assets[0].matched_fund).toEqual({
        name: 'Startech Fund VI',
        status: 'new',
        matched_id: null,
      });
      expect(fullReview.assets[0].matched_investor).toEqual({
        name: 'New Holding Corp',
        status: 'new',
        matched_id: null,
      });
      expect(fullReview.assets[0].matched_source).toEqual({
        name: 'Direct Wire',
        status: 'new',
        matched_id: null,
      });

      expect(fullReview.funds).toEqual([
        { name: 'Startech Fund VI', status: 'new', matched_id: null },
      ]);
      expect(fullReview.investors).toEqual([
        { name: 'New Holding Corp', status: 'new', matched_id: null },
      ]);
      expect(fullReview.sources).toEqual([
        { name: 'Direct Wire', status: 'new', matched_id: null },
      ]);
    });

    it('matches existing fund, holding entity, and funding source rows case-insensitively with trim', async () => {
      fundRepo.findAll.mockResolvedValue([{ id: 'f-101', name: 'Startech Growth Fund 1' }]);
      holdingEntityRepo.findAll.mockResolvedValue([{ id: 'he-202', name: 'Asia Star Fund Ltd' }]);
      fundSourceRepo.findAll.mockResolvedValue([{ id: 'fs-303', name: 'DCA' }]);

      const asset = sampleAsset({
        fund: '  startech growth fund 1  ',
        entity: 'asia star fund ltd',
        fundingSource: '  dca ',
      });

      const fullReview = await service.buildFullReview([asset]);

      expect(fullReview.assets[0].matched_fund).toEqual({
        name: 'Startech Growth Fund 1',
        status: 'existing',
        matched_id: 'f-101',
        auto_created: true,
      });
      expect(fullReview.assets[0].matched_investor).toEqual({
        name: 'Asia Star Fund Ltd',
        status: 'existing',
        matched_id: 'he-202',
      });
      expect(fullReview.assets[0].matched_source).toEqual({
        name: 'DCA',
        status: 'existing',
        matched_id: 'fs-303',
      });

      expect(fullReview.funds).toEqual([
        { name: 'Startech Growth Fund 1', status: 'existing', matched_id: 'f-101', auto_created: true },
      ]);
      expect(fullReview.investors).toEqual([
        { name: 'Asia Star Fund Ltd', status: 'existing', matched_id: 'he-202' },
      ]);
      expect(fullReview.sources).toEqual([
        { name: 'DCA', status: 'existing', matched_id: 'fs-303' },
      ]);
    });

    it('sets null on asset when fund, entity, or source is blank/null and omits from unique lists', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([]);

      const asset = sampleAsset({
        fund: '   ',
        entity: null,
        fundingSource: '',
      });

      const fullReview = await service.buildFullReview([asset]);

      expect(fullReview.assets[0].matched_fund).toBeNull();
      expect(fullReview.assets[0].matched_investor).toBeNull();
      expect(fullReview.assets[0].matched_source).toBeNull();

      expect(fullReview.funds).toEqual([]);
      expect(fullReview.investors).toEqual([]);
      expect(fullReview.sources).toEqual([]);
    });

    it('deduplicates catalog entries across multiple proposed assets sharing names', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([]);

      const asset1 = sampleAsset({
        code: 'A1',
        fund: 'Fund A',
        entity: 'Investor X',
        fundingSource: 'DCA',
      });
      const asset2 = sampleAsset({
        code: 'A2',
        fund: 'fund a',
        entity: 'Investor Y',
        fundingSource: 'dca',
      });

      const fullReview = await service.buildFullReview([asset1, asset2]);

      expect(fullReview.sources).toEqual([
        { name: 'DCA', status: 'new', matched_id: null },
      ]);
      expect(fullReview.funds).toEqual([
        { name: 'Fund A', status: 'new', matched_id: null },
      ]);
      expect(fullReview.investors).toHaveLength(2);
      expect(fullReview.investors).toEqual([
        { name: 'Investor X', status: 'new', matched_id: null },
        { name: 'Investor Y', status: 'new', matched_id: null },
      ]);
    });

    it('populates matched catalog info when calling buildReview', async () => {
      fundRepo.findAll.mockResolvedValue([{ id: 'f-1', name: 'Startech Fund' }]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([{ id: 'fs-1', name: 'DCA' }]);

      const review = await service.buildReview([
        sampleAsset({
          fund: 'Startech Fund',
          entity: 'New Entity',
          fundingSource: 'DCA',
        }),
      ]);

      expect(review).toHaveLength(1);
      expect(review[0].matched_fund).toEqual({
        name: 'Startech Fund',
        status: 'existing',
        matched_id: 'f-1',
      });
      expect(review[0].matched_investor).toEqual({
        name: 'New Entity',
        status: 'new',
        matched_id: null,
      });
      expect(review[0].matched_source).toEqual({
        name: 'DCA',
        status: 'existing',
        matched_id: 'fs-1',
      });
    });
  });

  describe('catalogSelections & selective creation in applySelected', () => {
    it('sets auto_created: true on FUND_CATALOG fund matches and omits on off-catalog funds and investor/source matches', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([]);

      const catalogAsset = sampleAsset({
        code: 'CAT1',
        fund: 'Startech Growth Fund 2',
        entity: 'Investor Alpha',
        fundingSource: 'Source A',
      });
      const offCatalogAsset = sampleAsset({
        code: 'OFF1',
        fund: 'Custom Off-Catalog Fund',
        entity: 'Investor Beta',
        fundingSource: 'Source B',
      });

      const fullReview = await service.buildFullReview([catalogAsset, offCatalogAsset]);

      const catFundMatch = fullReview.funds.find((f) => f.name === 'Startech Growth Fund 2');
      expect(catFundMatch).toEqual({
        name: 'Startech Growth Fund 2',
        status: 'new',
        matched_id: null,
        auto_created: true,
      });

      const offFundMatch = fullReview.funds.find((f) => f.name === 'Custom Off-Catalog Fund');
      expect(offFundMatch).toEqual({
        name: 'Custom Off-Catalog Fund',
        status: 'new',
        matched_id: null,
      });
      expect(offFundMatch?.auto_created).toBeUndefined();

      for (const inv of fullReview.investors) {
        expect(inv.auto_created).toBeUndefined();
      }
      for (const src of fullReview.sources) {
        expect(src.auto_created).toBeUndefined();
      }
    });

    it('skips holdingEntityRepo.insert and leaves txn holding_entity_id null when investor is deselected', async () => {
      const asset = sampleAsset({
        entity: 'New Investor Co',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, {
        investors: [], // Deselect New Investor Co
      });

      expect(result.created_assets).toBe(1);
      expect(holdingEntityRepo.insert).not.toHaveBeenCalled();
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: null,
        }),
      );
    });

    it('skips fundSourceRepo.insert, leaves txn funding_source_id null, and sets fund_assets.funding_source null when source is deselected', async () => {
      const asset = sampleAsset({
        fundingSource: 'Direct Wire Source',
        fundingSourceRaw: 'Direct Wire Source',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, {
        sources: [], // Deselect Direct Wire Source
      });

      expect(result.created_assets).toBe(1);
      expect(fundSourceRepo.insert).not.toHaveBeenCalled();
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          funding_source: null,
        }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          funding_source_id: null,
        }),
      );
    });

    it('keeps the raw funding_source text when fundingSource is a placeholder the reviewer never saw', async () => {
      // `meaningful()` nulls placeholders like "N/A", so buildFullReview never
      // offers them on the Source tab. An empty allow-list must therefore not be
      // read as a deselection of the raw text.
      const asset = sampleAsset({
        fundingSource: null,
        fundingSourceRaw: 'N/A',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, {
        sources: [],
      });

      expect(result.created_assets).toBe(1);
      expect(fundSourceRepo.insert).not.toHaveBeenCalled();
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ funding_source: 'N/A' }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ funding_source_id: null }),
      );
    });

    it('skips fundRepo.insert for off-catalog fund and leaves txn fund_id null when fund is deselected', async () => {
      const asset = sampleAsset({
        fund: 'Custom Off-Catalog Fund',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, {
        funds: ['Other Allowed Fund'], // Deselect Custom Off-Catalog Fund
      });

      expect(result.created_assets).toBe(1);
      // Ensure Custom Off-Catalog Fund is never inserted into fundRepo
      expect(fundRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Custom Off-Catalog Fund' }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: null,
        }),
      );
    });

    it('creates and links catalog records as before when names are selected in catalogSelections', async () => {
      const asset = sampleAsset({
        fund: 'Custom Off-Catalog Fund',
        entity: 'Investor Alpha',
        fundingSource: 'Source Beta',
        fundingSourceRaw: 'Source Beta',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, {
        funds: ['Custom Off-Catalog Fund'],
        investors: ['Investor Alpha'],
        sources: ['Source Beta'],
      });

      expect(result.created_assets).toBe(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Custom Off-Catalog Fund' });
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'Investor Alpha' });
      expect(fundSourceRepo.insert).toHaveBeenCalledWith({ name: 'Source Beta' });
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          funding_source: 'Source Beta',
        }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: 'fund-Custom Off-Catalog Fund',
          holding_entity_id: 'he-1',
          funding_source_id: 'fs-1',
        }),
      );
    });

    it('preserves existing behavior identically when catalogSelections is undefined (regression guard)', async () => {
      const asset = sampleAsset({
        fund: 'Custom Fund',
        entity: 'Asia Star Fund Ltd',
        fundingSource: 'DCA',
        fundingSourceRaw: 'DCA',
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, undefined, undefined);

      expect(result.created_assets).toBe(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Custom Fund' });
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'Asia Star Fund Ltd' });
      expect(fundSourceRepo.insert).toHaveBeenCalledWith({ name: 'DCA' });
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          funding_source: 'DCA',
        }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: 'fund-Custom Fund',
          holding_entity_id: 'he-1',
          funding_source_id: 'fs-1',
        }),
      );
    });

    it('v1: throws when proposal has no fund name at all', async () => {
      const asset = sampleAsset({ fund: '' });
      await expect(
        service.applySelected([asset], ['GOTO'], undefined, { isV1: true }, { funds: [] }),
      ).rejects.toThrow('unresolved fund reference');
    });

    it('v1: applies asset with fund_id null when fund name is present but deliberately deselected', async () => {
      const asset = sampleAsset({
        fund: 'Some Fund',
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
      });

      const result = await service.applySelected([asset], ['GOTO'], undefined, { isV1: true }, {
        funds: ['Other Fund'], // Deselect Some Fund
      });

      expect(result.created_assets).toBe(1);
      expect(fundRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Some Fund' }),
      );
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: null,
        }),
      );
    });

    it('creates ticked fund and investor when zero assets are selected', async () => {
      const result = await service.applySelected(
        [sampleAsset()],
        [], // zero assets approved
        undefined,
        undefined,
        {
          funds: ['Brand New Fund'],
          investors: ['Brand New Investor'],
        },
      );

      expect(result.applied).toBe(0);
      expect(result.created_assets).toBe(0);
      expect(result.updated_assets).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.txns_inserted).toBe(0);
      expect(result.valuations_upserted).toBe(0);
      expect(result.created_funds).toBe(1);
      expect(result.created_investors).toBe(1);
      expect(result.created_sources).toBe(0);

      expect(fundRepo.insert).toHaveBeenCalledTimes(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Brand New Fund' });
      expect(holdingEntityRepo.insert).toHaveBeenCalledTimes(1);
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'Brand New Investor' });
      expect(fundAssetRepo.insert).not.toHaveBeenCalled();
      expect(txnRepo.insert).not.toHaveBeenCalled();
      expect(valuationRepo.upsert).not.toHaveBeenCalled();
      expect(fundMetricsService.recomputeAsset).not.toHaveBeenCalled();
    });

    it('skips insert and reports 0 created when ticked catalog names already exist', async () => {
      fundRepo.findAll.mockResolvedValue([
        { id: 'fund-existing', name: 'Existing Fund' },
        { id: 'fund-others', name: 'Others' },
        { id: 'f1', name: 'Startech Growth Fund 1' },
        { id: 'f2', name: 'Startech Growth Fund 2' },
        { id: 'f3', name: 'Startech Growth Fund 3' },
        { id: 'f4', name: 'Startech Growth Fund 4' },
        { id: 'f5', name: 'Startech Growth Fund 5' },
        { id: 'm1', name: 'Meranti 1' },
        { id: 'm2', name: 'Meranti 2' },
      ]);
      holdingEntityRepo.findAll.mockResolvedValue([{ id: 'he-existing', name: 'Existing Investor' }]);
      fundSourceRepo.findAll.mockResolvedValue([{ id: 'fs-existing', name: 'Existing Source' }]);

      const result = await service.applySelected(
        [],
        [],
        undefined,
        undefined,
        {
          funds: ['Existing Fund'],
          investors: ['  existing investor  '],
          sources: ['EXISTING SOURCE'],
        },
      );

      expect(fundRepo.insert).not.toHaveBeenCalled();
      expect(holdingEntityRepo.insert).not.toHaveBeenCalled();
      expect(fundSourceRepo.insert).not.toHaveBeenCalled();
      expect(result.created_funds).toBe(0);
      expect(result.created_investors).toBe(0);
      expect(result.created_sources).toBe(0);
    });

    it('does not double-count a FUND_CATALOG fund that ensureFundCatalog already created', async () => {
      // Fresh workspace: ensureFundCatalog seeds all eight catalog funds before the
      // eager pass runs, so a ticked catalog name is already in the lookup and must
      // not be reported as a reviewer-driven creation. The UI agrees — those rows
      // carry auto_created and are excluded from the button's count.
      fundRepo.findAll.mockResolvedValue([]);

      const result = await service.applySelected([], [], undefined, undefined, {
        funds: ['Meranti 1'],
      });

      expect(result.created_funds).toBe(0);
      // Seeded by ensureFundCatalog, exactly once, not again by the eager pass.
      const meranti1Inserts = fundRepo.insert.mock.calls.filter(
        ([arg]) => arg.name === 'Meranti 1',
      );
      expect(meranti1Inserts).toHaveLength(1);
    });

    it('creates ticked fund not referenced by any approved asset', async () => {
      const asset = sampleAsset({
        code: 'A1',
        fund: 'Fund A',
      });

      const result = await service.applySelected(
        [asset],
        ['A1'],
        undefined,
        undefined,
        {
          funds: ['Fund A', 'Unreferenced Fund B'],
        },
      );

      expect(result.created_assets).toBe(1);
      expect(result.created_funds).toBe(2);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Fund A' });
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Unreferenced Fund B' });
      expect(fundRepo.insert).toHaveBeenCalledTimes(2);
    });

    it('inserts a ticked name that the asset loop also resolves exactly ONCE', async () => {
      const asset1 = sampleAsset({
        code: 'A1',
        fund: 'Shared New Fund',
        entity: 'Shared New Investor',
        fundingSource: 'Shared New Source',
        fundingSourceRaw: 'Shared New Source',
      });
      const asset2 = sampleAsset({
        code: 'A2',
        fund: 'Shared New Fund',
        entity: 'Shared New Investor',
        fundingSource: 'Shared New Source',
        fundingSourceRaw: 'Shared New Source',
      });

      const result = await service.applySelected(
        [asset1, asset2],
        ['A1', 'A2'],
        undefined,
        undefined,
        {
          funds: ['Shared New Fund'],
          investors: ['Shared New Investor'],
          sources: ['Shared New Source'],
        },
      );

      expect(result.created_assets).toBe(2);
      expect(result.created_funds).toBe(1);
      expect(result.created_investors).toBe(1);
      expect(result.created_sources).toBe(1);

      expect(fundRepo.insert).toHaveBeenCalledTimes(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Shared New Fund' });

      expect(holdingEntityRepo.insert).toHaveBeenCalledTimes(1);
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'Shared New Investor' });

      expect(fundSourceRepo.insert).toHaveBeenCalledTimes(1);
      expect(fundSourceRepo.insert).toHaveBeenCalledWith({ name: 'Shared New Source' });
    });

    it('creates nothing eagerly when catalogSelections is undefined (regression guard)', async () => {
      const result = await service.applySelected(
        [sampleAsset({ fund: 'New Fund', entity: 'New Investor', fundingSource: 'New Source' })],
        [], // zero assets selected
        undefined,
        undefined,
        undefined, // catalogSelections undefined
      );

      expect(result.applied).toBe(0);
      expect(result.created_funds).toBe(0);
      expect(result.created_investors).toBe(0);
      expect(result.created_sources).toBe(0);
      expect(fundRepo.insert).not.toHaveBeenCalled();
      expect(holdingEntityRepo.insert).not.toHaveBeenCalled();
      expect(fundSourceRepo.insert).not.toHaveBeenCalled();
    });

    it('resolves without throwing when isV1 is true with zero assets and only catalog selections', async () => {
      const invalidAssetForV1 = sampleAsset({
        fund: '', // Missing fund would throw if evaluated
        txns: [{ ...sampleAsset().txns[0], currency: '' }], // Missing currency would throw if evaluated
      });

      const result = await service.applySelected(
        [invalidAssetForV1],
        [], // Zero assets approved
        undefined,
        { isV1: true },
        {
          funds: ['V1 Fund'],
          investors: ['V1 Investor'],
          sources: ['V1 Source'],
        },
      );

      expect(result.applied).toBe(0);
      expect(result.created_assets).toBe(0);
      expect(result.created_funds).toBe(1);
      expect(result.created_investors).toBe(1);
      expect(result.created_sources).toBe(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'V1 Fund' });
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'V1 Investor' });
      expect(fundSourceRepo.insert).toHaveBeenCalledWith({ name: 'V1 Source' });
    });

    it('skips empty or whitespace-only names in catalogSelections', async () => {
      const result = await service.applySelected(
        [],
        [],
        undefined,
        undefined,
        {
          funds: ['   ', ''],
          investors: [''],
          sources: [' '],
        },
      );

      expect(fundRepo.insert).not.toHaveBeenCalled();
      expect(holdingEntityRepo.insert).not.toHaveBeenCalled();
      expect(fundSourceRepo.insert).not.toHaveBeenCalled();
      expect(result.created_funds).toBe(0);
      expect(result.created_investors).toBe(0);
      expect(result.created_sources).toBe(0);
    });
  });
});
