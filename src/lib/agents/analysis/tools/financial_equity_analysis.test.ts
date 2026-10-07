import { describe, expect, it } from "vitest";
import {
  computeFinancialEquityAnalysis,
  financialEquityAnalysis,
  financialEquityAnalysisTool,
  REQUIRED_FINANCIAL_INPUTS,
  type FinancialEquityAnalysisInput,
} from "./financial_equity_analysis";

/** A full-fat input whose numbers are all hand-checkable. */
const fullInput = (): FinancialEquityAnalysisInput => ({
  company_name: "Acme Materials",
  currency: "USD",
  units: "millions",
  financials: [
    { fiscal_year: 2021, revenue: 100, ebitda: 20, ebit: 15, net_profit: 10, equity: 80 },
    { fiscal_year: 2022, revenue: 120, ebitda: 25, ebit: 19, net_profit: 13, equity: 90 },
    { fiscal_year: 2023, revenue: 150, ebitda: 32, ebit: 25, net_profit: 18, equity: 104 },
    {
      fiscal_year: 2024,
      revenue: 200,
      ebitda: 44,
      ebit: 35,
      net_profit: 26,
      equity: 125,
      dividends_paid: 13,
    },
  ],
  peers: [
    { name: "Local A", scope: "local", net_profit_margin_pct: 10, pe: 14, ev_ebitda: 8, pb: 1.5 },
    { name: "Local B", scope: "local", net_profit_margin_pct: 12, pe: 16, ev_ebitda: 9, pb: 1.7 },
    { name: "Global A", scope: "global", net_profit_margin_pct: 16, pe: 22, ev_ebitda: 12, pb: 3 },
  ],
  market: [{ name: "Local index", scope: "local", net_profit_margin_pct: 9, pe: 15 }],
  valuation: {
    share_price: 20,
    shares_outstanding: 20,
    net_debt: 60,
    dividend_per_share: 0.65,
  },
  historical_multiples: {
    pe: [10, 12, 14, 16],
    ev_ebitda: [8, 9, 10, 11],
  },
  sum_of_parts: {
    parts: [
      { name: "Specialty", value: 300, method: "8x EV/EBITDA" },
      { name: "Commodity", value: 200, ownership_pct: 0.5 },
    ],
    holding_discount_pct: 10,
    net_debt: 60,
  },
});

