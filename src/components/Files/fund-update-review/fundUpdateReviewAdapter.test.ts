import { describe, expect, it } from 'vitest';
import {
  extractTwoStepReview,
  getEntityOptions,
  buildApprovePayload,
} from './adapter';
import type {
  FundUpdateReviewData,
  ReviewEntity,
  ReviewTransaction,
  ReviewValuation,
} from './types';

function sampleCanonicalReviewData(overrides: Partial<FundUpdateReviewData> = {}): FundUpdateReviewData {
  const entities: ReviewEntity[] = [
    {
      key: 'asset:AST-01',
      tab: 'asset',
      code: 'AST-01',
      name: 'Asset Alpha',
      status: 'new',
      matchedId: null,
      txnsCount: 2,
      valsCount: 1,
      fields: [{ label: 'Legal name', value: 'Alpha Corp' }],
      links: [
        { key: 'fund:Growth Fund I', kind: 'Fund', name: 'Growth Fund I', status: 'new' },
        { key: 'investor:Master LP', kind: 'Investor', name: 'Master LP', status: 'new' },
        { key: 'source:Special DCA', kind: 'Source of Fund', name: 'Special DCA', status: 'new' },
      ],
      isStaged: true,
    },
    {
      key: 'fund:Growth Fund I',
      tab: 'fund',
      code: '',
      name: 'Growth Fund I',
      status: 'new',
      matchedId: null,
      txnsCount: 2,
      valsCount: 1,
      fields: [],
      links: [],
      isStaged: true,
    },
    {
      key: 'investor:Master LP',
      tab: 'investor',
      code: '',
      name: 'Master LP',
      status: 'new',
      matchedId: null,
      txnsCount: 2,
      valsCount: 0,
      fields: [],
      links: [],
      isStaged: true,
    },
    {
      key: 'source:Special DCA',
      tab: 'source',
      code: '',
      name: 'Special DCA',
      status: 'new',
      matchedId: null,
      txnsCount: 2,
      valsCount: 0,
      fields: [],
      links: [],
      isStaged: true,
    },
    {
      key: 'fund:Existing Fund',
      tab: 'fund',
      code: '',
      name: 'Existing Fund',
      status: 'matched',
      matchedId: 'fund-exist-1',
      txnsCount: 0,
      valsCount: 0,
      fields: [],
      links: [],
      isStaged: true,
    },
  ];

  const transactions: ReviewTransaction[] = [
    {
      id: 'txn-1',
      sheetRow: 1,
      date: '2023-01-15',
      fromKey: 'investor:Master LP',
      toKey: 'asset:AST-01',
      srcKey: 'source:Special DCA',
      type: 'buy',
      subType: 'contribution',
      commitDelta: null,
      quantityDelta: 100,
      pricePerShare: 10,
      cashDelta: -1000,
      currency: 'USD',
      positionRef: null,
      status: 'actionable',
      selected: true,
      isTransfer: false,
      assetCode: 'AST-01',
    },
    {
      id: 'txn-2',
      sheetRow: 2,
      date: '2022-01-15',
      fromKey: 'investor:Master LP',
      toKey: 'asset:AST-01',
      srcKey: 'source:Special DCA',
      type: 'buy',
      subType: 'contribution',
      commitDelta: null,
      quantityDelta: 50,
      pricePerShare: 10,
      cashDelta: -500,
      currency: 'USD',
      positionRef: null,
      status: 'duplicate',
      selected: false,
      isTransfer: false,
      assetCode: 'AST-01',
    },
    {
      id: 'txn-3',
      sheetRow: 3,
      date: '2023-06-01',
      fromKey: 'investor:Unstaged LP',
      toKey: 'asset:AST-01',
      srcKey: null,
      type: 'buy',
      subType: 'contribution',
      commitDelta: null,
      quantityDelta: 20,
      pricePerShare: 10,
      cashDelta: -200,
      currency: 'USD',
      positionRef: null,
      status: 'blocked',
      blockReason: 'Unstaged LP is not being added in Step 1',
      selected: false,
      isTransfer: false,
    },
  ];

  const valuations: ReviewValuation[] = [
    {
      id: 'val-1',
      sheetRow: 1,
      assetCode: 'AST-01',
      assetName: 'Asset Alpha',
      asOfDate: '2023-03-31',
      periodLabel: 'Q1 2023',
      marketValue: 1200,
      pricePerShare: 12,
      sharesOutstanding: 100,
      shareholdingPct: 1,
      valuationMethod: 'at_cost',
      currency: 'USD',
      status: 'actionable',
      selected: true,
      originalKey: '2023-03-31|1200|12|100|at_cost',
    },
    {
      id: 'val-2',
      sheetRow: 2,
      assetCode: 'AST-01',
      assetName: 'Asset Alpha',
      asOfDate: '2022-12-31',
      periodLabel: 'Q4 2022',
      marketValue: 1000,
      pricePerShare: 10,
      sharesOutstanding: 100,
      shareholdingPct: 1,
      valuationMethod: 'at_cost',
      currency: 'USD',
      status: 'duplicate',
      selected: false,
      originalKey: '2022-12-31|1000|10|100|at_cost',
    },
  ];

  return {
    kind: 'fund_updates',
    template_id: 'startech_master_sheet_v1',
    summary: 'Test Fund Updates',
    stats: { asset_count: 1 },
    file: {
      id: 'file-1',
      file_name: 'test_report.xlsx',
      file_type: 'fund_updates',
      processing_status: 'awaiting_review',
    },
    two_step_review: {
      entities,
      transactions,
      valuations,
      reconciliation: [
        {
          fund: 'Growth Fund I',
          metricName: 'Paid-in vs Summary',
          sourceValue: 1000,
          calculatedValue: 1000,
          diff: 0,
          diffPct: 0,
          isReconciled: true,
        },
      ],
    },
    ...overrides,
  };
}

