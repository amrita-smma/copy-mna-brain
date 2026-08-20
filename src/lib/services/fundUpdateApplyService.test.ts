import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import type { ParsedAsset, ParsedCommitmentEvent } from '@/lib/fund_updates';
import { NANJING_TEMPLATE_ID } from '@/lib/fund_updates';

function sampleCommitmentEvent(overrides: Partial<ParsedCommitmentEvent> = {}): ParsedCommitmentEvent {
  return {
    fund: 'Fund A',
    investorName: 'Investor A',
    investorTypeRaw: '机构投资人',
    investorTypeLabel: 'Institutional Investor',
    date: '2024-01-15',
    intent: 'increase',
    amount: 1000000,
    currency: 'CNY',
    counterpartyName: null,
    actionRaw: '认缴',
    natureRaw: '新增额度',
    directionRaw: '认缴额度增加',
    notes: null,
    sourceRow: 3,
    ...overrides,
  };
}

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
  let fundAssetLedgerService: { addTransaction: ReturnType<typeof vi.fn> };
  let commitmentEventRepo: {
    findByFundAndHoldingEntity: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
  };
  let commitmentEventService: {
    createEvent: ReturnType<typeof vi.fn>;
  };
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
      insert: vi.fn().mockImplementation(async ({ name }) => ({ id: `he-${name}`, name })),
    };
    fundSourceRepo = {
      findAll: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'fs-1', name: 'DCA' }),
    };
    fundMetricsService = { recomputeAsset: vi.fn().mockResolvedValue(undefined) };
    const insertTxn = txnRepo.insert as unknown as (transaction: unknown) => Promise<unknown>;
    fundAssetLedgerService = {
      addTransaction: vi.fn(async (_assetId: string, transaction: unknown) => insertTxn(transaction)),
    };
    commitmentEventRepo = {
      findByFundAndHoldingEntity: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue([]),
    };
    commitmentEventService = {
      createEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    };

    service = new FundUpdateApplyService(
      fundRepo as never,
      fundAssetRepo as never,
      txnRepo as never,
      valuationRepo as never,
      holdingEntityRepo as never,
      fundSourceRepo as never,
      fundMetricsService as never,
      fundAssetLedgerService as never,
      commitmentEventRepo as never,
      commitmentEventService as never,
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

  it('defaults imported divestment sell_proceeds_destination to distributed_to_investor and non-divestment to null', async () => {
    fundRepo.findAll.mockResolvedValue([
      { id: 'fund-others', name: 'Others' },
    ]);

    const divestmentTxn = {
      date: '2023-01-01',
      type: 'divestment' as const,
      subTypeLabel: null,
      pricePerShare: 5,
      shareCount: 10,
      valueAmount: 50,
      currency: 'USD',
      fxRate: null,
      notes: null,
    };
    const explicitCashTxn = {
      date: '2023-06-01',
      type: 'divestment' as const,
      subTypeLabel: null,
      pricePerShare: 5,
      shareCount: 10,
      valueAmount: 50,
      currency: 'USD',
      fxRate: null,
      sellProceedsDestination: 'cash_in_fund' as const,
      notes: null,
    };
    const contributionTxn = {
      date: '2021-01-01',
      type: 'contribution' as const,
      subTypeLabel: null,
      pricePerShare: 1,
      shareCount: 50,
      valueAmount: 50,
      currency: 'USD',
      fxRate: null,
      notes: null,
    };

    const asset = sampleAsset({
      txns: [contributionTxn, divestmentTxn, explicitCashTxn],
    });

    await service.applySelected([asset], ['GOTO']);

    expect(txnRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        txn_type: 'contribution',
        sell_proceeds_destination: null,
      }),
    );
    expect(txnRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        txn_type: 'divestment',
        sell_proceeds_destination: 'distributed_to_investor',
      }),
    );
    expect(txnRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        txn_type: 'divestment',
        sell_proceeds_destination: 'cash_in_fund',
      }),
    );
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

  it('classifies same-name Nanjing asset under a different fund as new (no name-only fallback across funds)', async () => {
    const asset1 = sampleAsset({
      code: 'NJ-aaaa111122',
      name: 'Beijing Huayao Kechuang',
      legalName: '北京化药科创医药科技发展有限公司',
      fund: '南京瑞沣股权投资合伙企业（有限合伙）',
      currency: 'CNY',
    });
    const asset2 = sampleAsset({
      code: 'NJ-bbbb333344',
      name: 'Beijing Huayao Kechuang',
      legalName: '北京化药科创医药科技发展有限公司',
      fund: '淮安熙和创业投资基金合伙企业（有限合伙）',
      currency: 'CNY',
    });

    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-1', asset_name: 'Beijing Huayao Kechuang', type_details: { sheetCode: 'NJ-aaaa111122' } },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      { fund_asset_id: 'asset-1', txn_date: '2021-01-01', txn_type: 'contribution', value_amount: 50, share_count: 50, price_per_share: 1 },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([
      { fund_asset_id: 'asset-1', as_of_date: '2026-03-31' },
    ]);

    const review = await service.buildReview([asset1, asset2]);
    expect(review.find((r) => r.code === 'NJ-aaaa111122')).toEqual(
      expect.objectContaining({ status: 'unchanged', matched_asset_id: 'asset-1' }),
    );
    expect(review.find((r) => r.code === 'NJ-bbbb333344')).toEqual(
      expect.objectContaining({ status: 'new', matched_asset_id: null }),
    );

    const catalog = ['南京瑞沣股权投资合伙企业（有限合伙）', '淮安熙和创业投资基金合伙企业（有限合伙）'];
    fundRepo.findAll.mockResolvedValue([
      { id: 'fund-1', name: '南京瑞沣股权投资合伙企业（有限合伙）' },
      { id: 'fund-2', name: '淮安熙和创业投资基金合伙企业（有限合伙）' },
    ]);
    fundAssetRepo.insert.mockResolvedValue({ id: 'asset-2' });

    const result = await service.applySelected([asset1, asset2], ['NJ-bbbb333344'], undefined, catalog);
    expect(result.created_assets).toBe(1);
    expect(fundAssetRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      asset_name: 'Beijing Huayao Kechuang',
      type_details: expect.objectContaining({ sheetCode: 'NJ-bbbb333344' }),
    }));
    expect(fundAssetLedgerService.addTransaction).toHaveBeenCalledWith(
      'asset-2', expect.objectContaining({ fund_id: 'fund-2' }),
    );
  });

  it('throws before any DB writes when explicit fund_catalog is empty []', async () => {
    await expect(service.applySelected([sampleAsset()], ['GOTO'], undefined, [])).rejects.toThrow(
      'Explicit fund catalog cannot be empty',
    );
    expect(fundRepo.insert).not.toHaveBeenCalled();
    expect(fundAssetRepo.insert).not.toHaveBeenCalled();
    expect(txnRepo.insert).not.toHaveBeenCalled();
    expect(valuationRepo.upsert).not.toHaveBeenCalled();
  });

  it('throws before any DB writes when explicit fund_catalog omits a selected asset fund', async () => {
    const asset = sampleAsset({ code: 'NJ-1234567890', fund: '淮安熙和创业投资基金合伙企业（有限合伙）' });
    await expect(service.applySelected(
      [asset], ['NJ-1234567890'], undefined, ['南京金光紫金股权投资基金（有限合伙企业）'],
    )).rejects.toThrow(/Explicit fund catalog does not contain proposed fund/);
    expect(fundRepo.insert).not.toHaveBeenCalled();
    expect(fundAssetRepo.insert).not.toHaveBeenCalled();
    expect(txnRepo.insert).not.toHaveBeenCalled();
    expect(valuationRepo.upsert).not.toHaveBeenCalled();
  });

  it('preserves legacy name matching for non-Nanjing proposals', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-legacy', asset_name: 'GOTO Group', type_details: { sheetCode: 'OLD_GOTO' } },
    ]);
    txnRepo.findByFundAssetIds.mockResolvedValue([
      { fund_asset_id: 'asset-legacy', txn_date: '2021-01-01', txn_type: 'contribution', value_amount: 50, share_count: 50, price_per_share: 1 },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([{ fund_asset_id: 'asset-legacy', as_of_date: '2026-03-31' }]);
    const review = await service.buildReview([sampleAsset({ code: 'GOTO', name: 'GOTO Group' })]);
    expect(review[0]).toEqual(expect.objectContaining({ status: 'unchanged', matched_asset_id: 'asset-legacy' }));
  });

  it('does not match non-Nanjing asset to existing Nanjing asset by name fallback', async () => {
    fundAssetRepo.findAll.mockResolvedValue([
      { id: 'asset-nj', asset_name: 'GOTO Group', type_details: { sheetCode: 'NJ-1234567890' } },
    ]);
    const review = await service.buildReview([sampleAsset({ code: 'STARTECH_NEW', name: 'GOTO Group' })]);
    expect(review[0]).toEqual(expect.objectContaining({ status: 'new', matched_asset_id: null }));
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

    it('merges commitment event investors and leaves assets identical to no-events call', async () => {
      fundRepo.findAll.mockResolvedValue([{ id: 'f-1', name: 'Others' }]);
      holdingEntityRepo.findAll.mockResolvedValue([
        { id: 'he-existing', name: 'Existing Investor' },
      ]);
      fundSourceRepo.findAll.mockResolvedValue([{ id: 'fs-1', name: 'DCA' }]);

      const asset = sampleAsset();
      const ev1 = sampleCommitmentEvent({ investorName: 'Existing Investor' });
      const ev2 = sampleCommitmentEvent({ investorName: 'New Proposed Investor' });

      const reviewWithoutEvents = await service.buildFullReview([asset]);
      const reviewWithEvents = await service.buildFullReview([asset], [ev1, ev2]);

      expect(reviewWithEvents.assets).toEqual(reviewWithoutEvents.assets);
      expect(reviewWithEvents.investors).toEqual(
        expect.arrayContaining([
          { name: 'Existing Investor', status: 'existing', matched_id: 'he-existing' },
          { name: 'New Proposed Investor', status: 'new', matched_id: null },
        ]),
      );
    });
    it('marks existing commitment events as duplicate and includes actionable events', async () => {
      fundRepo.findAll.mockResolvedValue([{ id: 'f-1', name: 'Fund A' }]);
      holdingEntityRepo.findAll.mockResolvedValue([{ id: 'he-1', name: 'Investor A' }]);
      commitmentEventRepo.findByFundAndHoldingEntity.mockImplementation(async (f, he) => {
        if (f === 'f-1' && he === 'he-1') {
          return [{
            id: 'ce-1',
            fund_id: 'f-1',
            holding_entity_id: 'he-1',
            effective_date: '2024-01-01',
            event_type: 'initial_commitment',
            amount: 500000,
            currency: 'CNY'
          }];
        }
        return [];
      });

      const ev1 = sampleCommitmentEvent({ fund: 'Fund A', investorName: 'Investor A', date: '2024-01-01', amount: 500000 });
      const ev2 = sampleCommitmentEvent({ fund: 'Fund A', investorName: 'Investor A', date: '2024-02-01', amount: 250000 });
      const ev3 = sampleCommitmentEvent({ fund: 'Fund B', investorName: 'Investor B', date: '2024-01-01', amount: 100000 });

      const review = await service.buildFullReview([], [ev1, ev2, ev3]);
      expect(review.commitment_events).toBeDefined();
      expect(review.commitment_events).toHaveLength(3);

      const st1 = review.commitment_events?.find(e => e.event === ev1)?.status;
      const st2 = review.commitment_events?.find(e => e.event === ev2)?.status;
      const st3 = review.commitment_events?.find(e => e.event === ev3)?.status;

      expect(st1).toBe('duplicate');
      expect(st2).toBe('actionable');
      expect(st3).toBe('actionable');
    });
  });

  describe('FundUpdateApplyService.applyCommitmentEvents', () => {
    it('returns all-zero result on empty events array without hitting repo or service', async () => {
      const result = await service.applyCommitmentEvents([]);
      expect(result).toEqual({
        events_inserted: 0,
        events_skipped_duplicate: 0,
        events_skipped: 0,
        warnings: [],
      });
      expect(commitmentEventRepo.findByFundAndHoldingEntity).not.toHaveBeenCalled();
      expect(commitmentEventService.createEvent).not.toHaveBeenCalled();
    });

    it('assigns initial_commitment on fresh position and additional_commitment on subsequent events', async () => {
      const ev1 = sampleCommitmentEvent({ date: '2024-01-15', amount: 1000000, sourceRow: 3 });
      const ev2 = sampleCommitmentEvent({ date: '2024-02-15', amount: 500000, sourceRow: 4 });

      const result = await service.applyCommitmentEvents([ev1, ev2]);

      expect(result.events_inserted).toBe(2);
      expect(result.events_skipped).toBe(0);
      expect(result.events_skipped_duplicate).toBe(0);
      expect(result.warnings).toEqual([]);

      expect(commitmentEventService.createEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          eventType: 'initial_commitment',
          amount: 1000000,
          effectiveDate: '2024-01-15',
          currency: 'CNY',
        }),
      );
      expect(commitmentEventService.createEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          eventType: 'additional_commitment',
          amount: 500000,
          effectiveDate: '2024-02-15',
          currency: 'CNY',
        }),
      );
    });

    it('assigns additional_commitment for position with existing events in DB', async () => {
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([
        {
          id: 'existing-1',
          effective_date: '2023-01-01',
          event_type: 'initial_commitment',
          amount: 100000,
          currency: 'CNY',
        },
      ]);

      const ev = sampleCommitmentEvent({ date: '2024-01-15', amount: 500000 });
      const result = await service.applyCommitmentEvents([ev]);

      expect(result.events_inserted).toBe(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'additional_commitment',
          amount: 500000,
        }),
      );
    });

    it('maps decrease intent to reduction eventType', async () => {
      const ev = sampleCommitmentEvent({
        intent: 'decrease',
        actionRaw: '减资',
        natureRaw: '认缴额度减少',
        directionRaw: '认缴额度减少',
      });
      const result = await service.applyCommitmentEvents([ev]);

      expect(result.events_inserted).toBe(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'reduction',
        }),
      );
    });

    it('skips duplicate events against existing DB events and increments events_skipped_duplicate', async () => {
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([
        {
          id: 'existing-1',
          effective_date: '2024-01-15',
          event_type: 'initial_commitment',
          amount: 1000000,
          currency: 'CNY',
        },
      ]);

      const ev = sampleCommitmentEvent({ date: '2024-01-15', amount: 1000000 });
      const result = await service.applyCommitmentEvents([ev]);

      expect(result.events_skipped_duplicate).toBe(1);
      expect(result.events_inserted).toBe(0);
      expect(commitmentEventService.createEvent).not.toHaveBeenCalled();
    });

    it('inserts nothing when the same proposal is applied twice', async () => {
      const ev = sampleCommitmentEvent({ date: '2024-01-15', amount: 1000000 });

      // First run: fresh position -> 1 insert
      const result1 = await service.applyCommitmentEvents([ev]);
      expect(result1.events_inserted).toBe(1);

      // Second run: existing event now present in DB
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([
        {
          id: 'ev-1',
          effective_date: '2024-01-15',
          event_type: 'initial_commitment',
          amount: 1000000,
          currency: 'CNY',
        },
      ]);

      const result2 = await service.applyCommitmentEvents([ev]);
      expect(result2.events_inserted).toBe(0);
      expect(result2.events_skipped_duplicate).toBe(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledTimes(1);
    });

    it('skips whole group with a warning if existing ledger currency is not CNY', async () => {
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([
        {
          id: 'existing-usd',
          effective_date: '2023-01-01',
          event_type: 'initial_commitment',
          amount: 100000,
          currency: 'USD',
        },
      ]);

      const ev1 = sampleCommitmentEvent({ date: '2024-01-15', amount: 1000000 });
      const ev2 = sampleCommitmentEvent({ date: '2024-02-15', amount: 500000 });
      const result = await service.applyCommitmentEvents([ev1, ev2]);

      expect(result.events_skipped).toBe(2);
      expect(result.events_inserted).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('USD');
      expect(result.warnings[0]).toContain('CNY');
      expect(commitmentEventService.createEvent).not.toHaveBeenCalled();
    });

    it('counts single event error in events_skipped and continues applying remaining events', async () => {
      commitmentEventService.createEvent
        .mockRejectedValueOnce(new Error('CommitmentNegativeBalanceError: balance cannot be negative'))
        .mockResolvedValueOnce({ id: 'evt-2' });

      const ev1 = sampleCommitmentEvent({ date: '2024-01-15', amount: 1000000, sourceRow: 3 });
      const ev2 = sampleCommitmentEvent({ date: '2024-02-15', amount: 500000, sourceRow: 4 });

      const result = await service.applyCommitmentEvents([ev1, ev2]);

      expect(result.events_skipped).toBe(1);
      expect(result.events_inserted).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('balance cannot be negative');
    });

    it('skips event with a warning when fund is missing in an explicit catalog without throwing', async () => {
      const ev = sampleCommitmentEvent({ fund: 'Missing Fund', sourceRow: 10 });
      const result = await service.applyCommitmentEvents([ev], { fundCatalog: ['Fund A'] });

      expect(result.events_skipped).toBe(1);
      expect(result.events_inserted).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Missing Fund');
      expect(commitmentEventService.createEvent).not.toHaveBeenCalled();
    });

    it('inserts missing investor once and reuses it for subsequent events with same investor', async () => {
      holdingEntityRepo.findAll.mockResolvedValue([]);
      const ev1 = sampleCommitmentEvent({
        investorName: 'New Investor Corp',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-01-15',
        sourceRow: 3,
      });
      const ev2 = sampleCommitmentEvent({
        investorName: 'New Investor Corp',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-02-15',
        sourceRow: 4,
      });

      const result = await service.applyCommitmentEvents([ev1, ev2]);

      expect(result.events_inserted).toBe(2);
      expect(holdingEntityRepo.insert).toHaveBeenCalledTimes(1);
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({
        name: 'New Investor Corp',
        entity_type: 'Institutional Investor',
      });
    });

    it('passes events to createEvent in chronological order', async () => {
      const evLate = sampleCommitmentEvent({ date: '2024-03-01', amount: 300000, sourceRow: 5 });
      const evEarly = sampleCommitmentEvent({ date: '2024-01-01', amount: 100000, sourceRow: 3 });
      const evMid = sampleCommitmentEvent({ date: '2024-02-01', amount: 200000, sourceRow: 4 });

      await service.applyCommitmentEvents([evLate, evEarly, evMid]);

      expect(commitmentEventService.createEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ effectiveDate: '2024-01-01', amount: 100000 }),
      );
      expect(commitmentEventService.createEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ effectiveDate: '2024-02-01', amount: 200000 }),
      );
      expect(commitmentEventService.createEvent).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ effectiveDate: '2024-03-01', amount: 300000 }),
      );
    });

    it('passes explicit source or defaults to NANJING_TEMPLATE_ID, never manual', async () => {
      const ev1 = sampleCommitmentEvent();
      await service.applyCommitmentEvents([ev1], { source: 'custom_source_id' });
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'custom_source_id' }),
      );

      const ev2 = sampleCommitmentEvent();
      await service.applyCommitmentEvents([ev2]);
      expect(commitmentEventService.createEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ source: NANJING_TEMPLATE_ID }),
      );
    });

    it('calls holdingEntityRepo.findAll and commitmentEventRepo.findByFundAndHoldingEntity without N+1', async () => {
      const ev1 = sampleCommitmentEvent({ fund: 'Fund A', investorName: 'Inv 1', date: '2024-01-01', sourceRow: 3 });
      const ev2 = sampleCommitmentEvent({ fund: 'Fund A', investorName: 'Inv 1', date: '2024-01-02', sourceRow: 4 });
      const ev3 = sampleCommitmentEvent({ fund: 'Fund A', investorName: 'Inv 2', date: '2024-01-01', sourceRow: 5 });

      await service.applyCommitmentEvents([ev1, ev2, ev3]);

      expect(holdingEntityRepo.findAll).toHaveBeenCalledTimes(1);
      expect(commitmentEventRepo.findByFundAndHoldingEntity).toHaveBeenCalledTimes(2);
    });

    it('skips events whose fund is unticked without inserting fund or creating event, while applying selected events', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);

      const evSelected = sampleCommitmentEvent({
        fund: 'Selected Fund',
        investorName: 'Investor A',
        sourceRow: 2,
        amount: 1000000,
      });
      const evUnticked = sampleCommitmentEvent({
        fund: 'Unticked Fund',
        investorName: 'Investor A',
        sourceRow: 3,
        amount: 500000,
      });

      const result = await service.applyCommitmentEvents(
        [evSelected, evUnticked],
        {
          catalogSelections: {
            funds: ['Selected Fund'],
            investors: ['Investor A'],
          },
        },
      );

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Unticked Fund');
      expect(result.warnings[0]).toContain('not selected');

      // Only Selected Fund was inserted into fundRepo
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Selected Fund' });
      expect(fundRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unticked Fund' }),
      );

      // Only 1 commitment event was created
      expect(commitmentEventService.createEvent).toHaveBeenCalledTimes(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1000000,
        }),
      );
    });

    it('filters events by eventKeys when explicitly provided', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundRepo.insert.mockResolvedValue({ id: 'f-new', name: 'Some Fund' });
      holdingEntityRepo.insert.mockResolvedValue({ id: 'he-new', name: 'Some Investor', entity_type: null });
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([]);

      const ev1 = sampleCommitmentEvent({ amount: 1000000, sourceRow: 1 });
      const ev2 = sampleCommitmentEvent({ amount: 500000, sourceRow: 2 });
      const ev3 = sampleCommitmentEvent({ amount: 200000, sourceRow: 3 });

      const { reviewCommitmentEventKey } = await import('@/lib/fund_updates');
      const keysToApply = [reviewCommitmentEventKey(ev1), reviewCommitmentEventKey(ev3)];

      const result = await service.applyCommitmentEvents(
        [ev1, ev2, ev3],
        { eventKeys: keysToApply }
      );

      expect(result.events_inserted).toBe(2);
      expect(result.events_skipped).toBe(1);

      expect(commitmentEventService.createEvent).toHaveBeenCalledTimes(2);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000000 }));
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(expect.objectContaining({ amount: 200000 }));
      expect(commitmentEventService.createEvent).not.toHaveBeenCalledWith(expect.objectContaining({ amount: 500000 }));
    });

    it('applies no events and creates no catalog records when eventKeys is explicitly empty', async () => {
      const events = [sampleCommitmentEvent()];

      const result = await service.applyCommitmentEvents(events, { eventKeys: [] });

      expect(result).toEqual({
        events_inserted: 0,
        events_skipped_duplicate: 0,
        events_skipped: 1,
        warnings: [],
      });
      expect(fundRepo.findAll).not.toHaveBeenCalled();
      expect(fundRepo.insert).not.toHaveBeenCalled();
      expect(holdingEntityRepo.findAll).not.toHaveBeenCalled();
      expect(holdingEntityRepo.insert).not.toHaveBeenCalled();
      expect(commitmentEventService.createEvent).not.toHaveBeenCalled();
    });

    it('overrides eventKeys when investor or fund is unticked in catalogSelections', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundRepo.insert.mockResolvedValue({ id: 'f-1', name: 'Fund A' });
      holdingEntityRepo.insert.mockResolvedValue({ id: 'he-1', name: 'Investor 1', entity_type: null });
      commitmentEventRepo.findByFundAndHoldingEntity.mockResolvedValue([]);

      const ev1 = sampleCommitmentEvent({
        fund: 'Fund A',
        investorName: 'Investor 1',
        amount: 1000000,
        sourceRow: 1,
      });
      const ev2 = sampleCommitmentEvent({
        fund: 'Fund A',
        investorName: 'Unticked Investor',
        amount: 500000,
        sourceRow: 2,
      });

      const { reviewCommitmentEventKey } = await import('@/lib/fund_updates');
      // Both events are in eventKeys, but Investor 2 is not in catalogSelections.investors
      const keys = [reviewCommitmentEventKey(ev1), reviewCommitmentEventKey(ev2)];

      const result = await service.applyCommitmentEvents([ev1, ev2], {
        eventKeys: keys,
        catalogSelections: {
          funds: ['Fund A'],
          investors: ['Investor 1'],
        },
      });

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Unticked Investor');
      expect(result.warnings[0]).toContain('investor is not selected');

      expect(holdingEntityRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Investor 1' }),
      );
      expect(holdingEntityRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unticked Investor' }),
      );
      expect(commitmentEventService.createEvent).toHaveBeenCalledTimes(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1000000 }),
      );
    });


    it('skips events whose investor is unticked without inserting investor or creating event, while applying selected events', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);

      const evSelected = sampleCommitmentEvent({
        fund: 'Fund A',
        investorName: 'Selected Investor',
        sourceRow: 2,
        amount: 1000000,
      });
      const evUnticked = sampleCommitmentEvent({
        fund: 'Fund A',
        investorName: 'Unticked Investor',
        sourceRow: 3,
        amount: 500000,
      });

      const result = await service.applyCommitmentEvents(
        [evSelected, evUnticked],
        {
          catalogSelections: {
            funds: ['Fund A'],
            investors: ['Selected Investor'],
          },
        },
      );

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Unticked Investor');
      expect(result.warnings[0]).toContain('not selected');

      // Only Selected Investor was inserted into holdingEntityRepo
      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({
        name: 'Selected Investor',
        entity_type: 'Institutional Investor',
      });
      expect(holdingEntityRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unticked Investor' }),
      );

      // Only 1 commitment event was created
      expect(commitmentEventService.createEvent).toHaveBeenCalledTimes(1);
      expect(commitmentEventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1000000,
        }),
      );
    });

    it('ignores source selections in applyCommitmentEvents', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      holdingEntityRepo.findAll.mockResolvedValue([]);

      const ev = sampleCommitmentEvent({
        fund: 'Fund A',
        investorName: 'Investor A',
      });

      const result = await service.applyCommitmentEvents(
        [ev],
        {
          catalogSelections: {
            funds: ['Fund A'],
            investors: ['Investor A'],
            sources: [], // empty sources must not skip commitment event
          },
        },
      );

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(0);
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
          holding_entity_id: 'he-Investor Alpha',
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
          holding_entity_id: 'he-Asia Star Fund Ltd',
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

    it('creates only selected FUND_CATALOG fund in fresh workspace without seeding unticked ones', async () => {
      fundRepo.findAll.mockResolvedValue([]);

      const result = await service.applySelected([], [], undefined, undefined, {
        funds: ['Meranti 1'],
      });

      expect(result.created_funds).toBe(1);
      expect(fundRepo.insert).toHaveBeenCalledTimes(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Meranti 1' });
    });

    it('with explicit partial fund selection and proposal fund_catalog, unticked missing funds are not inserted and approved asset is applied with null fund relationship', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      const catalog = ['Fund A', 'Fund B'];
      const assetA = sampleAsset({ code: 'A1', fund: 'Fund A' });
      const assetB = sampleAsset({ code: 'B1', fund: 'Fund B' });

      // Reviewer approves assetB, but deselects Fund B (only selects Fund A in catalog selections)
      const result = await service.applySelected(
        [assetA, assetB],
        ['B1'],
        undefined,
        undefined,
        { funds: ['Fund A'] },
        catalog,
      );

      expect(result.created_assets).toBe(1);
      expect(result.created_funds).toBe(1);
      expect(fundRepo.insert).toHaveBeenCalledTimes(1);
      expect(fundRepo.insert).toHaveBeenCalledWith({ name: 'Fund A' });
      expect(fundRepo.insert).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Fund B' }));
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: null,
        }),
      );
    });

    it('with explicit empty fund selection and proposal fund_catalog, no funds are inserted and approved asset is applied with null fund relationship', async () => {
      fundRepo.findAll.mockResolvedValue([]);
      const catalog = ['Fund A', 'Fund B'];
      const asset = sampleAsset({ code: 'A1', fund: 'Fund A' });

      const result = await service.applySelected(
        [asset],
        ['A1'],
        undefined,
        undefined,
        { funds: [] },
        catalog,
      );

      expect(result.created_assets).toBe(1);
      expect(result.created_funds).toBe(0);
      expect(fundRepo.insert).not.toHaveBeenCalled();
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fund_id: null,
        }),
      );
    });

    it('inserts and links selected investors and sources while leaving unticked ones uninserted and null', async () => {
      holdingEntityRepo.findAll.mockResolvedValue([]);
      fundSourceRepo.findAll.mockResolvedValue([]);

      const asset1 = sampleAsset({
        code: 'A1',
        entity: 'Selected Investor',
        fundingSource: 'Selected Source',
        fundingSourceRaw: 'Selected Source',
      });
      const asset2 = sampleAsset({
        code: 'A2',
        entity: 'Unticked Investor',
        fundingSource: 'Unticked Source',
        fundingSourceRaw: 'Unticked Source',
      });

      const result = await service.applySelected(
        [asset1, asset2],
        ['A1', 'A2'],
        undefined,
        undefined,
        {
          investors: ['Selected Investor'],
          sources: ['Selected Source'],
        },
      );

      expect(result.created_assets).toBe(2);
      expect(result.created_investors).toBe(1);
      expect(result.created_sources).toBe(1);

      expect(holdingEntityRepo.insert).toHaveBeenCalledWith({ name: 'Selected Investor' });
      expect(holdingEntityRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unticked Investor' }),
      );

      expect(fundSourceRepo.insert).toHaveBeenCalledWith({ name: 'Selected Source' });
      expect(fundSourceRepo.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unticked Source' }),
      );

      // Asset 1 has source, asset 2 has null source
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_name: asset1.name,
          funding_source: 'Selected Source',
        }),
      );
      expect(fundAssetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_name: asset2.name,
          funding_source: null,
        }),
      );

      // Asset 1 txn has holding_entity_id & funding_source_id
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: 'he-Selected Investor',
          funding_source_id: 'fs-1',
        }),
      );
      // Asset 2 txn has null holding_entity_id & null funding_source_id
      expect(txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          holding_entity_id: null,
          funding_source_id: null,
        }),
      );
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
