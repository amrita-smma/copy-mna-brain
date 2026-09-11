import { resolveFundVehiclesEnabled } from "@/lib/features/fundVehicles";
vi.mock("@/lib/features/fundVehicles", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/features/fundVehicles")>(),
  resolveFundVehiclesEnabled: vi.fn().mockResolvedValue(true),
}));
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FundUpdateApplyService,
  existingLedgerEntryTxnKey,
  isPersistableFundUpdateValuation,
  isZeroEffectFundUpdateTxn,
  mapFundUpdateTxn,
  normalizeExistingTxnType,
  toExactDecimalString,
} from "./fundUpdateApplyService";
import { FundUpdateValidationError, IneligibleCashHolderError } from "./flErrors";
import { isUnresolvedDivestmentToken } from "@/lib/fundLedger/proceedsTreatment";
import { isEligibleCashHolder, type CashHolderCandidate } from "@/lib/fundLedger/cashOwnership";
import {
  fundUpdateTxnKey,
  UNATTRIBUTED_ENTITY,
  type ParsedAsset,
  type ParsedCommitmentEvent,
  type ParsedTxn,
  type ParsedValuation,
  type ReviewProposalItem,
} from "@/lib/fund_updates";

function sampleCommitmentEvent(overrides: Partial<ParsedCommitmentEvent> = {}): ParsedCommitmentEvent {
  return {
    fund: "Fund A",
    investorName: "Investor A",
    investorTypeRaw: "机构投资人",
    investorTypeLabel: "Institutional Investor",
    date: "2024-01-15",
    intent: "increase",
    amount: 1000000,
    currency: "CNY",
    counterpartyName: null,
    actionRaw: "认缴",
    natureRaw: "新增额度",
    directionRaw: "认缴额度增加",
    notes: null,
    sourceRow: 3,
    ...overrides,
  };
}

function sampleAsset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: "GOTO",
    name: "GOTO Group",
    legalName: "PT GoTo",
    country: "Indonesia",
    investmentTypeLabel: "Direct Investments",
    assetType: "direct_investment",
    fund: "Others",
    entity: "Asia Star Fund Ltd",
    fundingSource: "DCA",
    fundingSourceRaw: "DCA",
    entryDate: "2021-01-01",
    stakePct: 1,
    commitmentAmount: null,
    dealType: null,
    mgmtFeeRatePct: null,
    sector: "VC",
    subSector: "DI",
    instrument: "Common equity",
    sharesOutstanding: 100,
    sourceRef: "S009",
    vintageYear: 2021,
    valuations: [
      {
        asOfDate: "2026-03-31",
        periodLabel: "Q1 2026",
        marketValue: 100,
        pricePerShare: 1,
        sharesOutstanding: 100,
        shareholdingPct: 1,
        investedCapitalCum: 50,
        grossMoic: 2,
        grossXirr: null,
        valuationMethod: "stock_market_price",
        notes: null,
      },
    ],
    currentPricePerShare: 1,
    txns: [
      {
        date: "2021-01-01",
        type: "contribution",
        subTypeLabel: null,
        pricePerShare: 1,
        shareCount: 50,
        valueAmount: 50,
        currency: "USD",
        fxRate: null,
        notes: null,
      },
    ],
    ...overrides,
  };
}

function sampleTxn(overrides: Partial<ParsedTxn> = {}): ParsedTxn {
  return {
    date: "2023-01-01",
    type: "contribution",
    subTypeLabel: null,
    pricePerShare: 10,
    shareCount: 100,
    valueAmount: 1000,
    currency: "USD",
    fxRate: null,
    notes: null,
    ...overrides,
  };
}

function sampleValuation(overrides: Partial<ParsedValuation> = {}): ParsedValuation {
  return {
    asOfDate: "2023-03-31",
    periodLabel: "Q1 2023",
    marketValue: 1200,
    pricePerShare: 12,
    sharesOutstanding: 100,
    shareholdingPct: null,
    investedCapitalCum: null,
    grossMoic: null,
    grossXirr: null,
    valuationMethod: "at_cost",
    notes: null,
    ...overrides,
  };
}

function sampleReviewItem(overrides: Partial<ReviewProposalItem> = {}): ReviewProposalItem {
  return {
    sourceRow: 5,
    fund: "Startech Growth Fund 1",
    investorName: "Investor B",
    counterpartyRaw: "Unverified",
    date: "2023-03-01",
    amount: 200_000,
    currency: "CNY",
    action: "Commitment transfer",
    nature: "Transfer",
    direction: "Transfer",
    explanation: "Requires review",
    isPostable: false,
    requiresReview: true,
    ...overrides,
  };
}

describe("toExactDecimalString", () => {
  it("formats standard numbers and strings to exact 8-decimal places", () => {
    expect(toExactDecimalString(100)).toBe("100.00000000");
    expect(toExactDecimalString("50.5")).toBe("50.50000000");
    expect(toExactDecimalString(-25)).toBe("-25.00000000");
  });

  it("safely handles small exponent floating-point numbers without precision bugs", () => {
    expect(toExactDecimalString(1e-7)).toBe("0.00000010");
    expect(toExactDecimalString(0.00000001)).toBe("0.00000001");
    expect(toExactDecimalString(5e-6)).toBe("0.00000500");
  });

  it("safely handles large exponent numbers without exponential notation", () => {
    expect(toExactDecimalString(1e8)).toBe("100000000.00000000");
    expect(toExactDecimalString(1.23e4)).toBe("12300.00000000");
  });

  it("rejects non-finite or invalid inputs", () => {
    expect(() => toExactDecimalString(NaN)).toThrow();
    expect(() => toExactDecimalString(Infinity)).toThrow();
    expect(() => toExactDecimalString(null)).toThrow();
  });
});

describe("isPersistableFundUpdateValuation", () => {
  it("requires a market value while accepting zero", () => {
    const valuation = sampleAsset().valuations[0];

    expect(isPersistableFundUpdateValuation(valuation)).toBe(true);
    expect(isPersistableFundUpdateValuation({ ...valuation, marketValue: 0 })).toBe(true);
    expect(isPersistableFundUpdateValuation({ ...valuation, marketValue: null })).toBe(false);
  });
});

describe("isZeroEffectFundUpdateTxn", () => {
  const zeroTxn = {
    date: "2022-07-27",
    type: "other" as const,
    subTypeLabel: "Others",
    pricePerShare: null,
    shareCount: null,
    valueAmount: 0,
    currency: "USD",
    fxRate: null,
    notes: null,
  };

  it("identifies zero-cash placeholder rows without shares", () => {
    expect(isZeroEffectFundUpdateTxn(zeroTxn)).toBe(true);
  });

  it("does not hide share-only transactions", () => {
    expect(isZeroEffectFundUpdateTxn({ ...zeroTxn, shareCount: 10 })).toBe(false);
  });
});

describe("mapFundUpdateTxn", () => {
  const managedFundHolder: CashHolderCandidate = {
    holder_fund_id: "fund-managed-1",
    holderFundManaged: true,
  };
  const unmanagedFundHolder: CashHolderCandidate = {
    holder_fund_id: "fund-unmanaged-1",
    holderFundManaged: false,
  };
  const investorHolder: CashHolderCandidate = {
    holder_investor_id: "inv-1",
    holderFundManaged: false,
  };

  describe("fund position mappings", () => {
    it("maps contribution with null shareCount to paid_in with 0 quantity and negative cash", () => {
      const mapped = mapFundUpdateTxn(
        {
          date: "2024-01-01",
          type: "contribution",
          subTypeLabel: null,
          pricePerShare: null,
          shareCount: null,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "paid_in",
        cashDelta: "-1000.00000000",
        quantityDelta: "0.00000000",
        pricePerUnit: null,
        subType: null,
      });
    });

    it("maps contribution with positive shareCount to paid_in with exact quantity", () => {
      const mapped = mapFundUpdateTxn(
        {
          date: "2024-01-01",
          type: "contribution",
          subTypeLabel: "Initial",
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "paid_in",
        cashDelta: "-1000.00000000",
        quantityDelta: "100.00000000",
        pricePerUnit: "10.00000000",
        subType: "Initial",
      });
    });

    it("maps sell/divestment with positive share count to redemption with negative quantity", () => {
      const mapped = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: 12,
          shareCount: 50,
          valueAmount: 600,
          notes: null,
          fxRate: null,
        },
        "fund",
        unmanagedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "redemption",
        cashDelta: "600.00000000",
        quantityDelta: "-50.00000000",
        pricePerUnit: "12.00000000",
        subType: "divestment",
      });
    });

    it("maps sell/divestment with sellProceedsDestination 'cash_in_fund' to divestment:cash_in_fund sub_type", () => {
      const mappedFundRedemption = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: 12,
          shareCount: 50,
          valueAmount: 600,
          sellProceedsDestination: "cash_in_fund",
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mappedFundRedemption.subType).toBe("divestment:cash_in_fund");

      const mappedFundDistribution = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: null,
          shareCount: null,
          valueAmount: 600,
          sellProceedsDestination: "cash_in_fund",
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mappedFundDistribution.subType).toBe("divestment:cash_in_fund");

      const mappedAssetSell = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          sellProceedsDestination: "cash_in_fund",
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(mappedAssetSell.subType).toBe("divestment:cash_in_fund");
    });

    it("maps sell/divestment with sellProceedsDestination 'distributed_to_investor' to divestment:distributed_to_investor sub_type", () => {
      const mappedFundRedemption = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: 12,
          shareCount: 50,
          valueAmount: 600,
          sellProceedsDestination: "distributed_to_investor",
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mappedFundRedemption.subType).toBe("divestment:distributed_to_investor");

      const mappedFundDistribution = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: null,
          shareCount: null,
          valueAmount: 600,
          sellProceedsDestination: "distributed_to_investor",
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(mappedFundDistribution.subType).toBe("divestment:distributed_to_investor");

      const mappedAssetSell = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          sellProceedsDestination: "distributed_to_investor",
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(mappedAssetSell.subType).toBe("divestment:distributed_to_investor");
    });

    it("throws FundUpdateValidationError when sellProceedsDestination is invalid", () => {
      expect(() =>
        mapFundUpdateTxn(
          {
            date: "2024-02-01",
            type: "sell" as never,
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 600,
            sellProceedsDestination: "invalid_destination" as never,
            notes: null,
            fxRate: null,
          },
          "asset",
          managedFundHolder,
        ),
      ).toThrow(FundUpdateValidationError);
    });

    it("maps cash-only sell/divestment (null or zero shareCount) to distribution", () => {
      const mappedNull = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "divestment",
          subTypeLabel: null,
          pricePerShare: null,
          shareCount: null,
          valueAmount: 600,
          notes: null,
          fxRate: null,
        },
        "fund",
        unmanagedFundHolder,
      );
      expect(mappedNull).toEqual({
        entryType: "distribution",
        cashDelta: "600.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "divestment",
      });

      const mappedZero = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: "Partial Exit",
          pricePerShare: null,
          shareCount: 0,
          valueAmount: 600,
          notes: null,
          fxRate: null,
        },
        "fund",
        unmanagedFundHolder,
      );
      expect(mappedZero).toEqual({
        entryType: "distribution",
        cashDelta: "600.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "Partial Exit",
      });
    });

    it("maps distribution, dividend, interest_income, and return_of_capital to distribution with preserved sub_types", () => {
      const dist = mapFundUpdateTxn(
        { date: "2024-03-01", type: "distribution" as never, subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 200, notes: null, fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(dist).toEqual({
        entryType: "distribution",
        cashDelta: "200.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: null,
      });

      const roc = mapFundUpdateTxn(
        { date: "2024-03-01", type: "return_of_capital", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 150, notes: null, fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(roc).toEqual({
        entryType: "distribution",
        cashDelta: "150.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "return_of_capital",
      });

      const div = mapFundUpdateTxn(
        { date: "2024-03-01", type: "dividend" as never, subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 75, notes: null, fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(div).toEqual({
        entryType: "distribution",
        cashDelta: "75.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "dividend",
      });

      const interest = mapFundUpdateTxn(
        { date: "2024-03-01", type: "interest_income", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 30, notes: null, fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(interest).toEqual({
        entryType: "distribution",
        cashDelta: "30.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "interest_income",
      });
    });

    it("maps management_fee and expense to expense on fund positions", () => {
      const exp = mapFundUpdateTxn(
        { date: "2024-04-01", type: "management_fee" as never, subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 50, notes: null, fxRate: null },
        "fund",
        managedFundHolder,
      );
      expect(exp).toEqual({
        entryType: "expense",
        cashDelta: "-50.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "management_fee",
      });
    });

    it("rejects unexplained positive or negative other on fund positions before posting", () => {
      expect(() =>
        mapFundUpdateTxn(
          { date: "2024-04-01", type: "other", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 80, notes: null, fxRate: null },
          "fund",
          managedFundHolder,
        ),
      ).toThrow(FundUpdateValidationError);

      expect(() =>
        mapFundUpdateTxn(
          { date: "2024-04-01", type: "other", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: -40, notes: null, fxRate: null },
          "fund",
          managedFundHolder,
        ),
      ).toThrow(FundUpdateValidationError);
    });

    it("resolves identified other with expenses to expense and distributions to distribution on fund positions", () => {
      const pos = mapFundUpdateTxn(
        { date: "2024-04-01", type: "other", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 80, notes: "dividend", fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(pos.entryType).toBe("distribution");
      expect(pos.cashDelta).toBe("80.00000000");

      const neg = mapFundUpdateTxn(
        { date: "2024-04-01", type: "other", subTypeLabel: "Others", pricePerShare: null, shareCount: null, valueAmount: -40, notes: "Expenses", fxRate: null },
        "fund",
        unmanagedFundHolder,
      );
      expect(neg.entryType).toBe("expense");
      expect(neg.cashDelta).toBe("-40.00000000");
    });
  });

  describe("asset position mappings", () => {
    it("maps contribution/buy to asset entry buy", () => {
      const mapped = mapFundUpdateTxn(
        { date: "2024-01-01", type: "contribution", subTypeLabel: null, pricePerShare: 1, shareCount: 50, valueAmount: 50, notes: null, fxRate: null },
        "asset",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "buy",
        cashDelta: "-50.00000000",
        quantityDelta: "50.00000000",
        pricePerUnit: "1.00000000",
        subType: null,
      });
    });

    it("maps divestment/sell to asset entry sell", () => {
      const mapped = mapFundUpdateTxn(
        { date: "2024-02-01", type: "divestment", subTypeLabel: null, pricePerShare: 2, shareCount: 25, valueAmount: 50, notes: null, fxRate: null },
        "asset",
        investorHolder,
      );
      expect(mapped).toEqual({
        entryType: "sell",
        cashDelta: "50.00000000",
        quantityDelta: "-25.00000000",
        pricePerUnit: "2.00000000",
        subType: "divestment",
      });
    });

    it("carries a stated proceeds destination into the entry sub_type", () => {
      const mapped = mapFundUpdateTxn(
        { date: "2024-02-01", type: "divestment", subTypeLabel: null, pricePerShare: 2, shareCount: 25, valueAmount: 50, notes: null, fxRate: null, sellProceedsDestination: "cash_in_fund" },
        "asset",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "sell",
        cashDelta: "50.00000000",
        quantityDelta: "-25.00000000",
        pricePerUnit: "2.00000000",
        subType: "divestment:cash_in_fund",
      });
    });

    it("maps return_of_capital, dividend, interest_income to asset entry income", () => {
      const mapped = mapFundUpdateTxn(
        { date: "2024-03-01", type: "return_of_capital", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 20, notes: null, fxRate: null },
        "asset",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "income",
        cashDelta: "20.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "return_of_capital",
      });
    });

    it("maps expense to expense on asset positions", () => {
      const mapped = mapFundUpdateTxn(
        { date: "2024-04-01", type: "expense" as never, subTypeLabel: "Legal Fee", pricePerShare: null, shareCount: null, valueAmount: 15, notes: null, fxRate: null },
        "asset",
        managedFundHolder,
      );
      expect(mapped).toEqual({
        entryType: "expense",
        cashDelta: "-15.00000000",
        quantityDelta: undefined,
        pricePerUnit: null,
        subType: "Legal Fee",
      });
    });
  });

  it("throws FundUpdateValidationError for zero-cash transactions", () => {
    expect(() =>
      mapFundUpdateTxn(
        { date: "2024-01-01", type: "contribution", subTypeLabel: null, pricePerShare: null, shareCount: null, valueAmount: 0, notes: null, fxRate: null },
        "fund",
        managedFundHolder,
      ),
    ).toThrow(FundUpdateValidationError);
  });

  describe("Phase 2 proceeds treatment and cash ownership in mapFundUpdateTxn", () => {
    const managedFundHolder: CashHolderCandidate = {
      holder_fund_id: "fund-managed-1",
      holderFundManaged: true,
    };
    const unmanagedFundHolder: CashHolderCandidate = {
      holder_fund_id: "fund-unmanaged-1",
      holderFundManaged: false,
    };
    const investorHolder: CashHolderCandidate = {
      holder_investor_id: "inv-1",
      holderFundManaged: false,
    };

    it("disambiguates bare 'divestment' literal via isUnresolvedDivestmentToken and does not treat it as a stated treatment", () => {
      expect(isUnresolvedDivestmentToken("divestment")).toBe(true);
      expect(isUnresolvedDivestmentToken("  DIVESTMENT  ")).toBe(true);
      expect(isUnresolvedDivestmentToken("cash_in_fund")).toBe(false);
      expect(isUnresolvedDivestmentToken("distributed_to_investor")).toBe(false);

      // On managed fund, bare "divestment" token is treated as unstated, so it auto-defaults to cash_in_fund
      const managedMapped = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: "divestment",
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(managedMapped.subType).toBe("divestment:cash_in_fund");

      // On investor holder, bare "divestment" token is NOT treated as a stated treatment and produces no proceeds treatment
      const investorMapped = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: "divestment",
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "asset",
        investorHolder,
      );
      expect(investorMapped.subType).toBe("divestment");

      // Bare "divestment" passed via sellProceedsDestination is also unstated and defaults on managed fund
      const destMapped = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 10,
          shareCount: 100,
          valueAmount: 1000,
          sellProceedsDestination: "divestment" as never,
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(destMapped.subType).toBe("divestment:cash_in_fund");
    });

    it("defaults unstated treatment on managed-fund sale to retained (cash_in_fund)", () => {
      // Direct asset sell
      const assetSell = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 20,
          shareCount: 50,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(assetSell.entryType).toBe("sell");
      expect(assetSell.subType).toBe("divestment:cash_in_fund");
      expect(assetSell.cashDelta).toBe("1000.00000000");

      // Fund FoF redemption (positive shares)
      const fofRedemption = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 20,
          shareCount: 50,
          valueAmount: 1000,
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(fofRedemption.entryType).toBe("redemption");
      expect(fofRedemption.subType).toBe("divestment:cash_in_fund");

      // Fund FoF distribution (zero/null shares)
      const fofDistribution = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "distribution" as never,
          subTypeLabel: null,
          pricePerShare: null,
          shareCount: null,
          valueAmount: 500,
          notes: null,
          fxRate: null,
        },
        "fund",
        managedFundHolder,
      );
      expect(fofDistribution.entryType).toBe("distribution");
      expect(fofDistribution.subType).toBe("divestment:cash_in_fund");
    });

    it("preserves explicit document treatment on managed fund sale/redemption", () => {
      const explicitDistributed = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 20,
          shareCount: 50,
          valueAmount: 1000,
          sellProceedsDestination: "distributed_to_investor",
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(explicitDistributed.subType).toBe("divestment:distributed_to_investor");

      const explicitRetained = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: null,
          pricePerShare: 20,
          shareCount: 50,
          valueAmount: 1000,
          sellProceedsDestination: "cash_in_fund",
          notes: null,
          fxRate: null,
        },
        "asset",
        managedFundHolder,
      );
      expect(explicitRetained.subType).toBe("divestment:cash_in_fund");
    });

    it("normalizes away proceeds treatment for investor-held sales while preserving financial amounts", () => {
      const investorSale = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: "divestment:cash_in_fund",
          pricePerShare: 25,
          shareCount: 40,
          valueAmount: 1000,
          sellProceedsDestination: "cash_in_fund",
          notes: "Investor exiting position",
          fxRate: null,
        },
        "asset",
        investorHolder,
      );
      expect(investorSale.subType).toBe("divestment");
      expect(investorSale.cashDelta).toBe("1000.00000000");
      expect(investorSale.quantityDelta).toBe("-40.00000000");
      expect(investorSale.pricePerUnit).toBe("25.00000000");
    });

    it("normalizes away proceeds treatment for unmanaged-fund-held sales while preserving financial amounts", () => {
      const unmanagedSale = mapFundUpdateTxn(
        {
          date: "2024-02-01",
          type: "sell" as never,
          subTypeLabel: "divestment:cash_in_fund",
          pricePerShare: 15,
          shareCount: 100,
          valueAmount: 1500,
          sellProceedsDestination: "cash_in_fund",
          notes: "External vehicle exiting position",
          fxRate: null,
        },
        "asset",
        unmanagedFundHolder,
      );
      expect(unmanagedSale.subType).toBe("divestment");
      expect(unmanagedSale.cashDelta).toBe("1500.00000000");
      expect(unmanagedSale.quantityDelta).toBe("-100.00000000");
      expect(unmanagedSale.pricePerUnit).toBe("15.00000000");
    });
  });
});

describe("normalizeExistingTxnType", () => {
  it("normalizes paid_in and buy to contribution", () => {
    expect(normalizeExistingTxnType({ entry_type: "paid_in", sub_type: null } as never)).toBe("contribution");
    expect(normalizeExistingTxnType({ entry_type: "buy", sub_type: null } as never)).toBe("contribution");
  });

  it("normalizes redemption and sell to divestment", () => {
    expect(normalizeExistingTxnType({ entry_type: "redemption", sub_type: null } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "sell", sub_type: null } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "redemption", sub_type: "divestment:distributed_to_investor" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "sell", sub_type: "divestment:distributed_to_investor" } as never)).toBe("divestment");
  });

  it("normalizes distribution preserving sub_type or defaulting to distribution", () => {
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "divestment" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "divestment:cash_in_fund" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "divestment:distributed_to_investor" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "asset_exit_distribution" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "Partial Exit" } as never)).toBe("divestment");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "return_of_capital" } as never)).toBe("return_of_capital");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "dividend" } as never)).toBe("dividend");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: null } as never)).toBe("distribution");
  });

  it("normalizes income and expense", () => {
    expect(normalizeExistingTxnType({ entry_type: "income", sub_type: "return_of_capital" } as never)).toBe("return_of_capital");
    expect(normalizeExistingTxnType({ entry_type: "income", sub_type: null } as never)).toBe("income");
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: null } as never)).toBe("expense");
  });

  it("normalizes generic other and Others across entry types while preserving named categories", () => {
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: "Others" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: "others" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: "other" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "Others" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "Others:cash_in_fund" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "Others:distributed_to_investor" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "income", sub_type: "Others" } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "other", sub_type: null } as never)).toBe("other");
    expect(normalizeExistingTxnType({ entry_type: "others", sub_type: null } as never)).toBe("other");

    // Preserves named categories without collapsing
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: "management_fee" } as never)).toBe("management_fee");
    expect(normalizeExistingTxnType({ entry_type: "expense", sub_type: "Legal Fee" } as never)).toBe("Legal Fee");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "dividend" } as never)).toBe("dividend");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "return_of_capital" } as never)).toBe("return_of_capital");
    expect(normalizeExistingTxnType({ entry_type: "distribution", sub_type: "interest_income" } as never)).toBe("interest_income");
  });
});

