import { describe, expect, it } from "vitest";
import {
  reviewRowIsExpandable,
  applyTransactionUpdate,
  recomputeTransactionsAndValuations,
  validateTransactionStatus,
} from "./validation";
import type { ReviewEntity, ReviewTransaction, ReviewValuation } from "./types";

function createSampleEntities(): Map<string, ReviewEntity> {
  const map = new Map<string, ReviewEntity>();

  map.set("investor:Valid LP", {
    key: "investor:Valid LP",
    tab: "investor",
    code: "LP01",
    name: "Valid LP",
    status: "matched",
    matchedId: "inv-1",
    txnsCount: 1,
    valsCount: 0,
    fields: [],
    links: [],
    isStaged: true,
  });

  map.set("investor:New Staged LP", {
    key: "investor:New Staged LP",
    tab: "investor",
    code: "LP02",
    name: "New Staged LP",
    status: "new",
    matchedId: null,
    txnsCount: 1,
    valsCount: 0,
    fields: [],
    links: [],
    isStaged: true,
  });

  map.set("investor:New Unstaged LP", {
    key: "investor:New Unstaged LP",
    tab: "investor",
    code: "LP03",
    name: "New Unstaged LP",
    status: "new",
    matchedId: null,
    txnsCount: 1,
    valsCount: 0,
    fields: [],
    links: [],
    isStaged: false,
  });

  map.set("fund:Growth Fund I", {
    key: "fund:Growth Fund I",
    tab: "fund",
    code: "GF01",
    name: "Growth Fund I",
    status: "matched",
    matchedId: "fund-1",
    txnsCount: 2,
    valsCount: 1,
    fields: [],
    links: [],
    isStaged: true,
  });

  map.set("asset:AST-01", {
    key: "asset:AST-01",
    tab: "asset",
    code: "AST-01",
    name: "Asset Alpha",
    status: "new",
    matchedId: null,
    txnsCount: 1,
    valsCount: 1,
    fields: [],
    links: [],
    isStaged: true,
  });

  map.set("asset:AST-02-UNSTAGED", {
    key: "asset:AST-02-UNSTAGED",
    tab: "asset",
    code: "AST-02",
    name: "Asset Beta",
    status: "new",
    matchedId: null,
    txnsCount: 1,
    valsCount: 1,
    fields: [],
    links: [],
    isStaged: false,
  });

  return map;
}