describe("computeFinancialEquityAnalysis", () => {
  it("asks the orchestrator once for financials when none are usable", () => {
    const result = computeFinancialEquityAnalysis({ company_name: "Blank Co" });

    expect(result.status).toBe("needs_financial_data");
    expect(result.missing_inputs).toEqual(REQUIRED_FINANCIAL_INPUTS);
    expect(result.request_to_orchestrator).toContain("Blank Co");
    expect(result.request_to_orchestrator).toContain("data_request_already_made");
    // Nothing is computed on the asking turn.
    expect(result.revenue_growth).toBeUndefined();
    expect(result.valuation).toBeUndefined();
  });

  // The whole point of the trigger being "no content at all": an agent told to
  // go find figures and call back can return with one year and still get an
  // analysis, rather than being asked for the same figures a second time.
  it("never asks twice — a call carrying anything at all is analyzed, flag or no flag", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Retry Co",
      financials: [{ fiscal_year: 2024, revenue: 100, net_profit: 8 }],
    });

    expect(result.status).toBe("partial");
    expect(result.request_to_orchestrator).toBeUndefined();
    expect(result.margins?.latest_net_profit_margin_pct).toBe(8);
  });

  it.each([
    ["a peer set alone", { peers: [{ name: "P", scope: "local" as const, pe: 12 }] }],
    ["a market benchmark alone", { market: [{ name: "Index", scope: "global" as const, pe: 18 }] }],
    ["a sum-of-the-parts alone", { sum_of_parts: { parts: [{ name: "A", value: 100 }] } }],
  ])("does not ask when the call carries %s", (_label, extra) => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Partial Co",
      ...extra,
    });

    expect(result.status).toBe("partial");
    expect(result.request_to_orchestrator).toBeUndefined();
  });

  it("computes what it can once the caller says the data is unavailable", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Blank Co",
      financials: [{ fiscal_year: 2024, revenue: 100, net_profit: 8 }],
      data_request_already_made: true,
    });

    expect(result.status).toBe("partial");
    expect(result.missing_inputs).toBeUndefined();
    expect(result.request_to_orchestrator).toBeUndefined();
    // One year is enough for a margin, not for growth.
    expect(result.margins?.latest_net_profit_margin_pct).toBe(8);
    expect(result.revenue_growth).toBeUndefined();
    expect(result.data_gaps).toContain(
      "revenue growth: fewer than two fiscal years with revenue",
    );
  });

  it("still analyzes a priceable position that has no multi-year history, without asking", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "One Year Co",
      financials: [{ fiscal_year: 2024, revenue: 100, ebitda: 20, net_profit: 10, equity: 50 }],
      valuation: { market_cap: 150, net_debt: 50 },
    });

    expect(result.status).toBe("partial");
    expect(result.request_to_orchestrator).toBeUndefined();
    expect(result.valuation?.enterprise_value).toBe(200);
    expect(result.valuation?.pe).toBe(15);
    expect(result.valuation?.ev_ebitda).toBe(10);
    expect(result.valuation?.pb).toBe(3);
  });

  it("computes revenue, EBITDA, EBIT and net profit growth with YoY and CAGR", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    const revenue = result.revenue_growth;
    expect(revenue?.periods.map((p) => p.yoy_growth_pct)).toEqual([null, 20, 25, 33.33]);
    // (200 / 100) ** (1/3) - 1 = 25.99%
    expect(revenue?.cagr_pct).toBeCloseTo(25.99, 2);
    expect(revenue?.latest_yoy_growth_pct).toBe(33.33);
    expect(revenue?.years).toBe(3);

    // (44 / 20) ** (1/3) - 1 = 30.06%; (35 / 15) ** (1/3) - 1 = 32.64%
    expect(result.ebitda_growth?.cagr_pct).toBeCloseTo(30.06, 2);
    expect(result.ebit_growth?.cagr_pct).toBeCloseTo(32.64, 2);
    // (26 / 10) ** (1/3) - 1 = 37.51%
    expect(result.net_profit_growth?.cagr_pct).toBeCloseTo(37.51, 2);
  });

  it("flags margin compression when the bottom line lags the top line", () => {
    const input = fullInput();
    // Revenue doubles, net profit barely moves.
    input.financials = [
      { fiscal_year: 2023, revenue: 100, net_profit: 12 },
      { fiscal_year: 2024, revenue: 200, net_profit: 13 },
    ];

    const result = computeFinancialEquityAnalysis(input);

    expect(result.growth_sustainability?.bottom_line_vs_top_line_pp).toBeLessThan(-2);
    expect(result.growth_sustainability?.assessment).toContain(
      "not self-sustaining at the bottom line",
    );
    expect(result.margins?.net_profit_margin_change_pp).toBe(-5.5);
  });

  it("reports margin expansion when net profit compounds faster than revenue", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    expect(result.growth_sustainability?.bottom_line_vs_top_line_pp).toBeGreaterThan(2);
    expect(result.growth_sustainability?.assessment).toContain("widening margins");
    expect(result.margins?.latest_net_profit_margin_pct).toBe(13);
    expect(result.margins?.net_profit_margin_change_pp).toBe(3);
  });

  it("marks growth not meaningful when the base year is zero or negative", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Turnaround Co",
      financials: [
        { fiscal_year: 2023, revenue: 100, net_profit: -5 },
        { fiscal_year: 2024, revenue: 120, net_profit: 10 },
      ],
    });

    expect(result.net_profit_growth?.latest_yoy_growth_pct).toBeNull();
    expect(result.net_profit_growth?.cagr_pct).toBeNull();
    expect(result.revenue_growth?.latest_yoy_growth_pct).toBe(20);
  });

  it("compares margins and multiples to the local and global peer and market medians", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    const scopes = result.relative_position?.by_scope ?? [];
    expect(scopes.map((s) => `${s.scope}:${s.cohort}`)).toEqual([
      "local:peers",
      "global:peers",
      "local:market",
    ]);

    const localPeers = scopes.find((s) => s.scope === "local" && s.cohort === "peers");
    expect(localPeers?.count).toBe(2);
    expect(localPeers?.medians.net_profit_margin_pct).toBe(11);
    // Company NPM 13% vs a local peer median of 11% → +2pp.
    expect(localPeers?.company_vs_median.net_profit_margin_pct).toBe(2);

    const globalPeers = scopes.find((s) => s.scope === "global");
    expect(globalPeers?.medians.net_profit_margin_pct).toBe(16);
    expect(globalPeers?.company_vs_median.net_profit_margin_pct).toBe(-3);

    expect(result.observations).toContain(
      "net profit margin is 2pp above the local peers median",
    );
    expect(result.observations).toContain(
      "net profit margin is 3pp below the global peers median",
    );
  });

  it("computes P/E, EV/EBITDA and P/B off the market inputs", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    // 20 × 20 = 400 market cap; +60 net debt = 460 EV.
    expect(result.valuation?.market_cap).toBe(400);
    expect(result.valuation?.enterprise_value).toBe(460);
    expect(result.valuation?.pe).toBeCloseTo(15.38, 2); // 400 / 26
    expect(result.valuation?.ev_ebitda).toBeCloseTo(10.45, 2); // 460 / 44
    expect(result.valuation?.pb).toBe(3.2); // 400 / 125
  });

  it("refuses a P/E on negative earnings and says why", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Loss Co",
      financials: [
        { fiscal_year: 2023, revenue: 100, net_profit: -8, equity: 40 },
        { fiscal_year: 2024, revenue: 110, net_profit: -4, equity: 36 },
      ],
      valuation: { market_cap: 200, net_debt: 10 },
    });

    expect(result.valuation?.pe).toBeNull();
    expect(result.valuation?.notes).toContain(
      "P/E not meaningful — earnings are zero or negative",
    );
  });

  it("places today's multiples against the company's own history in standard deviations", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    const pe = result.historical_multiple_positions?.find((p) => p.multiple === "pe");
    // History [10, 12, 14, 16]: mean 13, sample stdev 2.5820; current 15.38.
    expect(pe?.historical_mean).toBe(13);
    expect(pe?.historical_stdev).toBeCloseTo(2.58, 2);
    expect(pe?.std_dev_from_mean).toBeCloseTo(0.92, 2);
    expect(pe?.premium_to_mean_pct).toBeCloseTo(18.31, 2);
    expect(pe?.band).toContain("above its historical mean");

    const evEbitda = result.historical_multiple_positions?.find(
      (p) => p.multiple === "ev_ebitda",
    );
    // History [8, 9, 10, 11]: mean 9.5, sample stdev 1.2910; current 10.45.
    expect(evEbitda?.historical_mean).toBe(9.5);
    expect(evEbitda?.std_dev_from_mean).toBeCloseTo(0.74, 2);

    // No P/B history was supplied, so no position is reported for it.
    expect(
      result.historical_multiple_positions?.some((p) => p.multiple === "pb"),
    ).toBe(false);
  });

  it("distinguishes an identical historical series from one too short to measure", () => {
    const input = fullInput();
    input.historical_multiples = { pe: [13, 13, 13] };

    const pe = computeFinancialEquityAnalysis(input).historical_multiple_positions?.[0];

    expect(pe?.observations).toBe(3);
    expect(pe?.historical_stdev).toBe(0);
    expect(pe?.std_dev_from_mean).toBeNull();
    expect(pe?.band).toBe(
      "every historical observation is identical — the series has no dispersion to measure",
    );
    // Dispersion is zero, but the premium to the mean is still meaningful.
    expect(pe?.premium_to_mean_pct).toBeCloseTo(18.31, 2);
  });

  it("reports no premium when the historical mean is non-positive", () => {
    const input = fullInput();
    input.historical_multiples = { pe: [-4, 0, -2] };

    const pe = computeFinancialEquityAnalysis(input).historical_multiple_positions?.[0];

    expect(pe?.premium_to_mean_pct).toBeNull();
  });

  it("flags the historical-multiple gap when the supplied series is empty", () => {
    const input = fullInput();
    input.historical_multiples = { pe: [] };

    const result = computeFinancialEquityAnalysis(input);

    expect(result.historical_multiple_positions).toBeUndefined();
    expect(result.data_gaps).toContain(
      "historical multiples: no multiple could be placed against the company's own history (no history supplied, or no current multiple to compare)",
    );
  });

  it("compounds over the calendar span, not the number of rows supplied", () => {
    // FY2020 → FY2024 is a four-year compound even with the middle years absent.
    const result = computeFinancialEquityAnalysis({
      company_name: "Gappy Co",
      financials: [
        { fiscal_year: 2020, revenue: 100 },
        { fiscal_year: 2024, revenue: 200 },
      ],
    });

    expect(result.revenue_growth?.years).toBe(4);
    expect(result.revenue_growth?.cagr_pct).toBeCloseTo(18.92, 2);
    expect(result.revenue_growth?.latest_yoy_growth_pct).toBe(100);
  });

  it("says so when the sum-of-the-parts had no net debt to deduct", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Unlevered-by-omission Co",
      financials: [
        { fiscal_year: 2023, revenue: 100 },
        { fiscal_year: 2024, revenue: 120 },
      ],
      valuation: { market_cap: 400 },
      sum_of_parts: { parts: [{ name: "A", value: 300 }] },
    });

    expect(result.sum_of_parts?.net_debt).toBe(0);
    expect(result.sum_of_parts?.equity_value).toBe(300);
    expect(result.data_gaps).toContain(
      "sum-of-the-parts: no net debt supplied — the equity value below assumes zero net debt and overstates it for a levered business",
    );
  });

  it("applies other_adjustments with its sign", () => {
    const input = fullInput();
    input.sum_of_parts = {
      parts: [{ name: "A", value: 400 }],
      net_debt: 100,
      other_adjustments: -40,
    };

    // 400 gross, no discount, −100 net debt, −40 adjustment.
    expect(computeFinancialEquityAnalysis(input).sum_of_parts?.equity_value).toBe(260);
  });

  it("reports no payout ratio when the latest year lost money", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Paying Loss Co",
      financials: [
        { fiscal_year: 2023, revenue: 100, net_profit: 5 },
        { fiscal_year: 2024, revenue: 90, net_profit: -3, dividends_paid: 4 },
      ],
      valuation: { market_cap: 200 },
    });

    expect(result.dividend?.dividend_yield_pct).toBe(2); // 4 / 200
    expect(result.dividend?.payout_ratio_pct).toBeNull();
  });

  it("explains an EV/EBITDA it could not compute for want of net debt", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "No Net Debt Co",
      financials: [
        { fiscal_year: 2023, revenue: 100, ebitda: 20 },
        { fiscal_year: 2024, revenue: 120, ebitda: 26 },
      ],
      valuation: { market_cap: 300 },
    });

    expect(result.valuation?.enterprise_value).toBeNull();
    expect(result.valuation?.ev_ebitda).toBeNull();
    expect(result.valuation?.notes).toContain(
      "EV/EBITDA not computed — net debt not supplied",
    );
  });

  it("reports no dispersion when a multiple has a single historical observation", () => {
    const input = fullInput();
    input.historical_multiples = { pe: [13] };

    const pe = computeFinancialEquityAnalysis(input).historical_multiple_positions?.[0];

    expect(pe?.observations).toBe(1);
    expect(pe?.historical_stdev).toBeNull();
    expect(pe?.std_dev_from_mean).toBeNull();
    expect(pe?.band).toBe("insufficient history to measure dispersion");
  });

  it("computes dividend yield from DPS and the payout ratio from the latest year", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    expect(result.dividend?.dividend_yield_pct).toBe(3.25); // 0.65 / 20
    expect(result.dividend?.payout_ratio_pct).toBe(50); // 13 / 26
  });

  it("falls back to total dividends over market cap when no DPS is given", () => {
    const input = fullInput();
    delete input.valuation?.dividend_per_share;

    const result = computeFinancialEquityAnalysis(input);

    expect(result.dividend?.dividend_yield_pct).toBe(3.25); // 13 / 400
  });

  it("builds a sum-of-the-parts with ownership, holding discount and net debt", () => {
    const result = computeFinancialEquityAnalysis(fullInput());

    const sotp = result.sum_of_parts;
    // 300 + (200 × 0.5) = 400 gross; −10% = 360; −60 net debt = 300 equity.
    expect(sotp?.gross_value).toBe(400);
    expect(sotp?.value_after_discount).toBe(360);
    expect(sotp?.equity_value).toBe(300);
    expect(sotp?.value_per_share).toBe(15); // 300 / 20 shares
    expect(sotp?.implied_upside_vs_market_cap_pct).toBe(-25); // vs a 400 market cap
    expect(result.observations).toContain(
      "sum-of-the-parts equity value is 25% below the current market capitalization",
    );
  });

  it("returns status computed with no gaps when every section has its inputs", () => {
    const input = fullInput();
    input.historical_multiples = { pe: [10, 12, 14, 16], ev_ebitda: [8, 9, 10, 11], pb: [2, 2.5, 3] };

    const result = computeFinancialEquityAnalysis(input);

    expect(result.data_gaps).toEqual([]);
    expect(result.status).toBe("computed");
  });

  it("lists every unsupplied section under data_gaps rather than failing", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Sparse Co",
      financials: [
        { fiscal_year: 2023, revenue: 100 },
        { fiscal_year: 2024, revenue: 130 },
      ],
    });

    expect(result.status).toBe("partial");
    expect(result.revenue_growth?.latest_yoy_growth_pct).toBe(30);
    expect(result.data_gaps).toEqual([
      "operating growth: no EBITDA or EBIT series with two or more years",
      "net profit growth: fewer than two fiscal years with net profit",
      "valuation: no price, market cap or balance-sheet inputs supplied",
      "historical multiples: no multiple could be placed against the company's own history (no history supplied, or no current multiple to compare)",
      "dividend yield: no dividend per share or dividends paid supplied",
      "relative comparison: no peer or market benchmarks supplied (local or global)",
      "sum-of-the-parts: no segment valuations supplied",
    ]);
  });

  it("sorts fiscal years before computing, whatever order they arrive in", () => {
    const result = computeFinancialEquityAnalysis({
      company_name: "Unsorted Co",
      financials: [
        { fiscal_year: 2024, revenue: 150 },
        { fiscal_year: 2022, revenue: 100 },
        { fiscal_year: 2023, revenue: 120 },
      ],
    });

    expect(result.revenue_growth?.periods.map((p) => p.fiscal_year)).toEqual([
      2022, 2023, 2024,
    ]);
    expect(result.revenue_growth?.earliest.value).toBe(100);
    expect(result.revenue_growth?.latest.value).toBe(150);
  });

  it("rejects a missing company name", () => {
    expect(() =>
      computeFinancialEquityAnalysis({ company_name: "  " } as FinancialEquityAnalysisInput),
    ).toThrow(/company_name/);
  });

  it("defaults currency and units", () => {
    const result = computeFinancialEquityAnalysis({ company_name: "Acme", data_request_already_made: true });

    expect(result.currency).toBe("USD");
    expect(result.units).toBe("millions");
  });
});

