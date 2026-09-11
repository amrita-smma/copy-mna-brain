import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedAsset, ParsedValuation } from '../fund_updates/types';
import { normalizeCanonicalName } from '../fundLedger/normalizeIdentity';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import { FlMasterDataService } from './flMasterDataService';

function sampleValuation(overrides: Partial<ParsedValuation> = {}): ParsedValuation {
  return {
    asOfDate: '2024-03-31',
    periodLabel: '2024Q1',
    marketValue: 10000000,
    pricePerShare: null,
    sharesOutstanding: null,
    shareholdingPct: null,
    investedCapitalCum: null,
    grossMoic: null,
    grossXirr: null,
    valuationMethod: 'at_cost',
    notes: null,
    ...overrides,
  };
}

function sampleAsset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: 'SDT-1',
    name: '赛德特生物制药有限公司',
    legalName: null,
    englishName: null,
    country: 'China',
    investmentTypeLabel: 'Direct Investments',
    assetType: 'direct_investment',
    fund: '南京瑞满',
    entity: '南京投资主体',
    fundingSource: 'DCA',
    fundingSourceRaw: 'DCA',
    entryDate: '2024-01-15',
    stakePct: 1,
    commitmentAmount: null,
    dealType: null,
    mgmtFeeRatePct: null,
    sector: 'Healthcare',
    subSector: 'Biotech',
    instrument: 'Common equity',
    sharesOutstanding: 1000000,
    sourceRef: null,
    vintageYear: 2024,
    currency: 'CNY',
    currentPricePerShare: null,
    valuations: [],
    txns: [],
    ...overrides,
  };
}