describe('FundUpdateReview Adapter (MB-513 Canonical Contract)', () => {
  describe('extractTwoStepReview', () => {
    it('extracts and deep-clones canonical two_step_review data with correct default selection states', () => {
      const data = sampleCanonicalReviewData();
      const extracted = extractTwoStepReview(data);

      expect(extracted.entities).toHaveLength(5);
      expect(extracted.transactions).toHaveLength(3);
      expect(extracted.valuations).toHaveLength(2);
      expect(extracted.reconciliation).toHaveLength(1);

      // Matched entities have isStaged = true
      const matchedEntity = extracted.entities.find((e) => e.status === 'matched');
      expect(matchedEntity?.isStaged).toBe(true);

      // Actionable transactions are selected; duplicates and blocked are unselected
      expect(extracted.transactions[0].selected).toBe(true);
      expect(extracted.transactions[1].selected).toBe(false);
      expect(extracted.transactions[2].selected).toBe(false);

      // Actionable valuations are selected; duplicates are unselected
      expect(extracted.valuations[0].selected).toBe(true);
      expect(extracted.valuations[1].selected).toBe(false);
    });

    it('throws error when two_step_review payload is missing', () => {
      const badData = { kind: 'fund_updates' } as unknown as FundUpdateReviewData;
      expect(() => extractTwoStepReview(badData)).toThrow(/missing canonical two_step_review payload/);
    });
  });

  describe('getEntityOptions', () => {
    it('formats options correctly by group and adds (New) badge for new entities', () => {
      const data = sampleCanonicalReviewData();
      const { entities } = extractTwoStepReview(data);

      const allOptions = getEntityOptions(entities, 'all');
      expect(allOptions.some((o) => o.name === 'Asset Alpha (New)' && o.group === 'Assets')).toBe(true);
      expect(allOptions.some((o) => o.name === 'Growth Fund I (New)' && o.group === 'Funds')).toBe(true);
      expect(allOptions.some((o) => o.name === 'Master LP (New)' && o.group === 'Investors')).toBe(true);
      expect(allOptions.some((o) => o.name === 'Special DCA (New)' && o.group === 'Sources of Fund')).toBe(true);
      // Existing fund does not have (New)
      expect(allOptions.some((o) => o.name === 'Existing Fund' && o.group === 'Funds' && !o.isNew)).toBe(true);

      const sourceOptions = getEntityOptions(entities, 'source');
      expect(sourceOptions).toHaveLength(1);
      expect(sourceOptions[0].name).toBe('Special DCA (New)');
    });
  });

  describe('buildApprovePayload', () => {
    it('builds canonical two_step_approval payload with entityDecisions, transactions, and valuations', () => {
      const data = sampleCanonicalReviewData();
      const { entities, transactions, valuations } = extractTwoStepReview(data);

      // Deselect the new source in Step 1 (action = 'omit')
      const modifiedEntities = entities.map((e) =>
        e.key === 'source:Special DCA' ? { ...e, isStaged: false } : e,
      );

      const payload = buildApprovePayload({
        entities: modifiedEntities,
        transactions,
        valuations,
      });

      expect(payload.file_type).toBe('fund_updates');
      expect(payload.matched_company_id).toBeNull();
      expect(payload.two_step_approval).toBeDefined();

      // Check entity decisions
      const decisions = payload.two_step_approval.entityDecisions;
      expect(decisions).toHaveLength(5);

      const assetDec = decisions.find((d) => d.key === 'asset:AST-01');
      expect(assetDec?.action).toBe('create');

      const existDec = decisions.find((d) => d.key === 'fund:Existing Fund');
      expect(existDec?.action).toBe('use_existing');
      expect(existDec?.matchedId).toBe('fund-exist-1');

      const omitDec = decisions.find((d) => d.key === 'source:Special DCA');
      expect(omitDec?.action).toBe('omit');

      // Check transactions: only actionable & selected transactions included (txn-1)
      expect(payload.two_step_approval.transactions).toHaveLength(1);
      expect(payload.two_step_approval.transactions[0].id).toBe('txn-1');
      expect(payload.two_step_approval.transactions[0].edits).toEqual({
        type: 'buy',
        subType: 'contribution',
        subTypeLabel: undefined,
        notes: undefined,
        date: '2023-01-15',
        amount: undefined,
        currency: 'USD',
        pricePerShare: 10,
        quantityDelta: 100,
        cashDelta: -1000,
        transferorName: undefined,
        allocations: undefined,
        investorName: undefined,
        direction: undefined,
      });

      // Check valuations: only actionable & selected valuations included (val-1)
      expect(payload.two_step_approval.valuations).toHaveLength(1);
      expect(payload.two_step_approval.valuations[0].id).toBe('val-1');
      expect(payload.two_step_approval.valuations[0].edits).toEqual({
        asOfDate: '2023-03-31',
        marketValue: 1200,
        pricePerShare: 12,
        sharesOutstanding: 100,
        shareholdingPct: 1,
        valuationMethod: 'at_cost',
        notes: undefined,
      });
    });

    it('omits sellProceedsDestination from approval edits when none is stated', () => {
      const data = sampleCanonicalReviewData();
      const { entities, transactions, valuations } = extractTwoStepReview(data);
      const sellTxn: (typeof transactions)[number] = {
        ...transactions[0],
        id: 'txn-sell-inferred',
        type: 'sell',
        cashDelta: 50000,
        amount: 50000,
        status: 'actionable',
        selected: true,
        sellProceedsDestination: null,
      };

      const payload = buildApprovePayload({
        entities,
        transactions: [sellTxn],
        valuations,
      });

      expect(payload.two_step_approval.transactions).toHaveLength(1);
      expect(payload.two_step_approval.transactions[0].edits).not.toHaveProperty(
        'sellProceedsDestination',
      );
    });

    it('includes a stated sellProceedsDestination in approval edits', () => {
      const data = sampleCanonicalReviewData();
      const { entities, transactions, valuations } = extractTwoStepReview(data);
      const sellTxn: (typeof transactions)[number] = {
        ...transactions[0],
        id: 'txn-sell-stated',
        type: 'sell',
        cashDelta: 50000,
        amount: 50000,
        status: 'actionable',
        selected: true,
        sellProceedsDestination: 'cash_in_fund',
      };

      const payload = buildApprovePayload({
        entities,
        transactions: [sellTxn],
        valuations,
      });

      expect(payload.two_step_approval.transactions[0].edits?.sellProceedsDestination).toBe(
        'cash_in_fund',
      );
    });
  });
});
