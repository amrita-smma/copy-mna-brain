import { describe, expect, it } from 'vitest';
import {
  buildNormalizedTwoStepReview,
  validateTwoStepDependencies,
} from './twoStepReview';
import type {
  FundUpdateFullReview,
  FundUpdateAssetReview,
  LegacyAssetProposal,
  WorkbookFallbackProposalV1,
  ReviewTransaction,
  ReviewValuation,
  ParsedAsset,
  ParsedTxn,
  ParsedValuation,
  ParsedCommitmentEvent,
  ReviewProposalItem,
} from './types';

function sampleTxn(overrides: Partial<ParsedTxn> = {}): ParsedTxn {
  return {
    date: '2023-01-01',
    type: 'contribution',
    subTypeLabel: null,
    pricePerShare: 10,
    shareCount: 100,
    valueAmount: 1000,
    currency: 'USD',
    fxRate: null,
    notes: null,
    ...overrides,
  };
}

function sampleValuation(overrides: Partial<ParsedValuation> = {}): ParsedValuation {
  return {
    asOfDate: '2023-03-31',
    periodLabel: 'Q1 2023',
    marketValue: 1500,
    pricePerShare: 15,
    sharesOutstanding: 100,
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
    code: 'ST-01',
    name: 'Startech Alpha',
    legalName: 'Alpha Corp',
    country: 'Indonesia',
    investmentTypeLabel: 'Direct Investments',
    assetType: 'direct_investment',
    fund: 'Startech Growth Fund 1',
    entity: 'Startech LP',
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
    sourceRef: 'S001',
    vintageYear: 2021,
    currency: 'USD',
    currentPricePerShare: 10,
    txns: [],
    valuations: [],
    ...overrides,
  };
}

function sampleAssetReview(overrides: Partial<FundUpdateAssetReview> = {}): FundUpdateAssetReview {
  const asset = overrides.proposed || sampleAsset();
  return {
    code: asset.code,
    name: asset.name,
    fund: asset.fund,
    asset_type: asset.assetType,
    entity: asset.entity,
    funding_source: asset.fundingSource,
    matched_fund: null,
    matched_investor: null,
    matched_source: null,
    status: 'new',
    matched_asset_id: null,
    proposed_txn_count: asset.txns.length,
    proposed_valuation_count: asset.valuations.length,
    existing_txn_count: 0,
    existing_valuation_count: 0,
    missing_txn_count: asset.txns.length,
    missing_valuation_count: asset.valuations.length,
    proposed: asset,
    missing_txns: asset.txns,
    missing_valuations: asset.valuations,
    ...overrides,
  };
}

function sampleCommitmentEvent(overrides: Partial<ParsedCommitmentEvent> = {}): ParsedCommitmentEvent {
  return {
    fund: '南京紫金基金',
    fundEnglishName: null,
    investorName: '南京高新创投',
    investorEnglishName: null,
    investorTypeRaw: '机构投资人',
    investorTypeLabel: 'Institutional Investor',
    date: '2023-01-10',
    amount: 10000000,
    currency: 'CNY',
    intent: 'increase',
    counterpartyName: null,
    actionRaw: '认缴',
    natureRaw: '新增额度',
    directionRaw: '认缴额度增加',
    notes: null,
    sourceRow: 2,
    ...overrides,
  };
}

function sampleReviewItem(overrides: Partial<ReviewProposalItem> = {}): ReviewProposalItem {
  return {
    sourceRow: 10,
    fund: '南京紫金基金',
    investorName: '南京高新创投',
    date: '2023-05-15',
    amount: 300000,
    currency: 'CNY',
    action: '实缴调整',
    nature: '损益核销',
    direction: '非现金调整',
    category: 'non_cash_adjustment',
    explanation: 'Profit/loss writeoff',
    isPostable: false,
    requiresReview: true,
    ...overrides,
  };
}