describe('Fund Master Data Deduplication & Multi-Fund Holdings', () => {
  const workspaceId = 'ws-dedup-test';
  const mockTx = { __tx: true };

  let db: { transaction: ReturnType<typeof vi.fn> };
  let flFundRepo: any;
  let flAssetRepo: any;
  let flPositionRepo: any;
  let flInvestorRepo: any;
  let flFundingSourceRepo: any;
  let flSourceRecordRepo: any;
  let flLedgerEntryRepo: any;
  let flValuationRepo: any;

  let masterDataService: FlMasterDataService;
  let positionService: any;
  let ledgerService: any;
  let valuationService: any;
  let applyService: FundUpdateApplyService;

  // In-memory mock storage
  let fundsStore: any[];
  let assetsStore: any[];
  let positionsStore: any[];
  let investorsStore: any[];
  let sourcesStore: any[];
  let entriesStore: any[];
  let valuationsStore: any[];

  beforeEach(() => {
    fundsStore = [
      { id: 'f-ruiman', workspace_id: workspaceId, name: '南京瑞满', managed: true, ownership_basis: 'commitment', base_currency: 'CNY' },
      { id: 'f-ruilai', workspace_id: workspaceId, name: '南京瑞来', managed: true, ownership_basis: 'commitment', base_currency: 'CNY' },
    ];
    assetsStore = [];
    positionsStore = [];
    investorsStore = [];
    sourcesStore = [];
    entriesStore = [];
    valuationsStore = [];

    db = {
      transaction: vi.fn(async (cb) => cb(mockTx)),
    };

    const fundCreateFn = vi.fn(async (data) => {
      const row = {
        ...data,
        canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
        id: data.id ?? `fund-${fundsStore.length + 1}`,
      };
      fundsStore.push(row);
      return row;
    });
    flFundRepo = {
      findByWorkspaceId: vi.fn(async () => [...fundsStore]),
      findById: vi.fn(async (_ws, id) => fundsStore.find((f) => f.id === id)),
      findByCanonicalName: vi.fn(async (_ws, canonicalName) =>
        fundsStore.find((f) => (f.canonical_name ?? normalizeCanonicalName(f.name)) === canonicalName),
      ),
      create: fundCreateFn,
      insert: fundCreateFn,
      insertOnConflictDoNothing: vi.fn(async (data) => {
        const canonicalName = data.canonical_name ?? normalizeCanonicalName(data.name);
        const existing = fundsStore.find(
          (f) => (f.canonical_name ?? normalizeCanonicalName(f.name)) === canonicalName,
        );
        if (existing) return undefined;
        return fundCreateFn(data);
      }),
      update: vi.fn(async (_ws, id, patch) => {
        const item = fundsStore.find((f) => f.id === id);
        if (item) Object.assign(item, patch);
        return item;
      }),
    };

    const assetCreateFn = vi.fn(async (data) => {
      const row = {
        ...data,
        canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
        id: data.id ?? `asset-${assetsStore.length + 1}`,
      };
      assetsStore.push(row);
      return row;
    });
    flAssetRepo = {
      findByWorkspaceId: vi.fn(async () => [...assetsStore]),
      findById: vi.fn(async (_ws, id) => assetsStore.find((a) => a.id === id)),
      findByCanonicalName: vi.fn(async (_ws, canonicalName) =>
        assetsStore.find((a) => (a.canonical_name ?? normalizeCanonicalName(a.name)) === canonicalName),
      ),
      create: assetCreateFn,
      insert: assetCreateFn,
      insertOnConflictDoNothing: vi.fn(async (data) => {
        const canonicalName = data.canonical_name ?? normalizeCanonicalName(data.name);
        const existing = assetsStore.find(
          (a) => (a.canonical_name ?? normalizeCanonicalName(a.name)) === canonicalName,
        );
        if (existing) return undefined;
        return assetCreateFn(data);
      }),
      update: vi.fn(async (_ws, id, patch) => {
        const item = assetsStore.find((a) => a.id === id);
        if (item) Object.assign(item, patch);
        return item;
      }),
    };

    const invCreateFn = vi.fn(async (data) => {
      const row = {
        ...data,
        canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
        id: data.id ?? `inv-${investorsStore.length + 1}`,
      };
      investorsStore.push(row);
      return row;
    });
    flInvestorRepo = {
      findByWorkspaceId: vi.fn(async () => [...investorsStore]),
      findById: vi.fn(async (_ws, id) => investorsStore.find((i) => i.id === id)),
      findByCanonicalName: vi.fn(async (_ws, canonicalName) =>
        investorsStore.find((i) => (i.canonical_name ?? normalizeCanonicalName(i.name)) === canonicalName),
      ),
      create: invCreateFn,
      insert: invCreateFn,
      insertOnConflictDoNothing: vi.fn(async (data) => {
        const canonicalName = data.canonical_name ?? normalizeCanonicalName(data.name);
        const existing = investorsStore.find(
          (i) => (i.canonical_name ?? normalizeCanonicalName(i.name)) === canonicalName,
        );
        if (existing) return undefined;
        return invCreateFn(data);
      }),
      update: vi.fn(async (_ws, id, patch) => {
        const item = investorsStore.find((i) => i.id === id);
        if (item) Object.assign(item, patch);
        return item;
      }),
    };

    const srcCreateFn = vi.fn(async (data) => {
      const row = {
        ...data,
        canonical_name: data.canonical_name ?? normalizeCanonicalName(data.name),
        id: data.id ?? `src-${sourcesStore.length + 1}`,
      };
      sourcesStore.push(row);
      return row;
    });
    flFundingSourceRepo = {
      findByWorkspaceId: vi.fn(async () => [...sourcesStore]),
      findById: vi.fn(async (_ws, id) => sourcesStore.find((s) => s.id === id)),
      findByCanonicalName: vi.fn(async (_ws, canonicalName) =>
        sourcesStore.find((s) => (s.canonical_name ?? normalizeCanonicalName(s.name)) === canonicalName),
      ),
      create: srcCreateFn,
      insert: srcCreateFn,
      insertOnConflictDoNothing: vi.fn(async (data) => {
        const canonicalName = data.canonical_name ?? normalizeCanonicalName(data.name);
        const existing = sourcesStore.find(
          (s) => (s.canonical_name ?? normalizeCanonicalName(s.name)) === canonicalName,
        );
        if (existing) return undefined;
        return srcCreateFn(data);
      }),
      update: vi.fn(async (_ws, id, patch) => {
        const item = sourcesStore.find((s) => s.id === id);
        if (item) Object.assign(item, patch);
        return item;
      }),
    };

    flPositionRepo = {
      findByWorkspaceId: vi.fn(async () => [...positionsStore]),
      findByAssetIds: vi.fn(async (_ws, ids) => positionsStore.filter((p) => ids.includes(p.asset_id))),
      findByFundIds: vi.fn(async (_ws, ids) => positionsStore.filter((p) => ids.includes(p.fund_id))),
      insert: vi.fn(async (data) => {
        const row = { id: `pos-${positionsStore.length + 1}`, ...data };
        positionsStore.push(row);
        return row;
      }),
    };

    flLedgerEntryRepo = {
      findByPositionIds: vi.fn(async (_ws, pids) => entriesStore.filter((e) => pids.includes(e.position_id))),
      findAllByPositionIds: vi.fn(async (_ws, pids) => entriesStore.filter((e) => pids.includes(e.position_id))),
    };

    flValuationRepo = {
      findByWorkspaceId: vi.fn(async () => [...valuationsStore]),
      findSeriesByTarget: vi.fn(async () => []),
      findByPositionIdsAndAsOfDates: vi.fn(async (_ws, positionIds, asOfDates) => {
        if (!positionIds?.length || !asOfDates?.length) return [];
        const posSet = new Set(positionIds);
        const dateSet = new Set(asOfDates);
        return valuationsStore.filter(
          (v) => v.position_id && posSet.has(v.position_id) && dateSet.has(v.as_of_date),
        );
      }),
    };

    flSourceRecordRepo = {
      upsertByHash: vi.fn(async (data) => ({ id: `sr-${Date.now()}`, ...data })),
    };

    masterDataService = new FlMasterDataService(
      db as any,
      flInvestorRepo,
      flFundRepo,
      flAssetRepo,
      flFundingSourceRepo,
    );

    positionService = {
      getOrOpenPosition: vi.fn(async (_ws, input) => {
        const existing = positionsStore.find(
          (p) =>
            p.holder_fund_id === input.holder_fund_id &&
            p.asset_id === input.asset_id &&
            p.fund_id === input.fund_id &&
            p.holder_investor_id === input.holder_investor_id &&
            p.holder_source_of_fund_id === input.holder_source_of_fund_id,
        );
        if (existing) return existing;
        const newPos = { id: `pos-${positionsStore.length + 1}`, workspace_id: workspaceId, ...input };
        positionsStore.push(newPos);
        return newPos;
      }),
    };

    ledgerService = {
      postEvent: vi.fn(async (_ws, eventInput) => {
        for (const entry of eventInput.entries) {
          entriesStore.push({
            id: `entry-${entriesStore.length + 1}`,
            position_id: entry.position_id,
            entry_date: eventInput.event_date,
            entry_type: entry.entry_type,
            sub_type: entry.sub_type ?? null,
            cash_delta: entry.cash_delta ?? null,
            quantity_delta: entry.quantity_delta ?? null,
            price_per_unit: entry.price_per_unit ?? null,
            currency: entry.currency ?? null,
          });
        }
        return { id: `evt-${Date.now()}`, entries: entriesStore };
      }),
    };

    valuationService = {
      record: vi.fn(async (_ws, input) => {
        valuationsStore.push({
          id: `val-${valuationsStore.length + 1}`,
          ...input,
        });
        return { id: `val-${valuationsStore.length}` };
      }),
    };

    applyService = new FundUpdateApplyService(
      db as any,
      workspaceId,
      flFundRepo,
      flAssetRepo,
      flPositionRepo,
      flInvestorRepo,
      flFundingSourceRepo,
      masterDataService,
      positionService,
      ledgerService,
      valuationService,
      flValuationRepo,
      flLedgerEntryRepo,
      flSourceRecordRepo,
    );
  });

  it('deduplicates asset across multiple holding funds in a single apply batch (1 fl_assets, 2 fl_positions)', async () => {
    const assetRuiman = sampleAsset({
      code: 'SDT-1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      txns: [
        { date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: 'Initial investment Ruiman', subTypeLabel: null, fxRate: null },
      ],
      valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 12000000, periodLabel: '2024Q1' })],
    });

    const assetRuilai = sampleAsset({
      code: 'SDT-2',
      name: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
      englishName: 'Saidet Biotech Co., Ltd.',
      fund: '南京瑞来',
      entryDate: '2024-02-01',
      txns: [
        { date: '2024-02-01', type: 'contribution', valueAmount: 5000000, shareCount: 500000, pricePerShare: 10, currency: 'CNY', notes: 'Initial investment Ruilai', subTypeLabel: null, fxRate: null },
      ],
      valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 6000000, periodLabel: '2024Q1' })],
    });

    const result = await applyService.applySelected(
      [assetRuiman, assetRuilai],
      ['SDT-1', 'SDT-2'],
    );

    expect(result.created_assets).toBe(1);
    expect(result.updated_assets).toBe(1);
    expect(result.txns_inserted).toBe(2);

    // Exactly 1 asset master record created
    expect(assetsStore).toHaveLength(1);
    const sharedAsset = assetsStore[0];
    expect(sharedAsset.name).toBe('赛德特生物制药有限公司');
    expect(sharedAsset.english_name).toBe('Saidet Biotech Co., Ltd.');

    // Exactly 2 distinct positions created pointing to the SAME asset
    expect(positionsStore).toHaveLength(2);
    const posRuiman = positionsStore.find((p) => p.holder_fund_id === 'f-ruiman');
    const posRuilai = positionsStore.find((p) => p.holder_fund_id === 'f-ruilai');
    expect(posRuiman).toBeDefined();
    expect(posRuilai).toBeDefined();
    expect(posRuiman.asset_id).toBe(sharedAsset.id);
    expect(posRuilai.asset_id).toBe(sharedAsset.id);

    // Transactions attached to correct respective positions
    const ruimanEntries = entriesStore.filter((e) => e.position_id === posRuiman.id);
    const ruilaiEntries = entriesStore.filter((e) => e.position_id === posRuilai.id);
    expect(ruimanEntries).toHaveLength(1);
    expect(ruilaiEntries).toHaveLength(1);
    expect(ruimanEntries[0].entry_date).toBe('2024-01-15');
    expect(ruilaiEntries[0].entry_date).toBe('2024-02-01');
  });

  it('handles follow-on investments on existing fund position without creating new asset', async () => {
    // 1. Initial investment
    const initialAsset = sampleAsset({
      code: 'SDT-1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      entryDate: '2024-01-15',
      txns: [
        { date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: 'Round A', subTypeLabel: null, fxRate: null },
      ],
      valuations: [],
    });
    await applyService.applySelected([initialAsset], ['SDT-1']);

    expect(assetsStore).toHaveLength(1);
    expect(positionsStore).toHaveLength(1);
    expect(entriesStore).toHaveLength(1);

    // 2. Follow-on investment by same fund
    const followOnAsset = sampleAsset({
      code: 'SDT-1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      entryDate: '2024-06-01',
      txns: [
        { date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: 'Round A', subTypeLabel: null, fxRate: null },
        { date: '2024-06-01', type: 'contribution', valueAmount: 5000000, shareCount: 250000, pricePerShare: 20, currency: 'CNY', notes: 'Round B', subTypeLabel: null, fxRate: null },
      ],
      valuations: [],
    });

    const review = await applyService.buildReview([followOnAsset]);
    expect(review[0].status).toBe('add_missing');
    expect(review[0].missing_txn_count).toBe(1);

    const followOnResult = await applyService.applySelected([followOnAsset], ['SDT-1']);
    expect(followOnResult.created_assets).toBe(0);
    expect(followOnResult.updated_assets).toBe(1);
    expect(followOnResult.txns_inserted).toBe(1);

    // Still exactly 1 asset and 1 position, but 2 transactions on that position
    expect(assetsStore).toHaveLength(1);
    expect(positionsStore).toHaveLength(1);
    expect(entriesStore).toHaveLength(2);
  });

  it('matches existing asset on second separate request and opens position for new fund', async () => {
    // Request 1: Fund Ruiman invests in Saidet
    const req1Asset = sampleAsset({
      code: 'SDT-1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      entryDate: '2024-01-15',
      txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: null, subTypeLabel: null, fxRate: null }],
      valuations: [],
    });
    await applyService.applySelected([req1Asset], ['SDT-1']);
    expect(assetsStore).toHaveLength(1);

    // Request 2: Fund Ruilai invests in same company (name with spaces and English suffix)
    const req2Asset = sampleAsset({
      code: 'SDT-RUILAI',
      name: '  赛德特 生物制药 有限公司  Saidet Biotech',
      fund: '南京瑞来',
      entryDate: '2024-03-01',
      txns: [{ date: '2024-03-01', type: 'contribution', valueAmount: 3000000, shareCount: 300000, pricePerShare: 10, currency: 'CNY', notes: null, subTypeLabel: null, fxRate: null }],
      valuations: [],
    });

    const review2 = await applyService.buildReview([req2Asset]);
    expect(review2[0].matched_asset_id).toBe(assetsStore[0].id);

    const res2 = await applyService.applySelected([req2Asset], ['SDT-RUILAI']);
    expect(res2.created_assets).toBe(0);
    expect(res2.updated_assets).toBe(1);

    // Asset was NOT duplicated
    expect(assetsStore).toHaveLength(1);
    // 2 distinct positions created
    expect(positionsStore).toHaveLength(2);
  });

  it('is completely idempotent on replay with 0 created assets and 0 duplicate entries', async () => {
    const asset = sampleAsset({
      code: 'SDT-1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      entryDate: '2024-01-15',
      txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: null, subTypeLabel: null, fxRate: null }],
      valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 10000000, periodLabel: '2024Q1' })],
    });

    // First apply
    await applyService.applySelected([asset], ['SDT-1']);
    expect(assetsStore).toHaveLength(1);
    expect(positionsStore).toHaveLength(1);
    expect(entriesStore).toHaveLength(1);

    // Review on replay
    const review = await applyService.buildReview([asset]);
    expect(review[0].status).toBe('unchanged');
    expect(review[0].missing_txn_count).toBe(0);
    expect(review[0].missing_valuation_count).toBe(0);

    // Re-apply
    const reapply = await applyService.applySelected([asset], ['SDT-1']);
    expect(reapply.skipped).toBe(1);
    expect(reapply.created_assets).toBe(0);
    expect(reapply.updated_assets).toBe(0);
    expect(reapply.txns_inserted).toBe(0);

    // State remains pristine
    expect(assetsStore).toHaveLength(1);
    expect(positionsStore).toHaveLength(1);
    expect(entriesStore).toHaveLength(1);
  });

  it('preserves distinct legal entities as separate assets', async () => {
    const asset1 = sampleAsset({
      code: 'SDT-PHARMA',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      entryDate: '2024-01-15',
      txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, shareCount: 1000000, pricePerShare: 10, currency: 'CNY', notes: null, subTypeLabel: null, fxRate: null }],
      valuations: [],
    });

    const asset2 = sampleAsset({
      code: 'SDT-TECH',
      name: '赛德特生物技术有限公司',
      fund: '南京瑞满',
      entryDate: '2024-01-15',
      txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 5000000, shareCount: 500000, pricePerShare: 10, currency: 'CNY', notes: null, subTypeLabel: null, fxRate: null }],
      valuations: [],
    });

    const result = await applyService.applySelected([asset1, asset2], ['SDT-PHARMA', 'SDT-TECH']);
    expect(result.created_assets).toBe(2);
    expect(assetsStore).toHaveLength(2);
    expect(assetsStore[0].name).toBe('赛德特生物制药有限公司');
    expect(assetsStore[1].name).toBe('赛德特生物技术有限公司');
  });

  it('deduplicates external Fund-of-Funds target across multiple holding funds (1 fl_funds FoF, 2 fl_positions)', async () => {
    const fofRuiman = sampleAsset({
      code: 'FOF-TARGET-1',
      name: '汇智成长二期母基金',
      fund: '南京瑞满',
      assetType: 'fund_of_funds',
      entryDate: '2024-01-15',
      txns: [
        { date: '2024-01-15', type: 'contribution', valueAmount: 20000000, shareCount: 20000000, pricePerShare: 1, currency: 'CNY', notes: 'Ruiman FoF commitment', subTypeLabel: null, fxRate: null },
      ],
      valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 21000000, periodLabel: '2024Q1' })],
    });

    const fofRuilai = sampleAsset({
      code: 'FOF-TARGET-2',
      name: '汇智成长二期母基金 Huizhi Growth Fund II',
      englishName: 'Huizhi Growth Fund II',
      fund: '南京瑞来',
      assetType: 'fund_of_funds',
      entryDate: '2024-02-01',
      txns: [
        { date: '2024-02-01', type: 'contribution', valueAmount: 10000000, shareCount: 10000000, pricePerShare: 1, currency: 'CNY', notes: 'Ruilai FoF commitment', subTypeLabel: null, fxRate: null },
      ],
      valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 10500000, periodLabel: '2024Q1' })],
    });

    const result = await applyService.applySelected([fofRuiman, fofRuilai], ['FOF-TARGET-1', 'FOF-TARGET-2']);

    expect(result.created_assets).toBe(0);
    expect(result.created_funds).toBe(1);
    expect(result.updated_assets).toBe(1);

    // Exactly 1 unmanaged target fund created
    const targetFofs = fundsStore.filter((f) => !f.managed);
    expect(targetFofs).toHaveLength(1);
    expect(targetFofs[0].name).toBe('汇智成长二期母基金');
    expect(targetFofs[0].english_name).toBe('Huizhi Growth Fund II');

    // 2 distinct FoF positions created
    const fofPositions = positionsStore.filter((p) => p.fund_id === targetFofs[0].id);
    expect(fofPositions).toHaveLength(2);
    expect(fofPositions.find((p) => p.holder_fund_id === 'f-ruiman')).toBeDefined();
    expect(fofPositions.find((p) => p.holder_fund_id === 'f-ruilai')).toBeDefined();
  });

  it('reuses an existing managed fund when it appears as a FoF target', async () => {
    const existingManagedTarget = {
      id: 'f-existing-target',
      workspace_id: workspaceId,
      name: '南京月升星繁创业投资合伙企业（有限合伙）',
      canonical_name: normalizeCanonicalName('南京月升星繁创业投资合伙企业（有限合伙）'),
      managed: true,
      ownership_basis: 'commitment',
      base_currency: 'CNY',
    };
    fundsStore.push(existingManagedTarget);

    const proposed = sampleAsset({
      code: 'SAPE40',
      name: '南京月升星繁创业投资合伙企业（有限合伙）',
      fund: '南京瑞满',
      assetType: 'fund_of_funds',
      txns: [
        {
          date: '2024-01-15',
          type: 'contribution',
          valueAmount: 10000000,
          shareCount: null,
          pricePerShare: null,
          currency: 'CNY',
          notes: null,
          subTypeLabel: null,
          fxRate: null,
        },
      ],
    });

    const result = await applyService.applySelected([proposed], ['SAPE40']);

    expect(fundsStore.filter((f) => normalizeCanonicalName(f.name) === existingManagedTarget.canonical_name)).toHaveLength(1);
    expect(positionsStore).toContainEqual(
      expect.objectContaining({
        holder_fund_id: 'f-ruiman',
        fund_id: existingManagedTarget.id,
      }),
    );
    expect(result.created_assets).toBe(0);
  });

  it('deduplicates multi-fund direct asset holdings into a single fl_assets record with distinct positions', async () => {
    const proposedRuiman = sampleAsset({
      code: 'NJ-RM-SDT',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      assetType: 'direct_investment',
      txns: [
        {
          date: '2024-01-15',
          type: 'contribution',
          valueAmount: 10000000,
          shareCount: null,
          pricePerShare: null,
          currency: 'CNY',
          notes: null,
          subTypeLabel: null,
          fxRate: null,
        },
      ],
      valuations: [
        {
          asOfDate: '2024-03-31',
          periodLabel: 'Q1 2024',
          marketValue: 12000000,
          pricePerShare: null,
          sharesOutstanding: null,
          shareholdingPct: null,
          investedCapitalCum: null,
          grossMoic: null,
          grossXirr: null,
          valuationMethod: null,
          notes: null,
        },
      ],
    });

    const proposedRuilai = sampleAsset({
      code: 'NJ-RL-SDT',
      name: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
      fund: '南京瑞来',
      assetType: 'direct_investment',
      txns: [
        {
          date: '2024-02-01',
          type: 'contribution',
          valueAmount: 5000000,
          shareCount: null,
          pricePerShare: null,
          currency: 'CNY',
          notes: null,
          subTypeLabel: null,
          fxRate: null,
        },
      ],
    });

    const result = await applyService.applySelected(
      [proposedRuiman, proposedRuilai],
      ['NJ-RM-SDT', 'NJ-RL-SDT'],
    );

    expect(result.created_assets).toBe(1);
    expect(result.updated_assets).toBe(1);

    // Exactly 1 asset created in assetsStore
    expect(assetsStore).toHaveLength(1);
    const createdAsset = assetsStore[0];
    expect(normalizeCanonicalName(createdAsset.name)).toBe('赛德特生物制药有限公司');

    // 2 distinct positions created (one per managing fund)
    const assetPositions = positionsStore.filter((p) => p.asset_id === createdAsset.id);
    expect(assetPositions).toHaveLength(2);
    expect(assetPositions.find((p) => p.holder_fund_id === 'f-ruiman')).toBeDefined();
    expect(assetPositions.find((p) => p.holder_fund_id === 'f-ruilai')).toBeDefined();
  });

  it('throws a safety invariant violation if two direct assets with same canonical identity resolve to differing asset IDs', async () => {
    const proposed1 = sampleAsset({
      code: 'NJ-A1',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞满',
      assetType: 'direct_investment',
    });
    const proposed2 = sampleAsset({
      code: 'NJ-A2',
      name: '赛德特生物制药有限公司',
      fund: '南京瑞来',
      assetType: 'direct_investment',
    });

    // Create 2 conflicting asset records in store
    const asset1 = {
      id: 'ast-conflicting-1',
      workspace_id: workspaceId,
      name: '赛德特 1',
      canonical_name: '赛德特1',
    };
    const asset2 = {
      id: 'ast-conflicting-2',
      workspace_id: workspaceId,
      name: '赛德特 2',
      canonical_name: '赛德特2',
    };
    assetsStore.push(asset1, asset2);

    // Provide conflicting matched_target_id selections for the same canonical entity name
    await expect(
      applyService.applySelected(
        [proposed1, proposed2],
        ['NJ-A1', 'NJ-A2'],
        [
          { asset_code: 'NJ-A1', txns: [], valuations: [], matched_target_id: 'ast-conflicting-1' },
          { asset_code: 'NJ-A2', txns: [], valuations: [], matched_target_id: 'ast-conflicting-2' },
        ],
      ),
    ).rejects.toThrow(/Safety invariant violation/);
  });

  it('idempotently handles concurrent creation race conditions via insertOnConflictDoNothing and findByCanonicalName', async () => {
    // Seed existing winner asset created by concurrent worker
    const winnerAsset = {
      id: 'ast-concurrent-winner',
      workspace_id: workspaceId,
      name: '赛德特生物制药有限公司',
      canonical_name: normalizeCanonicalName('赛德特生物制药有限公司'),
      english_name: null,
      asset_kind: 'equity',
    };
    assetsStore.push(winnerAsset);

    // Apply a proposed asset for the same canonical name
    const proposed = sampleAsset({
      code: 'NJ-RM-SDT',
      name: '赛德特生物制药有限公司',
      englishName: 'Saidet Biotech Co., Ltd.',
      fund: '南京瑞满',
      assetType: 'direct_investment',
      txns: [
        {
          date: '2024-01-15',
          type: 'contribution',
          valueAmount: 10000000,
          shareCount: null,
          pricePerShare: null,
          currency: 'CNY',
          notes: null,
          subTypeLabel: null,
          fxRate: null,
        },
      ],
    });

    const result = await applyService.applySelected([proposed], ['NJ-RM-SDT']);

    // Should resolve to the winner asset without creating a duplicate
    expect(assetsStore).toHaveLength(1);
    expect(assetsStore[0].id).toBe('ast-concurrent-winner');
    expect(assetsStore[0].english_name).toBe('Saidet Biotech Co., Ltd.');

    // 1 position opened for the winner asset
    const positions = positionsStore.filter((p) => p.asset_id === 'ast-concurrent-winner');
    expect(positions).toHaveLength(1);
    expect(positions[0].holder_fund_id).toBe('f-ruiman');
  });
});
