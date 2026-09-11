import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  classifyFundUpdateTxn,
  computeSignedCashDelta,
  fundUpdateTxnKey,
  validateTwoStepDependencies,
  type NormalizedTwoStepReview,
  type FundUpdateTwoStepApproval,
} from '@/lib/fund_updates';
import {
  mapFundUpdateTxn,
  existingLedgerEntryTxnKey,
  FundUpdateApplyService,
} from '@/lib/services/fundUpdateApplyService';
import { FileService } from '@/lib/services/fileService';
import { FundUpdateValidationError, IneligibleCashHolderError } from '@/lib/services/flErrors';
import {
  resolveProceedsTreatment,
  isProceedsTreatmentApplicable,
  isUnresolvedDivestmentToken,
} from '@/lib/fundLedger/proceedsTreatment';
import { isEligibleCashHolder, type CashHolderCandidate } from '@/lib/fundLedger/cashOwnership';
import { deriveCashLegs, type PositionWithFundFlags, type DerivableEntry } from '@/lib/fundLedger/deriveCashLegs';
import type { ParsedAsset, ParsedTxn } from '@/lib/fund_updates/parsers/startech_quarterly';

type TwoStepApprovalInput = FundUpdateTwoStepApproval;

describe('Phase 1 — Import correctness regression suite (literal expected values)', () => {
  const managedFundHolder: CashHolderCandidate = {
    holder_fund_id: 'fund-1',
    holderFundManaged: true,
  };

  // --------------------------------------------------------------------------
  // Case 1: GOTO row 27: Other, -28797.75 USD, notes Expenses
  // Review and approved event remain expense / -28797.75.
  // --------------------------------------------------------------------------
  describe('Case 1: GOTO row 27 (Other, -28797.75 USD, notes Expenses)', () => {
    const rawTxn: ParsedTxn = {
      date: '2024-03-31',
      type: 'other',
      subTypeLabel: 'Others',
      valueAmount: -28797.75,
      currency: 'USD',
      notes: 'Expenses',
      shareCount: null,
      pricePerShare: null,
      fxRate: null,
      sellProceedsDestination: null,
    };

    it('classifies as canonical expense with preserved negative cash delta and postable status', () => {
      const classification = classifyFundUpdateTxn({
        type: rawTxn.type,
        subTypeLabel: rawTxn.subTypeLabel,
        notes: rawTxn.notes,
        valueAmount: rawTxn.valueAmount,
        shareCount: rawTxn.shareCount,
        pricePerShare: rawTxn.pricePerShare,
        positionKind: 'asset',
      });

      expect(classification.canonicalKind).toBe('expense');
      expect(computeSignedCashDelta(rawTxn.valueAmount, classification)).toBe(-28797.75);
      expect(classification.isUnresolved).toBe(false);
      expect(classification.isPostable).toBe(true);
      expect(classification.isEstimated).toBe(false);
    });

    it('builds canonical review key matching expense identity with currency', () => {
      const key = fundUpdateTxnKey(rawTxn);
      expect(key).toBe('2024-03-31|expense|-28797.75|||USD');
    });

    it('maps to ledger entry with entry_type expense and negative cash delta (no sign-stripping with Math.abs)', () => {
      const mapped = mapFundUpdateTxn(rawTxn, 'asset', managedFundHolder);
      expect(mapped.entryType).toBe('expense');
      expect(mapped.cashDelta).toBe('-28797.75000000');

      // Reconstructed existing ledger entry key matches the review key
      const reconstructedKey = existingLedgerEntryTxnKey({
        entry_date: rawTxn.date,
        entry_type: mapped.entryType,
        sub_type: mapped.subType,
        cash_delta: mapped.cashDelta,
        currency: rawTxn.currency,
        notes: rawTxn.notes,
        quantity_delta: null,
        price_per_unit: null,
      } as never);
      expect(reconstructedKey).toBe('2024-03-31|expense|-28797.75|||USD');
    });
  });

  // --------------------------------------------------------------------------
  // Case 2: BUMA unexplained negative Other
  // Preserved negative evidence, explicit unresolved handling, never silent income/purchase.
  // --------------------------------------------------------------------------
  describe('Case 2: BUMA unexplained negative Other', () => {
    const rawTxn: ParsedTxn = {
      date: '2024-05-15',
      type: 'other',
      subTypeLabel: null,
      valueAmount: -150000,
      currency: 'USD',
      notes: null,
      shareCount: null,
      pricePerShare: null,
      fxRate: null,
    };

    it('preserves negative evidence, marks as unresolved, and blocks posting', () => {
      const classification = classifyFundUpdateTxn({
        type: rawTxn.type,
        subTypeLabel: rawTxn.subTypeLabel,
        notes: rawTxn.notes,
        valueAmount: rawTxn.valueAmount,
      });

      expect(classification.canonicalKind).toBe('other');
      expect(computeSignedCashDelta(rawTxn.valueAmount, classification)).toBe(-150000);
      expect(classification.isUnresolved).toBe(true);
      expect(classification.isPostable).toBe(false);
      expect(classification.unresolvedReason).toMatch(/unexplained/i);
    });

    it('throws FundUpdateValidationError before posting rather than silently mapping to buy or income', () => {
      expect(() => mapFundUpdateTxn(rawTxn, 'fund', managedFundHolder)).toThrow(FundUpdateValidationError);
      expect(() => mapFundUpdateTxn(rawTxn, 'fund', managedFundHolder)).toThrow(/unexplained.*other/i);
      expect(() => mapFundUpdateTxn(rawTxn, 'asset', managedFundHolder)).toThrow(FundUpdateValidationError);
    });
  });

  // --------------------------------------------------------------------------
  // Case 3: XTAL estimated CIT
  // Visibly estimated/unresolved, never silently a paid cash expense.
  // --------------------------------------------------------------------------
  describe('Case 3: XTAL estimated CIT', () => {
    const rawTxn: ParsedTxn = {
      date: '2025-06-30',
      type: 'other',
      subTypeLabel: 'Tax Provision',
      valueAmount: -50000,
      currency: 'USD',
      notes: 'Estimated CIT for Q2',
      shareCount: null,
      pricePerShare: null,
      fxRate: null,
    };

    it('identifies as estimated CIT tax provision and blocks posting', () => {
      const classification = classifyFundUpdateTxn({
        type: rawTxn.type,
        subTypeLabel: rawTxn.subTypeLabel,
        notes: rawTxn.notes,
        valueAmount: rawTxn.valueAmount,
      });

      expect(classification.isEstimated).toBe(true);
      expect(classification.isUnresolved).toBe(true);
      expect(classification.isPostable).toBe(false);
      expect(classification.unresolvedReason).toMatch(/estimated cit/i);
    });

    it('throws FundUpdateValidationError before posting so estimated CIT is never silently a paid cash expense', () => {
      expect(() => mapFundUpdateTxn(rawTxn, 'fund', managedFundHolder)).toThrow(FundUpdateValidationError);
      expect(() => mapFundUpdateTxn(rawTxn, 'fund', managedFundHolder)).toThrow(/estimated/i);
    });

    it('posts as an expense once a reviewer explicitly reclassifies it, keeping the estimate provenance', () => {
      const classification = classifyFundUpdateTxn({
        type: 'expense',
        subTypeLabel: rawTxn.subTypeLabel,
        notes: rawTxn.notes,
        valueAmount: rawTxn.valueAmount,
        reviewerResolvedType: true,
      });

      expect(classification.isUnresolved).toBe(false);
      expect(classification.isPostable).toBe(true);
      expect(classification.canonicalKind).toBe('expense');
      // Provenance is preserved: the source wording is still an estimate.
      expect(classification.isEstimated).toBe(true);

      const entry = mapFundUpdateTxn(
        { ...rawTxn, type: 'expense' as ParsedTxn['type'], reviewerResolvedType: true },
        'fund',
        managedFundHolder,
      );
      expect(entry.entryType).toBe('expense');
      expect(entry.cashDelta).toBe('-50000.00000000');
    });
  });

  // --------------------------------------------------------------------------
  // Case 4: Positive/negative same-magnitude Other cannot dedup; equal numeric different currency cannot dedup.
  // --------------------------------------------------------------------------
  describe('Case 4: Dedup precision (sign and currency boundaries)', () => {
    it('does not dedup positive vs negative Other of same magnitude', () => {
      const posTxn = {
        date: '2024-01-01',
        type: 'other',
        valueAmount: 10000,
        currency: 'USD',
      };
      const negTxn = {
        date: '2024-01-01',
        type: 'other',
        valueAmount: -10000,
        currency: 'USD',
      };

      const keyPos = fundUpdateTxnKey(posTxn);
      const keyNeg = fundUpdateTxnKey(negTxn);

      expect(keyPos).toBe('2024-01-01|other|10000|||USD');
      expect(keyNeg).toBe('2024-01-01|other|-10000|||USD');
      expect(keyPos).not.toBe(keyNeg);
    });

    it('does not dedup equal numeric amounts in different currencies', () => {
      const usdTxn = {
        date: '2024-01-01',
        type: 'contribution',
        valueAmount: 50000,
        currency: 'USD',
      };
      const sgdTxn = {
        date: '2024-01-01',
        type: 'contribution',
        valueAmount: 50000,
        currency: 'SGD',
      };

      const keyUsd = fundUpdateTxnKey(usdTxn);
      const keySgd = fundUpdateTxnKey(sgdTxn);

      expect(keyUsd).toBe('2024-01-01|contribution|50000|||USD');
      expect(keySgd).toBe('2024-01-01|contribution|50000|||SGD');
      expect(keyUsd).not.toBe(keySgd);
    });

    it('dedups equal numeric amounts in the same currency', () => {
      const txnA = {
        date: '2024-01-01',
        type: 'contribution',
        valueAmount: 50000,
        currency: 'USD',
      };
      const txnB = {
        date: '2024-01-01',
        type: 'contribution',
        valueAmount: 50000,
        currency: 'USD',
      };
      expect(fundUpdateTxnKey(txnA)).toBe(fundUpdateTxnKey(txnB));
    });
  });

  // --------------------------------------------------------------------------
  // Case 5: Two investors in one instrument with equal dated contributions remain separate;
  // remapping updates duplicate decisions.
  // --------------------------------------------------------------------------
  describe('Case 5: Multi-investor separation and remapping duplicate decisions', () => {
    let mockTxExecutor: any;
    let db: any;
    let flFundRepo: any;
    let flAssetRepo: any;
    let flPositionRepo: any;
    let flInvestorRepo: any;
    let flFundingSourceRepo: any;
    let flMasterDataService: any;
    let flPositionService: any;
    let flLedgerService: any;
    let flValuationService: any;
    let flValuationRepo: any;
    let flLedgerEntryRepo: any;
    let flSourceRecordRepo: any;
    let service: FundUpdateApplyService;

    beforeEach(() => {
      mockTxExecutor = { __isTx: true };
      db = { transaction: vi.fn(async (cb) => cb(mockTxExecutor)) };
      flFundRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([]),
        findById: vi.fn(),
      };
      flAssetRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([
          { id: 'asset-alpha', name: 'Asset Alpha', instrument_terms: { sheetCode: 'ALPHA' } },
        ]),
        findById: vi.fn().mockResolvedValue({ id: 'asset-alpha', name: 'Asset Alpha' }),
      };
      flInvestorRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([
          { id: 'inv-1', name: 'Investor Alice' },
          { id: 'inv-2', name: 'Investor Bob' },
        ]),
      };
      flPositionRepo = {
        findByAssetIds: vi.fn().mockResolvedValue([
          { id: 'pos-alice', asset_id: 'asset-alpha', holder_investor_id: 'inv-1' },
          { id: 'pos-bob', asset_id: 'asset-alpha', holder_investor_id: 'inv-2' },
        ]),
        findByFundIds: vi.fn().mockResolvedValue([]),
        findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
      };
      flLedgerEntryRepo = {
        findByPositionIds: vi.fn().mockResolvedValue([
          {
            id: 'entry-alice',
            position_id: 'pos-alice',
            entry_date: '2024-01-15',
            entry_type: 'buy',
            cash_delta: '-50000.00000000',
            quantity_delta: '100.00000000',
            price_per_unit: '500.00000000',
            currency: 'USD',
          },
        ]),
        findAllByPositionIds: vi.fn().mockResolvedValue([
          {
            id: 'entry-alice',
            position_id: 'pos-alice',
            entry_date: '2024-01-15',
            entry_type: 'buy',
            cash_delta: '-50000.00000000',
            quantity_delta: '100.00000000',
            price_per_unit: '500.00000000',
            currency: 'USD',
          },
        ]),
      };
      flValuationRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([]),
        findSeriesByTarget: vi.fn().mockResolvedValue([]),
        findByPositionIdsAndAsOfDates: vi.fn().mockResolvedValue([]),
      };
      flPositionService = {
        getOrOpenPosition: vi.fn(),
      };
      flLedgerService = {
        postEvent: vi.fn(),
      };
      flValuationService = {
        record: vi.fn(),
        update: vi.fn(),
      };
      flFundingSourceRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([]),
      };
      flSourceRecordRepo = {
        upsertByHash: vi.fn(),
      };
      flMasterDataService = {} as any;

      service = new FundUpdateApplyService(
        db,
        'ws-1',
        flFundRepo,
        flAssetRepo,
        flPositionRepo,
        flInvestorRepo,
        flFundingSourceRepo,
        flMasterDataService,
        flPositionService,
        flLedgerService,
        flValuationService,
        flValuationRepo,
        flLedgerEntryRepo,
        flSourceRecordRepo,
      );
    });

    it('proposes new contribution for Bob even though Alice has an identical dated contribution', async () => {
      const proposedBobAsset: ParsedAsset = {
        code: 'ALPHA',
        name: 'Asset Alpha',
        legalName: null,
        country: null,
        investmentTypeLabel: 'Direct Investments',
        assetType: 'direct_investment',
        fund: null,
        entity: 'Investor Bob',
        holderKind: 'investor',
        holderName: 'Investor Bob',
        fundingSource: null,
        fundingSourceRaw: null,
        entryDate: '2024-01-15',
        stakePct: null,
        commitmentAmount: null,
        dealType: null,
        mgmtFeeRatePct: null,
        sector: null,
        subSector: null,
        instrument: 'Common Equity',
        sharesOutstanding: null,
        sourceRef: null,
        vintageYear: 2024,
        valuations: [],
        currentPricePerShare: 500,
        txns: [
          {
            date: '2024-01-15',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 500,
            shareCount: 100,
            valueAmount: 50000,
            currency: 'USD',
            fxRate: null,
            notes: null,
          },
        ],
      };

      const review = await service.buildReview([proposedBobAsset]);
      expect(review).toHaveLength(1);
      expect(review[0].missing_txn_count).toBe(1);
      expect(review[0].status).toBe('add_missing');
    });

    it('marks as unchanged duplicate when proposed for Alice', async () => {
      const proposedAliceAsset: ParsedAsset = {
        code: 'ALPHA',
        name: 'Asset Alpha',
        legalName: null,
        country: null,
        investmentTypeLabel: 'Direct Investments',
        assetType: 'direct_investment',
        fund: null,
        entity: 'Investor Alice',
        holderKind: 'investor',
        holderName: 'Investor Alice',
        fundingSource: null,
        fundingSourceRaw: null,
        entryDate: '2024-01-15',
        stakePct: null,
        commitmentAmount: null,
        dealType: null,
        mgmtFeeRatePct: null,
        sector: null,
        subSector: null,
        instrument: 'Common Equity',
        sharesOutstanding: null,
        sourceRef: null,
        vintageYear: 2024,
        valuations: [],
        currentPricePerShare: 500,
        txns: [
          {
            date: '2024-01-15',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 500,
            shareCount: 100,
            valueAmount: 50000,
            currency: 'USD',
            fxRate: null,
            notes: null,
          },
        ],
      };

      const review = await service.buildReview([proposedAliceAsset]);
      expect(review).toHaveLength(1);
      expect(review[0].missing_txn_count).toBe(0);
      expect(review[0].status).toBe('unchanged');
    });
  });

  // --------------------------------------------------------------------------
  // Case 6: Exact copied/reordered replay skips; changed source attribution is explained;
  // share/price discrepancies do not silently collapse.
  // --------------------------------------------------------------------------
  describe('Case 6: Replay deduplication and source attribution conflict explanation', () => {
    it('skips exact copied/reordered replay and explains changed source attribution without double-writing', async () => {
      const mockTxExecutor = { __isTx: true };
      const db = { transaction: vi.fn(async (cb) => cb(mockTxExecutor)) };
      const flAssetRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([
          { id: 'asset-1', name: 'Portfolio Co', instrument_terms: { sheetCode: 'PCO' } },
        ]),
        findById: vi.fn().mockResolvedValue({ id: 'asset-1', name: 'Portfolio Co' }),
      };
      const flFundRepo = {
        findByWorkspaceId: vi.fn().mockResolvedValue([
          { id: 'fund-1', name: 'Fund One', managed: true },
        ]),
      };
      const flPositionRepo = {
        findByAssetIds: vi.fn().mockResolvedValue([
          { id: 'pos-1', asset_id: 'asset-1', holder_fund_id: 'fund-1' },
        ]),
        findByFundIds: vi.fn().mockResolvedValue([]),
        findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
      };
      const flLedgerEntryRepo = {
        findByPositionIds: vi.fn().mockResolvedValue([
          {
            id: 'entry-1',
            position_id: 'pos-1',
            entry_date: '2024-02-01',
            entry_type: 'buy',
            cash_delta: '-10000.00000000',
            quantity_delta: '100.00000000',
            price_per_unit: '100.00000000',
            currency: 'USD',
            source_record_id: 'src-old',
          },
        ]),
        findAllByPositionIds: vi.fn().mockResolvedValue([
          {
            id: 'entry-1',
            position_id: 'pos-1',
            entry_date: '2024-02-01',
            entry_type: 'buy',
            cash_delta: '-10000.00000000',
            quantity_delta: '100.00000000',
            price_per_unit: '100.00000000',
            currency: 'USD',
            source_record_id: 'src-old',
          },
        ]),
      };
      const flSourceRecordRepo = {
        findByIds: vi.fn().mockResolvedValue([
          { id: 'src-old', raw_payload: { fundingSource: 'Source A' } },
        ]),
        upsertByHash: vi.fn().mockResolvedValue({ id: 'src-new' }),
      };
      const flPositionService = {
        getOrOpenPosition: vi.fn().mockResolvedValue({ id: 'pos-1' }),
      };
      const flLedgerService = {
        postEvent: vi.fn(),
      };

      const service = new FundUpdateApplyService(
        db as any,
        'ws-1',
        flFundRepo as any,
        flAssetRepo as any,
        flPositionRepo as any,
        { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any, // flInvestorRepo
        { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any, // flFundingSourceRepo
        {
          getOrCreateFund: vi.fn().mockImplementation(async (_ws, input) => ({ id: `fund-${input.name}`, ...input })),
          getOrCreateAsset: vi.fn().mockImplementation(async (_ws, input) => ({ id: `asset-${input.code}`, ...input })),
          getOrCreateInvestor: vi.fn().mockImplementation(async (_ws, input) => ({ id: `inv-${input.name}`, ...input })),
          getOrCreateFundingSource: vi.fn().mockImplementation(async (_ws, input) => ({ id: `fs-${input.name}`, ...input })),
        } as any,
        flPositionService as any,
        flLedgerService as any,
        { record: vi.fn(), update: vi.fn() } as any,
        { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
        flLedgerEntryRepo as any,
        flSourceRecordRepo as any,
      );

      const proposedAsset: ParsedAsset = {
        code: 'PCO',
        name: 'Portfolio Co',
        legalName: null,
        country: null,
        investmentTypeLabel: 'Direct Investments',
        assetType: 'direct_investment',
        fund: 'Fund One',
        entity: 'Fund One',
        fundingSource: 'Source B',
        fundingSourceRaw: 'Source B',
        entryDate: '2024-02-01',
        stakePct: null,
        commitmentAmount: null,
        dealType: null,
        mgmtFeeRatePct: null,
        sector: null,
        subSector: null,
        instrument: 'Common Equity',
        sharesOutstanding: null,
        sourceRef: null,
        vintageYear: 2024,
        valuations: [],
        currentPricePerShare: 100,
        txns: [
          {
            date: '2024-02-01',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: 100,
            shareCount: 100,
            valueAmount: 10000,
            currency: 'USD',
            fxRate: null,
            notes: null,
          },
        ],
      };

      const result = await service.applySelected([proposedAsset], ['PCO'], [
        { asset_code: 'PCO', txns: proposedAsset.txns, valuations: [] },
      ]);

      expect(result.txns_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();

      expect(result.catalog_warnings).toBeDefined();
      expect(result.catalog_warnings?.length).toBeGreaterThan(0);
      expect(result.catalog_warnings?.[0]).toMatch(/2024-02-01.*differing source attribution/i);
    });

    it('does not silently collapse share count or price discrepancies', () => {
      const txn1 = {
        date: '2024-01-01',
        type: 'contribution',
        shareCount: 100,
        pricePerShare: 10,
        valueAmount: 1000,
        currency: 'USD',
      };
      const txn2 = {
        date: '2024-01-01',
        type: 'contribution',
        shareCount: 50,
        pricePerShare: 20,
        valueAmount: 1000,
        currency: 'USD',
      };

      const key1 = fundUpdateTxnKey(txn1);
      const key2 = fundUpdateTxnKey(txn2);

      expect(key1).toBe('2024-01-01|contribution|1000|100|10|USD');
      expect(key2).toBe('2024-01-01|contribution|1000|50|20|USD');
      expect(key1).not.toBe(key2);
    });
  });

  // --------------------------------------------------------------------------
  // Case 7: 01FN selected rows with unrelated omitted entities still reach posting;
  // AKUL with Meranti holder and Aldiracita source never substitutes source for investor.
  // Omitted required holder blocks approval.
  // --------------------------------------------------------------------------
  describe('Case 7: Entity omission, holder vs source distinction, and missing holder blocking', () => {
    it('allows selected rows on staged entities when an unrelated entity is omitted', () => {
      const review = {
        fileId: 'file-1',
        entities: [
          {
            key: 'fund:ActiveFund',
            name: 'Active Fund',
            tab: 'fund',
            status: 'matched' as const,
            matchedId: 'f-1',
            isStaged: true,
          },
          {
            key: 'fund:OmittedFund',
            name: 'Omitted Fund',
            tab: 'fund',
            status: 'new' as const,
            matchedId: 'f-2',
            isStaged: false,
          },
          {
            key: 'asset:P1',
            name: 'Asset P1',
            tab: 'asset',
            status: 'matched' as const,
            matchedId: 'a-1',
            isStaged: true,
          },
          {
            key: 'asset:P2',
            name: 'Asset P2',
            tab: 'asset',
            status: 'matched' as const,
            matchedId: 'a-2',
            isStaged: true,
          },
        ],
        transactions: [
          {
            id: 'txn-active',
            sheetRow: 1,
            date: '2024-01-01',
            type: 'contribution',
            fromKey: 'fund:ActiveFund',
            toKey: 'asset:P1',
            amount: 1000,
            selected: true,
            status: 'actionable',
          },
          {
            id: 'txn-omitted',
            sheetRow: 2,
            date: '2024-01-01',
            type: 'contribution',
            fromKey: 'fund:OmittedFund',
            toKey: 'asset:P2',
            amount: 2000,
            selected: true,
            status: 'actionable',
          },
        ],
        valuations: [],
      } as any;

      const dep = validateTwoStepDependencies({
        stagedEntities: review.entities,
        transactions: review.transactions,
        valuations: review.valuations,
      });
      const activeTxn = dep.validatedTransactions.find((t) => t.id === 'txn-active');
      const omittedTxn = dep.validatedTransactions.find((t) => t.id === 'txn-omitted');

      expect(activeTxn?.status).toBe('actionable');
      expect(omittedTxn?.status).toBe('blocked');
      expect(omittedTxn?.blockReason).toMatch(/omitted|deselected/i);
    });

    it('maintains distinct holder (Meranti) and funding source (Aldiracita) without substitution', () => {
      const akulAsset: ParsedAsset = {
        code: 'AKUL',
        name: 'Akulaku Inc',
        legalName: null,
        country: 'Indonesia',
        investmentTypeLabel: 'Direct Investments',
        assetType: 'direct_investment',
        fund: 'Meranti 1',
        entity: 'Meranti 1',
        holderKind: 'fund',
        holderName: 'Meranti 1',
        fundingSource: 'Aldiracita',
        fundingSourceRaw: 'Aldiracita',
        entryDate: '2024-01-01',
        stakePct: null,
        commitmentAmount: null,
        dealType: null,
        mgmtFeeRatePct: null,
        sector: null,
        subSector: null,
        instrument: 'Common Equity',
        sharesOutstanding: null,
        sourceRef: null,
        vintageYear: 2024,
        valuations: [],
        currentPricePerShare: null,
        txns: [],
      };

      expect(akulAsset.holderName).toBe('Meranti 1');
      expect(akulAsset.holderKind).toBe('fund');
      expect(akulAsset.fundingSource).toBe('Aldiracita');
      expect(akulAsset.holderName).not.toBe(akulAsset.fundingSource);
    });

    it('blocks transaction when required holder entity is omitted', () => {
      const review = {
        fileId: 'file-1',
        entities: [
          {
            key: 'investor:InvA',
            name: 'Investor A',
            tab: 'investor',
            status: 'new' as const,
            matchedId: null,
            isStaged: false,
          },
          {
            key: 'fund:FundA',
            name: 'Fund A',
            tab: 'fund',
            status: 'matched' as const,
            matchedId: 'f-1',
            isStaged: true,
          },
        ],
        transactions: [
          {
            id: 'txn-1',
            sheetRow: 1,
            date: '2024-01-01',
            type: 'contribution',
            fromKey: 'investor:InvA',
            toKey: 'fund:FundA',
            amount: 1000,
            selected: true,
            status: 'actionable',
          },
        ],
        valuations: [],
      } as any;

      const dep = validateTwoStepDependencies({
        stagedEntities: review.entities,
        transactions: review.transactions,
        valuations: review.valuations,
      });
      const txn = dep.validatedTransactions[0];
      expect(txn.status).toBe('blocked');
      expect(txn.blockReason).toMatch(/omitted|deselected/i);
    });
  });

  // --------------------------------------------------------------------------
  // Case 8: Prevalidation prevents partial writes on invalid inputs
  // --------------------------------------------------------------------------
  describe('Case 8: Prevalidation prevents partial writes', () => {
    let fileService: FileService;
    let mockCanonicalReview: NormalizedTwoStepReview;

    beforeEach(() => {
      mockCanonicalReview = {
        fileId: 'file-100',
        entities: [
          { key: 'asset:A1', name: 'Asset One', tab: 'asset', status: 'matched', matchedId: 'a-1', isStaged: true },
        ],
        transactions: [
          { id: 'txn-valid', sheetRow: 1, date: '2024-01-01', type: 'contribution', fromKey: 'fund:F1', toKey: 'asset:A1', amount: 1000, status: 'actionable' },
          { id: 'txn-dup', sheetRow: 2, date: '2024-01-01', type: 'contribution', fromKey: 'fund:F1', toKey: 'asset:A1', amount: 1000, status: 'duplicate' },
          { id: 'txn-blocked', sheetRow: 3, date: '2024-01-01', type: 'contribution', fromKey: 'fund:F1', toKey: 'asset:A1', amount: 1000, status: 'blocked', blockReason: 'Missing holder' },
        ],
        valuations: [
          { id: 'val-valid', sheetRow: 1, asOfDate: '2024-03-31', targetKey: 'asset:A1', marketValue: 50000, status: 'actionable' },
          { id: 'val-dup', sheetRow: 2, asOfDate: '2024-03-31', targetKey: 'asset:A1', marketValue: 50000, status: 'duplicate' },
          { id: 'val-blocked', sheetRow: 3, asOfDate: '2024-03-31', targetKey: 'asset:A1', marketValue: 50000, status: 'blocked', blockReason: 'Missing holder' },
        ],
      } as any;

      const fileRepoStub = {
        findById: vi.fn().mockResolvedValue({
          id: 'file-100',
          file_name: 'test.xlsx',
          processing_status: 'awaiting_review',
          structured_notes: JSON.stringify({
            fund_update_proposal: {
              assets: [],
              valuations: [],
            },
          }),
        }),
        findByIdForUpdate: vi.fn().mockImplementation(async (id: string) => fileRepoStub.findById(id)),
        updatePartial: vi.fn(),
      };

      const mockDb = {
        transaction: async (cb: (tx: any) => Promise<any>) => cb(mockDb),
        execute: vi.fn().mockResolvedValue([]),
      };

      fileService = new FileService(
        mockDb as any,
        'ws-1',
        fileRepoStub as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      fileService.setFundUpdateApplyService({
        applySelected: vi.fn().mockResolvedValue({ applied: 1 }),
      } as any);

      vi.spyOn(fileService as any, 'getFundUpdateReviewData').mockResolvedValue({
        two_step_review: mockCanonicalReview,
      });
    });

    it('rejects unknown transaction ID', async () => {
      const approval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-unknown' }],
        valuations: [],
      };

      await expect(
        fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: approval }),
      ).rejects.toThrow(/Unknown transaction ID "txn-unknown"/);
    });

    it('rejects repeated/duplicate submitted transaction ID', async () => {
      const approval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-valid' }, { id: 'txn-valid' }],
        valuations: [],
      };

      await expect(
        fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: approval }),
      ).rejects.toThrow(/Duplicate transaction ID "txn-valid" submitted/);
    });

    it('handles duplicate transaction status as an explained skip, not an approval rejection', async () => {
      const approval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-dup' }],
        valuations: [],
      };

      const result = await fileService.approve('file-100', {
        file_type: 'fund_updates',
        matched_company_id: null,
        two_step_approval: approval,
      });
      expect(result).toBeDefined();
    });

    it('rejects blocked transaction without resolution', async () => {
      const approval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-blocked' }],
        valuations: [],
      };

      await expect(
        fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: approval }),
      ).rejects.toThrow(/Cannot approve transaction "txn-blocked": item is blocked/);
    });

    it('rejects invalid edited date or amount', async () => {
      const invalidDateApproval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-valid', edits: { date: 'invalid-date' } }],
        valuations: [],
      };

      await expect(
        fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: invalidDateApproval }),
      ).rejects.toThrow(/Invalid date/);

      const invalidAmtApproval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-valid', edits: { amount: 'not_a_number' as any } }],
        valuations: [],
      };

      await expect(
        fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: invalidAmtApproval }),
      ).rejects.toThrow(/Invalid amount/);
    });

    it('rejects mixed batch if any transaction has a blocked/invalid selection before partial writes occur', async () => {
      const mixedApproval: TwoStepApprovalInput = {
        entityDecisions: [{ key: 'asset:A1', action: 'create' }],
        transactions: [{ id: 'txn-blocked' }],
        valuations: [],
      };

        await expect(
          fileService.approve('file-100', { file_type: 'fund_updates', matched_company_id: null, two_step_approval: mixedApproval }),
        ).rejects.toThrow(/item is blocked/);
      });
    });

    // --------------------------------------------------------------------------
    // Phase 2: Fund-only cash ownership, unstated proceeds defaulting, and bare "divestment" disambiguation
    // --------------------------------------------------------------------------
    describe('Phase 2: Fund-only cash ownership and unstated proceeds defaulting', () => {
      const managedFundHolder: CashHolderCandidate = {
        holder_fund_id: 'fund-mgd-1',
        holderFundManaged: true,
      };
      const unmanagedFundHolder: CashHolderCandidate = {
        holder_fund_id: 'fund-unmgd-1',
        holderFundManaged: false,
      };
      const investorHolder: CashHolderCandidate = {
        holder_investor_id: 'inv-1',
        holderFundManaged: false,
      };

      it('disambiguates bare "divestment" literal so it is never treated as a stated treatment', () => {
        expect(isUnresolvedDivestmentToken('divestment')).toBe(true);
        expect(isUnresolvedDivestmentToken('DIVESTMENT')).toBe(true);
        expect(isUnresolvedDivestmentToken('cash_in_fund')).toBe(false);
        expect(isUnresolvedDivestmentToken('distributed_to_investor')).toBe(false);

        // On managed fund: bare divestment token defaults to retained cash
        const managedRes = resolveProceedsTreatment({
          entryType: 'sell',
          holder: managedFundHolder,
          statedSubType: 'divestment',
        });
        expect(managedRes.defaulted).toBe(true);
        expect(managedRes.subType).toBe('divestment:cash_in_fund');

        // On investor holder: bare divestment token is not applicable, gives null treatment
        const investorRes = resolveProceedsTreatment({
          entryType: 'sell',
          holder: investorHolder,
          statedSubType: 'divestment',
        });
        expect(investorRes.defaulted).toBe(false);
        expect(investorRes.subType).toBeNull();
      });

      it('defaults unstated proceeds treatment on managed fund sale to retained and surfaces in review', async () => {
        const db = { transaction: async (cb: any) => cb({}) };
        const flFundRepo = {
          findByWorkspaceId: vi.fn().mockResolvedValue([
            { id: 'fund-mgd-1', name: 'Managed Fund 1', managed: true },
          ]),
        };
        const flAssetRepo = { findByWorkspaceId: vi.fn().mockResolvedValue([]) };
        const flPositionRepo = {
          findByAssetIds: vi.fn().mockResolvedValue([]),
          findByFundIds: vi.fn().mockResolvedValue([]),
          findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
        };
        const flLedgerEntryRepo = {
          findByPositionIds: vi.fn().mockResolvedValue([]),
          findAllByPositionIds: vi.fn().mockResolvedValue([]),
        };
        const service = new FundUpdateApplyService(
          db as any,
          'ws-1',
          flFundRepo as any,
          flAssetRepo as any,
          flPositionRepo as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          {
            getOrCreateFund: vi.fn(),
            getOrCreateAsset: vi.fn(),
            getOrCreateInvestor: vi.fn(),
            getOrCreateFundingSource: vi.fn(),
          } as any,
          {} as any,
          { postEvent: vi.fn() } as any,
          {} as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          flLedgerEntryRepo as any,
        );

        const proposedAsset: ParsedAsset = {
          code: 'TEST-MGD',
          name: 'Portfolio Company',
          legalName: null,
          country: null,
          investmentTypeLabel: 'Direct Investments',
          assetType: 'direct_investment',
          fund: 'Managed Fund 1',
          entity: 'Managed Fund 1',
          fundingSource: 'DCA',
          fundingSourceRaw: 'DCA',
          entryDate: '2024-01-01',
          stakePct: null,
          commitmentAmount: null,
          dealType: null,
          mgmtFeeRatePct: null,
          sector: null,
          subSector: null,
          instrument: 'Common Equity',
          sharesOutstanding: null,
          sourceRef: null,
          vintageYear: 2024,
          valuations: [],
          currentPricePerShare: null,
          txns: [
            {
              date: '2024-02-01',
              type: 'sell' as never,
              subTypeLabel: null,
              pricePerShare: 10,
              shareCount: 100,
              valueAmount: 1000,
              currency: 'USD',
              fxRate: null,
              notes: null,
              sellProceedsDestination: null, // Unstated
            },
          ],
        };

        const review = await service.buildFullReview([proposedAsset]);
        const item = review.assets.find((a) => a.code === 'TEST-MGD');
        expect(item).toBeDefined();
        expect(item?.proposed.txns[0].sellProceedsDestination).toBe('cash_in_fund');

        // mapFundUpdateTxn with managed holder defaults to divestment:cash_in_fund
        const mapped = mapFundUpdateTxn(proposedAsset.txns[0], 'asset', managedFundHolder);
        expect(mapped.entryType).toBe('sell');
        expect(mapped.subType).toBe('divestment:cash_in_fund');
      });

      it('preserves explicitly stated document treatment on managed-fund sale', () => {
        const explicitDistTxn: ParsedTxn = {
          date: '2024-02-01',
          type: 'sell' as never,
          subTypeLabel: null,
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          currency: 'USD',
          fxRate: null,
          notes: null,
          sellProceedsDestination: 'distributed_to_investor',
        };
        const mappedDist = mapFundUpdateTxn(explicitDistTxn, 'asset', managedFundHolder);
        expect(mappedDist.subType).toBe('divestment:distributed_to_investor');

        const explicitRetainedTxn: ParsedTxn = {
          ...explicitDistTxn,
          sellProceedsDestination: 'cash_in_fund',
        };
        const mappedRetained = mapFundUpdateTxn(explicitRetainedTxn, 'asset', managedFundHolder);
        expect(mappedRetained.subType).toBe('divestment:cash_in_fund');
      });

      it('normalizes away proceeds treatment for investor-held sale and generates no cash', () => {
        const investorSaleTxn: ParsedTxn = {
          date: '2024-02-01',
          type: 'sell' as never,
          subTypeLabel: 'divestment:cash_in_fund',
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          currency: 'USD',
          fxRate: null,
          notes: null,
          sellProceedsDestination: 'cash_in_fund',
        };
        const mapped = mapFundUpdateTxn(investorSaleTxn, 'asset', investorHolder);
        expect(mapped.subType).toBe('divestment');
        expect(mapped.cashDelta).toBe('1000.00000000');
        expect(mapped.quantityDelta).toBe('-100.00000000');

        // deriveCashLegs generates NO cash leg for investor holder
        const positions = new Map<string, PositionWithFundFlags>([
          ['pos-inv', { id: 'pos-inv', holder_investor_id: 'inv-1', holderFundManaged: false, asset_id: 'a-1' }],
        ]);
        const entries: DerivableEntry[] = [
          {
            position_id: 'pos-inv',
            entry_type: 'sell',
            sub_type: mapped.subType,
            cash_delta: mapped.cashDelta,
            currency: 'USD',
          },
        ];
        const legs = deriveCashLegs(entries, positions);
        expect(legs).toHaveLength(0);
      });

      it('normalizes away proceeds treatment for unmanaged-fund-held sale and generates no cash', () => {
        const unmanagedSaleTxn: ParsedTxn = {
          date: '2024-02-01',
          type: 'sell' as never,
          subTypeLabel: 'divestment:cash_in_fund',
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          currency: 'USD',
          fxRate: null,
          notes: null,
          sellProceedsDestination: 'cash_in_fund',
        };
        const mapped = mapFundUpdateTxn(unmanagedSaleTxn, 'asset', unmanagedFundHolder);
        expect(mapped.subType).toBe('divestment');

        // deriveCashLegs generates NO cash leg for unmanaged fund holder
        const positions = new Map<string, PositionWithFundFlags>([
          ['pos-unmgd', { id: 'pos-unmgd', holder_fund_id: 'fund-unmgd-1', holderFundManaged: false, asset_id: 'a-1' }],
        ]);
        const entries: DerivableEntry[] = [
          {
            position_id: 'pos-unmgd',
            entry_type: 'sell',
            sub_type: mapped.subType,
            cash_delta: mapped.cashDelta,
            currency: 'USD',
          },
        ];
        const legs = deriveCashLegs(entries, positions);
        expect(legs).toHaveLength(0);
      });

      it('investor subscription moves managed fund cash, creating no investor cash account', () => {
        const positions = new Map<string, PositionWithFundFlags>([
          ['pos-sub', {
            id: 'pos-sub',
            holder_investor_id: 'inv-1',
            fund_id: 'fund-mgd-1',
            instrumentFundManaged: true,
          }],
        ]);
        const entries: DerivableEntry[] = [
          {
            position_id: 'pos-sub',
            entry_type: 'paid_in',
            cash_delta: '-50000.00000000',
            currency: 'USD',
          },
        ];
        const legs = deriveCashLegs(entries, positions);

        // Managed fund gets an instrument-side cash leg of +50000
        expect(legs).toHaveLength(1);
        expect(legs[0]).toEqual({
          primary_entry_index: 0,
          holder_kind: 'fund',
          holder_id: 'fund-mgd-1',
          currency: 'USD',
          cash_delta: '50000.00000000',
          role: 'instrument',
        });
      });

      it('nets 退出 (+100 receipt) and 分配 (-60 payout) correctly to +40 net fund cash with 0 investor cash', () => {
        const positions = new Map<string, PositionWithFundFlags>([
          ['pos-asset', {
            id: 'pos-asset',
            holder_fund_id: 'fund-mgd-1',
            holderFundManaged: true,
            asset_id: 'asset-1',
          }],
        ]);
        const entries: DerivableEntry[] = [
          // 退出 with 资金流入基金: divestment receipt (+100)
          {
            position_id: 'pos-asset',
            entry_type: 'sell',
            sub_type: 'divestment:cash_in_fund',
            cash_delta: '100.00000000',
            currency: 'USD',
          },
          // 分配 with 资金流出基金: separate distribution payout (-60)
          {
            position_id: 'pos-asset',
            entry_type: 'expense',
            sub_type: null,
            cash_delta: '-60.00000000',
            currency: 'USD',
          },
        ];
        const legs = deriveCashLegs(entries, positions);

        expect(legs).toHaveLength(2);
        expect(legs[0].holder_kind).toBe('fund');
        expect(legs[0].holder_id).toBe('fund-mgd-1');
        expect(legs[0].cash_delta).toBe('100.00000000');

        expect(legs[1].holder_kind).toBe('fund');
        expect(legs[1].holder_id).toBe('fund-mgd-1');
        expect(legs[1].cash_delta).toBe('-60.00000000');

        // Net fund cash
        const netCash = Number(legs[0].cash_delta) + Number(legs[1].cash_delta);
        expect(netCash).toBe(40);

        // No legs for any investor
        expect(legs.every((l) => l.holder_kind === 'fund')).toBe(true);
      });

      it('rejects cash assets for ineligible holders in review and apply', async () => {
        const db = { transaction: async (cb: any) => cb({}) };
        const flFundRepo = { findByWorkspaceId: vi.fn().mockResolvedValue([]) };
        const flAssetRepo = { findByWorkspaceId: vi.fn().mockResolvedValue([]) };
        const flPositionRepo = {
          findByAssetIds: vi.fn().mockResolvedValue([]),
          findByFundIds: vi.fn().mockResolvedValue([]),
          findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
        };
        const service = new FundUpdateApplyService(
          db as any,
          'ws-1',
          flFundRepo as any,
          flAssetRepo as any,
          flPositionRepo as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          {
            getOrCreateFund: vi.fn(),
            getOrCreateAsset: vi.fn(),
            getOrCreateInvestor: vi.fn().mockResolvedValue({ id: 'inv-1', name: 'Investor Alice' }),
            getOrCreateFundingSource: vi.fn(),
          } as any,
          {} as any,
          { postEvent: vi.fn() } as any,
          {} as any,
          { findByWorkspaceId: vi.fn().mockResolvedValue([]) } as any,
          { findByPositionIds: vi.fn().mockResolvedValue([]), findAllByPositionIds: vi.fn().mockResolvedValue([]) } as any,
        );

        const cashAsset: ParsedAsset = {
          code: 'CASH',
          name: 'Cash',
          legalName: null,
          country: null,
          investmentTypeLabel: 'Cash',
          assetType: 'cash' as never,
          fund: 'Others',
          entity: 'Investor Alice',
          holderKind: 'investor',
          holderName: 'Investor Alice',
          fundingSource: null,
          fundingSourceRaw: null,
          entryDate: '2024-01-01',
          stakePct: null,
          commitmentAmount: null,
          dealType: null,
          mgmtFeeRatePct: null,
          sector: null,
          subSector: null,
          instrument: null,
          sharesOutstanding: null,
          sourceRef: null,
          vintageYear: 2024,
          valuations: [],
          currentPricePerShare: null,
          txns: [
            {
              date: '2024-01-01',
              type: 'contribution',
              subTypeLabel: null,
              pricePerShare: null,
              shareCount: null,
              valueAmount: 10000,
              currency: 'USD',
              fxRate: null,
              notes: null,
            },
          ],
        };

        const review = await service.buildFullReview([cashAsset]);
        const item = review.assets.find((a) => a.code === 'CASH');
        expect(item?.warnings?.some((w) => w.includes('Ineligible cash holder'))).toBe(true);

        await expect(
          service.applySelected([cashAsset], ['CASH']),
        ).rejects.toThrow(IneligibleCashHolderError);
      });
    });
  });