describe('twoStepReview — Canonical Two-Step Normalization & Dependency Engine (MB-513)', () => {
  describe('buildNormalizedTwoStepReview — STARTECH Proposal', () => {
    it('normalizes STARTECH quarterly proposal with canonical entity keys, separate transactions and valuations', () => {
      const txn2022 = sampleTxn({
        date: '2022-01-01',
        valueAmount: 500,
        shareCount: 50,
      });
      const txn2023 = sampleTxn({
        date: '2023-01-01',
        valueAmount: 1000,
        shareCount: 100,
      });
      const val2023 = sampleValuation({
        asOfDate: '2023-03-31',
        marketValue: 1500,
        pricePerShare: 15,
        sharesOutstanding: 100,
      });

      const proposedAsset = sampleAsset({
        code: 'ST-01',
        name: 'Startech Alpha',
        englishName: 'Startech Alpha Holdings',
        holderKind: 'investor',
        fund: 'Startech Growth Fund 1',
        entity: 'Startech LP',
        fundingSource: 'DCA',
        fundingSourceRaw: 'DCA',
        currency: 'USD',
        txns: [txn2022, txn2023],
        valuations: [val2023],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: proposedAsset,
            missing_txns: [txn2023], // 2022 is duplicate, 2023 is missing
            missing_valuations: [val2023],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [{ name: 'Startech LP', status: 'new', matched_id: null }],
        sources: [{ name: 'DCA', status: 'existing', matched_id: 'src-1' }],
        reconciliation: [],
        review_items: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // 1. Entities & Canonical Key Prefixes
      expect(result.entities).toHaveLength(4);
      expect(result.entities.map((e) => e.key)).toEqual([
        'asset:ST-01',
        'fund:Startech Growth Fund 1',
        'investor:Startech LP',
        'source:DCA',
      ]);
      // Verify no invalid legacy prefixes
      expect(result.entities.some((e) => e.key.startsWith('inv:') || e.key.startsWith('src:'))).toBe(false);
      expect(result.entities.find((e) => e.key === 'asset:ST-01')?.englishName).toBe(
        'Startech Alpha Holdings',
      );

      // 2. Transactions
      expect(result.transactions).toHaveLength(2);
      const dupTxn = result.transactions.find((t) => t.date === '2022-01-01');
      expect(dupTxn?.status).toBe('duplicate');
      expect(dupTxn?.selected).toBe(false);
      expect(dupTxn?.fromKey).toBe('investor:Startech LP');
      expect(dupTxn?.toKey).toBe('asset:ST-01');
      expect(dupTxn?.srcKey).toBe('source:DCA');

      const actionTxn = result.transactions.find((t) => t.date === '2023-01-01');
      expect(actionTxn?.status).toBe('actionable');
      expect(actionTxn?.selected).toBe(true);

      // 3. Valuations (Separate Tab)
      expect(result.valuations).toHaveLength(1);
      expect(result.valuations[0].assetCode).toBe('ST-01');
      expect(result.valuations[0].asOfDate).toBe('2023-03-31');
      expect(result.valuations[0].marketValue).toBe(1500);
      expect(result.valuations[0].status).toBe('actionable');
      expect(result.valuations[0].selected).toBe(true);
    });
  });

  describe('buildNormalizedTwoStepReview — Nanjing Lifecycle Events & Review Items', () => {
    it('normalizes Nanjing commitment events, non-cash adjustments, and single/multi-party transfers into transactions', () => {
      const proposedAsset = sampleAsset({
        code: 'NJ-01',
        name: 'Nanjing Biotech',
        fund: '南京紫金基金',
        entity: '南京高新创投',
        txns: [],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: proposedAsset,
            missing_txns: [],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: '南京紫金基金', status: 'new', matched_id: null }],
        investors: [{ name: '南京高新创投', status: 'new', matched_id: null }],
        sources: [],
        reconciliation: [
          {
            metricName: 'Paid-in Capital vs Summary',
            fund: '南京紫金基金',
            sourceValue: 10000000,
            calculatedValue: 10000000,
            diff: 0,
            diffPct: 0,
            isReconciled: true,
          },
        ],
        review_items: [
          sampleReviewItem({
            sourceRow: 10,
            fund: '南京紫金基金',
            investorName: '南京高新创投',
            date: '2023-05-15',
            amount: 300000,
            action: '实缴调整',
            category: 'non_cash_adjustment',
            explanation: 'Profit/loss writeoff',
          }),
          sampleReviewItem({
            sourceRow: 11,
            fund: '南京紫金基金',
            investorName: '受让人企业',
            counterpartyRaw: '转让人企业',
            date: '2023-06-20',
            amount: 1500000,
            action: 'Commitment transfer',
            nature: '转让',
            direction: '转让',
            category: 'truncated_transfer',
            explanation: 'Single party transfer',
          }),
          sampleReviewItem({
            sourceRow: 12,
            fund: '南京紫金基金',
            investorName: '受让人企业',
            counterpartyRaw: '转让人甲及转让人乙',
            date: '2023-07-25',
            amount: 2000000,
            action: 'Commitment transfer',
            nature: '转让',
            direction: '转让',
            category: 'multi_party_transfer',
            explanation: 'Multi-party split transfer',
          }),
        ],
      };

      const proposal: LegacyAssetProposal = {
        template_id: 'nanjing_fund_ledger_v1',
        stats: {
          asset_count: 1,
          direct_count: 1,
          fund_of_funds_count: 0,
          transaction_count: 0,
          valuation_count: 0,
          commitment_event_count: 2,
          review_item_count: 3,
        },
        assets: fullReview.assets.map((a) => a.proposed),
        fund_catalog: ['南京紫金基金'],
        reconciliation: fullReview.reconciliation,
        review_items: fullReview.review_items,
        commitment_events: [
          sampleCommitmentEvent({
            sourceRow: 2,
            fund: '南京紫金基金',
            investorName: '南京高新创投',
            date: '2023-01-10',
            amount: 10000000,
            intent: 'increase',
            actionRaw: '认缴',
            natureRaw: '新增额度',
            directionRaw: '认缴额度增加',
          }),
          sampleCommitmentEvent({
            sourceRow: 3,
            fund: '南京紫金基金',
            investorName: '南京高新创投',
            date: '2023-02-15',
            amount: 5000000,
            intent: 'paid_in',
            actionRaw: '实缴',
            natureRaw: '实缴出资',
            directionRaw: '实缴到账',
          }),
        ],
      };

      const result = buildNormalizedTwoStepReview(fullReview, proposal);

      // Verify reconciliation passed through
      expect(result.reconciliation).toHaveLength(1);
      expect(result.reconciliation[0].isReconciled).toBe(true);

      // Verify lifecycle transactions:
      // 2 commitment events + 3 review items = 5 transactions
      expect(result.transactions).toHaveLength(5);

      const commTxn = result.transactions.find((t) => t.date === '2023-01-10');
      expect(commTxn?.type).toBe('commitment');
      expect(commTxn?.fromKey).toBe('investor:南京高新创投');
      expect(commTxn?.toKey).toBe('fund:南京紫金基金');

      const paidInTxn = result.transactions.find((t) => t.date === '2023-02-15');
      expect(paidInTxn?.type).toBe('paid_in');

      const nonCashTxn = result.transactions.find((t) => t.date === '2023-05-15');
      expect(nonCashTxn?.isNonCashAdjustment).toBe(true);
      expect(nonCashTxn?.type).toBe('adjustment');

      const singleXferTxn = result.transactions.find((t) => t.date === '2023-06-20');
      expect(singleXferTxn?.isTransfer).toBe(true);
      expect(Boolean(singleXferTxn?.isMultiPartyTransfer)).toBe(false);

      const multiXferTxn = result.transactions.find((t) => t.date === '2023-07-25');
      expect(multiXferTxn?.isTransfer).toBe(true);
      expect(multiXferTxn?.isMultiPartyTransfer).toBe(true);
    });

    it('classifies duplicate commitment events as duplicate and leaves them unselected', () => {
      const fullReview: FundUpdateFullReview = {
        assets: [],
        funds: [{ name: '南京紫金基金', status: 'existing', matched_id: 'fund-1' }],
        investors: [
          { name: '南京高新创投', status: 'existing', matched_id: 'inv-1' },
          { name: '江苏省产业基金', status: 'existing', matched_id: 'inv-2' },
        ],
        sources: [],
        commitment_event_statuses: {
          2: 'duplicate',
          3: 'actionable',
          4: 'duplicate',
        },
      };

      const proposal: LegacyAssetProposal = {
        template_id: 'nanjing_fund_ledger',
        stats: {
          asset_count: 0,
          direct_count: 0,
          fund_of_funds_count: 0,
          transaction_count: 3,
          valuation_count: 0,
        },
        assets: [],
        commitment_events: [
          sampleCommitmentEvent({
            sourceRow: 2,
            fund: '南京紫金基金',
            investorName: '南京高新创投',
            date: '2023-01-10',
            intent: 'increase',
            amount: 50_000_000,
          }),
          sampleCommitmentEvent({
            sourceRow: 3,
            fund: '南京紫金基金',
            investorName: '南京高新创投',
            date: '2023-02-15',
            intent: 'paid_in',
            amount: 25_000_000,
          }),
          sampleCommitmentEvent({
            sourceRow: 4,
            fund: '南京紫金基金',
            investorName: '江苏省产业基金',
            date: '2023-03-20',
            intent: 'transfer_in',
            amount: 10_000_000,
            transferPairing: {
              status: 'paired',
              transferorName: '南京高新创投',
              eligibleForTransferOut: true,
              requiresReview: false,
            },
          }),
        ],
      };

      const result = buildNormalizedTwoStepReview(fullReview, proposal);

      expect(result.transactions).toHaveLength(3);

      const dupCommit = result.transactions.find((t) => t.sheetRow === 2);
      expect(dupCommit?.status).toBe('duplicate');
      expect(dupCommit?.selected).toBe(false);
      expect(dupCommit?.blockReason).toBeNull();

      const actPaidIn = result.transactions.find((t) => t.sheetRow === 3);
      expect(actPaidIn?.status).toBe('actionable');
      expect(actPaidIn?.selected).toBe(true);
      expect(actPaidIn?.blockReason).toBeNull();

      const dupTransfer = result.transactions.find((t) => t.sheetRow === 4);
      expect(dupTransfer?.status).toBe('duplicate');
      expect(dupTransfer?.selected).toBe(false);
      expect(dupTransfer?.blockReason).toBeNull();
    });
  });

  describe('buildNormalizedTwoStepReview — Workbook Fallback v1', () => {
    it('normalizes Workbook LLM fallback proposal into canonical two-step review structure', () => {
      const fallbackAsset = sampleAsset({
        code: 'FB-01',
        name: 'Fallback Bio',
        fund: 'Fallback Growth Fund',
        entity: 'Fallback Investor LLC',
        txns: [],
        valuations: [],
      });

      const fallbackProposal: WorkbookFallbackProposalV1 = {
        template_id: 'workbook_fallback_v1',
        schema_version: 'workbook_fallback_v1',
        stats: {
          asset_count: 1,
          direct_count: 1,
          fund_of_funds_count: 0,
          transaction_count: 1,
          valuation_count: 1,
          total_data_rows: 2,
          parsed_rows_count: 2,
          excluded_rows_count: 0,
          ambiguous_rows_count: 0,
          coverage_pct: 100,
          entity_count: 3,
          event_count: 1,
        },
        entities: [
          { proposalId: 'ent-1', entityType: 'fund', originalName: 'Fallback Growth Fund', aliases: [], sourceLocations: [], warnings: [] },
          { proposalId: 'ent-2', entityType: 'institutional_investor', originalName: 'Fallback Investor LLC', aliases: [], sourceLocations: [], warnings: [] },
          { proposalId: 'ent-3', entityType: 'portfolio_company', originalName: 'Fallback Bio', aliases: [], sourceLocations: [], warnings: [] },
        ],
        events: [
          {
            proposalId: 'evt-1',
            eventType: 'asset_investment',
            fromEntityRef: 'ent-2',
            toEntityRef: 'ent-3',
            relatedFundRef: 'Fallback Growth Fund',
            date: '2023-04-01',
            normalizedAmount: 1000000,
            normalizedCurrency: 'USD',
            sourceLocation: { sheet: 'Sheet1', row: 2 },
            warnings: [],
          },
        ],
        valuations: [
          {
            proposalId: 'val-1',
            entityRef: 'ent-3',
            asOfDate: '2023-06-30',
            normalizedMarketValue: 1200000,
            normalizedCurrency: 'USD',
            sourceMarketValue: 1200000,
            sourceCurrency: 'USD',
            sourceLocation: { sheet: 'Sheet1', row: 3 },
            warnings: [],
          },
        ],
        row_accounting: {
          totalDataRows: 2,
          parsedRows: [2, 3],
          excludedRows: [],
          ambiguousRows: [],
          unaccountedRows: [],
          coveragePct: 100,
        },
        interpretation: {
          detectedLanguages: ['en'],
          workbookPurpose: 'fund_summary',
          tables: [],
          glossary: [],
          currencies: [],
          summaryTables: [],
          warnings: [],
        },
        validation: {
          isReviewable: true,
          hardFailures: [],
          warnings: [],
          stats: {
            totalRows: 2,
            parsedRowsCount: 2,
            excludedRowsCount: 0,
            ambiguousRowsCount: 0,
            coveragePct: 100,
            actionCounts: {},
            eventCounts: {},
            fundTotals: {},
          },
        },
        warnings: [],
        assets: [fallbackAsset],
        reconciliation: [],
      };

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fallbackAsset,
            missing_txns: [],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Fallback Growth Fund', status: 'new', matched_id: null }],
        investors: [{ name: 'Fallback Investor LLC', status: 'new', matched_id: null }],
        sources: [],
        reconciliation: [],
        review_items: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview, fallbackProposal);

      expect(result.entities.some((e) => e.key === 'fund:Fallback Growth Fund')).toBe(true);
      expect(result.entities.some((e) => e.key === 'investor:Fallback Investor LLC')).toBe(true);
      expect(result.entities.some((e) => e.key === 'asset:FB-01')).toBe(true);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].fromKey).toBe('investor:Fallback Investor LLC');
      expect(result.transactions[0].toKey).toBe('asset:FB-01');

      expect(result.valuations).toHaveLength(1);
      expect(result.valuations[0].assetCode).toBe('FB-01');
      expect(result.valuations[0].marketValue).toBe(1200000);

      // An LLM-classified fund uses the target table resolved by the review.
      const fundAsset = { ...fallbackAsset, assetType: 'fund_of_funds' as const };
      const flagOffReview = buildNormalizedTwoStepReview({
        ...fullReview,
        assets: [sampleAssetReview({ proposed: fundAsset, target_kind: 'asset' })],
      }, {
        ...fallbackProposal,
        assets: [fundAsset],
        entities: fallbackProposal.entities.map((entity) => entity.proposalId === 'ent-3' ? { ...entity, entityType: 'fund' as const } : entity),
      });
      expect(flagOffReview.entities.find((entity) => entity.key === `asset:${fundAsset.code}`)?.tab).toBe('asset');
      expect(flagOffReview.entities.some((entity) => entity.key === `fund:${fundAsset.name}`)).toBe(false);
      expect(flagOffReview.transactions[0].toKey).toBe(`asset:${fundAsset.code}`);
      expect(flagOffReview.valuations[0].targetKey).toBe(`asset:${fundAsset.code}`);

    });
  });

  describe('validateTwoStepDependencies — Server & Client Validation Rules', () => {
    it('blocks transaction when required From or To entity is missing or deselected in Step 1', () => {
      const stagedEntities = new Map([
        ['fund:Fund A', { key: 'fund:Fund A', name: 'Fund A', kind: 'fund', isStaged: true }],
        ['investor:Investor B', { key: 'investor:Investor B', name: 'Investor B', kind: 'investor', isStaged: false }], // Deselected!
        ['asset:AST-1', { key: 'asset:AST-1', name: 'Asset 1', kind: 'asset', isStaged: true }],
      ]);

      const transactions: ReviewTransaction[] = [
        {
          id: 'txn-1',
          sheetRow: 1,
          date: '2023-01-01',
          type: 'buy',
          subType: 'contribution',
          commitDelta: null,
          quantityDelta: 10,
          pricePerShare: 10,
          cashDelta: -100,
          currency: 'USD',
          positionRef: null,
          isTransfer: false,
          fromKey: 'investor:Investor B', // references deselected entity
          toKey: 'asset:AST-1',
          srcKey: null,
          selected: true,
          status: 'actionable',
        },
      ];

      const validation = validateTwoStepDependencies({
        stagedEntities,
        transactions,
        valuations: [],
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0]).toContain("requires 'from' entity \"investor:Investor B\"");
      expect(validation.validatedTransactions[0].status).toBe('blocked');
    });

    it('blocks a selected transaction whose required From key is empty', () => {
      const validation = validateTwoStepDependencies({
        stagedEntities: new Map([
          ['asset:AST-1', { key: 'asset:AST-1', name: 'Asset 1', kind: 'asset', isStaged: true }],
        ]),
        transactions: [
          {
            id: 'txn-missing-from',
            sheetRow: 2,
            date: '2023-01-02',
            type: 'buy',
            subType: 'contribution',
            commitDelta: null,
            quantityDelta: 10,
            pricePerShare: 10,
            cashDelta: -100,
            currency: 'USD',
            positionRef: null,
            isTransfer: false,
            fromKey: '',
            toKey: 'asset:AST-1',
            srcKey: null,
            selected: true,
            status: 'actionable',
          },
        ],
        valuations: [],
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors[0]).toContain("requires 'from' entity");
      expect(validation.validatedTransactions[0].status).toBe('blocked');
    });

    it('does NOT block transaction when optional Source of Fund is missing or deselected', () => {
      const stagedEntities = new Map([
        ['fund:Fund A', { key: 'fund:Fund A', name: 'Fund A', kind: 'fund', isStaged: true }],
        ['investor:Investor A', { key: 'investor:Investor A', name: 'Investor A', kind: 'investor', isStaged: true }],
        ['source:DCA', { key: 'source:DCA', name: 'DCA', kind: 'source', isStaged: false }], // Optional source deselected!
        ['asset:AST-1', { key: 'asset:AST-1', name: 'Asset 1', kind: 'asset', isStaged: true }],
      ]);

      const transactions: ReviewTransaction[] = [
        {
          id: 'txn-2',
          sheetRow: 2,
          date: '2023-01-01',
          type: 'buy',
          subType: 'contribution',
          commitDelta: null,
          quantityDelta: 10,
          pricePerShare: 10,
          cashDelta: -100,
          currency: 'USD',
          positionRef: null,
          isTransfer: false,
          fromKey: 'investor:Investor A',
          toKey: 'asset:AST-1',
          srcKey: 'source:DCA', // optional source
          selected: true,
          status: 'actionable',
        },
      ];

      const validation = validateTwoStepDependencies({
        stagedEntities,
        transactions,
        valuations: [],
      });

      // Valid because Source is optional
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.validatedTransactions[0].status).toBe('actionable');
    });

    it('blocks valuation when required target asset is missing or deselected in Step 1', () => {
      const stagedEntities = new Map([
        ['asset:AST-1', { key: 'asset:AST-1', name: 'Asset 1', kind: 'asset', isStaged: false }], // Deselected!
      ]);

      const valuations: ReviewValuation[] = [
        {
          id: 'val-1',
          sheetRow: 1,
          assetCode: 'AST-1',
          assetName: 'Asset 1',
          asOfDate: '2023-03-31',
          periodLabel: 'Q1 2023',
          marketValue: 500000,
          pricePerShare: 10,
          sharesOutstanding: 50000,
          shareholdingPct: 1,
          valuationMethod: 'at_cost',
          currency: 'USD',
          originalKey: 'val-1',
          selected: true,
          status: 'actionable',
        },
      ];

      const validation = validateTwoStepDependencies({
        stagedEntities,
        transactions: [],
        valuations,
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0]).toContain('requires target "AST-1"');
      expect(validation.validatedValuations[0].status).toBe('blocked');
    });

    it('rejects multi-party transfer when allocation sum does not match total amount or has invalid counterparty', () => {
      const stagedEntities = new Map([
        ['fund:Fund A', { key: 'fund:Fund A', name: 'Fund A', kind: 'fund', isStaged: true }],
        ['investor:Investor A', { key: 'investor:Investor A', name: 'Investor A', kind: 'investor', isStaged: true }],
      ]);

      const transactions: ReviewTransaction[] = [
        {
          id: 'xfer-split',
          sheetRow: 1,
          date: '2023-07-01',
          type: 'commitment_transfer',
          subType: 'transfer_in',
          commitDelta: 1000000,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: 0,
          currency: 'CNY',
          positionRef: null,
          fromKey: 'fund:Fund A',
          toKey: 'investor:Investor A',
          srcKey: null,
          isTransfer: true,
          isMultiPartyTransfer: true,
          rawCommitmentEvent: sampleCommitmentEvent({
            fund: 'Fund A',
            investorName: 'Investor A',
            date: '2023-07-01',
            amount: 1000000,
            currency: 'CNY',
            intent: 'transfer_in',
          }),
          allocations: [
            { id: 'a1', transferorName: 'Transferor 1', amount: 400000 },
            { id: 'a2', transferorName: 'Transferor 2', amount: 500000 }, // Sum is 900,000 !== 1,000,000
          ],
          selected: true,
          status: 'actionable',
        },
      ];

      const validation = validateTwoStepDependencies({
        stagedEntities,
        transactions,
        valuations: [],
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('allocations sum (900000) does not match expected amount (1000000)'))).toBe(true);
    });
  });

  describe('Fund of Funds Two-Step Review Normalization (MB-513)', () => {
    it('normalizes FoF target (e.g. Yuesheng) once under Fund tab, never creates asset entity, and links direct asset (Jiangsu Medomics) to owning Fund', () => {
      const fofTxn = sampleTxn({
        date: '2024-01-15',
        type: 'contribution',
        valueAmount: 10000000,
        shareCount: null,
        pricePerShare: null,
      });
      const fofVal = sampleValuation({
        asOfDate: '2024-03-31',
        marketValue: 10500000,
      });

      const fofAsset = sampleAsset({
        code: 'SAPE40',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        englishName: 'Yuesheng Fund LP',
        assetType: 'fund_of_funds',
        investmentTypeLabel: 'Fund of Funds',
        fund: '南京瑞满基金',
        entity: null,
        fundingSource: null,
        txns: [fofTxn],
        valuations: [fofVal],
      });

      const directAsset = sampleAsset({
        code: 'JM-001',
        name: '江苏麦得美生物科技有限公司',
        englishName: 'Jiangsu Medomics Co.',
        assetType: 'direct_investment',
        investmentTypeLabel: 'Direct Investments',
        fund: '南京瑞满基金',
        txns: [sampleTxn({ date: '2024-02-01', valueAmount: 5000000 })],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofAsset,
            code: fofAsset.code,
            name: fofAsset.name,
            asset_type: 'fund_of_funds',
            fund: fofAsset.fund,
            missing_txns: [fofTxn],
            missing_valuations: [fofVal],
          }),
          sampleAssetReview({
            proposed: directAsset,
            code: directAsset.code,
            name: directAsset.name,
            asset_type: 'direct_investment',
            fund: directAsset.fund,
            missing_txns: directAsset.txns,
            missing_valuations: [],
          }),
        ],
        funds: [{ name: '南京瑞满基金', status: 'existing', matched_id: 'fund-rm-1' }],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // 1. Check entity tabs: exactly 1 Asset (Jiangsu Medomics), 2 Funds (Managing Fund + Yuesheng)
      const assetEntities = result.entities.filter((e) => e.tab === 'asset');
      expect(assetEntities).toHaveLength(1);
      expect(assetEntities[0].key).toBe('asset:JM-001');
      expect(assetEntities[0].name).toBe('江苏麦得美生物科技有限公司');
      expect(assetEntities[0].links.some((l) => l.key === 'fund:南京瑞满基金')).toBe(true);

      // No asset:SAPE40 review entity exists
      expect(result.entities.some((e) => e.key === 'asset:SAPE40')).toBe(false);

      const fundEntities = result.entities.filter((e) => e.tab === 'fund');
      expect(fundEntities).toHaveLength(2);

      const yueshengEntity = fundEntities.find((e) => e.name === '南通越盛股权投资合伙企业（有限合伙）');
      expect(yueshengEntity).toBeDefined();
      expect(yueshengEntity?.key).toBe('fund:南通越盛股权投资合伙企业（有限合伙）');
      expect(yueshengEntity?.role).toBe('Fund of Funds');
      expect(yueshengEntity?.englishName).toBe('Yuesheng Fund LP');
      expect(yueshengEntity?.links.some((l) => l.key === 'fund:南京瑞满基金')).toBe(true);

      // 2. FoF transaction targets resolve to fund entity
      const yueshengTxn = result.transactions.find((t) => t.assetCode === 'SAPE40');
      expect(yueshengTxn).toBeDefined();
      expect(yueshengTxn?.fromKey).toBe('fund:南京瑞满基金');
      expect(yueshengTxn?.toKey).toBe('fund:南通越盛股权投资合伙企业（有限合伙）');
      expect(yueshengTxn?.status).toBe('actionable');

      // 3. FoF valuation targetKey resolves to fund entity
      const yueshengVal = result.valuations.find((v) => v.assetCode === 'SAPE40');
      expect(yueshengVal).toBeDefined();
      expect(yueshengVal?.targetKey).toBe('fund:南通越盛股权投资合伙企业（有限合伙）');
      expect(yueshengVal?.status).toBe('actionable');
    });

    it('blocks FoF transactions and valuations when the FoF target fund is omitted in Step 1', () => {
      const stagedEntities = new Map([
        ['fund:南京瑞满基金', { key: 'fund:南京瑞满基金', name: '南京瑞满基金', kind: 'fund', isStaged: true }],
        ['fund:南通越盛股权投资合伙企业（有限合伙）', { key: 'fund:南通越盛股权投资合伙企业（有限合伙）', name: '南通越盛股权投资合伙企业（有限合伙）', kind: 'fund', isStaged: false }], // Omitted!
      ]);

      const transactions: ReviewTransaction[] = [
        {
          id: 'txn:SAPE40:0:2024-01-15:contribution',
          sheetRow: 1,
          date: '2024-01-15',
          fromKey: 'fund:南京瑞满基金',
          toKey: 'fund:南通越盛股权投资合伙企业（有限合伙）',
          srcKey: null,
          type: 'buy',
          subType: 'contribution',
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -10000000,
          currency: 'CNY',
          positionRef: null,
          status: 'actionable',
          selected: true,
          isTransfer: false,
          assetCode: 'SAPE40',
        },
      ];

      const valuations: ReviewValuation[] = [
        {
          id: 'val:SAPE40:2024-03-31:10500000',
          sheetRow: 1,
          targetKey: 'fund:南通越盛股权投资合伙企业（有限合伙）',
          assetCode: 'SAPE40',
          assetName: '南通越盛股权投资合伙企业（有限合伙）',
          asOfDate: '2024-03-31',
          periodLabel: 'Q1 2024',
          marketValue: 10500000,
          pricePerShare: null,
          sharesOutstanding: null,
          shareholdingPct: null,
          valuationMethod: 'capital_account_statement',
          currency: 'CNY',
          status: 'actionable',
          selected: true,
          originalKey: '2024-03-31|10500000|at_cost',
        },
      ];

      const validation = validateTwoStepDependencies({
        stagedEntities,
        transactions,
        valuations,
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors).toHaveLength(2);
      expect(validation.validatedTransactions[0].status).toBe('blocked');
      expect(validation.validatedValuations[0].status).toBe('blocked');
    });

    it('merges FoF target with existing catalog fund in fullReview.funds without duplicating', () => {
      const fofAsset = sampleAsset({
        code: 'FOF-YUESHENG',
        name: '南京月升星繁创业投资合伙企业（有限合伙）',
        englishName: 'Yuesheng Star Fund',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        txns: [sampleTxn({ date: '2024-01-10', valueAmount: 10000000 })],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofAsset,
            code: fofAsset.code,
            name: fofAsset.name,
            asset_type: 'fund_of_funds',
            fund: fofAsset.fund,
            missing_txns: fofAsset.txns,
            missing_valuations: [],
          }),
        ],
        funds: [
          { name: '南京瑞满基金', status: 'existing', matched_id: 'f-rm' },
          { name: '南京月升星繁创业投资合伙企业（有限合伙）', status: 'existing', matched_id: 'f-existing-yuesheng', english_name: 'Yuesheng Star Fund' },
        ],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // Exactly 2 funds (Managing fund + Target fund), no duplicate
      const fundEntities = result.entities.filter((e) => e.tab === 'fund');
      expect(fundEntities).toHaveLength(2);

      const yueshengEnt = fundEntities.find((e) => e.name === '南京月升星繁创业投资合伙企业（有限合伙）');
      expect(yueshengEnt).toBeDefined();
      expect(yueshengEnt?.status).toBe('matched');
      expect(yueshengEnt?.matchedId).toBe('f-existing-yuesheng');
      expect(yueshengEnt?.role).toBe('Fund of Funds');
      expect(yueshengEnt?.rawAsset).toBeDefined();
    });

    it('merges multiple holdings of the same FoF target held by distinct owning funds, preserving all links and rawAssets', () => {
      const fofHolding1 = sampleAsset({
        code: 'FOF-H1',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        englishName: 'Yuesheng Fund LP',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        entity: null,
        fundingSource: null,
        txns: [sampleTxn({ date: '2024-01-15', type: 'contribution', valueAmount: 6000000 })],
        valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 6500000 })],
      });

      const fofHolding2 = sampleAsset({
        code: 'FOF-H2',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        englishName: 'Yuesheng Fund LP',
        assetType: 'fund_of_funds',
        fund: '南京瑞来基金',
        entity: null,
        fundingSource: null,
        txns: [sampleTxn({ date: '2024-02-15', type: 'contribution', valueAmount: 4000000 })],
        valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 4500000 })],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofHolding1,
            code: fofHolding1.code,
            name: fofHolding1.name,
            asset_type: 'fund_of_funds',
            fund: fofHolding1.fund,
            missing_txns: fofHolding1.txns,
            missing_valuations: fofHolding1.valuations,
          }),
          sampleAssetReview({
            proposed: fofHolding2,
            code: fofHolding2.code,
            name: fofHolding2.name,
            asset_type: 'fund_of_funds',
            fund: fofHolding2.fund,
            missing_txns: fofHolding2.txns,
            missing_valuations: fofHolding2.valuations,
          }),
        ],
        funds: [
          { name: '南京瑞满基金', status: 'existing', matched_id: 'f-rm' },
          { name: '南京瑞来基金', status: 'existing', matched_id: 'f-rl' },
        ],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // Exactly 3 Fund entities: Ruiman, Ruilai, Yuesheng
      const fundEntities = result.entities.filter((e) => e.tab === 'fund');
      expect(fundEntities).toHaveLength(3);

      const yueshengEnt = fundEntities.find((e) => e.name === '南通越盛股权投资合伙企业（有限合伙）');
      expect(yueshengEnt).toBeDefined();
      expect(yueshengEnt?.rawAssets).toHaveLength(2);
      expect(yueshengEnt?.rawAssets?.map((a) => a.code).sort()).toEqual(['FOF-H1', 'FOF-H2']);

      // Preserves both owning fund links
      expect(yueshengEnt?.links.some((l) => l.key === 'fund:南京瑞满基金')).toBe(true);
      expect(yueshengEnt?.links.some((l) => l.key === 'fund:南京瑞来基金')).toBe(true);

      // Both transactions route to their respective owning fund and the single target fund
      expect(result.transactions).toHaveLength(2);
      const txn1 = result.transactions.find((t) => t.assetCode === 'FOF-H1');
      const txn2 = result.transactions.find((t) => t.assetCode === 'FOF-H2');
      expect(txn1?.fromKey).toBe('fund:南京瑞满基金');
      expect(txn1?.toKey).toBe('fund:南通越盛股权投资合伙企业（有限合伙）');
      expect(txn2?.fromKey).toBe('fund:南京瑞来基金');
      expect(txn2?.toKey).toBe('fund:南通越盛股权投资合伙企业（有限合伙）');

      // Both valuations route targetKey to the single target fund
      expect(result.valuations).toHaveLength(2);
      expect(result.valuations.every((v) => v.targetKey === 'fund:南通越盛股权投资合伙企业（有限合伙）')).toBe(true);
    });

    it('resolves transactions and valuations to canonical Fund entity despite slight whitespace/spelling variations', () => {
      const fofAsset = sampleAsset({
        code: 'FOF-VAR',
        name: ' 南通越盛股权投资合伙企业（有限合伙） ', // with whitespace
        assetType: 'fund_of_funds',
        fund: ' 南京瑞满基金 ',
        entity: null,
        fundingSource: null,
        txns: [sampleTxn({ date: '2024-01-15', type: 'contribution', valueAmount: 5000000 })],
        valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 5000000 })],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofAsset,
            code: fofAsset.code,
            name: fofAsset.name,
            asset_type: 'fund_of_funds',
            fund: fofAsset.fund,
            missing_txns: fofAsset.txns,
            missing_valuations: fofAsset.valuations,
          }),
        ],
        funds: [{ name: '南京瑞满基金', status: 'existing', matched_id: 'f-rm' }],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const txn = result.transactions[0];
      expect(txn.fromKey).toBe('fund:南京瑞满基金'); // canonical owning fund key
      expect(txn.toKey).toBe('fund: 南通越盛股权投资合伙企业（有限合伙） ');
    });

    it('avoids self-referential links when an owning fund has the same name as a target fund', () => {
      const fofAsset = sampleAsset({
        code: 'FOF-SELF',
        name: '南京瑞满基金', // same name as owning fund
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        txns: [],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofAsset,
            code: fofAsset.code,
            name: fofAsset.name,
            asset_type: 'fund_of_funds',
            fund: fofAsset.fund,
            missing_txns: [],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: '南京瑞满基金', status: 'existing', matched_id: 'f-rm' }],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const fundEnt = result.entities.find((e) => e.key === 'fund:南京瑞满基金');
      expect(fundEnt).toBeDefined();
      // Must not link to itself
      expect(fundEnt?.links.some((l) => l.key === 'fund:南京瑞满基金')).toBe(false);
    });

    it('links investor and source to FoF target with kind: Fund instead of dropping the link', () => {
      const fofAsset = sampleAsset({
        code: 'FOF-LINK',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        entity: 'Master LP',
        fundingSource: 'DCA Pool',
        txns: [],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: fofAsset,
            code: fofAsset.code,
            name: fofAsset.name,
            asset_type: 'fund_of_funds',
            fund: fofAsset.fund,
            missing_txns: [],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: '南京瑞满基金', status: 'existing', matched_id: 'f-rm' }],
        investors: [{ name: 'Master LP', status: 'new', matched_id: null, asset_codes: ['FOF-LINK'] }],
        sources: [{ name: 'DCA Pool', status: 'new', matched_id: null, asset_codes: ['FOF-LINK'] }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const investorEnt = result.entities.find((e) => e.key === 'investor:Master LP');
      expect(investorEnt).toBeDefined();
      expect(investorEnt?.links).toHaveLength(1);
      expect(investorEnt?.links[0]).toEqual({
        key: 'fund:南通越盛股权投资合伙企业（有限合伙）',
        kind: 'Fund',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        status: 'new',
      });

      const sourceEnt = result.entities.find((e) => e.key === 'source:DCA Pool');
      expect(sourceEnt).toBeDefined();
      expect(sourceEnt?.links).toHaveLength(1);
      expect(sourceEnt?.links[0]).toEqual({
        key: 'fund:南通越盛股权投资合伙企业（有限合伙）',
        kind: 'Fund',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        status: 'new',
      });
    });
  });

  describe('Direct Asset Canonical Deduplication & Multi-Fund Holdings', () => {
    it('reproduction: two Nanjing funds invest in 赛德特生物制药有限公司, producing 1 Step 1 Asset entity and 2 Step 2 fund-routed rows', () => {
      const txnRuiman = sampleTxn({
        date: '2024-01-15',
        type: 'contribution',
        valueAmount: 10_000_000,
        currency: 'CNY',
      });
      const txnRuilai = sampleTxn({
        date: '2024-02-01',
        type: 'contribution',
        valueAmount: 5_000_000,
        currency: 'CNY',
      });
      const valRuiman = sampleValuation({
        asOfDate: '2024-03-31',
        marketValue: 12_000_000,
      });

      const assetRuiman = sampleAsset({
        code: 'NJ-RUIMAN-SDT',
        name: '赛德特生物制药有限公司',
        legalName: '赛德特生物制药有限公司',
        englishName: 'Saidet Biotech Co., Ltd.',
        holderKind: 'fund',
        fund: '南京瑞满',
        entity: '南京高新创投',
        fundingSource: 'DCA',
        txns: [txnRuiman],
        valuations: [valRuiman],
      });

      const assetRuilai = sampleAsset({
        code: 'NJ-RUILAI-SDT',
        name: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
        legalName: '赛德特生物制药有限公司',
        englishName: 'Saidet Biotech Co., Ltd.',
        holderKind: 'fund',
        fund: '南京瑞来',
        entity: '南京高新创投',
        fundingSource: 'DCA',
        txns: [txnRuilai],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: assetRuiman,
            code: assetRuiman.code,
            name: assetRuiman.name,
            asset_type: 'direct_investment',
            fund: assetRuiman.fund,
            missing_txns: [txnRuiman],
            missing_valuations: [valRuiman],
            proposed_txn_count: 1,
            proposed_valuation_count: 1,
            missing_txn_count: 1,
            missing_valuation_count: 1,
          }),
          sampleAssetReview({
            proposed: assetRuilai,
            code: assetRuilai.code,
            name: assetRuilai.name,
            asset_type: 'direct_investment',
            fund: assetRuilai.fund,
            missing_txns: [txnRuilai],
            missing_valuations: [],
            proposed_txn_count: 1,
            proposed_valuation_count: 0,
            missing_txn_count: 1,
            missing_valuation_count: 0,
          }),
        ],
        funds: [
          { name: '南京瑞满', status: 'new', matched_id: null },
          { name: '南京瑞来', status: 'new', matched_id: null },
        ],
        investors: [{ name: '南京高新创投', status: 'new', matched_id: null }],
        sources: [{ name: 'DCA', status: 'new', matched_id: null }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // Step 1 Verification: Exactly ONE asset entity card for Saidet
      const assetEntities = result.entities.filter((e) => e.tab === 'asset');
      expect(assetEntities).toHaveLength(1);

      const sharedAsset = assetEntities[0];
      expect(sharedAsset.name).toBe('赛德特生物制药有限公司');
      expect(sharedAsset.englishName).toBe('Saidet Biotech Co., Ltd.');
      expect(sharedAsset.txnsCount).toBe(2);
      expect(sharedAsset.valsCount).toBe(1);
      expect(sharedAsset.rawAssets).toHaveLength(2);

      // Aggregated fields
      const fundsField = sharedAsset.fields.find((f) => f.label === 'Funds' || f.label === 'Fund');
      expect(fundsField).toBeDefined();
      expect(fundsField?.value).toBe('南京瑞满, 南京瑞来');

      const propTxnField = sharedAsset.fields.find((f) => f.label === 'Proposed Transactions');
      expect(propTxnField?.value).toBe(2);

      // Linked to both holding funds
      expect(sharedAsset.links.some((l) => l.key === 'fund:南京瑞满')).toBe(true);
      expect(sharedAsset.links.some((l) => l.key === 'fund:南京瑞来')).toBe(true);

      // Both funds link to the shared asset
      const fundRuiman = result.entities.find((e) => e.key === 'fund:南京瑞满');
      const fundRuilai = result.entities.find((e) => e.key === 'fund:南京瑞来');
      expect(fundRuiman?.links.some((l) => l.key === sharedAsset.key)).toBe(true);
      expect(fundRuilai?.links.some((l) => l.key === sharedAsset.key)).toBe(true);

      // Step 2 Verification: 2 distinct fund-routed transactions targeting the shared asset
      expect(result.transactions).toHaveLength(2);
      const rowRuiman = result.transactions.find((t) => t.assetCode === 'NJ-RUIMAN-SDT');
      const rowRuilai = result.transactions.find((t) => t.assetCode === 'NJ-RUILAI-SDT');

      expect(rowRuiman).toBeDefined();
      expect(rowRuilai).toBeDefined();

      // Row 1 from fund:南京瑞满 to shared asset
      expect(rowRuiman?.fromKey).toBe('fund:南京瑞满');
      expect(rowRuiman?.toKey).toBe(sharedAsset.key);
      expect(rowRuiman?.srcKey).toBe('source:DCA');
      expect(rowRuiman?.amount).toBe(10_000_000);
      expect(rowRuiman?.status).toBe('actionable');

      // Row 2 from fund:南京瑞来 to shared asset
      expect(rowRuilai?.fromKey).toBe('fund:南京瑞来');
      expect(rowRuilai?.toKey).toBe(sharedAsset.key);
      expect(rowRuilai?.srcKey).toBe('source:DCA');
      expect(rowRuilai?.amount).toBe(5_000_000);
      expect(rowRuilai?.status).toBe('actionable');

      // Valuation targets shared asset
      expect(result.valuations).toHaveLength(1);
      expect(result.valuations[0].targetKey).toBe(sharedAsset.key);
      expect(result.valuations[0].marketValue).toBe(12_000_000);
    });

    it('dependency engine: deselecting shared asset blocks all transactions from all holding funds', () => {
      const assetRuiman = sampleAsset({
        code: 'NJ-RM',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞满',
        entity: '',
        fundingSource: '',
        txns: [sampleTxn({ date: '2024-01-15', valueAmount: 100 })],
        valuations: [sampleValuation({ asOfDate: '2024-03-31', marketValue: 200 })],
      });
      const assetRuilai = sampleAsset({
        code: 'NJ-RL',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞来',
        entity: '',
        fundingSource: '',
        txns: [sampleTxn({ date: '2024-02-01', valueAmount: 50 })],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({ proposed: assetRuiman, missing_txns: assetRuiman.txns, missing_valuations: assetRuiman.valuations }),
          sampleAssetReview({ proposed: assetRuilai, missing_txns: assetRuilai.txns }),
        ],
        funds: [
          { name: '南京瑞满', status: 'new', matched_id: null },
          { name: '南京瑞来', status: 'new', matched_id: null },
        ],
        investors: [],
        sources: [],
      };

      const twoStep = buildNormalizedTwoStepReview(fullReview);
      const sharedAsset = twoStep.entities.find((e) => e.tab === 'asset')!;

      // Case 1: All staged -> valid
      const depValid = validateTwoStepDependencies({
        stagedEntities: twoStep.entities,
        transactions: twoStep.transactions,
        valuations: twoStep.valuations,
      });
      expect(depValid.isValid).toBe(true);

      // Case 2: Deselect shared asset -> both fund transactions and valuation blocked
      const deselectedEntities = twoStep.entities.map((e) =>
        e.key === sharedAsset.key ? { ...e, isStaged: false } : e,
      );
      const depBlocked = validateTwoStepDependencies({
        stagedEntities: deselectedEntities,
        transactions: twoStep.transactions,
        valuations: twoStep.valuations,
      });
      expect(depBlocked.isValid).toBe(false);
      expect(depBlocked.validatedTransactions.every((t) => t.status === 'blocked')).toBe(true);
      expect(depBlocked.validatedValuations.every((v) => v.status === 'blocked')).toBe(true);
    });

    it('dependency engine: deselecting one holding fund blocks only its transaction while keeping other fund actionable', () => {
      const assetRuiman = sampleAsset({
        code: 'NJ-RM',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞满',
        entity: '',
        fundingSource: '',
        txns: [sampleTxn({ date: '2024-01-15', valueAmount: 100 })],
      });
      const assetRuilai = sampleAsset({
        code: 'NJ-RL',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞来',
        entity: '',
        fundingSource: '',
        txns: [sampleTxn({ date: '2024-02-01', valueAmount: 50 })],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({ proposed: assetRuiman, missing_txns: assetRuiman.txns }),
          sampleAssetReview({ proposed: assetRuilai, missing_txns: assetRuilai.txns }),
        ],
        funds: [
          { name: '南京瑞满', status: 'new', matched_id: null },
          { name: '南京瑞来', status: 'new', matched_id: null },
        ],
        investors: [],
        sources: [],
      };

      const twoStep = buildNormalizedTwoStepReview(fullReview);

      // Deselect fund Ruiman only
      const staged = twoStep.entities.map((e) =>
        e.key === 'fund:南京瑞满' ? { ...e, isStaged: false } : e,
      );

      const depResult = validateTwoStepDependencies({
        stagedEntities: staged,
        transactions: twoStep.transactions,
        valuations: twoStep.valuations,
      });

      const rmTxn = depResult.validatedTransactions.find((t) => t.assetCode === 'NJ-RM');
      const rlTxn = depResult.validatedTransactions.find((t) => t.assetCode === 'NJ-RL');

      expect(rmTxn?.status).toBe('blocked');
      expect(rlTxn?.status).toBe('actionable');
    });

    it('never merges across entity types even if they share the exact same name', () => {
      const asset = sampleAsset({
        code: 'AST-FOO',
        name: '南京紫金创投',
        fund: '南京紫金创投',
      });

      const fullReview: FundUpdateFullReview = {
        assets: [sampleAssetReview({ proposed: asset })],
        funds: [{ name: '南京紫金创投', status: 'new', matched_id: null }],
        investors: [{ name: '南京紫金创投', status: 'new', matched_id: null }],
        sources: [{ name: '南京紫金创投', status: 'new', matched_id: null }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // Exactly 1 in each tab, distinct keys
      expect(result.entities.filter((e) => e.tab === 'asset')).toHaveLength(1);
      expect(result.entities.filter((e) => e.tab === 'fund')).toHaveLength(1);
      expect(result.entities.filter((e) => e.tab === 'investor')).toHaveLength(1);
      expect(result.entities.filter((e) => e.tab === 'source')).toHaveLength(1);

      expect(result.entities.map((e) => e.key)).toEqual([
        'asset:AST-FOO',
        'fund:南京紫金创投',
        'investor:南京紫金创投',
        'source:南京紫金创投',
      ]);
    });

    it('merges assets with different display names but identical normalized legalName into one canonical entity', () => {
      const assetA = sampleAsset({
        code: 'AST-A',
        name: '赛德特生物',
        legalName: '赛德特生物制药有限公司',
        fund: '南京瑞满',
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
      const assetB = sampleAsset({
        code: 'AST-B',
        name: '赛德特制药',
        legalName: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
        fund: '南京瑞来',
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

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({ proposed: assetA }),
          sampleAssetReview({ proposed: assetB }),
        ],
        funds: [
          { name: '南京瑞满', status: 'new', matched_id: null },
          { name: '南京瑞来', status: 'new', matched_id: null },
        ],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // Must merge into exactly 1 Asset entity
      const assetEntities = result.entities.filter((e) => e.tab === 'asset');
      expect(assetEntities).toHaveLength(1);
      expect(assetEntities[0].key).toBe('asset:AST-A');
      expect(assetEntities[0].rawAssets).toHaveLength(2);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions.every((t) => t.toKey === 'asset:AST-A')).toBe(true);
    });

    it('throws a FundUpdateValidationError when alias keys create ambiguity across distinct already-built entities', () => {
      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: sampleAsset({ code: 'AST-1', name: 'Company Alpha', legalName: 'Alpha Corp' }),
          }),
          sampleAssetReview({
            proposed: sampleAsset({ code: 'AST-2', name: 'Company Beta', legalName: 'Beta Corp' }),
          }),
          sampleAssetReview({
            // Matches Company Alpha by display name but matches Beta Corp by legal name -> Ambiguous!
            proposed: sampleAsset({ code: 'AST-3', name: 'Company Alpha', legalName: 'Beta Corp' }),
          }),
        ],
        funds: [],
        investors: [],
        sources: [],
      };

      expect(() => buildNormalizedTwoStepReview(fullReview)).toThrow(/Ambiguous canonical identity/);
    });

    it('surfaces matchedIdConflict and marks entity blocked when constituents have conflicting non-null matched_asset_id values', () => {
      const assetA = sampleAsset({
        code: 'AST-A',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞满',
      });
      const assetB = sampleAsset({
        code: 'AST-B',
        name: '赛德特生物制药有限公司',
        fund: '南京瑞来',
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({ proposed: assetA, matched_asset_id: 'ast-saidet-1', status: 'unchanged' }),
          sampleAssetReview({ proposed: assetB, matched_asset_id: 'ast-saidet-2', status: 'unchanged' }),
        ],
        funds: [
          { name: '南京瑞满', status: 'existing', matched_id: 'f-rm' },
          { name: '南京瑞来', status: 'existing', matched_id: 'f-rl' },
        ],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      const assetEnt = result.entities.find((e) => e.tab === 'asset');
      expect(assetEnt).toBeDefined();
      expect(assetEnt?.status).toBe('blocked');
      expect(assetEnt?.matchedIdConflict).toEqual({
        id1: 'ast-saidet-1',
        id2: 'ast-saidet-2',
      });

      // Dependency validation should reject/block due to the conflict
      const depResult = validateTwoStepDependencies({
        stagedEntities: new Map(result.entities.map((e) => [e.key, e])),
        transactions: result.transactions,
        valuations: result.valuations,
      });

      expect(depResult.isValid).toBe(false);
      expect(depResult.errors.some((e) => e.includes('conflicting matched IDs'))).toBe(true);
    });

    it('supports workbook_fallback_v1 proposals where multiple funds hold the same canonical company', () => {
      const v1Proposal: any = {
        schema_version: 'workbook_fallback_v1',
        entities: [
          { proposalId: 'ent-fund-1', entityType: 'fund', originalName: 'Startech Growth Fund 1' },
          { proposalId: 'ent-fund-2', entityType: 'fund', originalName: 'Startech Venture Fund 2' },
          { proposalId: 'ent-asset', entityType: 'portfolio_company', originalName: 'Acme SaaS Corp' },
        ],
        events: [
          {
            proposalId: 'evt-1',
            eventType: 'paid_in',
            sourceAction: 'Investment',
            date: '2024-01-15',
            fromEntityRef: 'ent-fund-1',
            toEntityRef: 'ent-asset',
            normalizedAmount: 500000,
            normalizedCurrency: 'USD',
          },
          {
            proposalId: 'evt-2',
            eventType: 'paid_in',
            sourceAction: 'Investment',
            date: '2024-02-15',
            fromEntityRef: 'ent-fund-2',
            toEntityRef: 'ent-asset',
            normalizedAmount: 750000,
            normalizedCurrency: 'USD',
          },
        ],
        valuations: [
          {
            proposalId: 'val-1',
            entityRef: 'ent-asset',
            asOfDate: '2024-03-31',
            normalizedMarketValue: 600000,
            normalizedCurrency: 'USD',
          },
        ],
      };

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: sampleAsset({ code: 'AST-ACME-1', name: 'Acme SaaS Corp', fund: 'Startech Growth Fund 1' }),
          }),
          sampleAssetReview({
            proposed: sampleAsset({ code: 'AST-ACME-2', name: 'Acme SaaS Corp', fund: 'Startech Venture Fund 2' }),
          }),
        ],
        funds: [
          { name: 'Startech Growth Fund 1', status: 'new', matched_id: null },
          { name: 'Startech Venture Fund 2', status: 'new', matched_id: null },
        ],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview, v1Proposal);

      // Exactly 1 asset entity for Acme SaaS Corp
      const assetEntities = result.entities.filter((e) => e.tab === 'asset');
      expect(assetEntities).toHaveLength(1);
      expect(assetEntities[0].name).toBe('Acme SaaS Corp');

      // Transactions route to the canonical asset key
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0].fromKey).toBe('fund:Startech Growth Fund 1');
      expect(result.transactions[0].toKey).toBe(assetEntities[0].key);
      expect(result.transactions[1].fromKey).toBe('fund:Startech Venture Fund 2');
      expect(result.transactions[1].toKey).toBe(assetEntities[0].key);

      // Valuations route to canonical asset key
      expect(result.valuations).toHaveLength(1);
      expect(result.valuations[0].targetKey).toBe(assetEntities[0].key);

      // Dependency validation succeeds
      const depResult = validateTwoStepDependencies({
        stagedEntities: new Map(result.entities.map((e) => [e.key, e])),
        transactions: result.transactions,
        valuations: result.valuations,
      });
      expect(depResult.isValid).toBe(true);
    });
  });

  describe('STARTECH Holder vs Funding Source Separation (Regression)', () => {
    it('Akulaku: From is Meranti; Source is Aldiracita, Hawthorn', () => {
      const txns = [
        sampleTxn({ date: '2021-01-15', type: 'contribution', valueAmount: 1_000_000 }),
        sampleTxn({ date: '2021-06-15', type: 'contribution', valueAmount: 2_000_000 }),
        sampleTxn({ date: '2022-01-15', type: 'contribution', valueAmount: 3_000_000 }),
        sampleTxn({ date: '2022-06-15', type: 'contribution', valueAmount: 4_000_000 }),
      ];

      const akulAsset = sampleAsset({
        code: 'AKUL',
        name: 'Akulaku',
        legalName: 'Akulaku Inc.',
        holderKind: 'investor',
        holderName: 'Meranti Global Investment Ltd',
        entity: 'Meranti Global Investment Ltd',
        fundingSource: 'Aldiracita, Hawthorn',
        fundingSourceRaw: 'Aldiracita, Hawthorn',
        fund: 'Startech Growth Fund 1',
        txns,
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: akulAsset,
            code: 'AKUL',
            name: 'Akulaku',
            missing_txns: akulAsset.txns,
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'existing', matched_id: 'fund-1' }],
        investors: [{ name: 'Meranti Global Investment Ltd', status: 'new', matched_id: null }],
        sources: [{ name: 'Aldiracita, Hawthorn', status: 'new', matched_id: null }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      expect(result.transactions).toHaveLength(4);
      for (const txn of result.transactions) {
        expect(txn.fromKey).toBe('investor:Meranti Global Investment Ltd');
        expect(txn.toKey).toBe('asset:AKUL');
        expect(txn.srcKey).toBe('source:Aldiracita, Hawthorn');
        expect(txn.sourceKey).toBe('source:Aldiracita, Hawthorn');
      }

      // Step 1 entity transaction counts
      const merantiEnt = result.entities.find((e) => e.key === 'investor:Meranti Global Investment Ltd');
      const aldiracitaEnt = result.entities.find((e) => e.key === 'source:Aldiracita, Hawthorn');
      const akulEnt = result.entities.find((e) => e.key === 'asset:AKUL');
      expect(merantiEnt?.txnsCount).toBe(4);
      expect(aldiracitaEnt?.txnsCount).toBe(4);
      expect(akulEnt?.txnsCount).toBe(4);
    });

    it('NIC example: From is its holder; Source remains NIC', () => {
      const txn = sampleTxn({ date: '2022-03-01', type: 'contribution', valueAmount: 500_000 });

      const nicAsset = sampleAsset({
        code: 'NIC-TECH',
        name: 'NIC Direct Portfolio',
        holderKind: 'investor',
        holderName: 'Meranti Global Investment Ltd',
        entity: 'Meranti Global Investment Ltd',
        fundingSource: 'NIC',
        fundingSourceRaw: 'NIC',
        fund: 'Startech Growth Fund 1',
        txns: [txn],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: nicAsset,
            code: 'NIC-TECH',
            name: 'NIC Direct Portfolio',
            missing_txns: [txn],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'existing', matched_id: 'fund-1' }],
        investors: [{ name: 'Meranti Global Investment Ltd', status: 'new', matched_id: null }],
        sources: [{ name: 'NIC', status: 'existing', matched_id: 'src-nic' }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].fromKey).toBe('investor:Meranti Global Investment Ltd');
      expect(result.transactions[0].toKey).toBe('asset:NIC-TECH');
      expect(result.transactions[0].srcKey).toBe('source:NIC');
      expect(result.transactions[0].sourceKey).toBe('source:NIC');
    });

    it('dependency validation rejects a selected transaction when its holder is omitted even if source and asset are staged', () => {
      const stagedEntities = new Map<string, any>([
        ['asset:AKUL', { key: 'asset:AKUL', name: 'Akulaku', kind: 'asset', isStaged: true }],
        ['source:Aldiracita, Hawthorn', { key: 'source:Aldiracita, Hawthorn', name: 'Aldiracita, Hawthorn', kind: 'source', isStaged: true }],
        ['investor:Meranti Global Investment Ltd', { key: 'investor:Meranti Global Investment Ltd', name: 'Meranti Global Investment Ltd', kind: 'investor', isStaged: false }], // Omitted!
      ]);

      const transactions: ReviewTransaction[] = [
        {
          id: 'txn:AKUL:0:2021-01-15:contribution',
          sheetRow: 1,
          date: '2021-01-15',
          fromKey: 'investor:Meranti Global Investment Ltd',
          toKey: 'asset:AKUL',
          srcKey: 'source:Aldiracita, Hawthorn',
          sourceKey: 'source:Aldiracita, Hawthorn',
          type: 'buy',
          subType: 'contribution',
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -1_000_000,
          currency: 'USD',
          positionRef: null,
          status: 'actionable',
          blockReason: null,
          selected: true,
          isTransfer: false,
        },
      ];

      const depResult = validateTwoStepDependencies({
        stagedEntities,
        transactions,
        valuations: [],
      });

      expect(depResult.isValid).toBe(false);
      expect(depResult.errors).toHaveLength(1);
      expect(depResult.errors[0]).toContain("requires 'from' entity \"investor:Meranti Global Investment Ltd\"");
      expect(depResult.validatedTransactions[0].status).toBe('blocked');
      expect(depResult.validatedTransactions[0].blockReason).toContain('Meranti Global Investment Ltd');
    });

    it('regression: missing holderKind with entity present uses the owning fund', () => {
      const txn = sampleTxn({ date: '2024-03-01', type: 'contribution', valueAmount: 2_000_000, currency: 'CNY' });

      const assetWithMissingHolderKind = sampleAsset({
        code: 'NJ-DEFAULT-FUND',
        name: 'Default Fund Asset',
        holderKind: undefined, // explicitly absent/missing
        fund: '南京瑞满',
        entity: '南京高新创投', // entity present
        fundingSource: 'DCA',
        txns: [txn],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: assetWithMissingHolderKind,
            code: 'NJ-DEFAULT-FUND',
            name: 'Default Fund Asset',
            missing_txns: [txn],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: '南京瑞满', status: 'new', matched_id: null }],
        investors: [{ name: '南京高新创投', status: 'new', matched_id: null }],
        sources: [{ name: 'DCA', status: 'new', matched_id: null }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      expect(result.transactions).toHaveLength(1);
      // Must use the owning fund, not the entity!
      expect(result.transactions[0].fromKey).toBe('fund:南京瑞满');
      expect(result.transactions[0].toKey).toBe('asset:NJ-DEFAULT-FUND');
      expect(result.transactions[0].srcKey).toBe('source:DCA');
    });

    it('regression: explicitly investor-held record missing its holder does not fall back to a fund', () => {
      const txn = sampleTxn({ date: '2024-03-01', type: 'contribution', valueAmount: 500_000, currency: 'USD' });

      const assetInvestorMissingHolder = sampleAsset({
        code: 'INV-NO-HOLDER',
        name: 'Investor Asset Missing Holder',
        holderKind: 'investor', // explicitly investor-held
        holderName: null,
        entity: null, // missing holder
        fund: 'Startech Growth Fund 1', // fund present
        fundingSource: 'DCA',
        txns: [txn],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: assetInvestorMissingHolder,
            code: 'INV-NO-HOLDER',
            name: 'Investor Asset Missing Holder',
            missing_txns: [txn],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [],
        sources: [{ name: 'DCA', status: 'new', matched_id: null }],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      expect(result.transactions).toHaveLength(1);
      // Must NOT fall back to fund:Startech Growth Fund 1; fromKey must be empty string
      expect(result.transactions[0].fromKey).toBe('');
      expect(result.transactions[0].toKey).toBe('asset:INV-NO-HOLDER');

      // Dependency validation must block this transaction because fromKey is empty
      const depResult = validateTwoStepDependencies({
        stagedEntities: new Map(result.entities.map((e) => [e.key, e])),
        transactions: result.transactions,
        valuations: [],
      });
      expect(depResult.isValid).toBe(false);
      expect(depResult.validatedTransactions[0].status).toBe('blocked');
      expect(depResult.validatedTransactions[0].blockReason).toContain("requires 'from' entity");
    });

    it('blocks valuation-only rows when the holder is missing (Q4 position scope)', () => {
      const val = sampleValuation({ asOfDate: '2024-03-31', marketValue: 50000 });
      const assetMissingHolder = sampleAsset({
        code: 'VAL-NO-HOLDER',
        name: 'Valuation Missing Holder',
        holderKind: 'investor',
        holderName: null,
        entity: null,
        fund: 'Startech Growth Fund 1',
        txns: [],
        valuations: [val],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            proposed: assetMissingHolder,
            code: 'VAL-NO-HOLDER',
            name: 'Valuation Missing Holder',
            missing_txns: [],
            missing_valuations: [val],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      expect(result.valuations).toHaveLength(1);
      expect(result.valuations[0].holderKey).toBe('');
      expect(result.valuations[0].status).toBe('blocked');
      expect(result.valuations[0].blockReason).toMatch(/requires a holder/i);
      expect(result.valuations[0].selected).toBe(false);

      const depResult = validateTwoStepDependencies({
        stagedEntities: new Map(result.entities.map((e) => [e.key, { ...e, isStaged: true }])),
        transactions: [],
        valuations: result.valuations.map((v) => ({ ...v, selected: true })),
      });
      expect(depResult.isValid).toBe(false);
      expect(depResult.validatedValuations[0].status).toBe('blocked');
      expect(depResult.validatedValuations[0].blockReason).toMatch(/requires a holder/i);
    });
  });

  describe('D3 — sell proceeds destination on review rows', () => {
    it('surfaces a stated destination without the inferred flag and keeps +cashDelta', () => {
      const sell = sampleTxn({
        date: '2024-06-01',
        type: 'divestment',
        valueAmount: 50000,
        shareCount: 10,
        sellProceedsDestination: 'cash_in_fund',
      });
      const proposedAsset = sampleAsset({
        code: 'ST-SELL',
        txns: [sell],
      });
      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            code: 'ST-SELL',
            proposed: proposedAsset,
            missing_txns: [sell],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [{ name: 'Startech LP', status: 'new', matched_id: null }],
        sources: [],
        reconciliation: [],
        review_items: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const row = result.transactions[0];
      expect(row.type).toBe('sell');
      expect(row.sellProceedsDestination).toBe('cash_in_fund');
      expect(row.cashDelta).toBe(50000);
    });

    it('infers distributed_to_investor for an unmarked sale and keeps +cashDelta (never 0)', () => {
      const sell = sampleTxn({
        date: '2024-06-01',
        type: 'divestment',
        valueAmount: 25000,
        shareCount: 5,
        sellProceedsDestination: null,
        subTypeLabel: null,
      });
      const proposedAsset = sampleAsset({
        code: 'ST-SELL-INF',
        txns: [sell],
      });
      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            code: 'ST-SELL-INF',
            proposed: proposedAsset,
            missing_txns: [sell],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [{ name: 'Startech LP', status: 'new', matched_id: null }],
        sources: [],
        reconciliation: [],
        review_items: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const row = result.transactions[0];
      expect(row.type).toBe('sell');
      // Unmarked sale: nothing is stated, so the review carries null and the UI renders
      // the effective default. Apply posts exactly what it would without this field.
      expect(row.sellProceedsDestination).toBeNull();
      expect(row.cashDelta).toBe(25000);
      expect(row.cashDelta).not.toBe(0);
    });

    it('treats a divestment subTypeLabel as a stated destination', () => {
      const sell = sampleTxn({
        date: '2024-06-01',
        type: 'divestment',
        valueAmount: 10000,
        sellProceedsDestination: null,
        subTypeLabel: 'divestment:distributed_to_investor',
      });
      const proposedAsset = sampleAsset({
        code: 'ST-SELL-LABEL',
        txns: [sell],
      });
      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            code: 'ST-SELL-LABEL',
            proposed: proposedAsset,
            missing_txns: [sell],
            missing_valuations: [],
          }),
        ],
        funds: [{ name: 'Startech Growth Fund 1', status: 'new', matched_id: null }],
        investors: [{ name: 'Startech LP', status: 'new', matched_id: null }],
        sources: [],
        reconciliation: [],
        review_items: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);
      const row = result.transactions[0];
      expect(row.sellProceedsDestination).toBe('distributed_to_investor');
    });
  });

  describe('Group as Investor Parent (Phase 1)', () => {
    it('places group entities on investor tab with isGroup: true and role: Group, populates groupName on assets and investors, and creates no fund entity for group', () => {
      const proposedAsset = sampleAsset({
        code: 'AST-GRP-1',
        name: 'Asset Alpha',
        fund: 'Startech Growth Fund 1',
        entity: 'Startech LP 1',
        group: 'Startech Growth Fund 1',
        holderKind: 'investor',
        txns: [],
        valuations: [],
      });

      const fullReview: FundUpdateFullReview = {
        assets: [
          sampleAssetReview({
            code: 'AST-GRP-1',
            name: 'Asset Alpha',
            proposed: proposedAsset,
            target_kind: 'asset',
            missing_txns: [],
            missing_valuations: [],
          }),
        ],
        funds: [],
        groups: [
          { name: 'Startech Growth Fund 1', status: 'new', matched_id: null },
        ],
        investors: [
          { name: 'Startech LP 1', status: 'new', matched_id: null, asset_codes: ['AST-GRP-1'] },
        ],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      // 1. Group entity is on tab: 'investor' with isGroup: true and role: 'Group'
      const groupEnt = result.entities.find((e) => e.key === 'group:Startech Growth Fund 1');
      expect(groupEnt).toBeDefined();
      expect(groupEnt?.tab).toBe('investor');
      expect(groupEnt?.isGroup).toBe(true);
      expect(groupEnt?.role).toBe('Group');
      expect(groupEnt?.name).toBe('Startech Growth Fund 1');

      // 2. Asset entity carries groupName
      const assetEnt = result.entities.find((e) => e.key === 'asset:AST-GRP-1');
      expect(assetEnt).toBeDefined();
      expect(assetEnt?.groupName).toBe('Startech Growth Fund 1');

      // 3. Investor entity carries groupName
      const invEnt = result.entities.find((e) => e.key === 'investor:Startech LP 1');
      expect(invEnt).toBeDefined();
      expect(invEnt?.groupName).toBe('Startech Growth Fund 1');

      // 4. No tab: 'fund' entity created for group name
      const fundEnt = result.entities.find((e) => e.tab === 'fund' && e.name === 'Startech Growth Fund 1');
      expect(fundEnt).toBeUndefined();
      expect(result.entities.filter((e) => e.tab === 'fund')).toHaveLength(0);

      // 5. Group links to member investor
      expect(groupEnt?.links.some((l) => l.key === 'investor:Startech LP 1')).toBe(true);
    });

    it('leaves groupName as null for an investor entity with no group signal even when Others group is present', () => {
      const fullReview: FundUpdateFullReview = {
        assets: [],
        funds: [],
        groups: [
          { name: 'Others', status: 'new', matched_id: null },
        ],
        investors: [
          { name: 'Unrelated Unknown Investor', status: 'new', matched_id: null, asset_codes: [] },
        ],
        sources: [],
      };

      const result = buildNormalizedTwoStepReview(fullReview);

      const invEnt = result.entities.find((e) => e.key === 'investor:Unrelated Unknown Investor');
      expect(invEnt).toBeDefined();
      expect(invEnt?.groupName).toBeNull();
    });
  });
});