describe("FundUpdateApplyService", () => {
  const mockTxExecutor = { __isTx: true };
  let db: { transaction: ReturnType<typeof vi.fn> };
  let flFundRepo: { findByWorkspaceId: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let flAssetRepo: { findByWorkspaceId: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let flPositionRepo: { findByAssetIds: ReturnType<typeof vi.fn>; findByFundIds: ReturnType<typeof vi.fn>; findByHolderInvestorIds: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  let flInvestorRepo: { findByWorkspaceId: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let flFundingSourceRepo: { findByWorkspaceId: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  let flSourceRecordRepo: { upsertByHash: ReturnType<typeof vi.fn> };
  let flMasterDataService: {
    createFund: ReturnType<typeof vi.fn>;
    createInvestor: ReturnType<typeof vi.fn>;
    createFundingSource: ReturnType<typeof vi.fn>;
    createAsset: ReturnType<typeof vi.fn>;
    getOrCreateFund: ReturnType<typeof vi.fn>;
    getOrCreateInvestor: ReturnType<typeof vi.fn>;
    getOrCreateFundingSource: ReturnType<typeof vi.fn>;
    getOrCreateAsset: ReturnType<typeof vi.fn>;
  };
  let flPositionService: { getOrOpenPosition: ReturnType<typeof vi.fn> };
  let flLedgerService: { postEvent: ReturnType<typeof vi.fn> };
  let flValuationService: { record: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let flValuationRepo: {
    findByWorkspaceId: ReturnType<typeof vi.fn>;
    findSeriesByTarget: ReturnType<typeof vi.fn>;
    findByPositionIdsAndAsOfDates: ReturnType<typeof vi.fn>;
  };
  let flLedgerEntryRepo: { findByPositionIds: ReturnType<typeof vi.fn>; findAllByPositionIds: ReturnType<typeof vi.fn> };
  let service: FundUpdateApplyService;

  beforeEach(() => {
    vi.mocked(resolveFundVehiclesEnabled).mockResolvedValue(true);
    db = {
      transaction: vi.fn(async (cb) => cb(mockTxExecutor)),
    };
    flFundRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([
        { id: "fund-others", name: "Others", managed: true },
        { id: "f1", name: "Startech Growth Fund 1", managed: true },
        { id: "f2", name: "Startech Growth Fund 2", managed: true },
        { id: "f3", name: "Startech Growth Fund 3", managed: true },
        { id: "f4", name: "Startech Growth Fund 4", managed: true },
        { id: "f5", name: "Startech Growth Fund 5", managed: true },
        { id: "m1", name: "Meranti 1", managed: true },
        { id: "m2", name: "Meranti 2", managed: true },
      ]),
      insert: vi.fn().mockImplementation(async ({ name }) => ({ id: `fund-${name}`, name, managed: true })),
      update: vi.fn().mockResolvedValue({}),
      findById: vi.fn().mockImplementation(async (_ws, id) => ({ id, name: `Fund-${id}` })),
    } as never;
    flAssetRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: "asset-new" }),
      update: vi.fn().mockResolvedValue({}),
      findById: vi.fn().mockImplementation(async (_ws, id) => ({ id, name: `Asset-${id}` })),
    };
    flPositionRepo = {
      findByAssetIds: vi.fn().mockResolvedValue([]),
      findByFundIds: vi.fn().mockResolvedValue([]),
      findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: "pos-1" }),
    };
    flInvestorRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockImplementation(async ({ name }) => ({ id: `he-${name}`, name })),
      update: vi.fn().mockResolvedValue({}),
    };
    flFundingSourceRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: "fs-1", name: "DCA" }),
    };
    flSourceRecordRepo = {
      upsertByHash: vi.fn().mockImplementation(async (data) => ({ id: `src-rec-${data.row_number ?? "1"}`, ...data })),
    };
    const createFundFn = vi.fn().mockImplementation(async (_ws, input) => ({ id: `fund-${input.name}`, ...input }));
    const createInvestorFn = vi.fn().mockImplementation(async (_ws, input) => ({ id: `inv-${input.name}`, ...input }));
    const createFundingSourceFn = vi.fn().mockImplementation(async (_ws, input) => ({ id: `fs-${input.name}`, ...input }));
    const createAssetFn = vi.fn().mockImplementation(async (_ws, input) => ({ id: "asset-new", ...input }));
    flMasterDataService = {
      createFund: createFundFn,
      createInvestor: createInvestorFn,
      createFundingSource: createFundingSourceFn,
      createAsset: createAssetFn,
      getOrCreateFund: vi.fn().mockImplementation(async (ws, input, tx) => createFundFn(ws, input, tx)),
      getOrCreateInvestor: vi.fn().mockImplementation(async (ws, input, tx) => createInvestorFn(ws, input, tx)),
      getOrCreateFundingSource: vi.fn().mockImplementation(async (ws, input, tx) => createFundingSourceFn(ws, input, tx)),
      getOrCreateAsset: vi.fn().mockImplementation(async (ws, input, tx) => createAssetFn(ws, input, tx)),
    };
    flPositionService = {
      getOrOpenPosition: vi.fn().mockImplementation(async (_ws, input) => ({
        id: `pos-${input.fund_id ?? input.asset_id ?? "unknown"}-${input.holder_investor_id ?? "fund"}`,
        ...input,
      })),
    };
    flLedgerService = {
      postEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    };
    flValuationService = {
      record: vi.fn().mockResolvedValue({ id: "val-1" }),
      update: vi.fn().mockResolvedValue({ id: "val-1" }),
    };
    flValuationRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findSeriesByTarget: vi.fn().mockResolvedValue([]),
      findByPositionIdsAndAsOfDates: vi.fn().mockResolvedValue([]),
    };
    const findByPositionIdsMock = vi.fn().mockResolvedValue([]);
    const findAllByPositionIdsMock = vi.fn().mockImplementation(async (ws, posIds, exec) => findByPositionIdsMock(ws, posIds, undefined, exec));
    flLedgerEntryRepo = {
      findByPositionIds: findByPositionIdsMock,
      findAllByPositionIds: findAllByPositionIdsMock,
    };

    service = new FundUpdateApplyService(
      db as never,
      "ws-1",
      flFundRepo as never,
      flAssetRepo as never,
      flPositionRepo as never,
      flInvestorRepo as never,
      flFundingSourceRepo as never,
      flMasterDataService as never,
      flPositionService as never,
      flLedgerService as never,
      flValuationService as never,
      flValuationRepo as never,
      flLedgerEntryRepo as never,
      flSourceRecordRepo as never,
    );
  });

  describe("Fund Vehicle View disabled", () => {
    beforeEach(() => vi.mocked(resolveFundVehiclesEnabled).mockResolvedValue(false));

    it("stages a fund-shaped proposal as an asset and preserves ledger entry types", async () => {
      const asset = sampleAsset({ assetType: "fund_of_funds", name: "External target" });
      const full = await service.buildFullReview([asset]);
      expect(full.assets[0].target_kind).toBe("asset");
      expect(full.funds.some((f) => f.name === asset.name)).toBe(false);
      expect(full.two_step_review?.entities.find((e) => e.key === `asset:${asset.code}`)?.tab).toBe("asset");
      const result = await service.applySelected([asset], [asset.code]);
      expect(result.created_assets).toBe(1);
      expect(result.created_funds).toBe(0);
      expect(flMasterDataService.createFund).not.toHaveBeenCalled();
      expect(flMasterDataService.createAsset).toHaveBeenCalledWith("ws-1", expect.objectContaining({
        instrument_terms: expect.objectContaining({ investmentTypeLabel: "Fund of Funds" }),
      }), mockTxExecutor);
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith("ws-1", expect.objectContaining({ asset_id: "asset-new" }), mockTxExecutor);
      expect(flLedgerService.postEvent).toHaveBeenCalledWith("ws-1", expect.objectContaining({
        entries: expect.arrayContaining([expect.objectContaining({ entry_type: "paid_in" })]),
      }), mockTxExecutor);
      expect(flValuationService.record).toHaveBeenCalledWith("ws-1", expect.objectContaining({ position_id: "pos-asset-new-fund" }), mockTxExecutor);
    });

    it("keeps known managed fund targets in the fund table", async () => {
      const asset = sampleAsset({ assetType: "fund_of_funds", name: "Startech Growth Fund 1" });
      const full = await service.buildFullReview([asset]);
      expect(full.assets[0]).toMatchObject({ target_kind: "fund", matched_asset_id: "f1" });
    });

    it("recognizes managed targets declared in the incoming catalog before creation", async () => {
      const asset = sampleAsset({ assetType: "fund_of_funds", name: "New managed vehicle" });
      const full = await service.buildFullReview([asset], undefined, { fundCatalog: [asset.name] });
      expect(full.assets[0].target_kind).toBe("fund");
    });

    it("blocks an existing unmanaged identity before creating an asset twin", async () => {
      const asset = sampleAsset({ assetType: "fund_of_funds", name: "External target" });
      flFundRepo.findByWorkspaceId.mockResolvedValue([{ id: "external", name: asset.name, managed: false }]);
      await expect(service.applySelected([asset], [asset.code])).rejects.toThrow("avoid double-counting");
      expect(flMasterDataService.createAsset).not.toHaveBeenCalled();
      expect(flFundRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("buildReview & buildFullReview", () => {
    it("marks unmatched assets as new", async () => {
      const review = await service.buildReview([sampleAsset()]);
      expect(review).toHaveLength(1);
      expect(review[0].status).toBe("new");
      expect(review[0].missing_txn_count).toBe(1);
      expect(review[0].missing_valuation_count).toBe(1);
    });

    it("marks identical existing assets as unchanged", async () => {
      flAssetRepo.findByWorkspaceId.mockResolvedValue([
        {
          id: "asset-1",
          name: "GOTO Group",
          instrument_terms: { sheetCode: "GOTO", sourceRef: "S009" },
        },
      ]);
      flPositionRepo.findByAssetIds.mockResolvedValue([
        { id: "pos-1", asset_id: "asset-1" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-1",
          entry_date: "2021-01-01",
          entry_type: "buy",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
          currency: "USD",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([
        { asset_id: "asset-1", as_of_date: "2026-03-31" },
      ]);

      const review = await service.buildReview([sampleAsset()]);
      expect(review[0].status).toBe("unchanged");
      expect(review[0].matched_asset_id).toBe("asset-1");
      expect(review[0].missing_txn_count).toBe(0);
      expect(review[0].missing_valuation_count).toBe(0);
    });

    it("matches existing external fund_of_funds on repeat import and marks unchanged", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-1",
        name: "Target Venture Fund",
        assetType: "fund_of_funds",
        valuations: [
          {
            asOfDate: "2026-03-31",
            periodLabel: "Q1 2026",
            marketValue: 100,
            pricePerShare: null,
            sharesOutstanding: null,
            shareholdingPct: null,
            investedCapitalCum: 50,
            grossMoic: 2,
            grossXirr: null,
            valuationMethod: "capital_account_statement",
            notes: null,
          },
        ],
      });

      flFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: "fund-others", name: "Others", managed: true },
        { id: "f1", name: "Startech Growth Fund 1", managed: true },
        { id: "f2", name: "Startech Growth Fund 2", managed: true },
        { id: "f3", name: "Startech Growth Fund 3", managed: true },
        { id: "f4", name: "Startech Growth Fund 4", managed: true },
        { id: "f5", name: "Startech Growth Fund 5", managed: true },
        { id: "m1", name: "Meranti 1", managed: true },
        { id: "m2", name: "Meranti 2", managed: true },
        {
          id: "fof-fund-1",
          name: "Target Venture Fund",
          managed: false,
          ownership_basis: "capital_account",
          registration_no: "FOF-1",
        },
      ]);
      flPositionRepo.findByFundIds.mockResolvedValue([
        { id: "pos-fof-1", fund_id: "fof-fund-1", holder_fund_id: "fund-others" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-fof-1",
          entry_date: "2021-01-01",
          entry_type: "paid_in",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
          currency: "USD",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([
        { fund_id: "fof-fund-1", as_of_date: "2026-03-31" },
      ]);

      const review = await service.buildReview([fofAsset]);
      expect(review).toHaveLength(1);
      expect(review[0].status).toBe("unchanged");
      expect(review[0].matched_asset_id).toBe("fof-fund-1");
      expect(review[0].missing_txn_count).toBe(0);
      expect(review[0].missing_valuation_count).toBe(0);

      // Verify second apply is idempotent
      const result = await service.applySelected([fofAsset], ["FOF-1"]);
      expect(result.skipped).toBe(1);
      expect(result.created_assets).toBe(0);
      expect(result.txns_inserted).toBe(0);
      expect(result.valuations_upserted).toBe(0);
      expect(flMasterDataService.createFund).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "Target Venture Fund" }),
        expect.anything(),
      );
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("prefers the exact owning-fund position over a holderless position when reviewing FoF transactions", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-EXACT-HOLDER",
        name: "Target Venture Fund",
        fund: "Owning Fund",
        assetType: "fund_of_funds",
        valuations: [],
      });

      flFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: "owning-fund", name: "Owning Fund", managed: true },
        {
          id: "target-fund",
          name: "Target Venture Fund",
          managed: false,
          registration_no: "FOF-EXACT-HOLDER",
        },
      ]);
      flPositionRepo.findByFundIds.mockResolvedValue([
        { id: "holderless-pos", fund_id: "target-fund", holder_fund_id: null },
        { id: "exact-pos", fund_id: "target-fund", holder_fund_id: "owning-fund" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "holderless-pos",
          entry_date: "2020-01-01",
          entry_type: "paid_in",
          cash_delta: "-999.00000000",
          quantity_delta: "0.00000000",
          price_per_unit: null,
          currency: "USD",
        },
        {
          position_id: "exact-pos",
          entry_date: "2021-01-01",
          entry_type: "paid_in",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
          currency: "USD",
        },
      ]);

      const review = await service.buildReview([fofAsset]);

      expect(review[0].status).toBe("unchanged");
      expect(review[0].missing_txn_count).toBe(0);
    });

    it("matches existing FoF with paid_in, redemption, and distribution entries on repeat import", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-2",
        name: "Target Venture Fund 2",
        assetType: "fund_of_funds",
        txns: [
          {
            date: "2021-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 100,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2022-01-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: 10,
            shareCount: 5,
            valueAmount: 50,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2023-01-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 25,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2023-06-01",
            type: "return_of_capital",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 15,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
        ],
        valuations: [],
      });

      flFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: "fund-others", name: "Others", managed: true },
        {
          id: "fof-fund-2",
          name: "Target Venture Fund 2",
          managed: false,
          ownership_basis: "capital_account",
          registration_no: "FOF-2",
        },
      ]);
      flPositionRepo.findByFundIds.mockResolvedValue([
        { id: "pos-fof-2", fund_id: "fof-fund-2", holder_fund_id: "fund-others" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-fof-2",
          entry_date: "2021-01-01",
          entry_type: "paid_in",
          cash_delta: "-100.00000000",
          quantity_delta: "0.00000000",
          price_per_unit: null,
          currency: "USD",
          sub_type: null,
        },
        {
          position_id: "pos-fof-2",
          entry_date: "2022-01-01",
          entry_type: "redemption",
          cash_delta: "50.00000000",
          quantity_delta: "-5.00000000",
          price_per_unit: "10.00000000",
          currency: "USD",
          sub_type: null,
        },
        {
          position_id: "pos-fof-2",
          entry_date: "2023-01-01",
          entry_type: "distribution",
          cash_delta: "25.00000000",
          quantity_delta: "0.00000000",
          price_per_unit: null,
          currency: "USD",
          sub_type: "asset_exit_distribution",
        },
        {
          position_id: "pos-fof-2",
          entry_date: "2023-06-01",
          entry_type: "distribution",
          cash_delta: "15.00000000",
          quantity_delta: "0.00000000",
          price_per_unit: null,
          currency: "USD",
          sub_type: "return_of_capital",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

      const review = await service.buildReview([fofAsset]);
      expect(review).toHaveLength(1);
      expect(review[0].status).toBe("unchanged");
      expect(review[0].matched_asset_id).toBe("fof-fund-2");
      expect(review[0].missing_txn_count).toBe(0);

      const result = await service.applySelected([fofAsset], ["FOF-2"]);
      expect(result.skipped).toBe(1);
      expect(result.txns_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("only proposes missing txns/valuations for matched assets", async () => {
      flAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: "asset-1", name: "GOTO Group", instrument_terms: { sheetCode: "GOTO" } },
      ]);
      flPositionRepo.findByAssetIds.mockResolvedValue([
        { id: "pos-1", asset_id: "asset-1" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-1",
          entry_date: "2021-01-01",
          entry_type: "buy",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
          currency: "USD",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

      const review = await service.buildReview([sampleAsset()]);
      expect(review[0].status).toBe("add_missing");
      expect(review[0].missing_txn_count).toBe(0);
      expect(review[0].missing_valuation_count).toBe(1);
    });

    it("surfaces a changed same-date valuation as a correction", async () => {
      flAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: "asset-1", name: "GOTO Group", instrument_terms: { sheetCode: "GOTO" } },
      ]);
      flPositionRepo.findByAssetIds.mockResolvedValue([{ id: "pos-1", asset_id: "asset-1" }]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-1",
          entry_date: "2021-01-01",
          entry_type: "buy",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([
        {
          asset_id: "asset-1",
          as_of_date: "2026-03-31",
          market_value: "99.00000000",
          price_per_unit: "1.00000000",
          units_outstanding: "100.00000000",
          valuation_method: "listed_price",
        },
      ]);

      const review = await service.buildReview([sampleAsset()]);
      expect(review[0].status).toBe("add_missing");
      expect(review[0].missing_valuation_count).toBe(1);
    });

    it("matches catalogs for funds, investors, and sources", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([{ id: "f1", name: "Startech Growth Fund 1", managed: true }]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([{ id: "he1", name: "Asia Star Fund Ltd" }]);
      flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([{ id: "fs1", name: "DCA" }]);

      const full = await service.buildFullReview([sampleAsset()]);
      expect(full.assets[0].matched_investor?.status).toBe("existing");
      expect(full.assets[0].matched_investor?.matched_id).toBe("he1");
      expect(full.assets[0].matched_source?.status).toBe("existing");
      expect(full.assets[0].matched_source?.matched_id).toBe("fs1");
    });

    it("an investor-held row produces a groups entry and no funds entry for the group name", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
      flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);

      const asset = sampleAsset({
        holderKind: "investor",
        group: "Startech Growth Fund 1",
        fund: "Startech Growth Fund 1",
        entity: "Startech Growth Fund VCC",
        holderName: "Startech Growth Fund VCC",
      });

      const full = await service.buildFullReview([asset]);
      expect(full.groups).toBeDefined();
      expect(full.groups?.some((g) => g.name === "Startech Growth Fund 1")).toBe(true);
      expect(full.funds.some((f) => f.name === "Startech Growth Fund 1")).toBe(false);
    });

    it("a fund-held row produces a funds entry and no groups entry for the fund name", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
      flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);

      const asset = sampleAsset({
        holderKind: "fund",
        fund: "Nanjing Growth Fund",
        entity: null,
      });

      const full = await service.buildFullReview([asset]);
      expect(full.funds.some((f) => f.name === "Nanjing Growth Fund")).toBe(true);
      expect(full.groups?.some((g) => g.name === "Nanjing Growth Fund")).toBe(false);
    });

    it("an existing investor with the group's name comes back existing with matched_id", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: "inv-grp-99", name: "Startech Growth Fund 1" },
      ]);
      flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);

      const asset = sampleAsset({
        holderKind: "investor",
        group: "Startech Growth Fund 1",
        fund: "Startech Growth Fund 1",
        entity: "Startech Growth Fund VCC",
        holderName: "Startech Growth Fund VCC",
      });

      const full = await service.buildFullReview([asset]);
      const grp = full.groups?.find((g) => g.name === "Startech Growth Fund 1");
      expect(grp).toBeDefined();
      expect(grp?.status).toBe("existing");
      expect(grp?.matched_id).toBe("inv-grp-99");
    });

    it("surfaces valid transfer counterparties in full.investors catalog with Transfer Counterparty role", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
      flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([]);

      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "认缴",
        natureRaw: "受让额度",
        amount: 2_000_000,
        investorName: "Transferee LP",
        transferPairing: {
          status: "unknown_counterparty",
          transferorName: "Unknown Transferor LP",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      const full = await service.buildFullReview([], [transferEvent]);
      expect(full.investors).toHaveLength(2);
      const transferee = full.investors.find((i) => i.name === "Transferee LP");
      const transferor = full.investors.find((i) => i.name === "Unknown Transferor LP");
      expect(transferee).toBeDefined();
      expect(transferee?.status).toBe("new");
      expect(transferor).toBeDefined();
      expect(transferor?.status).toBe("new");
      expect(transferor?.role).toBe("Transfer Counterparty");
    });
  });

  describe("Nanjing SmartFile review-time transaction deduplication (Path B)", () => {
    const existingFund = { id: "f1", name: "Startech Growth Fund 1", managed: true };
    const existingFund2 = { id: "f2", name: "Startech Growth Fund 2", managed: true };
    const investorA = { id: "inv-a", name: "Investor A", english_name: "Investor A" };
    const investorB = { id: "inv-b", name: "Investor B", english_name: "Investor B" };
    const investorC = { id: "inv-c", name: "Investor C", english_name: "Investor C" };
    const investorD = { id: "inv-d", name: "Investor D", english_name: "Investor D" };

    const posAFund1 = { id: "pos-a-f1", holder_investor_id: "inv-a", fund_id: "f1" };
    const posBFund1 = { id: "pos-b-f1", holder_investor_id: "inv-b", fund_id: "f1" };
    const posCFund1 = { id: "pos-c-f1", holder_investor_id: "inv-c", fund_id: "f1" };
    const posDFund1 = { id: "pos-d-f1", holder_investor_id: "inv-d", fund_id: "f1" };
    const posAFund2 = { id: "pos-a-f2", holder_investor_id: "inv-a", fund_id: "f2" };
    const posBFund2 = { id: "pos-b-f2", holder_investor_id: "inv-b", fund_id: "f2" };

    beforeEach(() => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([existingFund, existingFund2]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([investorA, investorB, investorC, investorD]);
      flPositionRepo.findByHolderInvestorIds.mockImplementation(async (_ws, ids: string[]) => {
        const all = [posAFund1, posBFund1, posCFund1, posDFund1, posAFund2, posBFund2];
        return all.filter((p) => ids.includes(p.holder_investor_id));
      });
    });

    it("classifies existing one-sided commitment increase as duplicate and unselected in review", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "entry-1",
          position_id: "pos-a-f1",
          entry_type: "commitment",
          entry_date: "2023-01-10",
          commitment_delta: "50000000.00000000",
        },
      ]);

      const proposed = sampleCommitmentEvent({
        sourceRow: 2,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-01-10",
        intent: "increase",
        amount: 50_000_000,
      });

      const full = await service.buildFullReview([], [proposed]);

      expect(full.commitment_event_statuses).toEqual({ 2: "duplicate" });
      expect(full.two_step_review?.transactions).toHaveLength(1);
      const txn = full.two_step_review?.transactions[0];
      expect(txn?.status).toBe("duplicate");
      expect(txn?.selected).toBe(false);
      expect(txn?.blockReason).toBeNull();
    });

    it("correctly handles commitment decrease with signed amount and does not confuse with increase", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "entry-dec",
          position_id: "pos-a-f1",
          entry_type: "commitment",
          entry_date: "2023-02-15",
          commitment_delta: "-20000000.00000000",
        },
      ]);

      const decreaseEvent = sampleCommitmentEvent({
        sourceRow: 5,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-02-15",
        intent: "decrease",
        amount: 20_000_000,
      });

      const increaseEvent = sampleCommitmentEvent({
        sourceRow: 6,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-02-15",
        intent: "increase",
        amount: 20_000_000,
      });

      const full = await service.buildFullReview([], [decreaseEvent, increaseEvent]);

      expect(full.commitment_event_statuses).toEqual({
        5: "duplicate",
        6: "actionable",
      });

      const decTxn = full.two_step_review?.transactions.find((t) => t.sheetRow === 5);
      const incTxn = full.two_step_review?.transactions.find((t) => t.sheetRow === 6);

      expect(decTxn?.status).toBe("duplicate");
      expect(decTxn?.selected).toBe(false);
      expect(incTxn?.status).toBe("actionable");
      expect(incTxn?.selected).toBe(true);
    });

    it("keeps paid-in and distribution with same date and amount distinct", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "entry-paid-in",
          position_id: "pos-a-f1",
          entry_type: "paid_in",
          entry_date: "2023-03-01",
          cash_delta: "-15000000.00000000",
        },
      ]);

      const distEvent = sampleCommitmentEvent({
        sourceRow: 10,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-03-01",
        intent: "distribution",
        amount: 15_000_000,
      });

      const paidInEvent = sampleCommitmentEvent({
        sourceRow: 11,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-03-01",
        intent: "paid_in",
        amount: 15_000_000,
      });

      const full = await service.buildFullReview([], [distEvent, paidInEvent]);

      expect(full.commitment_event_statuses).toEqual({
        10: "actionable",
        11: "duplicate",
      });

      const distTxn = full.two_step_review?.transactions.find((t) => t.sheetRow === 10);
      const paidInTxn = full.two_step_review?.transactions.find((t) => t.sheetRow === 11);

      expect(distTxn?.status).toBe("actionable");
      expect(distTxn?.selected).toBe(true);
      expect(paidInTxn?.status).toBe("duplicate");
      expect(paidInTxn?.selected).toBe(false);
    });

    it("leaves matching rows under a different investor or fund as actionable", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "entry-1",
          position_id: "pos-a-f1",
          entry_type: "commitment",
          entry_date: "2023-01-10",
          commitment_delta: "50000000.00000000",
        },
      ]);

      const diffInvestor = sampleCommitmentEvent({
        sourceRow: 2,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-01-10",
        intent: "increase",
        amount: 50_000_000,
      });

      const diffFund = sampleCommitmentEvent({
        sourceRow: 3,
        fund: "Startech Growth Fund 2",
        investorName: "Investor A",
        date: "2023-01-10",
        intent: "increase",
        amount: 50_000_000,
      });

      const full = await service.buildFullReview([], [diffInvestor, diffFund]);

      expect(full.commitment_event_statuses).toEqual({
        2: "actionable",
        3: "actionable",
      });

      expect(full.two_step_review?.transactions.every((t) => t.status === "actionable" && t.selected)).toBe(true);
    });

    it("keeps rows with absent investor, fund, or position actionable and not blocked", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([]);
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
      flPositionRepo.findByHolderInvestorIds.mockResolvedValue([]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);

      const newEvent = sampleCommitmentEvent({
        sourceRow: 2,
        fund: "Unseen Fund",
        investorName: "Unseen LP",
        date: "2023-04-01",
        intent: "increase",
        amount: 10_000_000,
      });

      const full = await service.buildFullReview([], [newEvent]);

      expect(full.commitment_event_statuses).toEqual({ 2: "actionable" });
      const txn = full.two_step_review?.transactions[0];
      expect(txn?.status).toBe("actionable");
      expect(txn?.selected).toBe(true);
      expect(txn?.blockReason).toBeNull();
    });

    it("matches transfer duplicates using both transferor and transferee positions", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "transfer-entry-in",
          position_id: "pos-b-f1",
          counterparty_position_id: "pos-a-f1",
          entry_type: "commitment_transfer",
          sub_type: "transfer_in",
          entry_date: "2023-05-01",
          commitment_delta: "5000000.00000000",
        },
      ]);

      // Same transferor (A), same transferee (B), same fund (f1) -> duplicate
      const sameTransfer = sampleCommitmentEvent({
        sourceRow: 20,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-05-01",
        intent: "transfer_in",
        amount: 5_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor A",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      // Different transferor (C -> B) -> actionable
      const diffTransferor = sampleCommitmentEvent({
        sourceRow: 21,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-05-01",
        intent: "transfer_in",
        amount: 5_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor C",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      // Different transferee (A -> D) -> actionable
      const diffTransferee = sampleCommitmentEvent({
        sourceRow: 22,
        fund: "Startech Growth Fund 1",
        investorName: "Investor D",
        date: "2023-05-01",
        intent: "transfer_in",
        amount: 5_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor A",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      // Different fund (f2) -> actionable
      const diffFund = sampleCommitmentEvent({
        sourceRow: 23,
        fund: "Startech Growth Fund 2",
        investorName: "Investor B",
        date: "2023-05-01",
        intent: "transfer_in",
        amount: 5_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor A",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      const full = await service.buildFullReview([], [
        sameTransfer,
        diffTransferor,
        diffTransferee,
        diffFund,
      ]);

      expect(full.commitment_event_statuses).toEqual({
        20: "duplicate",
        21: "actionable",
        22: "actionable",
        23: "actionable",
      });

      const txn20 = full.two_step_review?.transactions.find((t) => t.sheetRow === 20);
      const txn21 = full.two_step_review?.transactions.find((t) => t.sheetRow === 21);
      expect(txn20?.status).toBe("duplicate");
      expect(txn20?.selected).toBe(false);
      expect(txn21?.status).toBe("actionable");
      expect(txn21?.selected).toBe(true);
    });

    it("deterministically leaves only the first row actionable for intra-file duplicates", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);

      const row10 = sampleCommitmentEvent({
        sourceRow: 10,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-06-01",
        intent: "increase",
        amount: 30_000_000,
      });

      const row25 = sampleCommitmentEvent({
        sourceRow: 25,
        fund: "Startech Growth Fund 1",
        investorName: "Investor A",
        date: "2023-06-01",
        intent: "increase",
        amount: 30_000_000,
      });

      const full = await service.buildFullReview([], [row10, row25]);

      expect(full.commitment_event_statuses).toEqual({
        10: "actionable",
        25: "duplicate",
      });

      const txn10 = full.two_step_review?.transactions.find((t) => t.sheetRow === 10);
      const txn25 = full.two_step_review?.transactions.find((t) => t.sheetRow === 25);

      expect(txn10?.status).toBe("actionable");
      expect(txn10?.selected).toBe(true);
      expect(txn25?.status).toBe("duplicate");
      expect(txn25?.selected).toBe(false);
    });

    it("deterministically leaves only the first transfer actionable for intra-file duplicate transfers", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);

      const row30 = sampleCommitmentEvent({
        sourceRow: 30,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-07-01",
        intent: "transfer_in",
        amount: 8_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor A",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      const row45 = sampleCommitmentEvent({
        sourceRow: 45,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-07-01",
        intent: "transfer_in",
        amount: 8_000_000,
        transferPairing: {
          status: "paired",
          transferorName: "Investor A",
          eligibleForTransferOut: true,
          requiresReview: false,
        },
      });

      const full = await service.buildFullReview([], [row30, row45]);

      expect(full.commitment_event_statuses).toEqual({
        30: "actionable",
        45: "duplicate",
      });

      const txn30 = full.two_step_review?.transactions.find((t) => t.sheetRow === 30);
      const txn45 = full.two_step_review?.transactions.find((t) => t.sheetRow === 45);

      expect(txn30?.status).toBe("actionable");
      expect(txn30?.selected).toBe(true);
      expect(txn45?.status).toBe("duplicate");
      expect(txn45?.selected).toBe(false);
    });

    it("keeps structurally invalid or unresolved events blocked in twoStepReview", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);

      const invalidEvent = sampleCommitmentEvent({
        sourceRow: 50,
        fund: "Startech Growth Fund 1",
        investorName: "",
        date: "2023-08-01",
        intent: "increase",
        amount: 10_000_000,
      });

      const unresolvedTransfer = sampleCommitmentEvent({
        sourceRow: 51,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-08-01",
        intent: "transfer_in",
        amount: 5_000_000,
        transferPairing: {
          status: "missing_counterparty",
          transferorName: null,
          eligibleForTransferOut: false,
          requiresReview: true,
          reviewReason: "Transfer counterparty missing",
        },
      });

      const full = await service.buildFullReview([], [invalidEvent, unresolvedTransfer]);

      const txn50 = full.two_step_review?.transactions.find((t) => t.sheetRow === 50);
      const txn51 = full.two_step_review?.transactions.find((t) => t.sheetRow === 51);

      expect(txn50?.status).toBe("blocked");
      expect(txn50?.selected).toBe(false);
      expect(txn50?.blockReason).toBe("Missing required investor");

      expect(txn51?.status).toBe("blocked");
      expect(txn51?.selected).toBe(false);
      expect(txn51?.blockReason).toBe("Transfer counterparty missing");
    });

    it("loads all ledger entries without 50-entry truncation and classifies entries beyond the 50-item limit as duplicate", async () => {
      // Generate 120 entries distributed across positions
      const entries: any[] = [];
      for (let i = 1; i <= 60; i++) {
        entries.push({
          id: `entry-a-${i}`,
          position_id: "pos-a-f1",
          entry_type: "commitment",
          entry_date: `2023-01-${String(i).padStart(2, "0")}`,
          commitment_delta: `${i * 1000}.00000000`,
        });
      }
      for (let i = 1; i <= 60; i++) {
        entries.push({
          id: `entry-b-${i}`,
          position_id: "pos-b-f1",
          entry_type: "commitment",
          entry_date: `2023-02-${String(i).padStart(2, "0")}`,
          commitment_delta: `${i * 2000}.00000000`,
        });
      }

      // Entry at index 74 (belonging to pos-b-f1, well beyond position 50 in the overall list)
      const targetEntryBeyond50 = entries[74]; // id: entry-b-15, date: 2023-02-15, delta: 30000.00000000
      // Entry at index 119 (the last entry, index 120)
      const lastEntryBeyond100 = entries[119]; // id: entry-b-60, date: 2023-02-60, delta: 120000.00000000

      flLedgerEntryRepo.findAllByPositionIds.mockResolvedValue(entries);

      const proposedRowBeyond50 = sampleCommitmentEvent({
        sourceRow: 103,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: targetEntryBeyond50.entry_date,
        intent: "increase",
        amount: 30000,
      });

      const proposedRowBeyond100 = sampleCommitmentEvent({
        sourceRow: 104,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: lastEntryBeyond100.entry_date,
        intent: "increase",
        amount: 120000,
      });

      const genuinelyNewRow = sampleCommitmentEvent({
        sourceRow: 105,
        fund: "Startech Growth Fund 1",
        investorName: "Investor B",
        date: "2023-03-01",
        intent: "increase",
        amount: 999999,
      });

      const full = await service.buildFullReview([], [
        proposedRowBeyond50,
        proposedRowBeyond100,
        genuinelyNewRow,
      ]);

      expect(flLedgerEntryRepo.findAllByPositionIds).toHaveBeenCalledWith(
        "ws-1",
        expect.arrayContaining(["pos-b-f1"]),
      );

      expect(full.commitment_event_statuses).toEqual({
        103: "duplicate",
        104: "duplicate",
        105: "actionable",
      });

      const txn103 = full.two_step_review?.transactions.find((t) => t.sheetRow === 103);
      const txn104 = full.two_step_review?.transactions.find((t) => t.sheetRow === 104);
      const txn105 = full.two_step_review?.transactions.find((t) => t.sheetRow === 105);

      expect(txn103?.status).toBe("duplicate");
      expect(txn103?.selected).toBe(false);

      expect(txn104?.status).toBe("duplicate");
      expect(txn104?.selected).toBe(false);

      expect(txn105?.status).toBe("actionable");
      expect(txn105?.selected).toBe(true);
    });
  });

  describe("applySelected", () => {
    it("creates equity asset and inserts ledger on apply with tx executor", async () => {
      const result = await service.applySelected([sampleAsset()], ["GOTO"]);
      expect(result.created_assets).toBe(1);
      expect(result.txns_inserted).toBe(1);
      expect(result.valuations_upserted).toBe(1);

      // Verifies FlMasterDataService.createAsset with asset_kind equity
      expect(flMasterDataService.createAsset).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          name: "GOTO Group",
          asset_kind: "equity",
        }),
        mockTxExecutor,
      );

      // Verifies position opening with tx executor
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          asset_id: "asset-new",
        }),
        mockTxExecutor,
      );

      // Verifies ledger event posting with exact 8-decimal string precision and tx executor
      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          event_date: "2021-01-01",
          entries: [
            expect.objectContaining({
              entry_type: "buy",
              cash_delta: "-50.00000000",
              quantity_delta: "50.00000000",
              price_per_unit: "1.00000000",
              currency: "USD",
            }),
          ],
        }),
        mockTxExecutor,
      );

      // A sheet is a position: imported marks attach to the exact position,
      // not the asset-wide identity.
      expect(flValuationService.record).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          position_id: "pos-asset-new-fund",
          as_of_date: "2026-03-31",
          market_value: "100.00000000",
          gross_value: "50.00000000",
          valuation_method: "listed_price",
          units_outstanding: "100.00000000",
          notes: expect.stringContaining("source_meta"),
          currency: "USD",
        }),
        mockTxExecutor,
      );
    });

    it("opens the position on the earliest valuation when that predates cash and entry dates", async () => {
      const asset = sampleAsset({
        entryDate: "2026-01-15",
        txns: [
          {
            date: "2026-01-15",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: 1,
            shareCount: 50,
            valueAmount: 50,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
        ],
        valuations: [
          {
            asOfDate: "2025-12-31",
            periodLabel: "2025-12",
            marketValue: 40,
            pricePerShare: 1,
            sharesOutstanding: 50,
            shareholdingPct: 1,
            investedCapitalCum: 50,
            grossMoic: 0.8,
            grossXirr: null,
            valuationMethod: "at_cost",
            notes: null,
          },
        ],
      });

      await service.applySelected([asset], ["GOTO"]);

      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          opened_at: "2025-12-31",
        }),
        mockTxExecutor,
      );
      expect(flValuationService.record).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          as_of_date: "2025-12-31",
          market_value: "40.00000000",
        }),
        mockTxExecutor,
      );
    });

    it("creates external fund with managed=false and ownership_basis=capital_account for FoF", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-1",
        name: "Target Venture Fund",
        assetType: "fund_of_funds",
        valuations: [
          {
            asOfDate: "2026-03-31",
            periodLabel: "Q1 2026",
            marketValue: 100,
            pricePerShare: null,
            sharesOutstanding: null,
            shareholdingPct: null,
            investedCapitalCum: 50,
            grossMoic: 2,
            grossXirr: null,
            valuationMethod: "capital_account_statement",
            notes: "Q1 statement",
          },
        ],
      });

      const result = await service.applySelected([fofAsset], ["FOF-1"]);
      expect(result.created_assets).toBe(0);
      expect(result.created_funds).toBe(1);

      // Verifies external fund created via master data service with managed=false, ownership_basis=capital_account
      expect(flMasterDataService.createFund).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          name: "Target Venture Fund",
          managed: false,
          ownership_basis: "capital_account",
        }),
        mockTxExecutor,
      );

      // Verifies position links holder_fund_id to external fund_id (no asset_id)
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          fund_id: "fund-Target Venture Fund",
        }),
        mockTxExecutor,
      );

      // A FoF tracker mark likewise attaches to the capital-account position.
      expect(flValuationService.record).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          position_id: "pos-fund-Target Venture Fund-fund",
          as_of_date: "2026-03-31",
          market_value: "100.00000000",
          gross_value: "50.00000000",
          valuation_method: "capital_account_statement",
          notes: expect.stringContaining("Q1 statement | source_meta:"),
        }),
        mockTxExecutor,
      );
    });

    it("applies FoF target to explicitly remapped fund ID without creating original-name fund", async () => {
      const existingFund = {
        id: "fund-existing-remapped",
        workspace_id: "ws-1",
        name: "Existing Remapped Fund",
        legal_name: null,
        english_name: "Existing Remapped Fund En",
        registration_no: null,
        description: null,
        managed: false,
        ownership_basis: "capital_account",
        base_currency: "USD",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      flFundRepo.findById = vi.fn().mockImplementation(async (_ws, id) => id === "fund-existing-remapped" ? existingFund : null);
      flFundRepo.findByWorkspaceId = vi.fn().mockResolvedValue([existingFund]);

      const fofAsset = sampleAsset({
        code: "FOF-REMAP",
        name: "Original Name Sheet FoF",
        assetType: "fund_of_funds",
        fund: "Others",
        txns: [
          {
            date: "2024-01-15",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 1000,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected(
        [fofAsset],
        ["FOF-REMAP"],
        [
          {
            asset_code: "FOF-REMAP",
            matched_target_id: "fund-existing-remapped",
            remapped_target_name: "Existing Remapped Fund",
            txns: fofAsset.txns,
            valuations: [],
          },
        ],
      );

      // Does not create a new fund for 'Original Name Sheet FoF'
      expect(result.created_funds).toBe(0);
      expect(result.updated_assets).toBe(1);
      expect(flMasterDataService.createFund).not.toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ name: "Original Name Sheet FoF" }),
        mockTxExecutor,
      );
      expect(flMasterDataService.createFund).not.toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ managed: false }),
        mockTxExecutor,
      );

      // Opens position against the remapped fund ID
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-Others",
          fund_id: "fund-existing-remapped",
        }),
        mockTxExecutor,
      );
    });

    it("approves new FoF contribution with paid_in entry type, negative cash, nonnegative quantity, and funding source binding", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-NEW",
        name: "New Alpha FoF",
        assetType: "fund_of_funds",
        fundingSource: "NIC",
        fundingSourceRaw: "NIC",
        txns: [
          {
            date: "2024-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 500,
            currency: "USD",
            fxRate: null,
            notes: "Initial call without shares",
          },
          {
            date: "2024-03-01",
            type: "contribution",
            subTypeLabel: "Unitized",
            pricePerShare: 10,
            shareCount: 20,
            valueAmount: 200,
            currency: "USD",
            fxRate: null,
            notes: "Unitized call",
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-NEW"]);
      expect(result.created_assets).toBe(0);
      expect(result.created_funds).toBe(1);
      expect(result.txns_inserted).toBe(2);

      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          fund_id: "fund-New Alpha FoF",
          holder_source_of_fund_id: "fs-NIC",
        }),
        mockTxExecutor,
      );

      // Entry 1: shareCount null -> paid_in with 0 quantity
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-01-01",
          entries: [
            expect.objectContaining({
              entry_type: "paid_in",
              cash_delta: "-500.00000000",
              quantity_delta: "0.00000000",
              price_per_unit: null,
              allocations: [{ funding_source_id: "fs-NIC", amount: "500.00000000" }],
            }),
          ],
        }),
        mockTxExecutor,
      );

      // Entry 2: shareCount 20 -> paid_in with 20 quantity
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-03-01",
          entries: [
            expect.objectContaining({
              entry_type: "paid_in",
              cash_delta: "-200.00000000",
              quantity_delta: "20.00000000",
              price_per_unit: "10.00000000",
              allocations: [{ funding_source_id: "fs-NIC", amount: "200.00000000" }],
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("applies add_missing on existing FoF position as fund entries (paid_in and distribution)", async () => {
      flFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: "fund-others", name: "Others", managed: true },
        {
          id: "fof-fund-1",
          name: "Target Venture Fund",
          managed: false,
          ownership_basis: "capital_account",
          registration_no: "FOF-1",
        },
      ]);
      flPositionRepo.findByFundIds.mockResolvedValue([
        { id: "pos-fof-1", fund_id: "fof-fund-1", holder_fund_id: "fund-others" },
      ]);
      // Existing txn in DB
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-fof-1",
          entry_date: "2021-01-01",
          entry_type: "paid_in",
          cash_delta: "-50.00000000",
          quantity_delta: "0.00000000",
          price_per_unit: null,
          currency: "USD",
          sub_type: null,
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

      const missingTxn = {
        date: "2024-06-01",
        type: "contribution" as const,
        subTypeLabel: null,
        pricePerShare: null,
        shareCount: null,
        valueAmount: 75,
        currency: "USD",
        fxRate: null,
        notes: "Follow-on",
      };

      const fofAsset = sampleAsset({
        code: "FOF-1",
        name: "Target Venture Fund",
        assetType: "fund_of_funds",
        txns: [
          {
            date: "2021-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 50,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          missingTxn,
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-1"]);
      expect(result.updated_assets).toBe(1);
      expect(result.txns_inserted).toBe(1);

      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          fund_id: "fof-fund-1",
          holder_source_of_fund_id: "fs-DCA",
        }),
        mockTxExecutor,
      );

      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          event_date: "2024-06-01",
          entries: [
            expect.objectContaining({
              entry_type: "paid_in",
              cash_delta: "-75.00000000",
              quantity_delta: "0.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("maps FoF sell with positive share count to redemption", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-REDEMPTION",
        name: "FoF Units Fund",
        assetType: "fund_of_funds",
        txns: [
          {
            date: "2024-02-01",
            type: "sell" as never,
            subTypeLabel: "Unit Redemption",
            pricePerShare: 15,
            shareCount: 10,
            valueAmount: 150,
            currency: "USD",
            fxRate: null,
            notes: "Partial units redeemed",
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-REDEMPTION"]);
      expect(result.txns_inserted).toBe(1);

      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "redemption",
              cash_delta: "150.00000000",
              quantity_delta: "-10.00000000",
              price_per_unit: "15.00000000",
              sub_type: "divestment:cash_in_fund",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("maps FoF cash-only divestment/sell without shares to distribution with divestment sub_type", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-CASHDIV",
        name: "FoF Non-Unitized Fund",
        assetType: "fund_of_funds",
        txns: [
          {
            date: "2024-02-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 300,
            currency: "USD",
            fxRate: null,
            notes: "Cash divestment without shares",
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-CASHDIV"]);
      expect(result.txns_inserted).toBe(1);

      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "300.00000000",
              quantity_delta: undefined,
              price_per_unit: null,
              sub_type: "divestment:cash_in_fund",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("maps FoF distribution, dividend, return_of_capital, and interest_income to distribution with preserved sub_types", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-DIST",
        name: "FoF Income Distributions",
        assetType: "fund_of_funds",
        txns: [
          {
            date: "2024-03-01",
            type: "distribution" as never,
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 100,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2024-04-01",
            type: "dividend" as never,
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 40,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2024-05-01",
            type: "return_of_capital",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 60,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2024-06-01",
            type: "interest_income",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 20,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-DIST"]);
      expect(result.txns_inserted).toBe(4);

      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "100.00000000",
              sub_type: "divestment:cash_in_fund",
            }),
          ],
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "40.00000000",
              sub_type: "dividend",
            }),
          ],
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        3,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "60.00000000",
              sub_type: "return_of_capital",
            }),
          ],
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        4,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "20.00000000",
              sub_type: "interest_income",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("wires holder_source_of_fund_id into positions and funding_source_id into allocations for both asset and FoF paths", async () => {
      const directAsset = sampleAsset({
        code: "DIRECT-NIC",
        name: "Direct NIC Asset",
        fundingSource: "NIC",
        fundingSourceRaw: "NIC",
        txns: [{ date: "2024-01-01", type: "contribution", pricePerShare: 1, shareCount: 50, valueAmount: 50, currency: "USD", subTypeLabel: null, fxRate: null, notes: null }],
        valuations: [],
      });
      const fofAsset = sampleAsset({
        code: "FOF-NIC",
        name: "FoF NIC Fund",
        assetType: "fund_of_funds",
        fundingSource: "NIC",
        fundingSourceRaw: "NIC",
        txns: [{ date: "2024-01-01", type: "contribution", pricePerShare: null, shareCount: null, valueAmount: 80, currency: "USD", subTypeLabel: null, fxRate: null, notes: null }],
        valuations: [],
      });

      await service.applySelected([directAsset, fofAsset], ["DIRECT-NIC", "FOF-NIC"]);

      // Direct asset position binding
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          asset_id: "asset-new",
          holder_source_of_fund_id: "fs-NIC",
        }),
        mockTxExecutor,
      );

      // FoF position binding
      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_fund_id: "fund-others",
          fund_id: "fund-FoF NIC Fund",
          holder_source_of_fund_id: "fs-NIC",
        }),
        mockTxExecutor,
      );
    });

    it("maps return_of_capital to income", async () => {
      const rocTxn = {
        date: "2023-03-01",
        type: "return_of_capital" as const,
        subTypeLabel: "Return of Capital",
        pricePerShare: null,
        shareCount: null,
        valueAmount: 25,
        currency: "USD",
        fxRate: null,
        notes: "partial principal return",
      };

      const asset = sampleAsset({ txns: [rocTxn] });
      const result = await service.applySelected([asset], ["GOTO"]);
      expect(result.txns_inserted).toBe(1);

      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "income",
              cash_delta: "25.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("maps other type by signed amount: positive to income, negative to expense", async () => {
      const posOther = {
        date: "2023-04-01",
        type: "other" as const,
        subTypeLabel: "Misc Gain",
        pricePerShare: null,
        shareCount: null,
        valueAmount: 10,
        currency: "USD",
        fxRate: null,
        notes: "misc positive adjustment",
      };
      const negOther = {
        date: "2023-05-01",
        type: "other" as const,
        subTypeLabel: "Misc Fee",
        pricePerShare: null,
        shareCount: null,
        valueAmount: -5,
        currency: "USD",
        fxRate: null,
        notes: "misc negative charge",
      };

      const asset = sampleAsset({ txns: [posOther, negOther] });
      const result = await service.applySelected([asset], ["GOTO"]);
      expect(result.txns_inserted).toBe(2);

      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "income",
              cash_delta: "10.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "expense",
              cash_delta: "-5.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("skips zero-effect workbook transactions before postEvent", async () => {
      const zeroTxn = {
        date: "2023-06-01",
        type: "other" as const,
        subTypeLabel: "Zero Txn",
        pricePerShare: null,
        shareCount: null,
        valueAmount: 0,
        currency: "USD",
        fxRate: null,
        notes: "zero txn",
      };

      const asset = sampleAsset({ txns: [zeroTxn] });
      const result = await service.applySelected([asset], ["GOTO"]);
      expect(result.txns_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("creates investors with investor_type institution", async () => {
      await service.applySelected([sampleAsset()], ["GOTO"], undefined, undefined, {
        investors: ["New Corporate LP"],
      });

      expect(flMasterDataService.createInvestor).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          name: "New Corporate LP",
          investor_type: "institution",
        }),
        mockTxExecutor,
      );
    });

    it("skips unchanged assets on apply", async () => {
      flAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: "asset-1", name: "GOTO Group", instrument_terms: { sheetCode: "GOTO" } },
      ]);
      flPositionRepo.findByAssetIds.mockResolvedValue([
        { id: "pos-1", asset_id: "asset-1" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-1",
          entry_date: "2021-01-01",
          entry_type: "buy",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
          currency: "USD",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([
        { asset_id: "asset-1", as_of_date: "2026-03-31" },
      ]);

      const result = await service.applySelected([sampleAsset()], ["GOTO"]);
      expect(result.skipped).toBe(1);
      expect(result.created_assets).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("applies only selected missing txns when selection is provided", async () => {
      flAssetRepo.findByWorkspaceId.mockResolvedValue([
        { id: "asset-1", name: "GOTO Group", instrument_terms: { sheetCode: "GOTO" } },
      ]);
      flPositionRepo.findByAssetIds.mockResolvedValue([
        { id: "pos-1", asset_id: "asset-1" },
      ]);
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          position_id: "pos-1",
          entry_date: "2021-01-01",
          entry_type: "buy",
          cash_delta: "-50.00000000",
          quantity_delta: "50.00000000",
          price_per_unit: "1.00000000",
        },
      ]);
      flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

      const extraTxn = {
        date: "2022-06-01",
        type: "contribution" as const,
        subTypeLabel: null,
        pricePerShare: 2,
        shareCount: 25,
        valueAmount: 50,
        currency: "USD",
        fxRate: null,
        notes: null,
      };
      const asset = sampleAsset({
        txns: [
          {
            date: "2021-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: 1,
            shareCount: 50,
            valueAmount: 50,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          extraTxn,
        ],
      });

      const result = await service.applySelected([asset], ["GOTO"], [
        { asset_code: "GOTO", txns: [extraTxn], valuations: asset.valuations },
      ]);
      expect(result.updated_assets).toBe(1);
      expect(result.txns_inserted).toBe(1);
      expect(flLedgerService.postEvent).toHaveBeenCalledTimes(1);
    });

    it("maps divestment to sell and distribution/dividend to income", async () => {
      const divestTxn = {
        date: "2023-01-01",
        type: "divestment" as const,
        subTypeLabel: null,
        pricePerShare: 3,
        shareCount: 10,
        valueAmount: 30,
        currency: "USD",
        fxRate: null,
        notes: "partial exit",
      };
      const incomeTxn = {
        date: "2023-06-01",
        type: "interest_income" as const,
        subTypeLabel: "Dividend",
        pricePerShare: null,
        shareCount: null,
        valueAmount: 15,
        currency: "USD",
        fxRate: null,
        notes: "annual dividend",
      };

      const asset = sampleAsset({ txns: [divestTxn, incomeTxn] });
      const result = await service.applySelected([asset], ["GOTO"]);

      expect(result.txns_inserted).toBe(2);
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "sell",
              cash_delta: "30.00000000",
              quantity_delta: "-10.00000000",
              price_per_unit: "3.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              entry_type: "income",
              cash_delta: "15.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("enforces explicit fund catalog validation", async () => {
      const asset = sampleAsset({ fund: "Unknown Fund" });
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, ["Fund A", "Fund B"]),
      ).rejects.toThrowError(FundUpdateValidationError);
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, ["Fund A", "Fund B"]),
      ).rejects.toThrow(/Explicit fund catalog does not contain proposed fund/);
    });

    it("rejects empty explicit fund catalog with FundUpdateValidationError", async () => {
      const asset = sampleAsset();
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, []),
      ).rejects.toThrowError(FundUpdateValidationError);
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, []),
      ).rejects.toThrow("Explicit fund catalog cannot be empty");
    });

    it("enforces isV1 currency requirements with FundUpdateValidationError", async () => {
      const asset = sampleAsset({
        currency: undefined,
        txns: [{ date: "2021-01-01", type: "contribution", pricePerShare: 1, shareCount: 50, valueAmount: 50, currency: "" as any, subTypeLabel: null, fxRate: null, notes: null }],
      });
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, { isV1: true }),
      ).rejects.toThrowError(FundUpdateValidationError);
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, { isV1: true }),
      ).rejects.toThrow(/unresolved currency/);
    });

    it("enforces isV1 valuation currency requirements with FundUpdateValidationError", async () => {
      const asset = sampleAsset({
        currency: undefined,
        valuations: [
          {
            asOfDate: "2026-03-31",
            periodLabel: "Q1 2026",
            marketValue: 100,
            pricePerShare: 1,
            sharesOutstanding: 100,
            shareholdingPct: 1,
            investedCapitalCum: 50,
            grossMoic: 2,
            grossXirr: null,
            valuationMethod: "stock_market_price",
            notes: null,
          },
        ],
        txns: [],
      });
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, { isV1: true }),
      ).rejects.toThrowError(FundUpdateValidationError);
      await expect(
        service.applySelected([asset], ["GOTO"], undefined, { isV1: true }),
      ).rejects.toThrow(/unresolved currency/);
    });
  });

  describe("applyCommitmentEvents", () => {
    it("returns all-zero result on empty events array without hitting repo or service", async () => {
      const result = await service.applyCommitmentEvents([]);
      expect(result).toEqual({
        events_inserted: 0,
        events_skipped_duplicate: 0,
        events_skipped: 0,
        review_items_applied: 0,
        review_items_skipped_unresolved: 0,
        warnings: [],
        outcomes: [],
      });
      expect(flPositionService.getOrOpenPosition).not.toHaveBeenCalled();
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("posts commitment events for investor and fund position with tx executor", async () => {
      const ev1 = sampleCommitmentEvent({ date: "2024-01-15", amount: 1000000, sourceRow: 3 });
      const ev2 = sampleCommitmentEvent({ date: "2024-02-15", amount: 500000, sourceRow: 4 });

      const result = await service.applyCommitmentEvents([ev1, ev2]);

      expect(result.events_inserted).toBe(2);
      expect(result.events_skipped).toBe(0);
      expect(result.events_skipped_duplicate).toBe(0);
      expect(result.warnings).toEqual([]);

      expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          holder_investor_id: expect.any(String),
          fund_id: expect.any(String),
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenCalledTimes(2);
    });

    it("creates only the funds staged in catalogSelections, not the whole workbook catalog", async () => {
      const ev = sampleCommitmentEvent({ fund: "Fund A" });

      await service.applyCommitmentEvents([ev], {
        fundCatalog: ["Fund A", "Fund B", "Fund C"],
        catalogSelections: { funds: ["Fund A"], investors: [], sources: [] },
      });

      const createdFundNames = flMasterDataService.createFund.mock.calls.map(([, input]) => input.name);
      expect(createdFundNames).toEqual(["Fund A"]);
    });

    it("skips a commitment event whose fund was not staged instead of creating that fund", async () => {
      const ev = sampleCommitmentEvent({ fund: "Fund B" });

      const result = await service.applyCommitmentEvents([ev], {
        fundCatalog: ["Fund A", "Fund B"],
        catalogSelections: { funds: ["Fund A"], investors: [], sources: [] },
      });

      expect(result.events_inserted).toBe(0);
      expect(result.events_skipped).toBe(1);
      expect(flMasterDataService.createFund.mock.calls.map(([, input]) => input.name)).toEqual(["Fund A"]);
    });

    it("posts Nanjing paid-in capital and investor distributions on the investor/fund position", async () => {
      const paidIn = sampleCommitmentEvent({ intent: "paid_in", actionRaw: "实缴", amount: 2_000_000 });
      const distribution = sampleCommitmentEvent({
        intent: "distribution",
        actionRaw: "分配",
        date: "2024-02-15",
        amount: 500_000,
      });

      const result = await service.applyCommitmentEvents([paidIn, distribution]);

      expect(result.events_inserted).toBe(2);
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({ entries: [expect.objectContaining({
          entry_type: "paid_in",
          cash_delta: "-2000000.00000000",
          quantity_delta: "0.00000000",
        })] }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({ entries: [expect.objectContaining({
          entry_type: "distribution",
          cash_delta: "500000.00000000",
        })] }),
        mockTxExecutor,
      );
    });

    it("skips duplicate commitment events", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "existing-1",
          entry_date: "2024-01-15",
          entry_type: "commitment",
          commitment_delta: "1000000.00000000",
          currency: "CNY",
        },
      ]);

      const ev = sampleCommitmentEvent({ date: "2024-01-15", amount: 1000000 });
      const result = await service.applyCommitmentEvents([ev]);

      expect(result.events_skipped_duplicate).toBe(1);
      expect(result.events_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("warns and skips if existing commitment currency is not CNY", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "existing-1",
          entry_date: "2023-01-01",
          entry_type: "commitment",
          commitment_delta: "1000000.00000000",
          currency: "USD",
        },
      ]);

      const ev = sampleCommitmentEvent({ date: "2024-01-15", amount: 1000000 });
      const result = await service.applyCommitmentEvents([ev]);

      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("cannot apply CNY commitment events");
    });

    it("posts balanced commitment_transfer when transfer_in is paired with an existing master transferor", async () => {
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: "inv-transferor", name: "Transferor LP" },
      ]);
      flPositionService.getOrOpenPosition.mockImplementation(async (_ws, input) => {
        if (input.holder_investor_id === "inv-transferor") {
          return { id: "pos-transferor", holder_investor_id: "inv-transferor", fund_id: input.fund_id };
        }
        return { id: "pos-transferee", holder_investor_id: input.holder_investor_id, fund_id: input.fund_id };
      });

      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "转让",
        natureRaw: "份额受让",
        directionRaw: "认缴额度增加",
        amount: 3_000_000,
        transferPairing: {
          transferorName: "Transferor LP",
          eligibleForTransferOut: true,
          status: "paired",
          requiresReview: false,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent], {
        fileId: "file-nj-1",
        fundCatalog: ["Fund A"],
      });

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(0);
      expect(result.events_skipped_duplicate).toBe(0);
      expect(result.warnings).toEqual([]);

      expect(flLedgerService.postEvent).toHaveBeenCalledTimes(1);
      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          event_date: "2024-01-15",
          source_record_id: expect.stringContaining("src-rec"),
          entries: [
            expect.objectContaining({
              position_id: "pos-transferor",
              counterparty_position_id: "pos-transferee",
              entry_type: "commitment_transfer",
              sub_type: "transfer_out",
              commitment_delta: "-3000000.00000000",
              quantity_delta: "0.00000000",
              cash_delta: "0.00000000",
              currency: "CNY",
            }),
            expect.objectContaining({
              position_id: "pos-transferee",
              counterparty_position_id: "pos-transferor",
              entry_type: "commitment_transfer",
              sub_type: "transfer_in",
              commitment_delta: "3000000.00000000",
              quantity_delta: "0.00000000",
              cash_delta: "0.00000000",
              currency: "CNY",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("does NOT auto-create transferor from column 11 without catalog approval and blocks the transfer", async () => {
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]); // No existing master investors

      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "转让",
        amount: 2_000_000,
        transferPairing: {
          transferorName: "Brand New Unregistered LP",
          eligibleForTransferOut: true,
          status: "paired",
          requiresReview: false,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent]);

      expect(result.events_inserted).toBe(0);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("not found in master investors");
      expect(result.warnings[0]).toContain("Blocked transfer-in");

      // Transferee is created from col 3, but unselected transferor is NEVER created from col 11
      expect(flMasterDataService.createInvestor).toHaveBeenCalledTimes(1);
      expect(flMasterDataService.createInvestor).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ name: "Investor A" }),
        mockTxExecutor,
      );

      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("creates approved transferor from catalogSelections and posts balanced commitment_transfer", async () => {
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([]); // No existing master investors initially

      flMasterDataService.createInvestor.mockImplementation((_ws: any, input: any) =>
        Promise.resolve({ id: `inv-${input.name}`, name: input.name, investor_type: input.investor_type }),
      );

      flPositionService.getOrOpenPosition.mockImplementation((_ws: any, input: any) => {
        if (input.holder_investor_id === "inv-Brand New Unregistered LP") {
          return Promise.resolve({ id: "pos-transferor", holder_investor_id: "inv-Brand New Unregistered LP", fund_id: input.fund_id });
        }
        return Promise.resolve({ id: "pos-transferee", holder_investor_id: input.holder_investor_id, fund_id: input.fund_id });
      });

      flLedgerService.postEvent.mockResolvedValue({
        event: { id: "evt-transfer" } as any,
        entries: [
          { id: "e1", position_id: "pos-transferor", entry_type: "commitment_transfer" } as any,
          { id: "e2", position_id: "pos-transferee", entry_type: "commitment_transfer" } as any,
        ],
      });

      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "认缴",
        natureRaw: "受让额度",
        amount: 2_000_000,
        transferPairing: {
          transferorName: "Brand New Unregistered LP",
          eligibleForTransferOut: true,
          status: "unknown_counterparty",
          requiresReview: false,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent], {
        catalogSelections: {
          investors: ["Brand New Unregistered LP"],
        },
      });

      expect(result.events_inserted).toBe(1);
      expect(result.events_skipped).toBe(0);
      expect(result.warnings).toHaveLength(0);

      // Both transferee (col 3) and transferor (catalog approval) are created
      expect(flMasterDataService.createInvestor).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ name: "Brand New Unregistered LP" }),
        mockTxExecutor,
      );
      expect(flMasterDataService.createInvestor).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ name: "Investor A" }),
        mockTxExecutor,
      );

      // Balanced commitment transfer legs posted
      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              position_id: "pos-transferor",
              counterparty_position_id: "pos-transferee",
              entry_type: "commitment_transfer",
              sub_type: "transfer_out",
              commitment_delta: "-2000000.00000000",
            }),
            expect.objectContaining({
              position_id: "pos-transferee",
              counterparty_position_id: "pos-transferor",
              entry_type: "commitment_transfer",
              sub_type: "transfer_in",
              commitment_delta: "2000000.00000000",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("blocks transfer when pairing is reciprocal_reduction_found but cannot post an atomic pair", async () => {
      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "转让",
        amount: 1_500_000,
        transferPairing: {
          transferorName: "Other LP",
          eligibleForTransferOut: false,
          status: "reciprocal_reduction_found",
          requiresReview: false,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent]);

      expect(result.events_inserted).toBe(0);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings[0]).toContain("reciprocal_reduction_found");
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("warns and blocks one-sided increase when transfer pairing is ambiguous or unknown", async () => {
      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        actionRaw: "转让",
        amount: 1_000_000,
        transferPairing: {
          transferorName: null,
          eligibleForTransferOut: false,
          status: "unknown_counterparty",
          requiresReview: true,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent]);

      expect(result.events_inserted).toBe(0);
      expect(result.events_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("unknown_counterparty");
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("deduplicates paired transfers on replay via semantic transfer keys", async () => {
      flInvestorRepo.findByWorkspaceId.mockResolvedValue([
        { id: "inv-transferor", name: "Transferor LP" },
      ]);
      flPositionService.getOrOpenPosition.mockImplementation(async (_ws, input) => {
        if (input.holder_investor_id === "inv-transferor") {
          return { id: "pos-transferor", holder_investor_id: "inv-transferor", fund_id: input.fund_id };
        }
        return { id: "pos-transferee", holder_investor_id: input.holder_investor_id, fund_id: input.fund_id };
      });
      flLedgerEntryRepo.findByPositionIds.mockImplementation(async (_ws, posIds) => {
        if (posIds.includes("pos-transferee")) {
          return [
            {
              id: "existing-transfer-1",
              position_id: "pos-transferee",
              counterparty_position_id: "pos-transferor",
              entry_type: "commitment_transfer",
              sub_type: "transfer_in",
              entry_date: "2024-01-15",
              commitment_delta: "3000000.00000000",
              currency: "CNY",
            } as never,
          ];
        }
        return [];
      });

      const transferEvent = sampleCommitmentEvent({
        intent: "transfer_in",
        amount: 3_000_000,
        transferPairing: {
          transferorName: "Transferor LP",
          eligibleForTransferOut: true,
          status: "paired",
          requiresReview: false,
        },
      });

      const result = await service.applyCommitmentEvents([transferEvent]);

      expect(result.events_skipped_duplicate).toBe(1);
      expect(result.events_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("tracks provenance with FlSourceRecordRepository and threads source_record_id", async () => {
      const ev = sampleCommitmentEvent({ sourceRow: 12, date: "2024-01-15", amount: 1_000_000 });

      const result = await service.applyCommitmentEvents([ev], {
        fileId: "file-provenance-123",
        createdBy: "user-456",
      });

      expect(result.events_inserted).toBe(1);
      expect(flSourceRecordRepo.upsertByHash).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: "ws-1",
          file_id: "file-provenance-123",
          sheet_name: "基金流水明细",
          row_number: 12,
          created_by: "user-456",
          raw_payload: expect.objectContaining({
            sourceRow: 12,
            amount: 1_000_000,
          }),
        }),
        mockTxExecutor,
      );

      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          source_record_id: "src-rec-12",
          entries: [
            expect.objectContaining({
              source_record_id: "src-rec-12",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("skips duplicate commitment events on same-file replay via existing source_record_id", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
        {
          id: "entry-prev",
          source_record_id: "src-rec-15",
          entry_type: "commitment",
          commitment_delta: "5000000.00000000",
          entry_date: "2024-01-15",
          currency: "CNY",
        } as never,
      ]);

      const ev = sampleCommitmentEvent({ sourceRow: 15, date: "2024-01-15", amount: 5_000_000 });

      const result = await service.applyCommitmentEvents([ev], {
        fileId: "file-replay-999",
      });

      expect(result.events_skipped_duplicate).toBe(1);
      expect(result.events_inserted).toBe(0);
      expect(flLedgerService.postEvent).not.toHaveBeenCalled();
    });

    it("persists catalog filingCode to fl_funds.registration_no on create and match, and warns on conflict", async () => {
      flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);
      flFundRepo.findByWorkspaceId.mockResolvedValue([
        { id: "fund-matched", name: "Existing Nanjing Fund", managed: true, registration_no: null },
        { id: "fund-conflict", name: "Conflicting Fund", managed: true, registration_no: "EXISTING_CODE_999" },
      ]);

      const ev1 = sampleCommitmentEvent({ fund: "Existing Nanjing Fund", sourceRow: 2 });
      const ev2 = sampleCommitmentEvent({ fund: "Conflicting Fund", sourceRow: 3 });
      const ev3 = sampleCommitmentEvent({ fund: "Newly Created Fund", sourceRow: 4 });

      const result = await service.applyCommitmentEvents([ev1, ev2, ev3], {
        fundCatalogItems: [
          { nameZh: "Existing Nanjing Fund", filingCode: "FILING_CODE_001", subscribedAmount: 0, paidInAmount: 0, investedAmount: 0 },
          { nameZh: "Conflicting Fund", filingCode: "DIFFERENT_FILING_CODE_002", subscribedAmount: 0, paidInAmount: 0, investedAmount: 0 },
          { nameZh: "Newly Created Fund", filingCode: "FILING_CODE_003", subscribedAmount: 0, paidInAmount: 0, investedAmount: 0 },
        ],
      });

      expect(result.events_inserted).toBe(3);

      // On match with null registration_no: updates with filing code
      expect(flFundRepo.update).toHaveBeenCalledWith(
        "ws-1",
        "fund-matched",
        { registration_no: "FILING_CODE_001" },
        mockTxExecutor,
      );

      // On match with conflicting non-null registration_no: does NOT overwrite and records warning
      expect(flFundRepo.update).not.toHaveBeenCalledWith(
        "ws-1",
        "fund-conflict",
        expect.anything(),
        expect.anything(),
      );
      expect(result.warnings).toContainEqual(
        expect.stringContaining('Registration number conflict for fund "Conflicting Fund"'),
      );

      // On create: passes registration_no to createFund
      expect(flMasterDataService.createFund).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          name: "Newly Created Fund",
          registration_no: "FILING_CODE_003",
        }),
        mockTxExecutor,
      );
    });

    it("threads fileId and records source provenance for portfolio transactions in applySelected", async () => {
      const asset = sampleAsset({
        code: "ACME",
        name: "Acme Corp",
        fund: "Startech Growth Fund 1",
        currency: "USD",
        txns: [
          {
            date: "2024-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 100_000,
            currency: "USD",
            fxRate: null,
            notes: null,
            sourceRow: 8,
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([asset], ["ACME"], undefined, {
        isV1: false,
        fileId: "file-txn-provenance-1",
      });

      expect(result.applied).toBe(1);
      expect(flSourceRecordRepo.upsertByHash).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: "ws-1",
          file_id: "file-txn-provenance-1",
          sheet_name: "基金流水明细",
          row_number: 8,
        }),
        mockTxExecutor,
      );
      expect(flLedgerService.postEvent).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({
          source_record_id: "src-rec-8",
        }),
        mockTxExecutor,
      );
    });

    it("carries sellProceedsDestination cash_in_fund and distributed_to_investor through applySelected into structured V2 ledger entries", async () => {
      const asset = sampleAsset({
        code: "ACME-RET",
        name: "Acme Retained Corp",
        fund: "Startech Growth Fund 1",
        currency: "USD",
        txns: [
          {
            date: "2024-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: 10,
            shareCount: 100,
            valueAmount: 1000,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2024-06-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: 15,
            shareCount: 40,
            valueAmount: 600,
            currency: "USD",
            fxRate: null,
            notes: "Retained sale proceeds",
            sellProceedsDestination: "cash_in_fund",
          },
          {
            date: "2024-07-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: 15,
            shareCount: 20,
            valueAmount: 300,
            currency: "USD",
            fxRate: null,
            notes: "Distributed sale proceeds",
            sellProceedsDestination: "distributed_to_investor",
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([asset], ["ACME-RET"]);
      expect(result.applied).toBe(1);
      expect(result.txns_inserted).toBe(3);

      // Buy txn
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-01-01",
          entries: [
            expect.objectContaining({
              entry_type: "buy",
              cash_delta: "-1000.00000000",
              quantity_delta: "100.00000000",
              sub_type: null,
            }),
          ],
        }),
        mockTxExecutor,
      );

      // Retained sell txn: sub_type is "divestment:cash_in_fund"
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-06-01",
          entries: [
            expect.objectContaining({
              entry_type: "sell",
              cash_delta: "600.00000000",
              quantity_delta: "-40.00000000",
              sub_type: "divestment:cash_in_fund",
            }),
          ],
        }),
        mockTxExecutor,
      );

      // Distributed sell txn: sub_type is "divestment:distributed_to_investor"
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        3,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-07-01",
          entries: [
            expect.objectContaining({
              entry_type: "sell",
              cash_delta: "300.00000000",
              quantity_delta: "-20.00000000",
              sub_type: "divestment:distributed_to_investor",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    it("carries sellProceedsDestination cash_in_fund for FoF assets through applySelected", async () => {
      const fofAsset = sampleAsset({
        code: "FOF-RET",
        name: "FoF Retained Fund",
        legalName: "FoF Retained Fund L.P.",
        fund: "Startech Growth Fund 1",
        assetType: "fund_of_funds",
        entity: null,
        fundingSource: null,
        country: "US",
        investmentTypeLabel: "Fund of Funds",
        entryDate: "2024-01-01",
        stakePct: null,
        sector: null,
        subSector: null,
        commitmentAmount: null,
        currency: "USD",
        txns: [
          {
            date: "2024-01-01",
            type: "contribution",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 500_000,
            currency: "USD",
            fxRate: null,
            notes: null,
          },
          {
            date: "2024-08-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 150_000,
            currency: "USD",
            fxRate: null,
            notes: "Retained distribution from FoF",
            sellProceedsDestination: "cash_in_fund",
          },
          {
            date: "2024-09-01",
            type: "divestment",
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 80_000,
            currency: "USD",
            fxRate: null,
            notes: "Distributed return from FoF",
            sellProceedsDestination: "distributed_to_investor",
          },
        ],
        valuations: [],
      });

      const result = await service.applySelected([fofAsset], ["FOF-RET"]);
      expect(result.applied).toBe(1);
      expect(result.txns_inserted).toBe(3);

      // Paid-in txn
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        1,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-01-01",
          entries: [
            expect.objectContaining({
              entry_type: "paid_in",
              cash_delta: "-500000.00000000",
              sub_type: null,
            }),
          ],
        }),
        mockTxExecutor,
      );

      // Retained distribution from FoF without shares: entry_type is "distribution", sub_type is "divestment:cash_in_fund"
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        2,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-08-01",
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "150000.00000000",
              sub_type: "divestment:cash_in_fund",
            }),
          ],
        }),
        mockTxExecutor,
      );

      // Distributed distribution from FoF: sub_type is "divestment:distributed_to_investor"
      expect(flLedgerService.postEvent).toHaveBeenNthCalledWith(
        3,
        "ws-1",
        expect.objectContaining({
          event_date: "2024-09-01",
          entries: [
            expect.objectContaining({
              entry_type: "distribution",
              cash_delta: "80000.00000000",
              sub_type: "divestment:distributed_to_investor",
            }),
          ],
        }),
        mockTxExecutor,
      );
    });

    describe("review resolutions", () => {
      it("rejects a review resolution whose fund was not staged instead of creating it", async () => {
        await expect(
          service.applyCommitmentEvents([], {
            source: "nanjing_fund_ledger_v1",
            fundCatalog: ["Fund A", "Fund B"],
            catalogSelections: { funds: ["Fund A"], investors: [], sources: [] },
            reviewResolutions: [
              {
                sourceRow: 3,
                resolutionType: "non_cash_adjustment",
                investorName: "Investor A",
                fundName: "Fund B",
                date: "2023-05-10",
                amount: 150_000,
                currency: "CNY",
                direction: "reduction",
                subType: "profit_loss_writeoff",
              },
            ],
            reviewItems: [
              {
                sourceRow: 3,
                fund: "Fund B",
                investorName: "Investor A",
                date: "2023-05-10",
                amount: 150_000,
                currency: "CNY",
                action: "实缴调整",
                nature: "损益核销",
                direction: "非现金调整",
                explanation: "Non-cash adjustment requires review",
                isPostable: false,
                requiresReview: true,
                category: "non_cash_adjustment",
              },
            ],
          }),
        ).rejects.toThrow(/was not selected for creation in Step 1/);
        expect(flMasterDataService.createFund.mock.calls.map(([, input]) => input.name)).toEqual(["Fund A"]);
      });

      it("applies non-cash paid-in adjustment with zero cash and valuation delta", async () => {
        const result = await service.applyCommitmentEvents([], {
          source: "nanjing_fund_ledger_v1",
          fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
          fileId: "file-nj-1",
          createdBy: "user-1",
          reviewResolutions: [
            {
              sourceRow: 3,
              resolutionType: "non_cash_adjustment",
              investorName: "南京市紫金科技投资集团有限公司",
              fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
              date: "2023-05-10",
              amount: 150_000,
              currency: "CNY",
              direction: "reduction",
              subType: "profit_loss_writeoff",
              notes: "Review resolution test",
            },
          ],
          reviewItems: [
            {
              sourceRow: 3,
              fund: "南京瑞沣股权投资合伙企业（有限合伙）",
              investorName: "南京市紫金科技投资集团有限公司",
              date: "2023-05-10",
              amount: 150_000,
              currency: "CNY",
              action: "实缴调整",
              nature: "损益核销",
              direction: "非现金调整",
              category: "non_cash_adjustment",
              explanation: "Non-cash writeoff",
              isPostable: false,
              requiresReview: true,
            },
          ],
        });

        expect(result.review_items_applied).toBe(1);
        expect(result.review_items_skipped_unresolved).toBe(0);
        expect(flLedgerService.postEvent).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            event_date: "2023-05-10",
            entries: [
              expect.objectContaining({
                entry_type: "adjustment",
                sub_type: "paid_in_writeoff",
                cash_delta: "0.00000000",
                valuation_delta: "-150000.00000000",
                commitment_delta: "0.00000000",
                quantity_delta: "0.00000000",
                currency: "CNY",
              }),
            ],
          }),
          mockTxExecutor,
        );
      });

      it("Row 33: reduces paid-in for 高亚投资有限公司 by 914,781.37 CNY without cash or valuation changes", async () => {
        const result = await service.applyCommitmentEvents([], {
          source: "nanjing_fund_ledger_v1",
          fundCatalog: ["南京金光紫金股权投资基金（有限合伙企业）"],
          fileId: "file-nj-1",
          createdBy: "user-1",
          reviewResolutions: [
            {
              sourceRow: 33,
              resolutionType: "non_cash_adjustment",
              investorName: "高亚投资有限公司 GLOBE ASIA INVESTMENTS LIMITED",
              fundName: "南京金光紫金股权投资基金（有限合伙企业）",
              date: "2022-12-31",
              amount: 914781.37,
              currency: "CNY",
              direction: "reduction",
              subType: "profit_loss_writeoff",
              notes: "Row 33 valuation writeoff",
            },
          ],
          reviewItems: [
            {
              sourceRow: 33,
              fund: "南京金光紫金股权投资基金（有限合伙企业）",
              investorName: "高亚投资有限公司 GLOBE ASIA INVESTMENTS LIMITED",
              date: "2022-12-31",
              amount: 914781.37,
              currency: "CNY",
              action: "实缴调整",
              nature: "损益核销",
              direction: "非现金调整",
              category: "non_cash_adjustment",
              explanation: "Non-cash writeoff",
              isPostable: false,
              requiresReview: true,
            },
          ],
        });

        expect(result.review_items_applied).toBe(1);
        expect(flLedgerService.postEvent).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            event_date: "2022-12-31",
            entries: [
              expect.objectContaining({
                entry_type: "adjustment",
                sub_type: "paid_in_writeoff",
                cash_delta: "0.00000000",
                valuation_delta: "-914781.37000000",
                commitment_delta: "0.00000000",
                quantity_delta: "0.00000000",
                currency: "CNY",
              }),
            ],
          }),
          mockTxExecutor,
        );
      });

      it("applies single transfer resolution with balanced 2-leg transfer pair", async () => {
        const result = await service.applyCommitmentEvents([], {
          source: "nanjing_fund_ledger_v1",
          fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
          fileId: "file-nj-1",
          createdBy: "user-1",
          reviewResolutions: [
            {
              sourceRow: 94,
              resolutionType: "single_transfer",
              transferorName: "北京高新创投有限公司",
              transfereeName: "南京市紫金科技投资集团有限公司",
              fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
              date: "2023-08-15",
              amount: 500_000,
              currency: "CNY",
              notes: "Resolved truncated counterparty row 94",
            },
          ],
          reviewItems: [
            {
              sourceRow: 94,
              fund: "南京瑞沣股权投资合伙企业（有限合伙）",
              investorName: "南京市紫金科技投资集团有限公司",
              counterpartyRaw: "北京高新创投有限",
              date: "2023-08-15",
              amount: 500_000,
              currency: "CNY",
              action: "Commitment transfer",
              nature: "受让额度",
              direction: "认缴额度增加",
              category: "truncated_transfer",
              explanation: "Truncated counterparty",
              isPostable: false,
              requiresReview: true,
            },
          ],
        });

        expect(result.review_items_applied).toBe(1);
        expect(result.review_items_skipped_unresolved).toBe(0);
        expect(flLedgerService.postEvent).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            event_date: "2023-08-15",
            entries: expect.arrayContaining([
              expect.objectContaining({
                entry_type: "commitment_transfer",
                commitment_delta: "-500000.00000000",
                cash_delta: "0.00000000",
              }),
              expect.objectContaining({
                entry_type: "commitment_transfer",
                commitment_delta: "500000.00000000",
                cash_delta: "0.00000000",
              }),
            ]),
          }),
          mockTxExecutor,
        );
      });

      it("applies multi-party split transfer resolution posting atomic transfer pairs per allocation", async () => {
        const result = await service.applyCommitmentEvents([], {
          source: "nanjing_fund_ledger_v1",
          fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
          fileId: "file-nj-1",
          createdBy: "user-1",
          reviewResolutions: [
            {
              sourceRow: 95,
              resolutionType: "split_transfer",
              transfereeName: "南京市紫金科技投资集团有限公司",
              fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
              date: "2023-09-01",
              totalAmount: 1_000_000,
              currency: "CNY",
              notes: "Multi-party split row 95",
              allocations: [
                { transferorName: "南通产投投资发展有限公司", amount: 600_000 },
                { transferorName: "紫金资管管理有限责任公司", amount: 400_000 },
              ],
            },
          ],
          reviewItems: [
            {
              sourceRow: 95,
              fund: "南京瑞沣股权投资合伙企业（有限合伙）",
              investorName: "南京市紫金科技投资集团有限公司",
              counterpartyRaw: "南通产投及紫金资管",
              date: "2023-09-01",
              amount: 1_000_000,
              currency: "CNY",
              action: "Commitment transfer",
              nature: "受让额度",
              direction: "认缴额度增加",
              category: "multi_party_transfer",
              explanation: "Multi-party counterparty",
              isPostable: false,
              requiresReview: true,
            },
          ],
        });

        expect(result.review_items_applied).toBe(1);
        expect(result.review_items_skipped_unresolved).toBe(0);
        expect(flLedgerService.postEvent).toHaveBeenCalledTimes(2);
      });

      it("rejects multi-party split transfer when sum does not equal total amount", async () => {
        await expect(
          service.applyCommitmentEvents([], {
            source: "nanjing_fund_ledger_v1",
            fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
            fileId: "file-nj-1",
            reviewResolutions: [
              {
                sourceRow: 95,
                resolutionType: "split_transfer",
                transfereeName: "南京市紫金科技投资集团有限公司",
                fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
                date: "2023-09-01",
                totalAmount: 1_000_000,
                currency: "CNY",
                allocations: [
                  { transferorName: "南通产投投资发展有限公司", amount: 600_000 },
                  { transferorName: "紫金资管管理有限责任公司", amount: 300_000 },
                ],
              },
            ],
            reviewItems: [
              {
                sourceRow: 95,
                fund: "南京瑞沣股权投资合伙企业（有限合伙）",
                investorName: "南京市紫金科技投资集团有限公司",
                counterpartyRaw: "南通产投及紫金资管",
                date: "2023-09-01",
                amount: 1_000_000,
                currency: "CNY",
                action: "Commitment transfer",
                nature: "受让额度",
                direction: "认缴额度增加",
                category: "multi_party_transfer",
                explanation: "Multi-party counterparty",
                isPostable: false,
                requiresReview: true,
              },
            ],
          }),
        ).rejects.toThrow("Split transfer allocations sum");
      });

      it("rejects single transfer with placeholder counterparty name", async () => {
        await expect(
          service.applyCommitmentEvents([], {
            source: "nanjing_fund_ledger_v1",
            fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
            fileId: "file-nj-1",
            reviewResolutions: [
              {
                sourceRow: 94,
                resolutionType: "single_transfer",
                transferorName: "待定",
                transfereeName: "南京市紫金科技投资集团有限公司",
                fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
                date: "2023-08-15",
                amount: 500_000,
                currency: "CNY",
              },
            ],
            reviewItems: [
              {
                sourceRow: 94,
                fund: "南京瑞沣股权投资合伙企业（有限合伙）",
                investorName: "南京市紫金科技投资集团有限公司",
                counterpartyRaw: "待定",
                date: "2023-08-15",
                amount: 500_000,
                currency: "CNY",
                action: "Commitment transfer",
                nature: "受让额度",
                direction: "认缴额度增加",
                category: "missing_counterparty",
                explanation: "Placeholder counterparty",
                isPostable: false,
                requiresReview: true,
              },
            ],
          }),
        ).rejects.toThrow("Invalid transferor name");
      });

      it("keeps unconfigured review items skipped without blocking other resolutions", async () => {
        const result = await service.applyCommitmentEvents([], {
          source: "nanjing_fund_ledger_v1",
          fundCatalog: ["南京瑞沣股权投资合伙企业（有限合伙）"],
          fileId: "file-nj-1",
          reviewResolutions: [
            {
              sourceRow: 3,
              resolutionType: "non_cash_adjustment",
              investorName: "南京市紫金科技投资集团有限公司",
              fundName: "南京瑞沣股权投资合伙企业（有限合伙）",
              date: "2023-05-10",
              amount: 150_000,
              currency: "CNY",
              direction: "reduction",
              subType: "profit_loss_writeoff",
            },
          ],
          reviewItems: [
            {
              sourceRow: 3,
              fund: "南京瑞沣股权投资合伙企业（有限合伙）",
              investorName: "南京市紫金科技投资集团有限公司",
              date: "2023-05-10",
              amount: 150_000,
              currency: "CNY",
              action: "实缴调整",
              nature: "损益核销",
              direction: "非现金调整",
              category: "non_cash_adjustment",
              explanation: "Non-cash writeoff",
              isPostable: false,
              requiresReview: true,
            },
            {
              sourceRow: 94,
              fund: "南京瑞沣股权投资合伙企业（有限合伙）",
              investorName: "南京市紫金科技投资集团有限公司",
              counterpartyRaw: "北京高新创投有限",
              date: "2023-08-15",
              amount: 500_000,
              currency: "CNY",
              action: "Commitment transfer",
              nature: "受让额度",
              direction: "认缴额度增加",
              category: "truncated_transfer",
              explanation: "Truncated counterparty",
              isPostable: false,
              requiresReview: true,
            },
          ],
        });

        expect(result.review_items_applied).toBe(1);
        expect(result.review_items_skipped_unresolved).toBe(1);
      });

      it("persists english_name for assets, funds, and investors on apply", async () => {
        const result = await service.applyCommitmentEvents(
          [
            sampleCommitmentEvent({
              sourceRow: 10,
              fund: "南京新工医疗健康产业投资基金（有限合伙）",
              fundEnglishName: "Nanjing Medical Fund",
              investorName: "南京新工投资集团有限责任公司",
              investorEnglishName: "Nanjing Xingong Investment Group",
              investorTypeLabel: "Institutional Investor",
              date: "2023-01-15",
              amount: 5_000_000,
              currency: "CNY",
              intent: "increase",
              dataStatus: "verified",
            }),
          ],
          {
            source: "nanjing_fund_ledger_v1",
            fundCatalogItems: [
              {
                filingCode: "SZ1234",
                nameZh: "南京新工医疗健康产业投资基金（有限合伙）",
                nameEn: "Nanjing Medical Fund",
                subscribedAmount: null,
                paidInAmount: null,
                investedAmount: null,
              },
            ],
          },
        );

        expect(result.events_inserted).toBe(1);
        expect(flMasterDataService.createFund).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "南京新工医疗健康产业投资基金（有限合伙）",
            english_name: "Nanjing Medical Fund",
          }),
          expect.anything(),
        );
        expect(flMasterDataService.createInvestor).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "南京新工投资集团有限责任公司",
            english_name: "Nanjing Xingong Investment Group",
          }),
          expect.anything(),
        );
      });

      it("backfills english_name on an existing matched investor when empty, but never overwrites existing english_name", async () => {
        flInvestorRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: "inv-without-en",
            name: "南京紫金投资集团有限责任公司",
            english_name: null,
            investor_type: "institution",
          },
          {
            id: "inv-with-en",
            name: "江苏省国信集团有限公司",
            english_name: "Existing Guoxin English Name",
            investor_type: "institution",
          },
        ]);

        const result = await service.applyCommitmentEvents(
          [
            sampleCommitmentEvent({
              sourceRow: 11,
              fund: "南京新工医疗健康产业投资基金（有限合伙）",
              investorName: "南京紫金投资集团有限责任公司",
              investorEnglishName: "Nanjing Zijin Investment Group",
              date: "2023-01-15",
              amount: 1_000_000,
              currency: "CNY",
              intent: "increase",
            }),
            sampleCommitmentEvent({
              sourceRow: 12,
              fund: "南京新工医疗健康产业投资基金（有限合伙）",
              investorName: "江苏省国信集团有限公司",
              investorEnglishName: "New Guoxin Proposed Name",
              date: "2023-01-15",
              amount: 2_000_000,
              currency: "CNY",
              intent: "increase",
            }),
          ],
          {
            source: "nanjing_fund_ledger_v1",
            fundCatalogItems: [
              {
                filingCode: "SZ1234",
                nameZh: "南京新工医疗健康产业投资基金（有限合伙）",
                nameEn: "Nanjing Medical Fund",
                subscribedAmount: null,
                paidInAmount: null,
                investedAmount: null,
              },
            ],
          },
        );

        expect(result.events_inserted).toBe(2);
        // Backfill empty english_name
        expect(flInvestorRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "inv-without-en",
          { english_name: "Nanjing Zijin Investment Group" },
          expect.anything(),
        );
        // Do NOT overwrite existing non-empty english_name
        expect(flInvestorRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          "inv-with-en",
          expect.anything(),
          expect.anything(),
        );
      });
    });

    describe("matched target english_name backfill in applySelected", () => {
      it("backfills english_name for matched asset and external target fund without overwriting existing", async () => {
        const assetsList = [
          {
            id: "asset-no-en",
            name: "MicroNano Tech",
            legal_name: "MicroNano Tech LLC",
            english_name: null,
            asset_kind: "equity",
            instrument_terms: { sheet_code: "GOTO" },
          },
          {
            id: "asset-has-en",
            name: "Existing Tech",
            legal_name: "Existing Tech LLC",
            english_name: "Existing Tech English Name",
            asset_kind: "equity",
            instrument_terms: { sheet_code: "EXIST" },
          },
        ];
        flAssetRepo.findByWorkspaceId.mockResolvedValue(assetsList);
        flAssetRepo.findById.mockImplementation(async (_ws, id) => assetsList.find((a) => a.id === id));

        const fundsList = [
          { id: "fund-others", name: "Others", managed: true },
          {
            id: "fof-no-en",
            name: "Target FoF Fund",
            english_name: null,
            managed: false,
            ownership_basis: "capital_account",
            registration_no: "FOF-1",
          },
          {
            id: "fof-has-en",
            name: "Existing FoF Fund",
            english_name: "Existing FoF English Name",
            managed: false,
            ownership_basis: "capital_account",
            registration_no: "FOF-2",
          },
        ];
        flFundRepo.findByWorkspaceId.mockResolvedValue(fundsList);
        flFundRepo.findById.mockImplementation(async (_ws, id) => fundsList.find((f) => f.id === id));

        flPositionRepo.findByAssetIds.mockResolvedValue([
          { id: "pos-asset-1", asset_id: "asset-no-en", holder_fund_id: "fund-others" },
          { id: "pos-asset-2", asset_id: "asset-has-en", holder_fund_id: "fund-others" },
        ]);
        flPositionRepo.findByFundIds.mockResolvedValue([
          { id: "pos-fof-1", fund_id: "fof-no-en", holder_fund_id: "fund-others" },
          { id: "pos-fof-2", fund_id: "fof-has-en", holder_fund_id: "fund-others" },
        ]);
        flLedgerEntryRepo.findByPositionIds.mockResolvedValue([]);

        const assetNoEn = sampleAsset({
          code: "GOTO",
          name: "MicroNano Tech",
          englishName: "MicroNano Technologies",
          assetType: "direct_investment",
          txns: [],
          valuations: [],
        });
        const assetHasEn = sampleAsset({
          code: "EXIST",
          name: "Existing Tech",
          englishName: "Proposed Overwrite Name",
          assetType: "direct_investment",
          txns: [],
          valuations: [],
        });
        const fofNoEn = sampleAsset({
          code: "FOF-1",
          name: "Target FoF Fund",
          englishName: "Target FoF English Name",
          assetType: "fund_of_funds",
          txns: [],
          valuations: [],
        });
        const fofHasEn = sampleAsset({
          code: "FOF-2",
          name: "Existing FoF Fund",
          englishName: "Proposed FoF Overwrite",
          assetType: "fund_of_funds",
          txns: [],
          valuations: [],
        });

        await service.applySelected([assetNoEn, assetHasEn, fofNoEn, fofHasEn], ["GOTO", "EXIST", "FOF-1", "FOF-2"]);

        // Backfill asset without english_name
        expect(flAssetRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "asset-no-en",
          { english_name: "MicroNano Technologies" },
          expect.anything(),
        );
        // Do NOT overwrite existing asset english_name
        expect(flAssetRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          "asset-has-en",
          expect.anything(),
          expect.anything(),
        );

        // Backfill FoF fund without english_name
        expect(flFundRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "fof-no-en",
          { english_name: "Target FoF English Name" },
          expect.anything(),
        );
        // Do NOT overwrite existing FoF fund english_name
        expect(flFundRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          "fof-has-en",
          expect.anything(),
          expect.anything(),
        );
      });
    });

    describe("MB-513 Fund Update Apply Service Contract & Edge Cases", () => {
      describe("catalog & row selection granularity (Req 3)", () => {
        it("creates only selected new funds, investors, and sources from catalogSelections, skipping deselected new entities", async () => {
          const asset1 = sampleAsset({
            code: "A1",
            name: "Asset 1",
            fund: "New Selected Fund",
            entity: "New Selected Investor",
            fundingSource: "New Selected Source",
            fundingSourceRaw: "New Selected Source",
            txns: [],
            valuations: [],
          });

          await service.applySelected(
            [asset1],
            ["A1"],
            undefined,
            { fileId: "file-sel-1" },
            {
              funds: ["New Selected Fund"],
              investors: ["New Selected Investor"],
              sources: ["New Selected Source"],
            },
          );

          expect(flMasterDataService.getOrCreateFund).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({ name: "New Selected Fund" }),
            expect.anything(),
          );
          expect(flMasterDataService.getOrCreateInvestor).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({ name: "New Selected Investor" }),
            expect.anything(),
          );
          expect(flMasterDataService.getOrCreateFundingSource).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({ name: "New Selected Source" }),
            expect.anything(),
          );
        });

        it("applies only selected asset codes and subset of txns and valuations from fund_update_selections", async () => {
          const asset = sampleAsset({
            code: "A2",
            name: "Asset 2",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
              sampleTxn({
                date: "2023-06-01",
                type: "divestment",
                pricePerShare: 15,
                shareCount: 50,
                valueAmount: 750,
              }),
            ],
            valuations: [
              sampleValuation({
                asOfDate: "2023-03-31",
                marketValue: 1200,
                pricePerShare: 12,
                sharesOutstanding: 100,
              }),
              sampleValuation({
                asOfDate: "2023-09-30",
                marketValue: 800,
                pricePerShare: 16,
                sharesOutstanding: 50,
              }),
            ],
          });

          // Only select the first txn (2023-01-01) and second valuation (2023-09-30)
          const selections = [
            {
              asset_code: "A2",
              txns: [asset.txns[0]],
              valuations: [asset.valuations[1]],
            },
          ];

          const result = await service.applySelected([asset], ["A2"], selections, { fileId: "file-sel-2" });

          expect(result.applied).toBe(1);
          expect(result.txns_inserted).toBe(1);
          expect(result.valuations_upserted).toBe(1);

          expect(flLedgerService.postEvent).toHaveBeenCalledTimes(1);
          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              event_date: "2023-01-01",
            }),
            expect.anything(),
          );

          expect(flValuationService.record).toHaveBeenCalledTimes(1);
          expect(flValuationService.record).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              as_of_date: "2023-09-30",
              market_value: "800.00000000",
            }),
            expect.anything(),
          );
        });
      });

      describe("duplicate rows unselectable & skipped (Req 4)", () => {
        it("skips duplicate transactions and valuations on existing position", async () => {
          const existingAsset = {
            id: "asset-exist-1",
            name: "Existing Alpha",
            legal_name: null,
            instrument_terms: { sheetCode: "DUP1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-dup-1", asset_id: "asset-exist-1" },
          ]);

          // Existing ledger entry for 2023-01-01 buy
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
            {
              id: "le-exist-1",
              position_id: "pos-dup-1",
              entry_date: "2023-01-01",
              entry_type: "buy",
              cash_delta: "-1000.00000000",
              quantity_delta: "100.00000000",
              price_per_unit: "10.00000000",
            },
          ]);

          // Existing valuation for 2023-03-31
          flValuationRepo.findByWorkspaceId.mockResolvedValue([
            {
              id: "val-exist-1",
              asset_id: "asset-exist-1",
              position_id: "pos-dup-1",
              as_of_date: "2023-03-31",
              market_value: "1000.00000000",
              price_per_unit: "10.00000000",
            },
          ]);

          const proposed = sampleAsset({
            code: "DUP1",
            name: "Existing Alpha",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [
              sampleValuation({
                asOfDate: "2023-03-31",
                marketValue: 1000,
                pricePerShare: 10,
                sharesOutstanding: 100,
              }),
            ],
          });

          // In Two-Step review, duplicate items are marked duplicate and omitted from selections
          const selections = [
            {
              asset_code: "DUP1",
              txns: [], // Deselected / skipped because duplicate
              valuations: [], // Deselected / skipped because duplicate
            },
          ];

          const result = await service.applySelected([proposed], ["DUP1"], selections);

          expect(result.applied).toBe(0);
          expect(result.txns_inserted).toBe(0);
          expect(result.valuations_upserted).toBe(0);
          expect(flLedgerService.postEvent).not.toHaveBeenCalled();
          expect(flValuationService.record).not.toHaveBeenCalled();
        });

        it("increments events_skipped_duplicate on duplicate commitment events", async () => {
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
            {
              id: "le-comm-1",
              entry_date: "2023-01-10",
              entry_type: "commitment",
              sub_type: "increase",
              commitment_delta: "10000000.00000000",
              currency: "CNY",
            },
          ]);

          const duplicateEvent = sampleCommitmentEvent({
            fund: "Startech Growth Fund 1",
            investorName: "Investor A",
            date: "2023-01-10",
            amount: 10_000_000,
            intent: "increase",
          });

          const result = await service.applyCommitmentEvents([duplicateEvent], {
            fundCatalog: ["Startech Growth Fund 1"],
          });

          expect(result.events_inserted).toBe(0);
          expect(result.events_skipped_duplicate).toBe(1);
          expect(flLedgerService.postEvent).not.toHaveBeenCalled();
        });

        it("skips previously recorded source records idempotently using source_record_id hash", async () => {
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
            {
              id: "le-replay-1",
              source_record_id: "src-rec-15",
              entry_date: "2023-02-15",
              entry_type: "paid_in",
              cash_delta: "-5000000.00000000",
              currency: "CNY",
            },
          ]);

          const event = sampleCommitmentEvent({
            sourceRow: 15,
            fund: "Startech Growth Fund 1",
            investorName: "Investor A",
            date: "2023-02-15",
            amount: 5_000_000,
            intent: "paid_in",
          });

          const result = await service.applyCommitmentEvents([event], {
            fileId: "file-replay-1",
            fundCatalog: ["Startech Growth Fund 1"],
          });

          expect(result.events_inserted).toBe(0);
          expect(result.events_skipped_duplicate).toBe(1);
          expect(flLedgerService.postEvent).not.toHaveBeenCalled();
        });
      });

      describe("missing/deselected required From/To blocks business events (Req 5)", () => {
        it("throws FundUpdateValidationError if v1 proposal has asset with unresolved/empty fund reference", async () => {
          const assetNoFund = sampleAsset({
            code: "NO_FUND",
            name: "Unfunded Asset",
            fund: "",
            txns: [sampleTxn({ date: "2023-01-01", type: "contribution", valueAmount: 100 })],
          });

          await expect(
            service.applySelected([assetNoFund], ["NO_FUND"], undefined, { isV1: true }),
          ).rejects.toThrow("Cannot apply asset \"Unfunded Asset\" with unresolved fund reference");
        });

        it("throws FundUpdateValidationError if transfer resolution has missing transferor name", async () => {
          await expect(
            service.applyCommitmentEvents([], {
              fundCatalog: ["Startech Growth Fund 1"],
              reviewResolutions: [
                {
                  sourceRow: 5,
                  resolutionType: "single_transfer",
                  transferorName: "   ",
                  transfereeName: "Investor B",
                  fundName: "Startech Growth Fund 1",
                  date: "2023-03-01",
                  amount: 200_000,
                },
              ],
              reviewItems: [
                sampleReviewItem({
                  sourceRow: 5,
                  fund: "Startech Growth Fund 1",
                  investorName: "Investor B",
                  counterpartyRaw: "Unverified",
                  date: "2023-03-01",
                  amount: 200_000,
                  currency: "CNY",
                  action: "Commitment transfer",
                  explanation: "Requires review",
                }),
              ],
            }),
          ).rejects.toThrow("missing transferor name");
        });

        it("throws FundUpdateValidationError if transfer resolution has missing transferee name", async () => {
          await expect(
            service.applyCommitmentEvents([], {
              fundCatalog: ["Startech Growth Fund 1"],
              reviewResolutions: [
                {
                  sourceRow: 6,
                  resolutionType: "single_transfer",
                  transferorName: "Investor A",
                  transfereeName: "   ",
                  fundName: "Startech Growth Fund 1",
                  date: "2023-03-01",
                  amount: 200_000,
                },
              ],
              reviewItems: [
                sampleReviewItem({
                  sourceRow: 6,
                  fund: "Startech Growth Fund 1",
                  investorName: "Investor B",
                  counterpartyRaw: "Investor A",
                  date: "2023-03-01",
                  amount: 200_000,
                  currency: "CNY",
                  action: "Commitment transfer",
                  explanation: "Requires review",
                }),
              ],
            }),
          ).rejects.toThrow("Transfer resolution for row 6 does not match the source fund, date, transferee, amount, or currency");
        });

        it("throws FundUpdateValidationError if transferor and transferee are the same investor", async () => {
          await expect(
            service.applyCommitmentEvents([], {
              fundCatalog: ["Startech Growth Fund 1"],
              reviewResolutions: [
                {
                  sourceRow: 7,
                  resolutionType: "single_transfer",
                  transferorName: "Investor A",
                  transfereeName: "Investor A",
                  fundName: "Startech Growth Fund 1",
                  date: "2023-03-01",
                  amount: 200_000,
                },
              ],
              reviewItems: [
                sampleReviewItem({
                  sourceRow: 7,
                  fund: "Startech Growth Fund 1",
                  investorName: "Investor A",
                  counterpartyRaw: "Investor A",
                  date: "2023-03-01",
                  amount: 200_000,
                  currency: "CNY",
                  action: "Commitment transfer",
                  explanation: "Requires review",
                }),
              ],
            }),
          ).rejects.toThrow("Transferor and transferee cannot be the same investor");
        });

        it("quarantines and blocks unresolved transfer_in when transferPairing is missing or ambiguous", async () => {
          const blockedEvent = sampleCommitmentEvent({
            fund: "Startech Growth Fund 1",
            investorName: "Investor A",
            intent: "transfer_in",
            date: "2023-04-01",
            amount: 500_000,
            transferPairing: {
              status: "ambiguous",
              eligibleForTransferOut: false,
              requiresReview: true,
              reviewReason: "Ambiguous counterparty matching multiple entities.",
            },
          });

          const result = await service.applyCommitmentEvents([blockedEvent], {
            fundCatalog: ["Startech Growth Fund 1"],
          });

          expect(result.events_inserted).toBe(0);
          expect(result.events_skipped).toBe(1);
          expect(result.warnings.some((w) => w.includes("Blocked unresolved transfer-in"))).toBe(true);
          expect(flLedgerService.postEvent).not.toHaveBeenCalled();
        });
      });

      describe("missing/deselected optional Source posts with null source (Req 6)", () => {
        it("posts asset and transactions with null funding source when fundingSource is omitted or deselected in catalogSelections.sources", async () => {
          const assetWithSource = sampleAsset({
            code: "SRC1",
            name: "Sourced Asset",
            fund: "Others",
            fundingSource: "Special Purpose Source",
            fundingSourceRaw: "Special Purpose Source",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                valueAmount: 1000,
                shareCount: 100,
                pricePerShare: 10,
                currency: "USD",
              }),
            ],
            valuations: [],
          });

          // catalogSelections.sources explicitly excludes "Special Purpose Source"
          const result = await service.applySelected(
            [assetWithSource],
            ["SRC1"],
            undefined,
            { fileId: "file-src-1" },
            {
              funds: ["Others"],
              investors: [],
              sources: ["Other Allowed Source"], // "Special Purpose Source" is omitted/deselected
            },
          );

          expect(result.applied).toBe(1);
          expect(result.txns_inserted).toBe(1);

          // Position opened without funding source
          expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              holder_source_of_fund_id: null,
            }),
            expect.anything(),
          );

          // Instrument terms fundingSource is null when deselected
          expect(flMasterDataService.createAsset).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              instrument_terms: expect.objectContaining({
                fundingSource: null,
              }),
            }),
            expect.anything(),
          );

          // Ledger entry posted without allocations
          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              entries: [
                expect.objectContaining({
                  allocations: undefined,
                }),
              ],
            }),
            expect.anything(),
          );
        });
      });

      describe("transfer event-level atomicity (Req 8)", () => {
        it("posts both transfer_out and transfer_in legs atomically in one postEvent call with mutual counterparty positions", async () => {
          flInvestorRepo.findByWorkspaceId.mockResolvedValue([
            { id: "inv-from", name: "Transferor Corp", english_name: null, investor_type: "institution" },
            { id: "inv-to", name: "Transferee LLC", english_name: null, investor_type: "institution" },
          ]);

          flPositionService.getOrOpenPosition.mockImplementation(async (_ws, input) => ({
            id: `pos-${input.holder_investor_id}`,
            ...input,
          }));

          const result = await service.applyCommitmentEvents([], {
            fundCatalog: ["Startech Growth Fund 1"],
            fileId: "file-xfer-1",
            reviewResolutions: [
              {
                sourceRow: 100,
                resolutionType: "single_transfer",
                transferorName: "Transferor Corp",
                transfereeName: "Transferee LLC",
                fundName: "Startech Growth Fund 1",
                date: "2023-07-01",
                amount: 3_000_000,
                currency: "CNY",
                notes: "Resolved single transfer",
              },
            ],
            reviewItems: [
              sampleReviewItem({
                sourceRow: 100,
                fund: "Startech Growth Fund 1",
                investorName: "Transferee LLC",
                counterpartyRaw: "Transferor Corp",
                date: "2023-07-01",
                amount: 3_000_000,
                currency: "CNY",
                action: "Commitment transfer",
                explanation: "Single transfer resolution",
              }),
            ],
          });

          expect(result.review_items_applied).toBe(1);
          expect(result.events_inserted).toBe(1);

          expect(flLedgerService.postEvent).toHaveBeenCalledTimes(1);
          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              event_date: "2023-07-01",
              entries: [
                expect.objectContaining({
                  position_id: "pos-inv-from",
                  counterparty_position_id: "pos-inv-to",
                  entry_type: "commitment_transfer",
                  sub_type: "transfer_out",
                  commitment_delta: "-3000000.00000000",
                }),
                expect.objectContaining({
                  position_id: "pos-inv-to",
                  counterparty_position_id: "pos-inv-from",
                  entry_type: "commitment_transfer",
                  sub_type: "transfer_in",
                  commitment_delta: "3000000.00000000",
                }),
              ],
            }),
            expect.anything(),
          );
        });

        it("rejects single_transfer resolution if the source row was a multi-party transfer", async () => {
          await expect(
            service.applyCommitmentEvents([], {
              fundCatalog: ["Startech Growth Fund 1"],
              reviewResolutions: [
                {
                  sourceRow: 101,
                  resolutionType: "single_transfer",
                  transferorName: "南通产投投资发展有限公司",
                  transfereeName: "南京市紫金科技投资集团有限公司",
                  fundName: "Startech Growth Fund 1",
                  date: "2023-07-01",
                  amount: 1_000_000,
                  currency: "CNY",
                },
              ],
              reviewItems: [
                sampleReviewItem({
                  sourceRow: 101,
                  fund: "Startech Growth Fund 1",
                  investorName: "南京市紫金科技投资集团有限公司",
                  counterpartyRaw: "南通产投及紫金资管", // multi-party
                  date: "2023-07-01",
                  amount: 1_000_000,
                  currency: "CNY",
                  action: "Commitment transfer",
                  category: "multi_party_transfer",
                  explanation: "Multi party",
                }),
              ],
            }),
          ).rejects.toThrow("Multi-party transfer row 101 must use a split-transfer resolution");
        });

        it("rejects split_transfer resolution if the source row was a single counterparty transfer", async () => {
          await expect(
            service.applyCommitmentEvents([], {
              fundCatalog: ["Startech Growth Fund 1"],
              reviewResolutions: [
                {
                  sourceRow: 102,
                  resolutionType: "split_transfer",
                  transfereeName: "Transferee LLC",
                  fundName: "Startech Growth Fund 1",
                  date: "2023-07-01",
                  totalAmount: 1_000_000,
                  currency: "CNY",
                  allocations: [
                    { transferorName: "Transferor A", amount: 1_000_000 },
                  ],
                },
              ],
              reviewItems: [
                sampleReviewItem({
                  sourceRow: 102,
                  fund: "Startech Growth Fund 1",
                  investorName: "Transferee LLC",
                  counterpartyRaw: "Transferor A", // single counterparty
                  date: "2023-07-01",
                  amount: 1_000_000,
                  currency: "CNY",
                  action: "Commitment transfer",
                  category: "truncated_transfer",
                  explanation: "Single counterparty",
                }),
              ],
            }),
          ).rejects.toThrow("Single-counterparty transfer row 102 cannot use a split-transfer resolution");
        });
      });

      describe("valuations separate from cash & target resolution (Req 9)", () => {
        it("records direct asset valuations against flValuationService and updates existing mark on same date", async () => {
          const existingAsset = {
            id: "asset-val-1",
            name: "Val Target",
            legal_name: null,
            instrument_terms: { sheetCode: "VT1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) => id === "asset-val-1" ? existingAsset : null);
          flPositionService.getOrOpenPosition.mockResolvedValue({ id: "pos-vt1", asset_id: "asset-val-1", holder_fund_id: "fund-others" });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-vt1", asset_id: "asset-val-1", holder_fund_id: "fund-others" },
          ]);

          // Existing valuation with old mark
          const existingMark = {
            id: "val-old",
            asset_id: null,
            fund_id: null,
            position_id: "pos-vt1",
            as_of_date: "2023-06-30",
            market_value: "1000.00000000",
            price_per_unit: "10.00000000",
            units_outstanding: "100.00000000",
            gross_value: null,
            valuation_method: "at_cost",
            currency: "USD",
            notes: null,
            data_status: "verified",
          };
          flValuationRepo.findByWorkspaceId.mockResolvedValue([existingMark]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([existingMark]);

          const flValUpdateSpy = vi.fn().mockResolvedValue({});
          flValuationService.update = flValUpdateSpy;

          const proposed = sampleAsset({
            code: "VT1",
            name: "Val Target",
            fund: "Others",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2023-06-30",
                marketValue: 1500, // corrected mark
                pricePerShare: 15,
                sharesOutstanding: 100,
                valuationMethod: "fundraise_round",
                notes: "Updated mark",
              }),
            ],
          });

          const result = await service.applySelected([proposed], ["VT1"]);

          expect(result.applied).toBe(1);
          expect(result.valuations_upserted).toBe(1);
          expect(flValUpdateSpy).toHaveBeenCalledWith(
            "ws-1",
            "val-old",
            expect.objectContaining({
              as_of_date: "2023-06-30",
              market_value: "1500.00000000",
              price_per_unit: "15.00000000",
              valuation_method: "fundraise_round",
            }),
            expect.anything(),
          );
        });

        it("records Fund of Funds valuations against fund_id", async () => {
          const fofFund = {
            id: "fof-fund-1",
            name: "External Venture Fund I",
            managed: false,
            ownership_basis: "capital_account",
            registration_no: "FOF-VT",
          };
          flFundRepo.findByWorkspaceId.mockResolvedValue([
            { id: "fund-others", name: "Others", managed: true },
            fofFund,
          ]);
          flFundRepo.findById.mockImplementation(async (_ws, id) => id === "fof-fund-1" ? fofFund : null);
          flPositionService.getOrOpenPosition.mockResolvedValue({ id: "pos-fof-1", fund_id: "fof-fund-1", holder_fund_id: "fund-others" });
          flPositionRepo.findByFundIds.mockResolvedValue([
            { id: "pos-fof-1", fund_id: "fof-fund-1", holder_fund_id: "fund-others" },
          ]);

          const proposedFof = sampleAsset({
            code: "FOF-VT",
            name: "External Venture Fund I",
            assetType: "fund_of_funds",
            fund: "Others",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2023-12-31",
                marketValue: 5000000,
                valuationMethod: "capital_account_statement",
                notes: "Q4 NAV statement",
              }),
            ],
          });

          const result = await service.applySelected([proposedFof], ["FOF-VT"]);

          expect(result.applied).toBe(1);
          expect(result.valuations_upserted).toBe(1);
          expect(flValuationService.record).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              position_id: "pos-fof-1",
              as_of_date: "2023-12-31",
              market_value: "5000000.00000000",
              valuation_method: "capital_account_statement",
            }),
            expect.anything(),
          );
        });

        it("blocks valuation-only approval when the holder is omitted from catalog selections", async () => {
          const asset = sampleAsset({
            code: "VAL-ONLY",
            name: "Val Only Co",
            holderKind: "investor",
            holderName: "Meranti Global Investment Ltd",
            entity: "Meranti Global Investment Ltd",
            group: "Meranti 1",
            fund: "Meranti 1",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 50000,
              }),
            ],
          });

          await expect(
            service.applySelected(
              [asset],
              ["VAL-ONLY"],
              [
                {
                  asset_code: "VAL-ONLY",
                  txns: [],
                  valuations: asset.valuations,
                },
              ],
              undefined,
              {
                funds: ["Meranti 1"],
                investors: [],
                sources: [],
              },
            ),
          ).rejects.toThrow(
            new FundUpdateValidationError(
              'Cannot apply 1 selected valuation(s) for asset "VAL-ONLY" (Val Only Co): unresolved position for holder "Meranti Global Investment Ltd".',
            ),
          );

          expect(flValuationService.record).not.toHaveBeenCalled();
          expect(flValuationService.update).not.toHaveBeenCalled();
        });

        it("rejects same position/date mark in a different currency as an explicit conflict", async () => {
          const existingAsset = {
            id: "asset-ccy-1",
            name: "Currency Conflict Co",
            legal_name: null,
            instrument_terms: { sheetCode: "CCY1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) =>
            id === "asset-ccy-1" ? existingAsset : null,
          );
          flPositionService.getOrOpenPosition.mockResolvedValue({
            id: "pos-ccy-1",
            asset_id: "asset-ccy-1",
            holder_fund_id: "fund-others",
          });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-ccy-1", asset_id: "asset-ccy-1", holder_fund_id: "fund-others" },
          ]);

          const existingMark = {
            id: "val-usd",
            position_id: "pos-ccy-1",
            as_of_date: "2023-06-30",
            market_value: "1000.00000000",
            currency: "USD",
            valuation_method: "at_cost",
            price_per_unit: null,
            units_outstanding: null,
            gross_value: null,
            notes: null,
            data_status: "verified",
          };
          flValuationRepo.findByWorkspaceId.mockResolvedValue([existingMark]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([existingMark]);

          const proposed = sampleAsset({
            code: "CCY1",
            name: "Currency Conflict Co",
            fund: "Others",
            currency: "CNY",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2023-06-30",
                marketValue: 1200,
              }),
            ],
          });

          await expect(service.applySelected([proposed], ["CCY1"])).rejects.toThrow(
            /Valuation currency conflict/,
          );
          expect(flValuationService.update).not.toHaveBeenCalled();
          expect(flValuationService.record).not.toHaveBeenCalled();
        });

        it("skips identical position/date/currency mark as duplicate without writing", async () => {
          const existingAsset = {
            id: "asset-dup-val",
            name: "Dup Val Co",
            legal_name: null,
            instrument_terms: { sheetCode: "DUPV" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) =>
            id === "asset-dup-val" ? existingAsset : null,
          );
          flPositionService.getOrOpenPosition.mockResolvedValue({
            id: "pos-dup-val",
            asset_id: "asset-dup-val",
            holder_fund_id: "fund-others",
          });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-dup-val", asset_id: "asset-dup-val", holder_fund_id: "fund-others" },
          ]);

          const existingMark = {
            id: "val-dup",
            position_id: "pos-dup-val",
            as_of_date: "2023-03-31",
            market_value: "1200.00000000",
            currency: "USD",
            valuation_method: "at_cost",
            price_per_unit: "12.00000000",
            units_outstanding: "100.00000000",
            gross_value: null,
            notes: "source_meta: {\"period_label\":\"Q1 2023\"}",
            data_status: "verified",
          };
          // Force the mark into missing_valuations by returning empty from workspace scan,
          // then prove applyValuation still dedups via the targeted lookup.
          flValuationRepo.findByWorkspaceId.mockResolvedValue([]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([existingMark]);

          const proposed = sampleAsset({
            code: "DUPV",
            name: "Dup Val Co",
            fund: "Others",
            currency: "USD",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2023-03-31",
                marketValue: 1200,
                pricePerShare: 12,
                sharesOutstanding: 100,
                valuationMethod: "at_cost",
                notes: null,
              }),
            ],
          });

          const result = await service.applySelected([proposed], ["DUPV"]);
          expect(result.valuations_upserted).toBe(0);
          expect(result.outcomes?.some((o) => o.family === "valuation" && o.disposition === "duplicate")).toBe(
            true,
          );
          expect(flValuationService.record).not.toHaveBeenCalled();
          expect(flValuationService.update).not.toHaveBeenCalled();
        });

        it("same batch: absent initial mark with two same-date marks updates cache and applies sequentially", async () => {
          const existingAsset = {
            id: "asset-val-batch-1",
            name: "Batch No Init Co",
            legal_name: null,
            instrument_terms: { sheetCode: "BNI1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) =>
            id === "asset-val-batch-1" ? existingAsset : null,
          );
          flPositionService.getOrOpenPosition.mockResolvedValue({
            id: "pos-bni-1",
            asset_id: "asset-val-batch-1",
            holder_fund_id: "fund-others",
          });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-bni-1", asset_id: "asset-val-batch-1", holder_fund_id: "fund-others" },
          ]);

          flValuationRepo.findByWorkspaceId.mockResolvedValue([]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([]);

          const recordResult = {
            id: "val-bni-rec",
            asset_id: null,
            fund_id: null,
            position_id: "pos-bni-1",
            as_of_date: "2024-03-31",
            market_value: "100000.00000000",
            currency: "USD",
            valuation_method: "at_cost",
            price_per_unit: null,
            units_outstanding: null,
            gross_value: null,
            notes: null,
            data_status: "verified",
          };
          const updateResult = {
            ...recordResult,
            market_value: "120000.00000000",
          };

          const flValRecordSpy = vi.fn().mockResolvedValue(recordResult);
          const flValUpdateSpy = vi.fn().mockResolvedValue(updateResult);
          flValuationService.record = flValRecordSpy;
          flValuationService.update = flValUpdateSpy;

          const proposed = sampleAsset({
            code: "BNI1",
            name: "Batch No Init Co",
            fund: "Others",
            currency: "USD",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 100000,
                sourceRow: 10,
              }),
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 120000,
                sourceRow: 11,
              }),
            ],
          });

          const result = await service.applySelected(
            [proposed],
            ["BNI1"],
            [
              {
                asset_code: "BNI1",
                txns: [],
                valuations: proposed.valuations,
              },
            ],
          );

          expect(result.valuations_upserted).toBe(2);
          expect(flValRecordSpy).toHaveBeenCalledTimes(1);
          expect(flValRecordSpy).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              position_id: "pos-bni-1",
              as_of_date: "2024-03-31",
              market_value: "100000.00000000",
            }),
            expect.anything(),
          );
          expect(flValUpdateSpy).toHaveBeenCalledTimes(1);
          expect(flValUpdateSpy).toHaveBeenCalledWith(
            "ws-1",
            "val-bni-rec",
            expect.objectContaining({
              as_of_date: "2024-03-31",
              market_value: "120000.00000000",
            }),
            expect.anything(),
          );
          const valOutcomes = (result.outcomes ?? []).filter(
            (o) => o.family === "valuation",
          );
          expect(valOutcomes.length).toBe(2);
          expect(valOutcomes[0].disposition).toBe("posted");
          expect(valOutcomes[1].disposition).toBe("posted");
        });

        it("same batch: existing A with incoming B then A calls update twice and restores A", async () => {
          const existingAsset = {
            id: "asset-val-batch-2",
            name: "Batch Restore Co",
            legal_name: null,
            instrument_terms: { sheetCode: "BRE1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) =>
            id === "asset-val-batch-2" ? existingAsset : null,
          );
          flPositionService.getOrOpenPosition.mockResolvedValue({
            id: "pos-bre-1",
            asset_id: "asset-val-batch-2",
            holder_fund_id: "fund-others",
          });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-bre-1", asset_id: "asset-val-batch-2", holder_fund_id: "fund-others" },
          ]);

          const initialMark = {
            id: "val-bre-existing",
            asset_id: null,
            fund_id: null,
            position_id: "pos-bre-1",
            as_of_date: "2024-03-31",
            market_value: "100000.00000000",
            currency: "USD",
            valuation_method: "at_cost",
            price_per_unit: null,
            units_outstanding: null,
            gross_value: null,
            notes: null,
            data_status: "verified",
          };
          flValuationRepo.findByWorkspaceId.mockResolvedValue([initialMark]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([initialMark]);

          const updatedToB = {
            ...initialMark,
            market_value: "150000.00000000",
          };
          const updatedBackToA = {
            ...initialMark,
            market_value: "100000.00000000",
          };

          const flValUpdateSpy = vi
            .fn()
            .mockResolvedValueOnce(updatedToB)
            .mockResolvedValueOnce(updatedBackToA);
          flValuationService.update = flValUpdateSpy;

          const proposed = sampleAsset({
            code: "BRE1",
            name: "Batch Restore Co",
            fund: "Others",
            currency: "USD",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 150000,
                sourceRow: 10,
              }),
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 100000,
                sourceRow: 11,
              }),
            ],
          });

          const result = await service.applySelected(
            [proposed],
            ["BRE1"],
            [
              {
                asset_code: "BRE1",
                txns: [],
                valuations: proposed.valuations,
              },
            ],
          );

          expect(result.valuations_upserted).toBe(2);
          expect(flValUpdateSpy).toHaveBeenCalledTimes(2);
          expect(flValUpdateSpy).toHaveBeenNthCalledWith(
            1,
            "ws-1",
            "val-bre-existing",
            expect.objectContaining({
              as_of_date: "2024-03-31",
              market_value: "150000.00000000",
            }),
            expect.anything(),
          );
          expect(flValUpdateSpy).toHaveBeenNthCalledWith(
            2,
            "ws-1",
            "val-bre-existing",
            expect.objectContaining({
              as_of_date: "2024-03-31",
              market_value: "100000.00000000",
            }),
            expect.anything(),
          );
          const valOutcomes = (result.outcomes ?? []).filter(
            (o) => o.family === "valuation",
          );
          expect(valOutcomes.length).toBe(2);
          expect(valOutcomes[0].disposition).toBe("posted");
          expect(valOutcomes[1].disposition).toBe("posted");
        });

        it("same batch: identical repeated marks marks second as duplicate", async () => {
          const existingAsset = {
            id: "asset-val-batch-3",
            name: "Batch Identical Co",
            legal_name: null,
            instrument_terms: { sheetCode: "BID1" },
          };
          flAssetRepo.findByWorkspaceId.mockResolvedValue([existingAsset]);
          flAssetRepo.findById.mockImplementation(async (_ws, id) =>
            id === "asset-val-batch-3" ? existingAsset : null,
          );
          flPositionService.getOrOpenPosition.mockResolvedValue({
            id: "pos-bid-1",
            asset_id: "asset-val-batch-3",
            holder_fund_id: "fund-others",
          });
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-bid-1", asset_id: "asset-val-batch-3", holder_fund_id: "fund-others" },
          ]);

          flValuationRepo.findByWorkspaceId.mockResolvedValue([]);
          flValuationRepo.findByPositionIdsAndAsOfDates.mockResolvedValue([]);

          const recordResult = {
            id: "val-bid-1",
            asset_id: null,
            fund_id: null,
            position_id: "pos-bid-1",
            as_of_date: "2024-03-31",
            market_value: "80000.00000000",
            currency: "USD",
            valuation_method: "at_cost",
            price_per_unit: null,
            units_outstanding: null,
            gross_value: null,
            notes: null,
            data_status: "verified",
          };
          const flValRecordSpy = vi.fn().mockResolvedValue(recordResult);
          const flValUpdateSpy = vi.fn();
          flValuationService.record = flValRecordSpy;
          flValuationService.update = flValUpdateSpy;

          const proposed = sampleAsset({
            code: "BID1",
            name: "Batch Identical Co",
            fund: "Others",
            currency: "USD",
            txns: [],
            valuations: [
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 80000,
                pricePerShare: null,
                sharesOutstanding: null,
                periodLabel: null,
                sourceRow: 10,
              }),
              sampleValuation({
                asOfDate: "2024-03-31",
                marketValue: 80000,
                pricePerShare: null,
                sharesOutstanding: null,
                periodLabel: null,
                sourceRow: 11,
              }),
            ],
          });

          const result = await service.applySelected(
            [proposed],
            ["BID1"],
            [
              {
                asset_code: "BID1",
                txns: [],
                valuations: proposed.valuations,
              },
            ],
          );

          expect(result.valuations_upserted).toBe(1);
          expect(flValRecordSpy).toHaveBeenCalledTimes(1);
          expect(flValUpdateSpy).not.toHaveBeenCalled();

          const valOutcomes = (result.outcomes ?? []).filter(
            (o) => o.family === "valuation",
          );
          expect(valOutcomes.length).toBe(2);
          expect(valOutcomes[0].disposition).toBe("posted");
          expect(valOutcomes[1].disposition).toBe("duplicate");
        });
      });
    });

    describe("Phase 2b — investor-held positions and group parent investors", () => {
      it("opens a position with holder_investor_id + asset_id and no holder_fund_id for holderKind: 'investor' direct asset", async () => {
        const asset = sampleAsset({
          code: "DIR-INV",
          name: "Acme Corp",
          assetType: "direct_investment",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        const result = await service.applySelected([asset], ["DIR-INV"]);

        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_investor_id: "inv-Meranti Global Investment Ltd",
            asset_id: "asset-new",
          }),
          mockTxExecutor,
        );
        const callArgs = flPositionService.getOrOpenPosition.mock.calls[0][1];
        expect(callArgs.holder_fund_id).toBeUndefined();
        expect(result.created_assets).toBe(1);
      });

      it("opens holder_investor_id + fund_id and creates target external fund for holderKind: 'investor' fund-of-funds asset", async () => {
        const fofAsset = sampleAsset({
          code: "FOF-INV",
          name: "Target Venture Fund",
          assetType: "fund_of_funds",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
          valuations: [],
        });

        const result = await service.applySelected([fofAsset], ["FOF-INV"]);

        expect(flMasterDataService.createFund).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "Target Venture Fund",
            managed: false,
            ownership_basis: "capital_account",
          }),
          mockTxExecutor,
        );
        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_investor_id: "inv-Meranti Global Investment Ltd",
            fund_id: "fund-Target Venture Fund",
          }),
          mockTxExecutor,
        );
        const callArgs = flPositionService.getOrOpenPosition.mock.calls[0][1];
        expect(callArgs.holder_fund_id).toBeUndefined();
        expect(result.created_funds).toBe(1);
      });

      it("does not create fl_funds row for a group name on the investor path", async () => {
        flFundRepo.findByWorkspaceId.mockResolvedValue([]);

        const asset = sampleAsset({
          code: "DIR-INV-2",
          name: "Beta Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        await service.applySelected([asset], ["DIR-INV-2"]);

        expect(flMasterDataService.createFund).not.toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({ name: "Meranti 1" }),
          expect.anything(),
        );
        expect(flFundRepo.insert).not.toHaveBeenCalled();
      });

      it("REGRESSION: an entity with an existing parent_investor_id different from the workbook's computed group keeps its parent after an apply", async () => {
        flInvestorRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: "inv-custom-parented",
            name: "Meranti Global Investment Ltd",
            canonical_name: "meranti global investment ltd",
            parent_investor_id: "inv-Custom Group",
            investor_type: "institution",
          },
          {
            id: "inv-Custom Group",
            name: "Custom Group",
            canonical_name: "custom group",
            parent_investor_id: null,
            investor_type: "internal_entity",
          },
        ]);

        const asset = sampleAsset({
          code: "DIR-INV-REGRESSION",
          name: "Gamma Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        await service.applySelected([asset], ["DIR-INV-REGRESSION"]);

        expect(flInvestorRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          "inv-custom-parented",
          expect.objectContaining({ parent_investor_id: expect.anything() }),
          expect.anything(),
        );
      });

      it("explicitly sets parent_investor_id to group investor, including pre-existing unparented investor (parent_investor_id: null)", async () => {
        flInvestorRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: "inv-pre-seeded",
            name: "Meranti Global Investment Ltd",
            canonical_name: "meranti global investment ltd",
            parent_investor_id: null,
            investor_type: "institution",
          },
        ]);

        const asset = sampleAsset({
          code: "DIR-INV-PRE",
          name: "Gamma Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        await service.applySelected([asset], ["DIR-INV-PRE"]);

        expect(flInvestorRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "inv-pre-seeded",
          { parent_investor_id: "inv-Meranti 1" },
          mockTxExecutor,
        );
      });

      it("sets group for a newly created investor on the same apply", async () => {
        flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);

        const asset = sampleAsset({
          code: "DIR-INV-NEW",
          name: "Zeta Tech",
          holderKind: "investor",
          holderName: "Brand New Investor Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        await service.applySelected([asset], ["DIR-INV-NEW"]);

        expect(flInvestorRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "inv-Brand New Investor Ltd",
          { parent_investor_id: "inv-Meranti 1" },
          mockTxExecutor,
        );
      });

      it("resolves holder to UNATTRIBUTED_ENTITY and groups under Others when entityIsUnattributed: true", async () => {
        const asset = sampleAsset({
          code: "DIR-UNATTRIBUTED",
          name: "Delta Tech",
          holderKind: "investor",
          holderName: UNATTRIBUTED_ENTITY,
          entityIsUnattributed: true,
          group: "Others",
          fund: "Others",
        });

        await service.applySelected([asset], ["DIR-UNATTRIBUTED"]);

        expect(flMasterDataService.getOrCreateInvestor).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: UNATTRIBUTED_ENTITY,
            investor_type: "institution",
          }),
          mockTxExecutor,
        );
        expect(flMasterDataService.getOrCreateInvestor).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "Others",
            investor_type: "internal_entity",
          }),
          mockTxExecutor,
        );
        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_investor_id: `inv-${UNATTRIBUTED_ENTITY}`,
            asset_id: "asset-new",
          }),
          mockTxExecutor,
        );
        expect(flInvestorRepo.update).toHaveBeenCalledWith(
          "ws-1",
          `inv-${UNATTRIBUTED_ENTITY}`,
          { parent_investor_id: "inv-Others" },
          mockTxExecutor,
        );
      });

      it("creates one investor under literal name for composite entity (entityIsComposite: true) without splitting", async () => {
        const compositeName = "Meranti Global Investment Ltd. & Startech Growth VCC";
        const asset = sampleAsset({
          code: "DIR-COMPOSITE",
          name: "Epsilon Tech",
          holderKind: "investor",
          holderName: compositeName,
          entityIsComposite: true,
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        await service.applySelected([asset], ["DIR-COMPOSITE"]);

        expect(flMasterDataService.getOrCreateInvestor).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: compositeName,
            investor_type: "institution",
          }),
          mockTxExecutor,
        );
        expect(flMasterDataService.getOrCreateInvestor).not.toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({ name: "Startech Growth VCC" }),
          expect.anything(),
        );
      });

      it("regression: opens holder_fund_id + asset_id and creates fund for holderKind: 'fund' (or absent)", async () => {
        const assetNoHolderKind = sampleAsset({
          code: "DIR-LEGACY",
          name: "Legacy Tech",
          holderKind: undefined,
          fund: "New Fund X",
        });

        await service.applySelected([assetNoHolderKind], ["DIR-LEGACY"]);

        expect(flMasterDataService.getOrCreateFund).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "New Fund X",
            managed: true,
            ownership_basis: "commitment",
          }),
          mockTxExecutor,
        );
        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_fund_id: "fund-New Fund X",
            asset_id: "asset-new",
          }),
          mockTxExecutor,
        );
        const callArgs = flPositionService.getOrOpenPosition.mock.calls[0][1];
        expect(callArgs.holder_investor_id).toBeUndefined();
      });

      it("counts group investors in created_groups, not created_funds", async () => {
        const asset = sampleAsset({
          code: "DIR-COUNT",
          name: "Zeta Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });

        const result = await service.applySelected([asset], ["DIR-COUNT"]);

        expect(result.created_groups).toBe(1);
        expect(result.created_funds).toBe(0);
      });

      it("respects fundsAllowList for parent group attribution on the investor path without discarding positions", async () => {
        const assetInGroup = sampleAsset({
          code: "DIR-ALLOWED",
          name: "Allowed Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });
        const assetOtherGroup = sampleAsset({
          code: "DIR-DISALLOWED",
          name: "Disallowed Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 2",
          fund: "Meranti 2",
        });

        const result = await service.applySelected(
          [assetInGroup, assetOtherGroup],
          ["DIR-ALLOWED", "DIR-DISALLOWED"],
          undefined,
          undefined,
          { funds: ["Meranti 1"] },
        );

        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_investor_id: "inv-Meranti Global Investment Ltd",
          }),
          mockTxExecutor,
        );
        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledTimes(2);
        expect(flInvestorRepo.update).toHaveBeenCalledWith(
          "ws-1",
          "inv-Meranti Global Investment Ltd",
          { parent_investor_id: "inv-Meranti 1" },
          mockTxExecutor,
        );
        expect(flInvestorRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          expect.anything(),
          expect.objectContaining({ parent_investor_id: "inv-Meranti 2" }),
          expect.anything(),
        );
        expect(result.created_groups).toBe(1);
        expect(result.created_funds).toBe(0);
      });

      it("does not create an fl_funds row for any staged group name and creates a parent investor for the selected group only", async () => {
        flInvestorRepo.findByWorkspaceId.mockResolvedValue([]);
        flFundRepo.findByWorkspaceId.mockResolvedValue([]);

        const assetGroup1 = sampleAsset({
          code: "DIR-GRP-1",
          name: "Alpha Tech",
          holderKind: "investor",
          holderName: "Meranti Global Investment Ltd",
          group: "Meranti 1",
          fund: "Meranti 1",
        });
        const assetGroup2 = sampleAsset({
          code: "DIR-GRP-2",
          name: "Beta Tech",
          holderKind: "investor",
          holderName: "Startech Partner LLC",
          group: "Meranti 2",
          fund: "Meranti 2",
        });

        const result = await service.applySelected(
          [assetGroup1, assetGroup2],
          ["DIR-GRP-1"],
          undefined,
          undefined,
          {
            funds: ["Meranti 1", "Meranti 2"],
          },
        );

        // 1. No fund is created for either group name (getOrCreateFund is never called with them)
        expect(flMasterDataService.getOrCreateFund).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ name: "Meranti 1" }),
          expect.anything(),
        );
        expect(flMasterDataService.getOrCreateFund).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ name: "Meranti 2" }),
          expect.anything(),
        );

        // 2. A parent investor is created for the selected group only
        expect(flMasterDataService.getOrCreateInvestor).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            name: "Meranti 1",
            investor_type: "internal_entity",
          }),
          mockTxExecutor,
        );
        expect(flMasterDataService.getOrCreateInvestor).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            name: "Meranti 2",
          }),
          expect.anything(),
        );
        expect(result.created_groups).toBe(1);
        expect(result.created_funds).toBe(0);
      });

      it("REGRESSION 01FN: posts transactions for investor-held FoF when group/fund 'Others' is omitted", async () => {
        const targetFundId = "fund-01-fintech-id";
        const holderInvestorId = "inv-smma-id";
        const fundingSourceId = "src-bank-id";

        flFundRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: targetFundId,
            name: "01 Fintech",
            canonical_name: "01 fintech",
            managed: false,
            ownership_basis: "capital_account",
            base_currency: "USD",
          } as any,
        ]);

        flInvestorRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: holderInvestorId,
            name: "PT Sinar Mas Multiartha Tbk",
            canonical_name: "pt sinar mas multiartha tbk",
            parent_investor_id: null,
            investor_type: "institution",
          } as any,
        ]);

        flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: fundingSourceId,
            name: "Bank Account",
            canonical_name: "bank account",
          } as any,
        ]);

        const fofAsset = sampleAsset({
          code: "01FN",
          name: "01 Fintech",
          assetType: "fund_of_funds",
          holderKind: "investor",
          holderName: "PT Sinar Mas Multiartha Tbk",
          entity: "PT Sinar Mas Multiartha Tbk",
          fundingSource: "Bank Account",
          group: "Others",
          fund: "Others",
          txns: [
            sampleTxn({ date: "2023-01-15", type: "contribution", valueAmount: 100_000, currency: "USD" }),
            sampleTxn({ date: "2023-04-15", type: "contribution", valueAmount: 200_000, currency: "USD" }),
            sampleTxn({ date: "2023-07-15", type: "contribution", valueAmount: 300_000, currency: "USD" }),
          ],
          valuations: [],
        });

        const result = await service.applySelected(
          [fofAsset],
          ["01FN"],
          [
            {
              asset_code: "01FN",
              matched_target_id: targetFundId,
              txns: fofAsset.txns,
              valuations: [],
            },
          ],
          undefined,
          {
            funds: ["01 Fintech"], // deliberately omitting 'Others'
            investors: ["PT Sinar Mas Multiartha Tbk"],
            sources: ["Bank Account"],
          },
        );

        expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
          "ws-1",
          expect.objectContaining({
            holder_investor_id: holderInvestorId,
            fund_id: targetFundId,
            holder_source_of_fund_id: fundingSourceId,
          }),
          mockTxExecutor,
        );
        const posCall = flPositionService.getOrOpenPosition.mock.calls[0][1];
        expect(posCall.holder_fund_id).toBeUndefined();

        expect(result.txns_inserted).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.updated_assets).toBe(1);
        expect(result.applied).toBe(1);
        expect(result.created_groups).toBe(0);
        expect(flInvestorRepo.update).not.toHaveBeenCalledWith(
          "ws-1",
          holderInvestorId,
          expect.objectContaining({ parent_investor_id: expect.anything() }),
          expect.anything(),
        );
      });

      it("negative test: omission of the holder investor still prevents position opening and transaction posting", async () => {
        const targetFundId = "fund-01-fintech-id";
        const holderInvestorId = "inv-smma-id";
        const fundingSourceId = "src-bank-id";

        flFundRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: targetFundId,
            name: "01 Fintech",
            canonical_name: "01 fintech",
            managed: false,
            ownership_basis: "capital_account",
            base_currency: "USD",
          } as any,
        ]);

        flInvestorRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: holderInvestorId,
            name: "PT Sinar Mas Multiartha Tbk",
            canonical_name: "pt sinar mas multiartha tbk",
            parent_investor_id: null,
            investor_type: "institution",
          } as any,
        ]);

        flFundingSourceRepo.findByWorkspaceId.mockResolvedValue([
          {
            id: fundingSourceId,
            name: "Bank Account",
            canonical_name: "bank account",
          } as any,
        ]);

        const fofAsset = sampleAsset({
          code: "01FN",
          name: "01 Fintech",
          assetType: "fund_of_funds",
          holderKind: "investor",
          holderName: "PT Sinar Mas Multiartha Tbk",
          entity: "PT Sinar Mas Multiartha Tbk",
          fundingSource: "Bank Account",
          group: "Others",
          fund: "Others",
          txns: [
            sampleTxn({ date: "2023-01-15", type: "contribution", valueAmount: 100_000, currency: "USD" }),
            sampleTxn({ date: "2023-04-15", type: "contribution", valueAmount: 200_000, currency: "USD" }),
            sampleTxn({ date: "2023-07-15", type: "contribution", valueAmount: 300_000, currency: "USD" }),
          ],
          valuations: [],
        });

        await expect(
          service.applySelected(
            [fofAsset],
            ["01FN"],
            [
              {
                asset_code: "01FN",
                matched_target_id: targetFundId,
                txns: fofAsset.txns,
                valuations: [],
              },
            ],
            undefined,
            {
              funds: ["01 Fintech"],
              investors: [], // holder investor deliberately omitted!
              sources: ["Bank Account"],
            },
          ),
        ).rejects.toThrow(
          new FundUpdateValidationError(
            'Cannot apply 3 selected transaction(s) for asset "01FN" (01 Fintech): unresolved position for holder "PT Sinar Mas Multiartha Tbk".',
          ),
        );

        expect(flPositionService.getOrOpenPosition).not.toHaveBeenCalled();
      });

      it("preserves legitimate skip behavior when an asset has no selected transactions or valuations", async () => {
        const targetFundId = "fund-01-fintech-id";
        const fofAsset = sampleAsset({
          code: "01FN",
          name: "01 Fintech",
          assetType: "fund_of_funds",
          holderKind: "investor",
          holderName: "PT Sinar Mas Multiartha Tbk",
          entity: "PT Sinar Mas Multiartha Tbk",
          fundingSource: "Bank Account",
          group: "Others",
          fund: "Others",
          txns: [],
          valuations: [],
        });

        const result = await service.applySelected(
          [fofAsset],
          ["01FN"],
          [
            {
              asset_code: "01FN",
              matched_target_id: targetFundId,
              txns: [],
              valuations: [],
            },
          ],
          undefined,
          {
            funds: ["01 Fintech"],
            investors: [], // holder investor omitted, but 0 txns selected
            sources: ["Bank Account"],
          },
        );

        expect(flPositionService.getOrOpenPosition).not.toHaveBeenCalled();
        expect(result.txns_inserted).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.applied).toBe(0);
      });
    });

    describe("Startech ledger replay deduplication (confirmed mismatches & round-trips)", () => {
      const investorHolder: CashHolderCandidate = {
        holder_investor_id: "inv-1",
        holderFundManaged: false,
      };
      const confirmedRows: Array<{
        name: string;
        txn: ParsedTxn;
        expectedKey: string;
      }> = [
        {
          name: "SSTU row 26 (other, negative fractional value, expenses)",
          txn: {
            date: "2022-09-13",
            type: "other",
            subTypeLabel: "Others",
            valueAmount: -1922.41675248884,
            shareCount: null,
            pricePerShare: null,
            currency: "USD",
            fxRate: null,
            notes: "Expenses",
            sellProceedsDestination: null,
          },
          expectedKey: "2022-09-13|expense|-1922.41675249|||USD",
        },
        {
          name: "MEGA row 92 (divestment, negative value)",
          txn: {
            date: "2025-04-22",
            type: "divestment",
            subTypeLabel: null,
            valueAmount: -3436548.21,
            shareCount: null,
            pricePerShare: null,
            currency: "USD",
            fxRate: null,
            notes: null,
            sellProceedsDestination: "distributed_to_investor",
          },
          expectedKey: "2025-04-22|divestment|3436548.21|||USD",
        },
        {
          name: "XTAL row 28 (other, negative whole value, expenses)",
          txn: {
            date: "2025-08-21",
            type: "other",
            subTypeLabel: "Others",
            valueAmount: -2400000,
            shareCount: null,
            pricePerShare: null,
            currency: "USD",
            fxRate: null,
            notes: "Expenses",
            sellProceedsDestination: null,
          },
          expectedKey: "2025-08-21|expense|-2400000|||USD",
        },
        {
          name: "XTAL row 29 (other, negative high-precision value, expenses)",
          txn: {
            date: "2025-08-21",
            type: "other",
            subTypeLabel: "Others",
            valueAmount: -1034612.6859154929,
            shareCount: null,
            pricePerShare: null,
            currency: "USD",
            fxRate: null,
            notes: "Expenses",
            sellProceedsDestination: null,
          },
          expectedKey: "2025-08-21|expense|-1034612.68591549|||USD",
        },
      ];

      for (const { name, txn, expectedKey } of confirmedRows) {
        it(`produces matching pre-persistence and reconstructed replay keys for ${name}`, () => {
          const proposalKey = fundUpdateTxnKey(txn);
          expect(proposalKey).toBe(expectedKey);

          // Persisted entry via mapFundUpdateTxn on fund position
          const mappedFund = mapFundUpdateTxn(txn, "fund", investorHolder);
          if (name.includes("MEGA row 92")) {
            expect(mappedFund.subType).toBe("divestment");
          }
          const ledgerEntryFromFund = {
            entry_date: txn.date,
            entry_type: mappedFund.entryType,
            sub_type: mappedFund.subType,
            cash_delta: mappedFund.cashDelta,
            currency: txn.currency || "USD",
            notes: txn.notes ?? null,
            quantity_delta: mappedFund.quantityDelta ?? null,
            price_per_unit: mappedFund.pricePerUnit ?? null,
          } as never;
          const replayKeyFromFund = existingLedgerEntryTxnKey(ledgerEntryFromFund);
          expect(replayKeyFromFund).toBe(expectedKey);
          expect(proposalKey).toBe(replayKeyFromFund);

          // Persisted entry via mapFundUpdateTxn on asset position
          const mappedAsset = mapFundUpdateTxn(txn, "asset", investorHolder);
          if (name.includes("MEGA row 92")) {
            expect(mappedAsset.subType).toBe("divestment");
          }
          const ledgerEntryFromAsset = {
            entry_date: txn.date,
            entry_type: mappedAsset.entryType,
            sub_type: mappedAsset.subType,
            cash_delta: mappedAsset.cashDelta,
            currency: txn.currency || "USD",
            notes: txn.notes ?? null,
            quantity_delta: mappedAsset.quantityDelta ?? null,
            price_per_unit: mappedAsset.pricePerUnit ?? null,
          } as never;
          const replayKeyFromAsset = existingLedgerEntryTxnKey(ledgerEntryFromAsset);
          expect(replayKeyFromAsset).toBe(expectedKey);
          expect(proposalKey).toBe(replayKeyFromAsset);
        });
      }

      describe("negative round-trip tests: genuinely different transactions do not dedup", () => {
        const baseTxn: ParsedTxn = {
          date: "2022-09-13",
          type: "expense",
          subTypeLabel: "Expenses",
          valueAmount: -1922.41675248884,
          shareCount: null,
          pricePerShare: null,
          currency: "USD",
          fxRate: null,
          notes: "Expenses",
        };
        const baseMapped = mapFundUpdateTxn(baseTxn, "fund", investorHolder);
        const baseEntry = {
          entry_date: baseTxn.date,
          entry_type: baseMapped.entryType,
          sub_type: baseMapped.subType,
          cash_delta: baseMapped.cashDelta,
          currency: "USD",
          quantity_delta: baseMapped.quantityDelta ?? null,
          price_per_unit: baseMapped.pricePerUnit ?? null,
        } as never;
        const baseReplayKey = existingLedgerEntryTxnKey(baseEntry);

        it("does not dedup when date differs", () => {
          const diffDateTxn: ParsedTxn = { ...baseTxn, date: "2022-09-14" };
          expect(fundUpdateTxnKey(diffDateTxn)).not.toBe(baseReplayKey);
        });

        it("does not dedup when value differs", () => {
          const diffValTxn: ParsedTxn = { ...baseTxn, valueAmount: -1922.41675248 };
          expect(fundUpdateTxnKey(diffValTxn)).not.toBe(baseReplayKey);
        });

        it("does not dedup when semantic type differs without collapsing named categories", () => {
          const rocTxn: ParsedTxn = { ...baseTxn, type: "return_of_capital" };
          const interestTxn: ParsedTxn = { ...baseTxn, type: "interest_income" };
          const contribTxn: ParsedTxn = { ...baseTxn, type: "contribution" };
          const divestTxn: ParsedTxn = { ...baseTxn, type: "divestment" };
          expect(fundUpdateTxnKey(rocTxn)).not.toBe(baseReplayKey);
          expect(fundUpdateTxnKey(interestTxn)).not.toBe(baseReplayKey);
          expect(fundUpdateTxnKey(contribTxn)).not.toBe(baseReplayKey);
          expect(fundUpdateTxnKey(divestTxn)).not.toBe(baseReplayKey);
        });

        it("does not dedup when shares or price differ", () => {
          const withSharesTxn: ParsedTxn = { ...baseTxn, shareCount: 50 };
          const withPriceTxn: ParsedTxn = { ...baseTxn, pricePerShare: 10 };
          expect(fundUpdateTxnKey(withSharesTxn)).not.toBe(baseReplayKey);
          expect(fundUpdateTxnKey(withPriceTxn)).not.toBe(baseReplayKey);
        });

        it("does not dedup when currency differs", () => {
          const diffCurrencyTxn: ParsedTxn = { ...baseTxn, currency: "CNY" };
          expect(fundUpdateTxnKey(diffCurrencyTxn)).not.toBe(baseReplayKey);
        });

        it("matches signed positive expense magnitude against stored negative expense cash delta", () => {
          const positiveExpenseTxn: ParsedTxn = { ...baseTxn, valueAmount: 1922.41675248884 };
          expect(fundUpdateTxnKey(positiveExpenseTxn)).toBe(baseReplayKey);
        });

        it("does not dedup when cash sign differs for non-expense (positive vs negative same-magnitude)", () => {
          const otherPositiveTxn: ParsedTxn = {
            date: "2022-09-13",
            type: "other",
            subTypeLabel: "Unclassified",
            valueAmount: 1922.41675248884,
            shareCount: null,
            pricePerShare: null,
            currency: "USD",
            fxRate: null,
            notes: null,
          };
          const otherNegativeTxn: ParsedTxn = {
            ...otherPositiveTxn,
            valueAmount: -1922.41675248884,
          };
          expect(fundUpdateTxnKey(otherPositiveTxn)).not.toBe(fundUpdateTxnKey(otherNegativeTxn));
        });
      });

      describe("service integration: review and apply dedup enforcement", () => {
        it("reports all four confirmed Startech rows as duplicates during review re-upload", async () => {
          const proposedTxns: ParsedTxn[] = confirmedRows.map((r) => r.txn);
          const simulatedEntries = proposedTxns.map((txn, idx) => {
            const mapped = mapFundUpdateTxn(txn, "fund", investorHolder);
            return {
              id: `entry-${idx}`,
              position_id: "pos-1",
              entry_date: txn.date,
              entry_type: mapped.entryType,
              sub_type: mapped.subType,
              cash_delta: mapped.cashDelta,
              currency: txn.currency || "USD",
              notes: txn.notes ?? null,
              quantity_delta: mapped.quantityDelta ?? null,
              price_per_unit: mapped.pricePerUnit ?? null,
            };
          });

          flAssetRepo.findByWorkspaceId.mockResolvedValue([
            {
              id: "asset-startech",
              name: "Startech Portfolio Asset",
              instrument_terms: { sheetCode: "SSTU" },
            },
          ]);
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-1", asset_id: "asset-startech" },
          ]);
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue(simulatedEntries);
          flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

          const proposedAsset = sampleAsset({
            code: "SSTU",
            name: "Startech Portfolio Asset",
            txns: proposedTxns,
            valuations: [],
          });

          const fullReview = await service.buildFullReview([proposedAsset]);
          expect(fullReview.assets).toHaveLength(1);
          const assetReview = fullReview.assets[0];

          expect(assetReview.status).toBe("unchanged");
          expect(assetReview.missing_txns).toHaveLength(0);
          expect(assetReview.missing_txn_count).toBe(0);
          expect(assetReview.existing_txn_count).toBe(4);
        });

        it("preserves actionable corrections in buildFullReview when economic fields differ", async () => {
          const proposedTxns: ParsedTxn[] = confirmedRows.map((r) => r.txn);
          const simulatedEntries = proposedTxns.map((txn, idx) => {
            const mapped = mapFundUpdateTxn(txn, "fund", investorHolder);
            return {
              id: `entry-${idx}`,
              position_id: "pos-1",
              entry_date: txn.date,
              entry_type: mapped.entryType,
              sub_type: mapped.subType,
              cash_delta: mapped.cashDelta,
              currency: txn.currency || "USD",
              notes: txn.notes ?? null,
              quantity_delta: mapped.quantityDelta ?? null,
              price_per_unit: mapped.pricePerUnit ?? null,
            };
          });

          flAssetRepo.findByWorkspaceId.mockResolvedValue([
            {
              id: "asset-startech",
              name: "Startech Portfolio Asset",
              instrument_terms: { sheetCode: "SSTU" },
            },
          ]);
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-1", asset_id: "asset-startech" },
          ]);
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue(simulatedEntries);
          flValuationRepo.findByWorkspaceId.mockResolvedValue([]);

          // 4 unchanged rows plus 1 genuine correction row
          const correctionTxn: ParsedTxn = {
            date: "2025-05-01",
            type: "other",
            subTypeLabel: "Others",
            valueAmount: -500000,
            shareCount: null,
            pricePerShare: null,
            fxRate: null,
            notes: null,
          };

          const proposedAsset = sampleAsset({
            code: "SSTU",
            name: "Startech Portfolio Asset",
            txns: [...proposedTxns, correctionTxn],
            valuations: [],
          });

          const fullReview = await service.buildFullReview([proposedAsset]);
          expect(fullReview.assets).toHaveLength(1);
          const assetReview = fullReview.assets[0];

          expect(assetReview.status).toBe("add_missing");
          expect(assetReview.missing_txns).toHaveLength(1);
          expect(assetReview.missing_txn_count).toBe(1);
          expect(assetReview.missing_txns[0]).toEqual(expect.objectContaining(correctionTxn));
        });

        it("inserts zero duplicate entries on applySelected replay for all four confirmed rows", async () => {
          const proposedTxns: ParsedTxn[] = confirmedRows.map((r) => r.txn);
          const simulatedEntries = proposedTxns.map((txn, idx) => {
            const mapped = mapFundUpdateTxn(txn, "fund", investorHolder);
            return {
              id: `entry-${idx}`,
              position_id: "pos-1",
              entry_date: txn.date,
              entry_type: mapped.entryType,
              sub_type: mapped.subType,
              cash_delta: mapped.cashDelta,
              currency: txn.currency || "USD",
              notes: txn.notes ?? null,
              quantity_delta: mapped.quantityDelta ?? null,
              price_per_unit: mapped.pricePerUnit ?? null,
            };
          });

          flAssetRepo.findByWorkspaceId.mockResolvedValue([
            {
              id: "asset-startech",
              name: "Startech Portfolio Asset",
              instrument_terms: { sheetCode: "SSTU" },
            },
          ]);
          flPositionRepo.findByAssetIds.mockResolvedValue([
            { id: "pos-1", asset_id: "asset-startech", fund_id: "f-1" },
          ]);
          flLedgerEntryRepo.findAllByPositionIds.mockResolvedValue(simulatedEntries);

          const proposedAsset = sampleAsset({
            code: "SSTU",
            name: "Startech Portfolio Asset",
            txns: proposedTxns,
            valuations: [],
          });

          const result = await service.applySelected(
            [proposedAsset],
            ["SSTU"],
          );

          expect(result.txns_inserted).toBe(0);
          expect(flLedgerService.postEvent).not.toHaveBeenCalled();
        });
      });

      describe("allowlist keying with both raw-lowercase and normalizeCanonicalName forms", () => {
        it("recognises staged investor with full-width parentheses so position opens and txn posts", async () => {
          const stagedHolder = "南京月升星繁创业投资合伙企业（有限合伙）";
          const assetHolder = "南京月升星繁创业投资合伙企业(有限合伙)";
          const asset = sampleAsset({
            code: "NJ-1",
            name: "Nanjing Asset",
            holderKind: "investor",
            holderName: assetHolder,
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [],
          });

          const result = await service.applySelected(
            [asset],
            ["NJ-1"],
            undefined,
            undefined,
            {
              funds: ["Others"],
              investors: [stagedHolder],
              sources: [],
            },
          );

          expect(result.applied).toBe(1);
          expect(result.txns_inserted).toBe(1);
          expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              holder_investor_id: expect.any(String),
            }),
            expect.anything(),
          );
          expect(flLedgerService.postEvent).toHaveBeenCalled();
        });

        it("recognises staged fund with full-width parentheses so position opens and txn posts", async () => {
          const stagedFund = "南京瑞满创业投资合伙企业（有限合伙）";
          const proposedFund = "南京瑞满创业投资合伙企业(有限合伙)";
          const asset = sampleAsset({
            code: "NJ-FUND-1",
            name: "Nanjing Fund Asset",
            holderKind: "fund",
            fund: proposedFund,
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [],
          });

          const result = await service.applySelected(
            [asset],
            ["NJ-FUND-1"],
            undefined,
            undefined,
            {
              funds: [stagedFund],
              investors: [],
              sources: [],
            },
          );

          expect(result.applied).toBe(1);
          expect(result.txns_inserted).toBe(1);
          expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              holder_fund_id: expect.any(String),
            }),
            expect.anything(),
          );
          expect(flLedgerService.postEvent).toHaveBeenCalled();
        });

        it("recognises staged source with full-width parentheses so position opens with fundingSource", async () => {
          const stagedSource = "自有资金（专项账户）";
          const proposedSource = "自有资金(专项账户)";
          const asset = sampleAsset({
            code: "NJ-SRC-1",
            name: "Nanjing Sourced Asset",
            holderKind: "fund",
            fund: "Others",
            fundingSource: proposedSource,
            fundingSourceRaw: proposedSource,
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [],
          });

          const result = await service.applySelected(
            [asset],
            ["NJ-SRC-1"],
            undefined,
            undefined,
            {
              funds: ["Others"],
              investors: [],
              sources: [stagedSource],
            },
          );

          expect(result.applied).toBe(1);
          expect(flPositionService.getOrOpenPosition).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              holder_source_of_fund_id: expect.any(String),
            }),
            expect.anything(),
          );
        });

        it("rejects genuinely unstaged entity so allowlist is not a pass-through", async () => {
          const stagedHolder = "南京月升星繁创业投资合伙企业（有限合伙）";
          const unstagedHolder = "完全未暂存的外部投资人";
          const asset = sampleAsset({
            code: "UNSTAGED-1",
            name: "Unstaged Holder Asset",
            holderKind: "investor",
            holderName: unstagedHolder,
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [],
          });

          await expect(
            service.applySelected(
              [asset],
              ["UNSTAGED-1"],
              undefined,
              undefined,
              {
                funds: ["Others"],
                investors: [stagedHolder],
                sources: [],
              },
            ),
          ).rejects.toThrow(
            `Cannot apply 1 selected transaction(s) for asset "UNSTAGED-1" (Unstaged Holder Asset): unresolved position for holder "${unstagedHolder}".`,
          );
        });

        it("does not match empty normalized strings when allowlist contains empty/whitespace entries", async () => {
          const asset = sampleAsset({
            code: "UNSTAGED-EMPTY-1",
            name: "Empty Holder Asset",
            holderKind: "investor",
            holderName: "任意未暂存投资人",
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2023-01-01",
                type: "contribution",
                pricePerShare: 10,
                shareCount: 100,
                valueAmount: 1000,
              }),
            ],
            valuations: [],
          });

          await expect(
            service.applySelected(
              [asset],
              ["UNSTAGED-EMPTY-1"],
              undefined,
              undefined,
              {
                funds: ["Others"],
                investors: ["", "   "],
                sources: [],
              },
            ),
          ).rejects.toThrow(/unresolved position for holder/);
        });
      });

      describe("Phase 2 — fund-only cash ownership, unstated proceeds defaulting, and review", () => {
        it("surfaces defaulted cash_in_fund in buildFullReview for managed fund and strips treatment for investor holder", async () => {
          const managedAsset = sampleAsset({
            code: "MGD-SALE",
            name: "Managed Asset With Unstated Sale",
            fund: "Startech Growth Fund 1",
            holderKind: "fund",
            txns: [
              sampleTxn({
                date: "2024-03-01",
                type: "sell" as never,
                valueAmount: 1000,
                shareCount: 100,
                pricePerShare: 10,
                sellProceedsDestination: null,
              }),
            ],
          });

          const investorAsset = sampleAsset({
            code: "INV-SALE",
            name: "Investor Asset With Stated Sale",
            holderKind: "investor",
            holderName: "Investor Alice",
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2024-03-01",
                type: "sell" as never,
                valueAmount: 2000,
                shareCount: 200,
                pricePerShare: 10,
                sellProceedsDestination: "cash_in_fund",
                subTypeLabel: "divestment:cash_in_fund",
              }),
            ],
          });

          const review = await service.buildFullReview([managedAsset, investorAsset]);

          // Managed fund sale without stated treatment defaults to 'cash_in_fund' in review
          const managedReviewItem = review.assets.find((a) => a.code === "MGD-SALE");
          expect(managedReviewItem).toBeDefined();
          expect(managedReviewItem?.proposed.txns[0].sellProceedsDestination).toBe("cash_in_fund");
          expect(
            review.two_step_review?.transactions.find((txn) => txn.assetCode === "MGD-SALE")
              ?.sellProceedsDestination,
          ).toBe("cash_in_fund");

          // Investor sale has no tracked cash destination.
          const investorReviewItem = review.assets.find((a) => a.code === "INV-SALE");
          expect(investorReviewItem).toBeDefined();
          expect(investorReviewItem?.proposed.txns[0].sellProceedsDestination).toBeNull();
          expect(investorReviewItem?.proposed.txns[0].subTypeLabel).toBe("divestment");
          expect(
            review.two_step_review?.transactions.find((txn) => txn.assetCode === "INV-SALE")
              ?.sellProceedsDestination,
          ).toBeNull();
        });

        it("surfaces warning in buildFullReview and fails early in applySelected for cash asset on ineligible investor holder", async () => {
          const cashAsset = sampleAsset({
            code: "CASH-ASSET",
            name: "Cash",
            assetType: "cash" as never,
            holderKind: "investor",
            holderName: "Investor Alice",
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2024-01-01",
                type: "contribution",
                valueAmount: 10000,
              }),
            ],
          });

          const review = await service.buildFullReview([cashAsset]);
          const item = review.assets.find((a) => a.code === "CASH-ASSET");
          expect(item?.warnings).toBeDefined();
          expect(item?.warnings?.some((w) => w.includes("Ineligible cash holder"))).toBe(true);

          await expect(
            service.applySelected([cashAsset], ["CASH-ASSET"]),
          ).rejects.toThrow(IneligibleCashHolderError);
        });

        it("does not report false unresolved proceeds treatment warning when existing and incoming both default on managed fund", async () => {
          flPositionRepo.findByAssetIds.mockResolvedValue([
            {
              id: "pos-asset-DUP-SALE-fund",
              asset_id: "asset-new",
              holder_fund_id: "f1",
            } as never,
          ]);
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
            {
              id: "entry-existing-div",
              position_id: "pos-asset-DUP-SALE-fund",
              entry_date: "2024-02-01",
              entry_type: "sell",
              sub_type: "divestment:cash_in_fund",
              cash_delta: "1000.00000000",
              quantity_delta: "-100.00000000",
              price_per_unit: "10.00000000",
              currency: "USD",
              created_at: "2024-02-01T00:00:00Z",
            } as never,
          ]);
          flLedgerEntryRepo.findAllByPositionIds.mockResolvedValue([
            {
              id: "entry-existing-div",
              position_id: "pos-asset-DUP-SALE-fund",
              entry_date: "2024-02-01",
              entry_type: "sell",
              sub_type: "divestment:cash_in_fund",
              cash_delta: "1000.00000000",
              quantity_delta: "-100.00000000",
              price_per_unit: "10.00000000",
              currency: "USD",
              created_at: "2024-02-01T00:00:00Z",
            } as never,
          ]);

          const incomingAsset = sampleAsset({
            code: "DUP-SALE",
            name: "Duplicate Sale Asset",
            fund: "Startech Growth Fund 1",
            holderKind: "fund",
            fundingSource: null,
            fundingSourceRaw: null,
            txns: [
              sampleTxn({
                date: "2024-02-01",
                type: "sell" as never,
                valueAmount: 1000,
                shareCount: 100,
                pricePerShare: 10,
                currency: "USD",
                fundingSource: null,
                fundingSourceId: null,
                sellProceedsDestination: null, // Unstated - auto-defaults to cash_in_fund
              }),
            ],
          });

          const result = await service.applySelected([incomingAsset], ["DUP-SALE"]);
          expect(result.txns_inserted).toBe(0);
          expect(result.catalog_warnings?.some((w) => w.includes("unresolved proceeds treatment"))).toBeFalsy();
          const outcome = result.outcomes.find((o) => o.assetCode === "DUP-SALE");
          expect(outcome?.disposition).toBe("duplicate");
          expect(outcome?.warnings).toBeUndefined();
        });

        it("reports differing proceeds treatment warning when existing is distributed and incoming is retained", async () => {
          flPositionRepo.findByAssetIds.mockResolvedValue([
            {
              id: "pos-asset-DIFF-SALE-fund",
              asset_id: "asset-new",
              holder_fund_id: "f1",
            } as never,
          ]);
          flLedgerEntryRepo.findByPositionIds.mockResolvedValue([
            {
              id: "entry-existing-dist",
              position_id: "pos-asset-DIFF-SALE-fund",
              entry_date: "2024-02-01",
              entry_type: "sell",
              sub_type: "divestment:distributed_to_investor",
              cash_delta: "1000.00000000",
              quantity_delta: "-100.00000000",
              price_per_unit: "10.00000000",
              currency: "USD",
              created_at: "2024-02-01T00:00:00Z",
            } as never,
          ]);
          flLedgerEntryRepo.findAllByPositionIds.mockResolvedValue([
            {
              id: "entry-existing-dist",
              position_id: "pos-asset-DIFF-SALE-fund",
              entry_date: "2024-02-01",
              entry_type: "sell",
              sub_type: "divestment:distributed_to_investor",
              cash_delta: "1000.00000000",
              quantity_delta: "-100.00000000",
              price_per_unit: "10.00000000",
              currency: "USD",
              created_at: "2024-02-01T00:00:00Z",
            } as never,
          ]);

          const incomingAsset = sampleAsset({
            code: "DIFF-SALE",
            name: "Differing Proceeds Asset",
            fund: "Startech Growth Fund 1",
            holderKind: "fund",
            txns: [
              sampleTxn({
                date: "2024-02-01",
                type: "sell" as never,
                valueAmount: 1000,
                shareCount: 100,
                pricePerShare: 10,
                currency: "USD",
                sellProceedsDestination: "cash_in_fund",
              }),
            ],
          });

          const result = await service.applySelected([incomingAsset], ["DIFF-SALE"]);
          expect(result.txns_inserted).toBe(0);
          expect(result.catalog_warnings?.some((w) => w.includes("differing proceeds treatment"))).toBe(true);
        });

        it("processes 退出 (+100 receipt) and 分配 (-60 payout) separately and nets correctly without investor cash account", async () => {
          // Nanjing-shaped import:
          // Exit receipt (退出): divestment with unstated destination resolves to cash_in_fund (+100)
          // Payout to investor (分配): separate fund outflow (-60)
          // The two rows are posted as separate events and never conflated.
          const pairedAsset = sampleAsset({
            code: "EXIT-PAYOUT-PAIR",
            name: "Exit and Payout Asset",
            fund: "Fund A",
            holderKind: "fund",
            txns: [
              sampleTxn({
                date: "2024-05-01",
                type: "sell" as never,
                valueAmount: 100,
                shareCount: 10,
                pricePerShare: 10,
                currency: "USD",
                sellProceedsDestination: null, // Unstated: resolves to cash_in_fund on managed fund
                notes: "退出 资金流入基金",
              }),
              sampleTxn({
                date: "2024-05-02",
                type: "expense" as never,
                valueAmount: 60,
                currency: "USD",
                notes: "分配 资金流出基金",
              }),
            ],
          });

          const result = await service.applySelected([pairedAsset], ["EXIT-PAYOUT-PAIR"]);
          expect(result.txns_inserted).toBe(2);

          // Verify receipt event: +100 cash_delta, divestment:cash_in_fund sub_type
          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              entries: [
                expect.objectContaining({
                  entry_type: "sell",
                  cash_delta: "100.00000000",
                  sub_type: "divestment:cash_in_fund",
                }),
              ],
            }),
            mockTxExecutor,
          );

          // Verify payout event: -60 cash_delta (separate outflow, never conflated)
          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              entries: [
                expect.objectContaining({
                  entry_type: "expense",
                  cash_delta: "-60.00000000",
                }),
              ],
            }),
            mockTxExecutor,
          );
        });

        it("posts investor-held sale with demoted proceeds treatment (sub_type 'divestment')", async () => {
          const investorSaleAsset = sampleAsset({
            code: "INV-SALE-POST",
            name: "Investor Sale Asset",
            holderKind: "investor",
            holderName: "Investor Alice",
            group: "Others",
            fund: "Others",
            txns: [
              sampleTxn({
                date: "2024-06-01",
                type: "sell" as never,
                valueAmount: 5000,
                shareCount: 50,
                pricePerShare: 100,
                currency: "USD",
                sellProceedsDestination: "cash_in_fund", // Ineligible holder: must be demoted to divestment
                notes: "Investor direct exit",
              }),
            ],
          });

          const result = await service.applySelected([investorSaleAsset], ["INV-SALE-POST"]);
          expect(result.txns_inserted).toBe(1);

          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              entries: [
                expect.objectContaining({
                  entry_type: "sell",
                  cash_delta: "5000.00000000",
                  quantity_delta: "-50.00000000",
                  price_per_unit: "100.00000000",
                  sub_type: "divestment", // Demoted to divestment (identity preserved)!
                }),
              ],
            }),
            mockTxExecutor,
          );
        });

        it("preserves distributed_to_investor treatment for uncreated fund created as managed on apply (Test 2)", async () => {
          const uncreatedFundAsset = sampleAsset({
            code: "UNCREATED-FUND-SALE",
            name: "Uncreated Fund Asset",
            fund: "New Uncreated Managed Fund",
            holderKind: "fund",
            txns: [
              sampleTxn({
                date: "2024-04-01",
                type: "sell" as never,
                valueAmount: 3000,
                shareCount: 30,
                pricePerShare: 100,
                currency: "USD",
                sellProceedsDestination: "distributed_to_investor",
                notes: "Sale distributed directly to LPs",
              }),
            ],
          });

          // 1. Review step: unresolved fund displays stated treatment and pending fund match note
          const review = await service.buildFullReview([uncreatedFundAsset]);
          const reviewAsset = review.assets.find((a) => a.code === "UNCREATED-FUND-SALE");
          expect(reviewAsset).toBeDefined();
          expect(reviewAsset?.proposed.txns[0].sellProceedsDestination).toBe("distributed_to_investor");
          expect(
            review.two_step_review?.transactions.find(
              (txn) => txn.assetCode === "UNCREATED-FUND-SALE",
            )?.sellProceedsDestination,
          ).toBe("distributed_to_investor");
          expect(reviewAsset?.proposed.txns[0].notes).toContain("pending fund match");

          // 2. Apply step: creates fund as managed: true, posts with distributed_to_investor
          const result = await service.applySelected([uncreatedFundAsset], ["UNCREATED-FUND-SALE"]);
          expect(result.txns_inserted).toBe(1);

          expect(flLedgerService.postEvent).toHaveBeenCalledWith(
            "ws-1",
            expect.objectContaining({
              entries: [
                expect.objectContaining({
                  entry_type: "sell",
                  cash_delta: "3000.00000000",
                  quantity_delta: "-30.00000000",
                  price_per_unit: "100.00000000",
                  sub_type: "divestment:distributed_to_investor",
                }),
              ],
            }),
            mockTxExecutor,
          );
        });

        it("shows cash_in_fund in both review models for an unstated sale on a new fund", async () => {
          const asset = sampleAsset({
            code: "NEW-FUND-UNSTATED-SALE",
            name: "New Fund Asset With Unstated Sale",
            fund: "New Managed Fund With Unstated Sale",
            holderKind: "fund",
            txns: [
              sampleTxn({
                date: "2024-05-01",
                type: "sell" as never,
                valueAmount: 4000,
                shareCount: 40,
                pricePerShare: 100,
                sellProceedsDestination: null,
              }),
            ],
          });

          const review = await service.buildFullReview([asset]);
          const reviewAsset = review.assets.find(
            (candidate) => candidate.code === "NEW-FUND-UNSTATED-SALE",
          );
          const reviewTxn = review.two_step_review?.transactions.find(
            (txn) => txn.assetCode === "NEW-FUND-UNSTATED-SALE",
          );

          expect(reviewAsset?.matched_fund.matched_id).toBeNull();
          expect(reviewAsset?.proposed.txns[0].sellProceedsDestination).toBe("cash_in_fund");
          expect(reviewTxn?.sellProceedsDestination).toBe("cash_in_fund");
        });
      });
    });
  });
});