describe("financial_equity_analysis tool", () => {
  it("is registered under its snake_case name and is the aliased export", () => {
    expect(financialEquityAnalysis.name).toBe("financial_equity_analysis");
    expect(financialEquityAnalysisTool).toBe(financialEquityAnalysis);
  });

  it("describes the seven-step analysis and the ask-once protocol", () => {
    const description = financialEquityAnalysis.description;

    expect(description).toContain("Revenue growth");
    expect(description).toContain("EBITDA and EBIT growth");
    expect(description).toContain("local vs global");
    expect(description).toContain("Net profit growth");
    expect(description).toContain("standard deviations");
    expect(description).toContain("Dividend yield");
    expect(description).toContain("Sum-of-the-parts");
    expect(description).toContain("needs_financial_data");
    expect(description).toContain("data_request_already_made");
  });

  it("returns the computed analysis through invoke", async () => {
    const result = (await financialEquityAnalysis.invoke(
      fullInput() as never,
    )) as Awaited<ReturnType<typeof computeFinancialEquityAnalysis>>;

    expect(result.company_name).toBe("Acme Materials");
    expect(result.revenue_growth?.latest_yoy_growth_pct).toBe(33.33);
    expect(result.valuation?.market_cap).toBe(400);
  });

  it("returns the data request through invoke when nothing usable is supplied", async () => {
    const result = (await financialEquityAnalysis.invoke({
      company_name: "Blank Co",
    } as never)) as Awaited<ReturnType<typeof computeFinancialEquityAnalysis>>;

    expect(result.status).toBe("needs_financial_data");
    expect(result.missing_inputs?.length).toBeGreaterThan(0);
  });
});
