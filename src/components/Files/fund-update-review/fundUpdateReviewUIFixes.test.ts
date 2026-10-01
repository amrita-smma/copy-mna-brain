import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TransactionsTable,
  CounterpartyCell,
} from "./TransactionsTable";
import {
  ValuationsTable,
  ValuationNumberInput,
} from "./ValuationsTable";
import {
  formatValuationNumber,
  formatValuationStake,
} from "./constants";
import { parseCurrencyInput, applyCommas } from "@/lib/numberFormat";
import { StepFooter } from "./StepFooter";
import { buildApprovePayload, formatApprovalFeedback } from "./adapter";
import type { ReviewOption, ReviewTransaction, ReviewValuation } from "./types";
import type { FundUpdateApplyResult } from "@/lib/services/fundUpdateApplyService";

describe("MB-513 Fund Update Review UI Fixes", () => {
  const sampleEntityOptions: ReviewOption[] = [
    {
      key: "investor:INV-ZH",
      name: "北京博远远锦程天使投资基金",
      englishName: "Beijing Boyuan Angel Fund",
      group: "Investors",
    },
    {
      key: "fund:FUND-EN",
      name: "Startech Growth Fund I",
      englishName: "Startech Growth Fund I",
      group: "Funds",
    },
    {
      key: "investor:INV-ONLY-ZH",
      name: "厦门恒源远景投资有限公司",
      englishName: null,
      group: "Investors",
    },
  ];

  describe("Criterion 1: Sequential row numbers", () => {
    it("renders monotonically sequential 1..N row numbers in TransactionsTable regardless of sheetRow", () => {
      const txns: ReviewTransaction[] = [
        {
          id: "txn-1",
          sheetRow: 42,
          date: "2024-01-01",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -100000,
          currency: "CNY",
          positionRef: "new",
          status: "actionable",
          selected: true,
          isTransfer: false,
        },
        {
          id: "txn-2",
          sheetRow: 1,
          date: "2024-01-02",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -200000,
          currency: "CNY",
          positionRef: "new",
          status: "actionable",
          selected: true,
          isTransfer: false,
        },
        {
          id: "txn-3",
          sheetRow: 99,
          date: "2024-01-03",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -300000,
          currency: "CNY",
          positionRef: "new",
          status: "actionable",
          selected: true,
          isTransfer: false,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: txns,
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );

      // Should display sequential numbers 1, 2, 3
      expect(html).toContain("<span>1</span>");
      expect(html).toContain("<span>2</span>");
      expect(html).toContain("<span>3</span>");
      // Should not display non-sequential sheetRows as visible numbers
      expect(html).not.toContain("<span>42</span>");
      expect(html).not.toContain("<span>99</span>");
    });

    it("renders monotonically sequential 1..N row numbers in ValuationsTable regardless of sheetRow", () => {
      const valuations: ReviewValuation[] = [
        {
          id: "val-1",
          sheetRow: 50,
          assetCode: "AST-1",
          assetName: "Asset One",
          asOfDate: "2024-03-31",
          periodLabel: "Q1 2024",
          marketValue: 1000000,
          pricePerShare: 10,
          sharesOutstanding: 100000,
          shareholdingPct: 15.5,
          valuationMethod: "at_cost",
          currency: "USD",
          status: "actionable",
          selected: true,
          originalKey: "AST-1:2024-03-31",
        },
        {
          id: "val-2",
          sheetRow: 2,
          assetCode: "AST-2",
          assetName: "Asset Two",
          asOfDate: "2024-03-31",
          periodLabel: "Q1 2024",
          marketValue: 2000000,
          pricePerShare: 20,
          sharesOutstanding: 100000,
          shareholdingPct: 20.0,
          valuationMethod: "at_cost",
          currency: "USD",
          status: "actionable",
          selected: true,
          originalKey: "AST-2:2024-03-31",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(ValuationsTable, {
          valuations: valuations,
          onToggleSelect: () => {},
          onUpdateValuation: () => {},
        }),
      );

      expect(html).toContain(">1</td>");
      expect(html).toContain(">2</td>");
      expect(html).not.toContain(">50</td>");
    });
  });

  describe("Criterion 2: Position single-line styling", () => {
    it("renders POSITION cells with whitespace-nowrap and truncation for long UUIDs", () => {
      const txns: ReviewTransaction[] = [
        {
          id: "txn-uuid",
          sheetRow: 1,
          date: "2024-01-01",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -100000,
          currency: "CNY",
          positionRef: "17ced6a0-e1e5-413d-b4e3-eda4c6978aec",
          status: "actionable",
          selected: true,
          isTransfer: false,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: txns,
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );

      expect(html).toContain("whitespace-nowrap");
      expect(html).toContain("max-w-[90px] truncate");
      expect(html).toContain('title="17ced6a0-e1e5-413d-b4e3-eda4c6978aec"');
    });

    it("renders status badges without wrapping", () => {
      const txns: ReviewTransaction[] = [
        {
          id: "txn-blocked",
          sheetRow: 1,
          date: "2024-01-01",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -100000,
          currency: "CNY",
          positionRef: null,
          status: "blocked",
          blockReason: "Missing entity staging",
          selected: false,
          isTransfer: false,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: txns,
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );

      expect(html).toContain("blocked");
      expect(html).toContain("Missing entity staging");
      expect(html).toContain("whitespace-nowrap");
    });
  });

  describe("Criterion 3: Date/calendar typography consistency", () => {
    it("renders compact date inputs with consistent font sizing and calendar icon styling", () => {
      const txns: ReviewTransaction[] = [
        {
          id: "txn-date",
          sheetRow: 1,
          date: "2024-01-15",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -100000,
          currency: "CNY",
          positionRef: "new",
          status: "actionable",
          selected: true,
          isTransfer: false,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: txns,
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );

      expect(html).toContain('type="date"');
      expect(html).toContain("h-6");
      expect(html).toContain("text-[11px]");
    });

    it("renders read-only plain text for blocked row dates", () => {
      const txns: ReviewTransaction[] = [
        {
          id: "txn-blocked-date",
          sheetRow: 1,
          date: "2024-01-15",
          fromKey: "investor:INV-ZH",
          toKey: "fund:FUND-EN",
          srcKey: null,
          type: "buy",
          subType: "contribution",
          commitDelta: null,
          quantityDelta: null,
          pricePerShare: null,
          cashDelta: -100000,
          currency: "CNY",
          positionRef: "new",
          status: "blocked",
          selected: false,
          isTransfer: false,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: txns,
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );

      expect(html).not.toContain('type="date"');
      expect(html).toContain("2024-01-15");
    });
  });

  describe("Criterion 4: Name hierarchy swap", () => {
    it("renders primary non-English name on top and English name as secondary line when meaningfully different", () => {
      const html = renderToStaticMarkup(
        React.createElement(CounterpartyCell, {
          entityKey: "investor:INV-ZH",
          entityOptions: sampleEntityOptions,
        }),
      );

      expect(html).toContain("北京博远远锦程天使投资基金");
      expect(html).toContain("Beijing Boyuan Angel Fund");
      expect(html).toContain("text-[10px] text-muted-foreground");
    });

    it("does not render duplicate secondary line when English name is absent", () => {
      const html = renderToStaticMarkup(
        React.createElement(CounterpartyCell, {
          entityKey: "investor:INV-ONLY-ZH",
          entityOptions: sampleEntityOptions,
        }),
      );

      expect(html).toContain("厦门恒源远景投资有限公司");
      expect(html).not.toContain("text-[10px] text-muted-foreground");
    });

    it("does not render duplicate secondary line when English name is identical to primary name", () => {
      const html = renderToStaticMarkup(
        React.createElement(CounterpartyCell, {
          entityKey: "fund:FUND-EN",
          entityOptions: sampleEntityOptions,
        }),
      );

      expect(html).toContain("Startech Growth Fund I");
      const count = (html.match(/Startech Growth Fund I/g) || []).length;
      expect(count).toBe(2);
      expect(html).not.toContain("text-[10px] text-muted-foreground");
    });

    it("splits bilingual embedded strings into primary original and secondary English", () => {
      const html = renderToStaticMarkup(
        React.createElement(CounterpartyCell, {
          entityKey: "investor:raw-bilingual",
          entityOptions: [
            {
              key: "investor:raw-bilingual",
              name: "厦门恒源 (Xiamen Hengyuan)",
              englishName: null,
              group: "Investors",
            },
          ],
        }),
      );

      expect(html).toContain("厦门恒源");
      expect(html).toContain("Xiamen Hengyuan");
    });
  });

  describe("Criterion 5: Valuation number formatting via existing numberFormat.ts", () => {
    it("formats numbers with grouping commas and exactly two decimals", () => {
      expect(formatValuationNumber(820770.98)).toBe("820,770.98");
      expect(formatValuationNumber(0)).toBe("0.00");
      expect(formatValuationNumber(1582475)).toBe("1,582,475.00");
      expect(formatValuationNumber(355984.99775)).toBe("355,985.00");
      expect(formatValuationNumber(null)).toBe("—");
      expect(formatValuationNumber(undefined)).toBe("—");
      expect(formatValuationNumber(NaN)).toBe("—");
    });

    it("formats stake percentage with grouping commas, two decimals, and percent suffix", () => {
      expect(formatValuationStake(3.432887)).toBe("3.43%");
      expect(formatValuationStake(0)).toBe("0.00%");
      expect(formatValuationStake(100)).toBe("100.00%");
      expect(formatValuationStake(null)).toBe("—");
      expect(formatValuationStake(undefined)).toBe("—");
    });

    it("parses user numeric input with commas and k/m multipliers via parseCurrencyInput", () => {
      expect(parseCurrencyInput("820,770.98")).toBe(820770.98);
      expect(parseCurrencyInput("1,582,475.00")).toBe(1582475);
      expect(parseCurrencyInput("0.00")).toBe(0);
      expect(parseCurrencyInput("0")).toBe(0);
      expect(parseCurrencyInput("")).toBeNull();
      expect(parseCurrencyInput("   ")).toBeNull();
      expect(parseCurrencyInput("abc")).toBeNull();
      expect(parseCurrencyInput("1.5M")).toBe(1500000);
      expect(parseCurrencyInput("250k")).toBe(250000);
    });

    it("applies commas cleanly to numbers with exact decimals", () => {
      expect(applyCommas((1582475).toFixed(2))).toBe("1,582,475.00");
      expect(applyCommas((0).toFixed(2))).toBe("0.00");
      expect(applyCommas((820770.98).toFixed(2))).toBe("820,770.98");
    });

    it("renders formatted numbers in ValuationNumberInput when not focused", () => {
      const html = renderToStaticMarkup(
        React.createElement(ValuationNumberInput, {
          value: 1582475,
          onChange: () => {},
          ariaLabel: "Market value",
        }),
      );

      expect(html).toContain('value="1,582,475.00"');
    });

    it("renders zero formatted as 0.00 in ValuationNumberInput", () => {
      const html = renderToStaticMarkup(
        React.createElement(ValuationNumberInput, {
          value: 0,
          onChange: () => {},
          ariaLabel: "Market value",
        }),
      );

      expect(html).toContain('value="0.00"');
    });

    it("renders empty string for null in ValuationNumberInput", () => {
      const html = renderToStaticMarkup(
        React.createElement(ValuationNumberInput, {
          value: null,
          onChange: () => {},
          ariaLabel: "Market value",
        }),
      );

      expect(html).toContain('value=""');
    });
  });

  describe("Criterion 9: Step 2 footer duplicate ledger rows wording", () => {
    it("renders 'No duplicate ledger rows found · all valid rows staged for approval' when duplicateRowsCount is 0", () => {
      const html = renderToStaticMarkup(
        React.createElement(StepFooter, {
          step: 2,
          stagedNewEntitiesCount: 1,
          totalNewEntitiesCount: 1,
          selectedTxnsCount: 5,
          selectedValsCount: 0,
          duplicateRowsCount: 0,
          approving: false,
          onNextStep: () => {},
          onPrevStep: () => {},
          onApprove: () => {},
          onCancel: () => {},
        }),
      );

      expect(html).toContain("No duplicate ledger rows found · all valid rows staged for approval");
      expect(html).not.toContain("No duplicates found · all valid rows staged for approval");
    });

    it("renders duplicate rows count when duplicateRowsCount > 0", () => {
      const html = renderToStaticMarkup(
        React.createElement(StepFooter, {
          step: 2,
          stagedNewEntitiesCount: 1,
          totalNewEntitiesCount: 1,
          selectedTxnsCount: 5,
          selectedValsCount: 0,
          duplicateRowsCount: 3,
          approving: false,
          onNextStep: () => {},
          onPrevStep: () => {},
          onApprove: () => {},
          onCancel: () => {},
        }),
      );

      expect(html).toContain("3 rows already imported and will be skipped");
    });
  });

  describe("Criterion 10: formatApprovalFeedback truthful feedback reporting", () => {
    function makeApplyResult(overrides: Partial<FundUpdateApplyResult>): FundUpdateApplyResult {
      return {
        applied: 0,
        created_assets: 0,
        updated_assets: 0,
        skipped: 0,
        txns_inserted: 0,
        valuations_upserted: 0,
        created_funds: 0,
        created_investors: 0,
        created_sources: 0,
        ...overrides,
      };
    }

    it("returns success with posted counts when all rows post successfully", () => {
      const result = makeApplyResult({
        applied: 1,
        txns_inserted: 3,
        valuations_upserted: 0,
        outcomes: [
          { submittedId: "t1", family: "transaction", disposition: "posted", reason: null },
          { submittedId: "t2", family: "transaction", disposition: "posted", reason: null },
          { submittedId: "t3", family: "transaction", disposition: "posted", reason: null },
        ],
      });

      const feedback = formatApprovalFeedback(result);
      expect(feedback.type).toBe("success");
      expect(feedback.message).toContain("Applied 1 assets (+3 txns, +0 vals)");
      expect(feedback.warningDetail).toBeUndefined();
    });

    it("leads with posting differences and counts the ones review already flagged, without failing the approval", () => {
      const reviewDifference = {
        fund: "Fund D",
        metric: "commitment" as const,
        kind: "review" as const,
        ledgerValue: 75,
        rowsValue: 75,
        catalogValue: 84,
        diff: -9,
      };
      const result = makeApplyResult({
        commitment_events_inserted: 4,
        outcomes: [
          { submittedId: "c1", family: "commitment_event", disposition: "posted", reason: null },
        ],
        catalog_check: {
          checked_funds: 3,
          differences: [reviewDifference],
          skipped_funds: ["Fund E"],
          missing_funds: [],
          warnings: ["Fund A: ledger paid-in CNY 76 vs rows CNY 47 (diff +29).", "Fund B: second", "Fund C: third"],
          notes: ["Fund D: review note", "Fund E: not checked"],
        },
      });

      const feedback = formatApprovalFeedback(result);
      expect(feedback.type).toBe("success");
      expect(feedback.warningDetail).toBe(
        "3 posting differences in the written ledger: Fund A: ledger paid-in CNY 76 vs rows CNY 47 (diff +29). · Fund B: second (+1 more)" +
          " · 1 difference against 基金汇总 already flagged in review · 1 fund not checked (partial import)",
      );
    });

    it("adds nothing when the post-import catalog check found no differences", () => {
      const result = makeApplyResult({
        commitment_events_inserted: 1,
        outcomes: [
          { submittedId: "c1", family: "commitment_event", disposition: "posted", reason: null },
        ],
        catalog_check: {
          checked_funds: 3,
          differences: [],
          skipped_funds: [],
          missing_funds: [],
          warnings: [],
          notes: [],
        },
      });

      expect(formatApprovalFeedback(result).warningDetail).toBeUndefined();
    });

    it("returns success with warning detail when partial rows are skipped", () => {
      const result = makeApplyResult({
        applied: 1,
        txns_inserted: 2,
        valuations_upserted: 0,
        outcomes: [
          { submittedId: "t1", family: "transaction", disposition: "posted", reason: null },
          { submittedId: "t2", family: "transaction", disposition: "duplicate", reason: "Already exists in fl_ledger_entries" },
          { submittedId: "t3", family: "transaction", disposition: "posted", reason: null },
        ],
      });

      const feedback = formatApprovalFeedback(result);
      expect(feedback.type).toBe("success");
      expect(feedback.message).toContain("Applied 1 assets (+2 txns, +0 vals)");
      expect(feedback.warningDetail).toContain("1 row skipped (1 duplicate)");
      expect(feedback.warningDetail).toContain("Already exists in fl_ledger_entries");
    });

    it("returns warning and explains skips when zero rows are posted (all duplicates)", () => {
      const result = makeApplyResult({
        applied: 0,
        txns_inserted: 0,
        valuations_upserted: 0,
        outcomes: [
          { submittedId: "t1", family: "transaction", disposition: "duplicate", reason: "Already exists in fl_ledger_entries" },
          { submittedId: "t2", family: "transaction", disposition: "duplicate", reason: "Already exists in fl_ledger_entries" },
        ],
      });

      const feedback = formatApprovalFeedback(result);
      expect(feedback.type).toBe("warning");
      expect(feedback.message).toBe("No new rows posted: all 2 rows were skipped (2 duplicates)");
      expect(feedback.warningDetail).toBe("Already exists in fl_ledger_entries");
    });

    it("returns warning breaking down duplicate, stale, and rejected when zero rows are posted", () => {
      const result = makeApplyResult({
        applied: 0,
        txns_inserted: 0,
        valuations_upserted: 0,
        outcomes: [
          { submittedId: "t1", family: "transaction", disposition: "duplicate", reason: "Replay duplicate" },
          { submittedId: "v1", family: "valuation", disposition: "stale", reason: "Valuation row has no market value or amount" },
          { submittedId: "c1", family: "commitment_event", disposition: "rejected", reason: "Catalog mismatch" },
        ],
      });

      const feedback = formatApprovalFeedback(result);
      expect(feedback.type).toBe("warning");
      expect(feedback.message).toBe("No new rows posted: all 3 rows were skipped (1 duplicate, 1 unsupported/stale, 1 rejected)");
      expect(feedback.warningDetail).toContain("Replay duplicate");
      expect(feedback.warningDetail).toContain("Valuation row has no market value or amount");
    });

    it("handles legacy results without outcomes by falling back to inserted counts and commitment warnings", () => {
      const legacyResult = makeApplyResult({
        applied: 1,
        txns_inserted: 1,
        valuations_upserted: 0,
        commitment_events_inserted: 1,
        commitment_events_skipped: 2,
        commitment_event_warnings: ["Commitment event row 2 skipped: unknown investor"],
      });

      const feedback = formatApprovalFeedback(legacyResult);
      expect(feedback.type).toBe("success");
      expect(feedback.message).toContain("Applied 1 assets (+1 txns, +0 vals)");
      expect(feedback.message).toContain("1 commitment events posted");
      expect(feedback.warningDetail).toBe("2 commitment rows were not posted: Commitment event row 2 skipped: unknown investor");
    });
  });

  describe("D3: sell proceeds destination on cash column", () => {
    const baseSellTxn: ReviewTransaction = {
      id: "txn-sell-1",
      sheetRow: 1,
      date: "2024-06-01",
      fromKey: "asset:AST",
      toKey: "investor:INV-ZH",
      srcKey: null,
      type: "sell",
      subType: "divestment",
      commitDelta: null,
      quantityDelta: -10,
      pricePerShare: 100,
      cashDelta: 50000,
      currency: "USD",
      amount: 50000,
      positionRef: "new",
      status: "actionable",
      selected: true,
      isTransfer: false,
    };

    it("renders +cash and a stated destination badge (read-only)", () => {
      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              ...baseSellTxn,
              sellProceedsDestination: "cash_in_fund",
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
          readOnly: true,
        }),
      );

      expect(html).toContain("+$50K");
      expect(html).toContain("Cash in fund");
      expect(html).not.toContain("not stated");
      // Cash Δ must remain a positive signed amount (never a posted 0.00).
      expect(html).toMatch(/\+\$50K/);
    });

    it("does not render a proceeds destination for an ineligible sale", () => {
      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              ...baseSellTxn,
              id: "txn-sell-inferred",
              sellProceedsDestination: null,
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
          readOnly: true,
        }),
      );

      expect(html).toContain("+$50K");
      expect(html).not.toContain("Cash in fund");
      expect(html).not.toContain("proceeds-destination-txn-sell-inferred");
    });

    it("exposes the normalized cash-in-fund default in an editable select", () => {
      const updates: Array<{ id: string; patch: Partial<ReviewTransaction> }> = [];
      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              ...baseSellTxn,
              id: "txn-sell-edit",
              sellProceedsDestination: "cash_in_fund",
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: (id: string, patch: Partial<ReviewTransaction>) => {
            updates.push({ id, patch });
          },
        }),
      );

      // Editable path uses a select trigger (option labels render in a portal, not static HTML).
      expect(html).toContain("proceeds-destination-select-txn-sell-edit");
      expect(html).toContain("+$50K");
      expect(html).toContain("Cash in fund");

      // Simulate the same update the Select onValueChange handler performs.
      updates.push({
        id: "txn-sell-edit",
        patch: { sellProceedsDestination: "cash_in_fund" },
      });
      expect(updates[0].patch.sellProceedsDestination).toBe("cash_in_fund");

      const afterEdit = buildApprovePayload({
        entities: [],
        transactions: [
          {
            ...baseSellTxn,
            id: "txn-sell-edit",
            status: "actionable",
            selected: true,
            ...updates[0].patch,
          },
        ],
        valuations: [],
      });
      expect(afterEdit.two_step_approval.transactions[0].edits?.sellProceedsDestination).toBe(
        "cash_in_fund",
      );
    });

    it("renders cash amount and proceeds destination inline on one non-wrapping line with compact vertical alignment", () => {
      // DOM assertions verify structural tokens and classes without claiming DOM tests prove visual rendering.
      const readOnlyHtml = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              ...baseSellTxn,
              id: "txn-sell-ro-layout",
              sellProceedsDestination: "cash_in_fund",
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
          readOnly: true,
        }),
      );

      // Must use horizontal inline-flex items-center layout, NOT stacked flex-col
      expect(readOnlyHtml).toContain("inline-flex items-center justify-end gap-1.5 whitespace-nowrap");
      expect(readOnlyHtml).not.toContain("inline-flex flex-col");
      expect(readOnlyHtml).toContain("whitespace-nowrap shrink-0");

      const editableHtml = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              ...baseSellTxn,
              id: "txn-sell-edit-layout",
              sellProceedsDestination: "cash_in_fund",
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
          readOnly: false,
        }),
      );

      expect(editableHtml).toContain("inline-flex items-center justify-end gap-1.5 whitespace-nowrap");
      expect(editableHtml).not.toContain("inline-flex flex-col");
      // The trigger keeps its compact sizing and an opaque surface.
      expect(editableHtml).toContain("h-6 w-[148px] bg-card text-[10px] font-sans py-0 px-2 shrink-0");
    });
  });

  describe("MB-569: non-blocking review note", () => {
    it("shows a review note in the reason column of a selectable row", () => {
      const note = "Recorded from 淮安熙和创业投资基金合伙企业（有限合伙）'s paid-in rows; this row posts no ledger entry.";
      const html = renderToStaticMarkup(
        React.createElement(TransactionsTable, {
          transactions: [
            {
              id: "txn:NJ-yue-hua:0:2024-09-09:contribution",
              sheetRow: 1,
              date: "2024-09-09",
              fromKey: "fund:FUND-EN",
              toKey: "fund:FUND-EN",
              srcKey: null,
              type: "buy",
              subType: "Initial Investment",
              commitDelta: null,
              quantityDelta: null,
              pricePerShare: null,
              cashDelta: -29000000,
              currency: "CNY",
              positionRef: "new",
              status: "actionable",
              blockReason: null,
              reviewNote: note,
              selected: true,
              isTransfer: false,
            },
          ],
          entityOptions: sampleEntityOptions,
          sourceOptions: [],
          onToggleSelect: () => {},
          onUpdateTxn: () => {},
        }),
      );
      expect(html).toContain("淮安熙和创业投资基金合伙企业（有限合伙）&#x27;s paid-in rows");
      expect(html).not.toContain(">blocked<");
    });
  });
});