describe("MB-513 Live Blocked-Row Resolution & Validation Engine", () => {
  it("valid non-cash resolution unblocks and auto-selects row", () => {
    const entityMap = createSampleEntities();

    const initialBlockedTxn: ReviewTransaction = {
      id: "review-item:5",
      sheetRow: 5,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "adjustment",
      subType: "损益核销",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 500000,
      currency: "CNY",
      positionRef: null,
      status: "blocked",
      blockReason: "Non-cash adjustment requires review resolution",
      selected: false,
      isTransfer: false,
      isNonCashAdjustment: true,
      nonCashState: {
        enabled: false,
        investorName: "",
        direction: "reduction",
        subType: "",
      },
    };

    // 1. Initial state is blocked
    const initValidation = validateTransactionStatus(initialBlockedTxn, entityMap);
    expect(initValidation.status).toBe("blocked");
    expect(initValidation.isResolved).toBe(false);

    // 2. User resolves non-cash adjustment with valid investor, direction, and subtype
    const resolvedTxn = applyTransactionUpdate(
      initialBlockedTxn,
      {
        nonCashState: {
          enabled: true,
          investorName: "Valid LP",
          direction: "reduction",
          subType: "profit_loss_writeoff",
        },
      },
      entityMap,
    );

    // Should transition to actionable, auto-select, and mark resolved
    expect(resolvedTxn.status).toBe("actionable");
    expect(resolvedTxn.blockReason).toBeNull();
    expect(resolvedTxn.selected).toBe(true);
    expect(resolvedTxn.isResolved).toBe(true);
  });

  it("does not accept parser-prefilled non-cash values until the user edits the resolution", () => {
    const entityMap = createSampleEntities();
    const txn: ReviewTransaction = {
      id: "review-item:prefilled",
      sheetRow: 8,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "adjustment",
      subType: "损益核销",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 500000,
      currency: "CNY",
      positionRef: null,
      status: "blocked",
      selected: false,
      isTransfer: false,
      isNonCashAdjustment: true,
      nonCashState: {
        enabled: false,
        investorName: "Valid LP",
        direction: "reduction",
        subType: "profit_loss_writeoff",
      },
    };

    expect(validateTransactionStatus(txn, entityMap)).toMatchObject({
      status: "blocked",
      isResolved: false,
    });
  });

  it("invalid non-cash resolution remains blocked and deselected", () => {
    const entityMap = createSampleEntities();

    const blockedTxn: ReviewTransaction = {
      id: "review-item:6",
      sheetRow: 6,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "adjustment",
      subType: "损益核销",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 300000,
      currency: "CNY",
      positionRef: null,
      status: "blocked",
      blockReason: "Needs review",
      selected: false,
      isTransfer: false,
      isNonCashAdjustment: true,
      nonCashState: {
        enabled: true,
        investorName: "   ", // Blank investor
        direction: "reduction",
        subType: "profit_loss_writeoff",
      },
    };

    const result = applyTransactionUpdate(blockedTxn, {}, entityMap);
    expect(result.status).toBe("blocked");
    expect(result.selected).toBe(false);
    expect(result.blockReason).toContain("Non-cash adjustment requires a valid investor");
  });

  it("valid single transfer resolves, unblocks, and auto-selects", () => {
    const entityMap = createSampleEntities();

    const initialTransfer: ReviewTransaction = {
      id: "review-item:10",
      sheetRow: 10,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "investor:New Staged LP",
      srcKey: null,
      type: "commitment_transfer",
      subType: "Commitment transfer",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 1000000,
      currency: "CNY",
      positionRef: null,
      status: "blocked",
      blockReason: "Transfer requires review resolution",
      selected: false,
      isTransfer: true,
      isMultiPartyTransfer: false,
      singleTransferState: {
        enabled: false,
        transferorName: "", // Empty transferor initially
      },
    };

    // Initial state blocked
    expect(validateTransactionStatus(initialTransfer, entityMap).status).toBe("blocked");

    // Edit with valid counterparty name
    const resolved = applyTransactionUpdate(
      initialTransfer,
      {
        singleTransferState: {
          enabled: true,
          transferorName: "Nanjing Master Holding Co Ltd",
        },
      },
      entityMap,
    );

    expect(resolved.status).toBe("actionable");
    expect(resolved.selected).toBe(true);
    expect(resolved.blockReason).toBeNull();
    expect(resolved.isResolved).toBe(true);
  });

  it("keeps a deterministically paired commitment transfer actionable without manual resolution", () => {
    const entityMap = createSampleEntities();
    const txn: ReviewTransaction = {
      id: "transfer:94",
      sheetRow: 94,
      date: "2023-02-07",
      fromKey: "investor:Valid LP",
      toKey: "investor:New Staged LP",
      srcKey: null,
      type: "commitment_transfer",
      subType: "commitment_transfer",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 6000,
      currency: "CNY",
      positionRef: null,
      status: "actionable",
      selected: true,
      isTransfer: true,
      isMultiPartyTransfer: false,
      rawCommitmentEvent: {
        fund: "Growth Fund I",
        investorName: "New Staged LP",
        investorTypeRaw: "机构投资人",
        investorTypeLabel: "Institutional Investor",
        date: "2023-02-07",
        intent: "transfer_in",
        amount: 6000,
        currency: "CNY",
        counterpartyName: "Valid LP",
        actionRaw: "认缴",
        natureRaw: "受让额度",
        directionRaw: "认缴额度增加",
        notes: null,
        sourceRow: 94,
        transferPairing: {
          status: "paired",
          transferorName: "Valid LP",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      },
    };

    expect(validateTransactionStatus(txn, entityMap)).toMatchObject({
      status: "actionable",
      isResolved: false,
    });
  });

  it("invalid and mismatched multi-party allocations remain blocked", () => {
    const entityMap = createSampleEntities();

    const multiTransfer: ReviewTransaction = {
      id: "review-item:12",
      sheetRow: 12,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "investor:New Staged LP",
      srcKey: null,
      type: "commitment_transfer",
      subType: "Commitment transfer",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 1000000,
      currency: "CNY",
      positionRef: null,
      status: "blocked",
      blockReason: "Multi-party transfer requires resolution",
      selected: false,
      isTransfer: true,
      isMultiPartyTransfer: true,
      allocations: [
        { id: "alloc-1", transferorName: "LP A", amount: 400000 },
        { id: "alloc-2", transferorName: "LP B", amount: 400000 }, // Sum 800k vs expected 1M
      ],
    };

    // Mismatched sum (800k != 1M) -> blocked
    const mismatched = applyTransactionUpdate(multiTransfer, {}, entityMap);
    expect(mismatched.status).toBe("blocked");
    expect(mismatched.selected).toBe(false);
    expect(mismatched.blockReason).toContain("does not match expected amount");

    // Invalid counterparty delimiter in one allocation -> blocked
    const invalidCounterparty = applyTransactionUpdate(
      multiTransfer,
      {
        allocations: [
          { id: "alloc-1", transferorName: "LP A、LP C", amount: 500000 }, // Punctuation delimiter
          { id: "alloc-2", transferorName: "LP B", amount: 500000 },
        ],
      },
      entityMap,
    );
    expect(invalidCounterparty.status).toBe("blocked");
    expect(invalidCounterparty.selected).toBe(false);

    // Negative / zero amount in allocation -> blocked
    const zeroAmount = applyTransactionUpdate(
      multiTransfer,
      {
        allocations: [
          { id: "alloc-1", transferorName: "LP A", amount: 0 },
          { id: "alloc-2", transferorName: "LP B", amount: 1000000 },
        ],
      },
      entityMap,
    );
    expect(zeroAmount.status).toBe("blocked");

    // Valid allocation: valid names, positive amounts, exact sum -> actionable
    const validAllocations = applyTransactionUpdate(
      multiTransfer,
      {
        allocations: [
          { id: "alloc-1", transferorName: "LP A", amount: 600000 },
          { id: "alloc-2", transferorName: "LP B", amount: 400000 },
        ],
      },
      entityMap,
    );
    expect(validAllocations.status).toBe("actionable");
    expect(validAllocations.selected).toBe(true);
    expect(validAllocations.blockReason).toBeNull();
    expect(validAllocations.isResolved).toBe(true);
  });

  it("missing or unstaged From or To entity still blocks even with valid resolution fields", () => {
    const entityMap = createSampleEntities();

    // From is an unstaged new entity
    const txnWithUnstagedFrom: ReviewTransaction = {
      id: "txn:unstaged-1",
      sheetRow: 20,
      date: "2023-01-15",
      fromKey: "investor:New Unstaged LP", // isStaged is false
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "buy",
      subType: "contribution",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: -10000,
      amount: 10000,
      currency: "CNY",
      positionRef: null,
      status: "actionable",
      blockReason: null,
      selected: true,
      isTransfer: false,
    };

    const validated = applyTransactionUpdate(txnWithUnstagedFrom, {}, entityMap);
    expect(validated.status).toBe("blocked");
    expect(validated.selected).toBe(false);
    expect(validated.blockReason).toContain("is not being added in Step 1");
  });

  it("resolved row becomes blocked and deselected when invalidated", () => {
    const entityMap = createSampleEntities();

    // Start with actionable resolved non-cash adjustment
    const actionableTxn: ReviewTransaction = {
      id: "review-item:7",
      sheetRow: 7,
      date: "2023-06-30",
      fromKey: "investor:Valid LP",
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "adjustment",
      subType: "损益核销",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: 0,
      amount: 200000,
      currency: "CNY",
      positionRef: null,
      status: "actionable",
      blockReason: null,
      selected: true,
      isTransfer: false,
      isNonCashAdjustment: true,
      isResolved: true,
      nonCashState: {
        enabled: true,
        investorName: "Valid LP",
        direction: "reduction",
        subType: "profit_loss_writeoff",
      },
    };

    // User clears investorName -> becomes blocked and deselected
    const invalidated = applyTransactionUpdate(
      actionableTxn,
      {
        nonCashState: {
          enabled: true,
          investorName: "", // Cleared!
          direction: "reduction",
          subType: "profit_loss_writeoff",
        },
      },
      entityMap,
    );

    expect(invalidated.status).toBe("blocked");
    expect(invalidated.selected).toBe(false);
    expect(invalidated.blockReason).toContain("Non-cash adjustment requires a valid investor");
  });

  it("manual deselection is preserved after row is actionable", () => {
    const entityMap = createSampleEntities();

    // Row is already actionable, but user manually unchecks it
    const manuallyDeselectedTxn: ReviewTransaction = {
      id: "txn:normal-1",
      sheetRow: 30,
      date: "2023-01-15",
      fromKey: "investor:Valid LP",
      toKey: "fund:Growth Fund I",
      srcKey: null,
      type: "paid_in",
      subType: "capital_call",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: -50000,
      amount: 50000,
      currency: "CNY",
      positionRef: null,
      status: "actionable",
      blockReason: null,
      selected: false, // User manually deselected!
      isTransfer: false,
    };

    // User edits the date on this row
    const updatedDate = applyTransactionUpdate(
      manuallyDeselectedTxn,
      { date: "2023-01-20" },
      entityMap,
    );

    expect(updatedDate.status).toBe("actionable");
    expect(updatedDate.date).toBe("2023-01-20");
    // Manual deselection must be preserved!
    expect(updatedDate.selected).toBe(false);
  });

  it("recomputeTransactionsAndValuations validates valuations against staged targets", () => {
    const entityMap = createSampleEntities();

    const vals: ReviewValuation[] = [
      {
        id: "val-1",
        sheetRow: 1,
        assetCode: "AST-01",
        assetName: "Asset Alpha",
        asOfDate: "2023-03-31",
        periodLabel: "2023 Q1",
        marketValue: 1000000,
        pricePerShare: 10,
        sharesOutstanding: 100000,
        shareholdingPct: 10,
        valuationMethod: "at_cost",
        currency: "USD",
        status: "actionable",
        selected: true,
        originalKey: "AST-01|2023-03-31",
      },
      {
        id: "val-2",
        sheetRow: 2,
        assetCode: "AST-02-UNSTAGED",
        assetName: "Asset Beta",
        asOfDate: "2023-03-31",
        periodLabel: "2023 Q1",
        marketValue: 500000,
        pricePerShare: 5,
        sharesOutstanding: 100000,
        shareholdingPct: 5,
        valuationMethod: "at_cost",
        currency: "USD",
        status: "actionable",
        selected: true,
        originalKey: "AST-02|2023-03-31",
      },
    ];

    const { valuations: recomputed } = recomputeTransactionsAndValuations([], vals, entityMap);

    // Val 1 target is staged -> actionable & selected
    expect(recomputed[0].status).toBe("actionable");
    expect(recomputed[0].selected).toBe(true);

    // Val 2 target is unstaged -> blocked & deselected
    expect(recomputed[1].status).toBe("blocked");
    expect(recomputed[1].selected).toBe(false);
    expect(recomputed[1].blockReason).toContain("is not being added in Step 1");
  });

  it("initial hydration: missing holder (holderKey = '') remains blocked and deselected", () => {
    const entityMap = createSampleEntities();

    const missingHolderVal: ReviewValuation = {
      id: "val-missing-holder",
      sheetRow: 1,
      targetKey: "asset:AST-01",
      holderKey: "",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "blocked",
      blockReason:
        'Valuation for "Asset Alpha" as of 2023-03-31 requires a holder; missing holder cannot become an instrument-wide mark.',
      selected: false,
      originalKey: "AST-01|2023-03-31",
    };

    const { valuations: recomputed } = recomputeTransactionsAndValuations(
      [],
      [missingHolderVal],
      entityMap,
    );

    // Target AST-01 is staged, but holderKey is empty: must remain blocked & unselected
    expect(recomputed[0].status).toBe("blocked");
    expect(recomputed[0].selected).toBe(false);
    expect(recomputed[0].blockReason).toContain("requires a holder");
  });

  it("holder deselected and restaged: blocks on deselection and resolves to actionable & selected on restage", () => {
    const entityMap = createSampleEntities();

    // investor:New Staged LP is staged initially
    const valWithHolder: ReviewValuation = {
      id: "val-with-holder",
      sheetRow: 1,
      targetKey: "asset:AST-01",
      holderKey: "investor:New Staged LP",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "actionable",
      selected: true,
      originalKey: "AST-01|2023-03-31",
    };

    // 1. Initial state: both target and holder staged -> actionable & selected
    const { valuations: initial } = recomputeTransactionsAndValuations(
      [],
      [valWithHolder],
      entityMap,
    );
    expect(initial[0].status).toBe("actionable");
    expect(initial[0].selected).toBe(true);

    // 2. User deselects holder in Step 1:
    const deselectedMap = new Map(entityMap);
    const deselectedHolder = { ...deselectedMap.get("investor:New Staged LP")!, isStaged: false };
    deselectedMap.set("investor:New Staged LP", deselectedHolder);

    const { valuations: afterDeselect } = recomputeTransactionsAndValuations(
      [],
      initial,
      deselectedMap,
    );
    expect(afterDeselect[0].status).toBe("blocked");
    expect(afterDeselect[0].selected).toBe(false);
    expect(afterDeselect[0].blockReason).toContain("is not being added in Step 1");

    // 3. User restages holder in Step 1:
    const restagedMap = new Map(entityMap);
    const restagedHolder = { ...restagedMap.get("investor:New Staged LP")!, isStaged: true };
    restagedMap.set("investor:New Staged LP", restagedHolder);

    const { valuations: afterRestage } = recomputeTransactionsAndValuations(
      [],
      afterDeselect,
      restagedMap,
    );
    expect(afterRestage[0].status).toBe("actionable");
    expect(afterRestage[0].selected).toBe(true);
    expect(afterRestage[0].blockReason).toBeNull();
  });

  it("matched holder (status: 'matched') is recognized as staged even if isStaged is not explicitly true", () => {
    const entityMap = createSampleEntities();
    // investor:Valid LP is status: "matched" in createSampleEntities
    const valWithMatchedHolder: ReviewValuation = {
      id: "val-matched-holder",
      sheetRow: 1,
      targetKey: "asset:AST-01",
      holderKey: "investor:Valid LP",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "actionable",
      selected: true,
      originalKey: "AST-01|2023-03-31",
    };

    const { valuations: recomputed } = recomputeTransactionsAndValuations(
      [],
      [valWithMatchedHolder],
      entityMap,
    );

    expect(recomputed[0].status).toBe("actionable");
    expect(recomputed[0].selected).toBe(true);
    expect(recomputed[0].blockReason).toBeNull();
  });

  it("undefined legacy holder: preserves existing contract (evaluates only target staging)", () => {
    const entityMap = createSampleEntities();

    const legacyVal: ReviewValuation = {
      id: "val-legacy",
      sheetRow: 1,
      targetKey: "asset:AST-01",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "actionable",
      selected: true,
      originalKey: "AST-01|2023-03-31",
    };

    // With target staged:
    const { valuations: stagedResult } = recomputeTransactionsAndValuations(
      [],
      [legacyVal],
      entityMap,
    );
    expect(stagedResult[0].status).toBe("actionable");
    expect(stagedResult[0].selected).toBe(true);

    // With target unstaged:
    const legacyValUnstaged: ReviewValuation = {
      ...legacyVal,
      targetKey: "asset:AST-02-UNSTAGED",
      assetCode: "AST-02-UNSTAGED",
    };
    const { valuations: unstagedResult } = recomputeTransactionsAndValuations(
      [],
      [legacyValUnstaged],
      entityMap,
    );
    expect(unstagedResult[0].status).toBe("blocked");
    expect(unstagedResult[0].selected).toBe(false);
    expect(unstagedResult[0].blockReason).toContain("is not being added in Step 1");
  });

  it("preserves duplicate valuations and unrelated block reasons across recomputations", () => {
    const entityMap = createSampleEntities();

    const dupVal: ReviewValuation = {
      id: "val-dup",
      sheetRow: 1,
      targetKey: "asset:AST-01",
      holderKey: "fund:Growth Fund I",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "duplicate",
      selected: false,
      originalKey: "AST-01|2023-03-31",
    };

    const unrelatedBlockedVal: ReviewValuation = {
      id: "val-unrelated-blocked",
      sheetRow: 2,
      targetKey: "asset:AST-01",
      holderKey: "fund:Growth Fund I",
      assetCode: "AST-01",
      assetName: "Asset Alpha",
      asOfDate: "2023-03-31",
      periodLabel: "2023 Q1",
      marketValue: 1000000,
      pricePerShare: 10,
      sharesOutstanding: 100000,
      shareholdingPct: 10,
      valuationMethod: "at_cost",
      currency: "USD",
      status: "blocked",
      blockReason: "Valuation currency conflict for position pos-1: existing mark is USD, incoming is CNY.",
      selected: false,
      originalKey: "AST-01|2023-03-31",
    };

    const { valuations: recomputed } = recomputeTransactionsAndValuations(
      [],
      [dupVal, unrelatedBlockedVal],
      entityMap,
    );

    // Duplicate remains untouched
    expect(recomputed[0].status).toBe("duplicate");
    expect(recomputed[0].selected).toBe(false);

    // Unrelated blocked remains blocked even though target and holder are staged
    expect(recomputed[1].status).toBe("blocked");
    expect(recomputed[1].selected).toBe(false);
    expect(recomputed[1].blockReason).toContain("currency conflict");
  });

  describe("estimated Other rows", () => {
    const estimatedTxn: ReviewTransaction = {
      id: "txn:XTAL:5:2025-08-21:other",
      sheetRow: 30,
      date: "2025-08-21",
      fromKey: "fund:Growth Fund I",
      toKey: "asset:AST-01",
      srcKey: null,
      type: "other",
      subType: "Others",
      subTypeLabel: "Others",
      notes: "Conservative Estimated CIT",
      commitDelta: null,
      quantityDelta: null,
      pricePerShare: null,
      cashDelta: -1034612.69,
      amount: 1034612.69,
      currency: "USD",
      positionRef: null,
      status: "blocked",
      blockReason:
        'Estimated transaction ("Others Conservative Estimated CIT") is a projection/estimate and requires resolution before cash posting',
      selected: false,
      isTransfer: false,
      rawTxn: {
        date: "2025-08-21",
        type: "other",
        subTypeLabel: "Others",
        notes: "Conservative Estimated CIT",
        valueAmount: -1034612.69,
        shareCount: null,
        pricePerShare: null,
        fxRate: null,
        currency: "USD",
      },
    } as unknown as ReviewTransaction;

    it("blocks an estimated row that the reviewer has not reclassified", () => {
      const validation = validateTransactionStatus(estimatedTxn, createSampleEntities());
      expect(validation.status).toBe("blocked");
      expect(validation.blockReason).toMatch(/estimate|projection/i);
    });

    it("stays blocked when only the date or amount is edited", () => {
      const edited = applyTransactionUpdate(
        estimatedTxn,
        { date: "2025-08-22", amount: 1034612.69 },
        createSampleEntities(),
      );
      expect(edited.status).toBe("blocked");
      expect(edited.selected).toBe(false);
    });

    it("unblocks and auto-selects once the reviewer reclassifies it as an expense", () => {
      const resolved = applyTransactionUpdate(estimatedTxn, { type: "expense" }, createSampleEntities());
      expect(resolved.status).toBe("actionable");
      expect(resolved.isResolved).toBe(true);
      expect(resolved.selected).toBe(true);
      expect(resolved.blockReason).toBeNull();
      expect(resolved.cashDelta).toBe(-1034612.69);
    });

    it("re-blocks when the reviewer sets the type back to Other", () => {
      const resolved = applyTransactionUpdate(estimatedTxn, { type: "expense" }, createSampleEntities());
      const reverted = applyTransactionUpdate(resolved, { type: "other" }, createSampleEntities());
      expect(reverted.status).toBe("blocked");
      expect(reverted.selected).toBe(false);
    });
  });
});

describe('reviewRowIsExpandable', () => {
  it('expands transfers and non-cash adjustments', () => {
    expect(reviewRowIsExpandable({ isTransfer: true, isNonCashAdjustment: false })).toBe(true);
    expect(reviewRowIsExpandable({ isTransfer: false, isNonCashAdjustment: true })).toBe(true);
  });

  it('leaves an ordinary row unexpandable, so it shows no affordance', () => {
    expect(reviewRowIsExpandable({ isTransfer: false, isNonCashAdjustment: false })).toBe(false);
    expect(
      reviewRowIsExpandable({ isTransfer: undefined, isNonCashAdjustment: undefined }),
    ).toBe(false);
  });
});
