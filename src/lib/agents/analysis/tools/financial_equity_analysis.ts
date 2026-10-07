/**
 * `financial_equity_analysis` — the minority-stakes equity analysis calculator.
 *
 * A minority investor buys a share of someone else's business and gets paid by
 * the business performing, by the multiple it trades at, and by the cash it
 * distributes. This tool turns a stated set of financials into exactly those
 * facts, in the order an equity analyst works through them:
 *
 *   1. Revenue growth
 *   2. EBITDA / EBIT growth
 *   3. Relative position vs peers and the market (local and global) — margins
 *      (NPM) and whether the growth is sustained at the bottom line
 *   4. Net profit growth (and what drove it)
 *   5. Valuation — P/E, EV/EBITDA, P/B, versus the company's own historical
 *      multiples, expressed in standard deviations from its own mean
 *   6. Dividend yield
 *   7. Sum-of-the-parts
 *
 * It is deterministic and fact-only: it computes, compares and flags, and never
 * emits a score, a target price or a buy/sell verdict — that judgment belongs
 * to the agent that called it.
 *
 * Missing data is handled by ASKING ONCE. A call carrying NO financial content
 * at all returns `status: "needs_financial_data"` plus the exact list of inputs
 * it wants, which the calling agent relays to the user/orchestrator. Any call
 * that carries something — one fiscal year, a price, a peer set — is analyzed
 * instead, with whatever is still missing reported as `data_gaps`, so an agent
 * that goes away and comes back with partial figures can never be sent away
 * again. `data_request_already_made: true` is the escape hatch for the case
 * where nothing at all could be found.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";

const fiscalYearSchema = z.object({
  fiscal_year: z
    .number()
    .int()
    .describe("Fiscal year, e.g. 2024. Rows are sorted ascending by this."),
  revenue: z.number().optional().describe("Revenue / net sales for the year"),
  ebitda: z.number().optional().describe("EBITDA for the year"),
  ebit: z.number().optional().describe("EBIT / operating profit for the year"),
  net_profit: z
    .number()
    .optional()
    .describe("Net profit attributable to shareholders for the year"),
  equity: z
    .number()
    .optional()
    .describe("Book value of shareholders' equity at year end"),
  dividends_paid: z
    .number()
    .optional()
    .describe("Total dividends paid for the year"),
});

const comparableSchema = z.object({
  name: z.string().min(1).describe("Peer company or market/index name"),
  scope: z
    .enum(["local", "global"])
    .describe("Whether this comparable is a local-market or a global comparable"),
  net_profit_margin_pct: z
    .number()
    .optional()
    .describe("Net profit margin, in percent (e.g. 12.5 for 12.5%)"),
  ebitda_margin_pct: z.number().optional().describe("EBITDA margin, in percent"),
  revenue_growth_pct: z
    .number()
    .optional()
    .describe("Revenue growth, in percent"),
  net_profit_growth_pct: z
    .number()
    .optional()
    .describe("Net profit growth, in percent"),
  pe: z.number().optional().describe("Price / earnings multiple"),
  ev_ebitda: z.number().optional().describe("EV / EBITDA multiple"),
  pb: z.number().optional().describe("Price / book value multiple"),
  dividend_yield_pct: z
    .number()
    .optional()
    .describe("Dividend yield, in percent"),
});

const sumOfPartsPartSchema = z.object({
  name: z.string().min(1).describe("Segment, subsidiary or asset name"),
  value: z
    .number()
    .describe("100% enterprise/equity value attributed to this part"),
  ownership_pct: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Economic ownership of this part, decimal in [0, 1]; defaults to 1"),
  method: z
    .string()
    .optional()
    .describe("How the part was valued (e.g. '7x EV/EBITDA', 'DCF', 'book')"),
  note: z.string().optional().describe("Any caveat on this part"),
});

export const financialEquityAnalysisInputSchema = z.object({
  company_name: z.string().min(1).describe("The company being analyzed"),
  currency: z.string().optional().describe("Currency of all figures; default USD"),
  units: z
    .string()
    .optional()
    .describe("Units of all absolute figures, e.g. 'millions'; default millions"),
  financials: z
    .array(fiscalYearSchema)
    .optional()
    .describe(
      "Historical income-statement figures, one row per fiscal year. Two or more years are needed for any growth analysis.",
    ),
  peers: z
    .array(comparableSchema)
    .optional()
    .describe("Peer companies, each tagged local or global"),
  market: z
    .array(comparableSchema)
    .optional()
    .describe(
      "Market / index benchmarks (e.g. the local exchange, a global sector index), each tagged local or global",
    ),
  valuation: z
    .object({
      share_price: z.number().optional().describe("Current share price"),
      shares_outstanding: z
        .number()
        .optional()
        .describe("Shares outstanding, in the same units as the absolute figures"),
      market_cap: z
        .number()
        .optional()
        .describe("Market capitalization; derived from price × shares when omitted"),
      net_debt: z
        .number()
        .optional()
        .describe("Net debt (debt − cash); negative means net cash"),
      book_value_of_equity: z
        .number()
        .optional()
        .describe("Book value of equity; falls back to the latest fiscal year's equity"),
      net_profit: z
        .number()
        .optional()
        .describe("Earnings to use for P/E; falls back to the latest fiscal year"),
      ebitda: z
        .number()
        .optional()
        .describe("EBITDA to use for EV/EBITDA; falls back to the latest fiscal year"),
      dividend_per_share: z.number().optional().describe("Dividend per share"),
      dividends_paid: z
        .number()
        .optional()
        .describe("Total dividends paid; falls back to the latest fiscal year"),
    })
    .optional()
    .describe("Current market and balance-sheet inputs for the valuation section"),
  historical_multiples: z
    .object({
      pe: z.array(z.number()).optional().describe("Historical P/E observations"),
      ev_ebitda: z
        .array(z.number())
        .optional()
        .describe("Historical EV/EBITDA observations"),
      pb: z.array(z.number()).optional().describe("Historical P/B observations"),
    })
    .optional()
    .describe(
      "The company's own historical multiple series, used to place today's multiple in standard deviations from its own mean",
    ),
  sum_of_parts: z
    .object({
      parts: z.array(sumOfPartsPartSchema).min(1),
      net_debt: z
        .number()
        .optional()
        .describe("Net debt deducted from the summed parts; defaults to valuation.net_debt"),
      holding_discount_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Holding-company / conglomerate discount applied to the summed parts, in percent"),
      other_adjustments: z
        .number()
        .optional()
        .describe("Any other adjustment added to the equity value (negative to subtract)"),
    })
    .optional()
    .describe("Sum-of-the-parts build-up"),
  data_request_already_made: z
    .boolean()
    .optional()
    .describe(
      "Set to true when you already asked for the missing financials once and could not get them. The tool then computes whatever the inputs support instead of asking again.",
    ),
});

export type FinancialEquityAnalysisInput = z.infer<
  typeof financialEquityAnalysisInputSchema
>;

export interface GrowthPeriod {
  fiscal_year: number;
  value: number;
  yoy_growth_pct: number | null;
}

export interface GrowthBlock {
  metric: string;
  periods: GrowthPeriod[];
  earliest: { fiscal_year: number; value: number };
  latest: { fiscal_year: number; value: number };
  years: number;
  cagr_pct: number | null;
  latest_yoy_growth_pct: number | null;
}

export interface MultiplePosition {
  multiple: "pe" | "ev_ebitda" | "pb";
  current: number;
  historical_mean: number;
  historical_stdev: number | null;
  observations: number;
  std_dev_from_mean: number | null;
  premium_to_mean_pct: number | null;
  band: string;
}

export interface FinancialEquityAnalysisResult {
  status: "computed" | "partial" | "needs_financial_data";
  company_name: string;
  currency: string;
  units: string;
  missing_inputs?: string[];
  request_to_orchestrator?: string;
  data_gaps: string[];
  revenue_growth?: GrowthBlock;
  ebitda_growth?: GrowthBlock;
  ebit_growth?: GrowthBlock;
  net_profit_growth?: GrowthBlock;
  margins?: {
    by_year: Array<{
      fiscal_year: number;
      ebitda_margin_pct: number | null;
      ebit_margin_pct: number | null;
      net_profit_margin_pct: number | null;
    }>;
    latest_net_profit_margin_pct: number | null;
    net_profit_margin_change_pp: number | null;
  };
  growth_sustainability?: {
    revenue_cagr_pct: number | null;
    ebitda_cagr_pct: number | null;
    net_profit_cagr_pct: number | null;
    bottom_line_vs_top_line_pp: number | null;
    assessment: string;
  };
  relative_position?: {
    company: Record<string, number | null>;
    by_scope: Array<{
      scope: "local" | "global";
      cohort: "peers" | "market";
      count: number;
      medians: Record<string, number | null>;
      company_vs_median: Record<string, number | null>;
    }>;
  };
  valuation?: {
    share_price: number | null;
    shares_outstanding: number | null;
    market_cap: number | null;
    net_debt: number | null;
    enterprise_value: number | null;
    pe: number | null;
    ev_ebitda: number | null;
    pb: number | null;
    notes: string[];
  };
  historical_multiple_positions?: MultiplePosition[];
  dividend?: {
    dividend_per_share: number | null;
    dividends_paid: number | null;
    dividend_yield_pct: number | null;
    payout_ratio_pct: number | null;
  };
  sum_of_parts?: {
    parts: Array<{
      name: string;
      value: number;
      ownership_pct: number;
      attributable_value: number;
      method: string | null;
      note: string | null;
    }>;
    gross_value: number;
    holding_discount_pct: number;
    value_after_discount: number;
    net_debt: number;
    other_adjustments: number;
    equity_value: number;
    value_per_share: number | null;
    implied_upside_vs_market_cap_pct: number | null;
  };
  observations: string[];
}

const COMPARABLE_METRICS = [
  "net_profit_margin_pct",
  "ebitda_margin_pct",
  "revenue_growth_pct",
  "net_profit_growth_pct",
  "pe",
  "ev_ebitda",
  "pb",
  "dividend_yield_pct",
] as const;

type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Percent change, or null when the base is non-positive (growth is not meaningful). */
function pctChange(from: number, to: number): number | null {
  if (!isNum(from) || !isNum(to) || from <= 0) return null;
  return round(((to - from) / from) * 100);
}

/**
 * Compound annual growth rate in percent, or null when the base is non-positive.
 *
 * `years` is the CALENDAR span between the first and last fiscal year, not the
 * number of rows supplied minus one. FY2020 → FY2024 is a four-year compound
 * whether or not the three intervening years were passed in; annualizing it
 * over one "interval" would report a four-year doubling as 100% a year.
 */
function cagr(from: number, to: number, years: number): number | null {
  if (!isNum(from) || !isNum(to) || from <= 0 || to <= 0 || years <= 0) return null;
  return round(((to / from) ** (1 / years) - 1) * 100);
}

function median(values: number[]): number | null {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : round((sorted[mid - 1] + sorted[mid]) / 2, 4);
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n − 1); null for fewer than two observations. */
function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (!isNum(numerator) || !isNum(denominator) || denominator <= 0) return null;
  return round(numerator / denominator);
}

function buildGrowthBlock(
  metric: string,
  rows: Array<{ fiscal_year: number; value: number }>,
): GrowthBlock | undefined {
  if (rows.length < 2) return undefined;

  const periods: GrowthPeriod[] = rows.map((row, index) => ({
    fiscal_year: row.fiscal_year,
    value: row.value,
    yoy_growth_pct: index === 0 ? null : pctChange(rows[index - 1].value, row.value),
  }));

  const earliest = rows[0];
  const latest = rows[rows.length - 1];
  const years = latest.fiscal_year - earliest.fiscal_year;

  return {
    metric,
    periods,
    earliest: { fiscal_year: earliest.fiscal_year, value: earliest.value },
    latest: { fiscal_year: latest.fiscal_year, value: latest.value },
    years,
    cagr_pct: cagr(earliest.value, latest.value, years),
    latest_yoy_growth_pct: periods[periods.length - 1].yoy_growth_pct,
  };
}

/** Where a multiple sits against its own history, in standard deviations. */
function describeBand(z: number | null): string {
  if (z === null) return "insufficient history to measure dispersion";
  const magnitude = Math.abs(z);
  const direction = z >= 0 ? "above" : "below";
  if (magnitude < 0.5) return `in line with its own history (${round(z)}σ)`;
  if (magnitude < 1) return `modestly ${direction} its historical mean (${round(z)}σ)`;
  if (magnitude < 2) return `${round(magnitude)}σ ${direction} its historical mean`;
  return `${round(magnitude)}σ ${direction} its historical mean — an extreme of the recorded range`;
}

function multiplePosition(
  multiple: MultiplePosition["multiple"],
  current: number | null,
  history: number[] | undefined,
): MultiplePosition | null {
  if (!isNum(current) || !history || history.length === 0) return null;
  const observations = history.filter(isNum);
  if (observations.length === 0) return null;

  const historicalMean = mean(observations);
  const sd = stdev(observations);
  const z = sd !== null && sd > 0 ? (current - historicalMean) / sd : null;

  // Three distinct "no z-score" cases, kept distinct in the band text: fewer
  // than two observations (no dispersion is measurable), two or more identical
  // observations (dispersion is genuinely zero — a premium to the mean is still
  // meaningful), and an ordinary z-score.
  const band =
    sd === null
      ? describeBand(null)
      : sd === 0
        ? "every historical observation is identical — the series has no dispersion to measure"
        : describeBand(z);

  return {
    multiple,
    current,
    historical_mean: round(historicalMean),
    historical_stdev: sd === null ? null : round(sd),
    observations: observations.length,
    std_dev_from_mean: z === null ? null : round(z),
    // A non-positive historical mean makes a percentage premium meaningless —
    // report nothing rather than a 0 that reads as "in line".
    premium_to_mean_pct:
      historicalMean > 0 ? round(((current - historicalMean) / historicalMean) * 100) : null,
    band,
  };
}

/**
 * The inputs this tool asks the orchestrator for when it has nothing usable.
 * Kept as data so the tool's request and its `data_gaps` stay in sync.
 */
export const REQUIRED_FINANCIAL_INPUTS = [
  "financials: at least two fiscal years with revenue (plus EBITDA or EBIT, and net profit, where available)",
  "valuation: share price and shares outstanding (or market cap), net debt, and book value of equity",
  "historical_multiples: the company's own P/E, EV/EBITDA and P/B history, so today's multiple can be placed in standard deviations",
  "peers and market: comparable companies and an index benchmark, each tagged local or global, with margins, growth and multiples",
  "dividends: dividend per share or total dividends paid",
];

/**
 * Pure, deterministic equity analysis over stated financials. Never fetches
 * anything; every figure in the result is derived from the inputs.
 */
export function computeFinancialEquityAnalysis(
  inputs: FinancialEquityAnalysisInput,
): FinancialEquityAnalysisResult {
  if (typeof inputs.company_name !== "string" || inputs.company_name.trim() === "") {
    throw new Error("company_name must be a non-empty string");
  }

  const currency = inputs.currency?.trim() || "USD";
  const units = inputs.units?.trim() || "millions";
  const rows = [...(inputs.financials ?? [])].sort(
    (a, b) => a.fiscal_year - b.fiscal_year,
  );
  const latestRow = rows[rows.length - 1];

  const revenueRows = rows
    .filter((r) => isNum(r.revenue))
    .map((r) => ({ fiscal_year: r.fiscal_year, value: r.revenue as number }));

  const hasValuationInputs =
    !!inputs.valuation &&
    (isNum(inputs.valuation.market_cap) ||
      (isNum(inputs.valuation.share_price) &&
        isNum(inputs.valuation.shares_outstanding)));

  // Ask ONCE, and only when the call carries no financial content whatsoever.
  // The trigger is deliberately "nothing at all" rather than "not enough": a
  // caller that comes back with whatever it could find — one fiscal year, a
  // price, a peer set — gets analysis plus `data_gaps`, never a second request.
  // Otherwise an agent obeying "go get the figures and call again" could be
  // asked again for the figures it just failed to find, and loop.
  const hasAnyFinancialContent =
    rows.some(
      (r) =>
        isNum(r.revenue) ||
        isNum(r.ebitda) ||
        isNum(r.ebit) ||
        isNum(r.net_profit) ||
        isNum(r.equity) ||
        isNum(r.dividends_paid),
    ) ||
    hasValuationInputs ||
    (inputs.peers?.length ?? 0) > 0 ||
    (inputs.market?.length ?? 0) > 0 ||
    !!inputs.sum_of_parts;

  if (!hasAnyFinancialContent) {
    if (!inputs.data_request_already_made) {
      return {
        status: "needs_financial_data",
        company_name: inputs.company_name,
        currency,
        units,
        missing_inputs: REQUIRED_FINANCIAL_INPUTS,
        request_to_orchestrator: `No usable financial information was supplied for ${inputs.company_name}. Ask the user (or look it up) for the inputs listed in missing_inputs, then call financial_equity_analysis again. If they genuinely are not available, call it again with data_request_already_made: true and this tool will compute whatever the available inputs support.`,
        data_gaps: ["no fiscal-year series and no market valuation inputs"],
        observations: [],
      };
    }
  }

  const dataGaps: string[] = [];
  const observations: string[] = [];
  const result: FinancialEquityAnalysisResult = {
    status: "computed",
    company_name: inputs.company_name,
    currency,
    units,
    data_gaps: dataGaps,
    observations,
  };

  // 1. Revenue growth.
  const revenueGrowth = buildGrowthBlock("revenue", revenueRows);
  if (revenueGrowth) {
    result.revenue_growth = revenueGrowth;
  } else {
    dataGaps.push("revenue growth: fewer than two fiscal years with revenue");
  }

  // 2. EBITDA / EBIT growth.
  const ebitdaGrowth = buildGrowthBlock(
    "ebitda",
    rows
      .filter((r) => isNum(r.ebitda))
      .map((r) => ({ fiscal_year: r.fiscal_year, value: r.ebitda as number })),
  );
  const ebitGrowth = buildGrowthBlock(
    "ebit",
    rows
      .filter((r) => isNum(r.ebit))
      .map((r) => ({ fiscal_year: r.fiscal_year, value: r.ebit as number })),
  );
  if (ebitdaGrowth) result.ebitda_growth = ebitdaGrowth;
  if (ebitGrowth) result.ebit_growth = ebitGrowth;
  if (!ebitdaGrowth && !ebitGrowth) {
    dataGaps.push("operating growth: no EBITDA or EBIT series with two or more years");
  }

  // 4. Net profit growth.
  const netProfitGrowth = buildGrowthBlock(
    "net_profit",
    rows
      .filter((r) => isNum(r.net_profit))
      .map((r) => ({ fiscal_year: r.fiscal_year, value: r.net_profit as number })),
  );
  if (netProfitGrowth) {
    result.net_profit_growth = netProfitGrowth;
  } else {
    dataGaps.push("net profit growth: fewer than two fiscal years with net profit");
  }

  // Margins, per year and as a trend.
  if (rows.length > 0) {
    const byYear = rows.map((r) => {
      const revenue = isNum(r.revenue) && r.revenue > 0 ? r.revenue : null;
      return {
        fiscal_year: r.fiscal_year,
        ebitda_margin_pct:
          revenue !== null && isNum(r.ebitda) ? round((r.ebitda / revenue) * 100) : null,
        ebit_margin_pct:
          revenue !== null && isNum(r.ebit) ? round((r.ebit / revenue) * 100) : null,
        net_profit_margin_pct:
          revenue !== null && isNum(r.net_profit)
            ? round((r.net_profit / revenue) * 100)
            : null,
      };
    });
    const npmSeries = byYear.filter((y) => y.net_profit_margin_pct !== null);
    const firstNpm = npmSeries[0]?.net_profit_margin_pct ?? null;
    const lastNpm = npmSeries[npmSeries.length - 1]?.net_profit_margin_pct ?? null;

    result.margins = {
      by_year: byYear,
      latest_net_profit_margin_pct: lastNpm,
      net_profit_margin_change_pp:
        firstNpm !== null && lastNpm !== null && npmSeries.length > 1
          ? round(lastNpm - firstNpm)
          : null,
    };
  }

  // 3b. Sustainability of growth: does the bottom line keep up with the top line?
  if (revenueGrowth || netProfitGrowth) {
    const revenueCagr = revenueGrowth?.cagr_pct ?? null;
    const netProfitCagr = netProfitGrowth?.cagr_pct ?? null;
    const spread =
      revenueCagr !== null && netProfitCagr !== null
        ? round(netProfitCagr - revenueCagr)
        : null;

    let assessment: string;
    if (spread === null) {
      assessment =
        "not measurable — revenue and net profit CAGR cannot both be computed from the supplied years";
    } else if (spread > 2) {
      assessment =
        "net profit is compounding faster than revenue — growth is translating into widening margins";
    } else if (spread < -2) {
      assessment =
        "net profit is compounding slower than revenue — growth is being bought with margin, so it is not self-sustaining at the bottom line";
    } else {
      assessment =
        "net profit is compounding broadly in line with revenue — margins are holding";
    }

    result.growth_sustainability = {
      revenue_cagr_pct: revenueCagr,
      ebitda_cagr_pct: ebitdaGrowth?.cagr_pct ?? null,
      net_profit_cagr_pct: netProfitCagr,
      bottom_line_vs_top_line_pp: spread,
      assessment,
    };
    observations.push(assessment);
  }

  // 5. Valuation: multiples off the current market inputs.
  const valuationInput = inputs.valuation;
  const valuationNotes: string[] = [];
  let marketCap: number | null = null;
  let pe: number | null = null;
  let evEbitda: number | null = null;
  let pb: number | null = null;

  if (valuationInput) {
    marketCap = isNum(valuationInput.market_cap)
      ? valuationInput.market_cap
      : isNum(valuationInput.share_price) && isNum(valuationInput.shares_outstanding)
        ? round(valuationInput.share_price * valuationInput.shares_outstanding, 4)
        : null;

    const netDebt = isNum(valuationInput.net_debt) ? valuationInput.net_debt : null;
    const enterpriseValue =
      marketCap !== null && netDebt !== null ? round(marketCap + netDebt, 4) : null;

    const earnings = isNum(valuationInput.net_profit)
      ? valuationInput.net_profit
      : isNum(latestRow?.net_profit)
        ? (latestRow.net_profit as number)
        : null;
    const ebitda = isNum(valuationInput.ebitda)
      ? valuationInput.ebitda
      : isNum(latestRow?.ebitda)
        ? (latestRow.ebitda as number)
        : null;
    const bookEquity = isNum(valuationInput.book_value_of_equity)
      ? valuationInput.book_value_of_equity
      : isNum(latestRow?.equity)
        ? (latestRow.equity as number)
        : null;

    pe = ratio(marketCap, earnings);
    evEbitda = ratio(enterpriseValue, ebitda);
    pb = ratio(marketCap, bookEquity);

    if (earnings !== null && earnings <= 0) {
      valuationNotes.push("P/E not meaningful — earnings are zero or negative");
    }
    if (pe === null && earnings === null) {
      valuationNotes.push("P/E not computed — no net profit supplied");
    }
    if (evEbitda === null) {
      valuationNotes.push(
        netDebt === null
          ? "EV/EBITDA not computed — net debt not supplied"
          : "EV/EBITDA not computed — EBITDA is missing or non-positive",
      );
    }
    if (pb === null) {
      valuationNotes.push("P/B not computed — book value of equity is missing or non-positive");
    }

    result.valuation = {
      share_price: isNum(valuationInput.share_price) ? valuationInput.share_price : null,
      shares_outstanding: isNum(valuationInput.shares_outstanding)
        ? valuationInput.shares_outstanding
        : null,
      market_cap: marketCap,
      net_debt: netDebt,
      enterprise_value: enterpriseValue,
      pe,
      ev_ebitda: evEbitda,
      pb,
      notes: valuationNotes,
    };
  } else {
    dataGaps.push("valuation: no price, market cap or balance-sheet inputs supplied");
  }

  // 5c. Historical multiples and where today sits in standard deviations.
  const positions = [
    multiplePosition("pe", pe, inputs.historical_multiples?.pe),
    multiplePosition("ev_ebitda", evEbitda, inputs.historical_multiples?.ev_ebitda),
    multiplePosition("pb", pb, inputs.historical_multiples?.pb),
  ].filter((p): p is MultiplePosition => p !== null);

  if (positions.length > 0) {
    result.historical_multiple_positions = positions;
    for (const position of positions) {
      observations.push(`${position.multiple} is ${position.band}`);
    }
  } else {
    // Covers an absent history, an empty one (`{ pe: [] }`), and a history with
    // no current multiple to compare it to — all leave the question unanswered.
    dataGaps.push(
      "historical multiples: no multiple could be placed against the company's own history (no history supplied, or no current multiple to compare)",
    );
  }

  // 6. Dividend yield and payout.
  const dividendPerShare = isNum(valuationInput?.dividend_per_share)
    ? (valuationInput?.dividend_per_share as number)
    : null;
  const dividendsPaid = isNum(valuationInput?.dividends_paid)
    ? (valuationInput?.dividends_paid as number)
    : isNum(latestRow?.dividends_paid)
      ? (latestRow.dividends_paid as number)
      : null;
  const sharePrice = isNum(valuationInput?.share_price)
    ? (valuationInput?.share_price as number)
    : null;

  if (dividendPerShare !== null || dividendsPaid !== null) {
    const yieldFromDps =
      dividendPerShare !== null && sharePrice !== null && sharePrice > 0
        ? round((dividendPerShare / sharePrice) * 100)
        : null;
    const yieldFromTotal =
      dividendsPaid !== null && marketCap !== null && marketCap > 0
        ? round((dividendsPaid / marketCap) * 100)
        : null;
    const latestNetProfit = isNum(latestRow?.net_profit)
      ? (latestRow.net_profit as number)
      : null;

    result.dividend = {
      dividend_per_share: dividendPerShare,
      dividends_paid: dividendsPaid,
      dividend_yield_pct: yieldFromDps ?? yieldFromTotal,
      payout_ratio_pct:
        dividendsPaid !== null && latestNetProfit !== null && latestNetProfit > 0
          ? round((dividendsPaid / latestNetProfit) * 100)
          : null,
    };
  } else {
    dataGaps.push("dividend yield: no dividend per share or dividends paid supplied");
  }

  // 3. Relative position vs peers and the market, local and global.
  const companyMetrics: Record<string, number | null> = {
    net_profit_margin_pct: result.margins?.latest_net_profit_margin_pct ?? null,
    ebitda_margin_pct:
      result.margins?.by_year[result.margins.by_year.length - 1]?.ebitda_margin_pct ?? null,
    revenue_growth_pct: revenueGrowth?.latest_yoy_growth_pct ?? null,
    net_profit_growth_pct: netProfitGrowth?.latest_yoy_growth_pct ?? null,
    pe,
    ev_ebitda: evEbitda,
    pb,
    dividend_yield_pct: result.dividend?.dividend_yield_pct ?? null,
  };

  const allCohorts: Array<{
    scope: "local" | "global";
    cohort: "peers" | "market";
    rows: z.infer<typeof comparableSchema>[];
  }> = [
    { scope: "local", cohort: "peers", rows: (inputs.peers ?? []).filter((p) => p.scope === "local") },
    { scope: "global", cohort: "peers", rows: (inputs.peers ?? []).filter((p) => p.scope === "global") },
    { scope: "local", cohort: "market", rows: (inputs.market ?? []).filter((m) => m.scope === "local") },
    { scope: "global", cohort: "market", rows: (inputs.market ?? []).filter((m) => m.scope === "global") },
  ];
  const cohorts = allCohorts.filter((c) => c.rows.length > 0);

  if (cohorts.length > 0) {
    result.relative_position = {
      company: companyMetrics,
      by_scope: cohorts.map((cohort) => {
        const medians: Record<string, number | null> = {};
        const deltas: Record<string, number | null> = {};
        for (const metric of COMPARABLE_METRICS) {
          const values = cohort.rows
            .map((row) => row[metric as ComparableMetric])
            .filter(isNum);
          const med = median(values);
          medians[metric] = med;
          const own = companyMetrics[metric];
          deltas[metric] = med !== null && isNum(own) ? round(own - med) : null;
        }
        return {
          scope: cohort.scope,
          cohort: cohort.cohort,
          count: cohort.rows.length,
          medians,
          company_vs_median: deltas,
        };
      }),
    };

    for (const scope of result.relative_position.by_scope) {
      const npmDelta = scope.company_vs_median.net_profit_margin_pct;
      if (npmDelta !== null) {
        observations.push(
          `net profit margin is ${Math.abs(npmDelta)}pp ${npmDelta >= 0 ? "above" : "below"} the ${scope.scope} ${scope.cohort} median`,
        );
      }
    }
  } else {
    dataGaps.push(
      "relative comparison: no peer or market benchmarks supplied (local or global)",
    );
  }

  // 7. Sum-of-the-parts.
  if (inputs.sum_of_parts) {
    const parts = inputs.sum_of_parts.parts.map((part) => {
      const ownership = isNum(part.ownership_pct) ? part.ownership_pct : 1;
      return {
        name: part.name,
        value: part.value,
        ownership_pct: ownership,
        attributable_value: round(part.value * ownership, 4),
        method: part.method ?? null,
        note: part.note ?? null,
      };
    });

    const grossValue = round(
      parts.reduce((sum, part) => sum + part.attributable_value, 0),
      4,
    );
    const discountPct = isNum(inputs.sum_of_parts.holding_discount_pct)
      ? inputs.sum_of_parts.holding_discount_pct
      : 0;
    const afterDiscount = round(grossValue * (1 - discountPct / 100), 4);
    const suppliedNetDebt = isNum(inputs.sum_of_parts.net_debt)
      ? inputs.sum_of_parts.net_debt
      : isNum(valuationInput?.net_debt)
        ? (valuationInput?.net_debt as number)
        : null;
    // Defaulting to zero silently would overstate equity value on any levered
    // business, so the assumption is reported rather than buried.
    if (suppliedNetDebt === null) {
      dataGaps.push(
        "sum-of-the-parts: no net debt supplied — the equity value below assumes zero net debt and overstates it for a levered business",
      );
    }
    const sotpNetDebt = suppliedNetDebt ?? 0;
    const otherAdjustments = isNum(inputs.sum_of_parts.other_adjustments)
      ? inputs.sum_of_parts.other_adjustments
      : 0;
    const equityValue = round(afterDiscount - sotpNetDebt + otherAdjustments, 4);
    const shares = isNum(valuationInput?.shares_outstanding)
      ? (valuationInput?.shares_outstanding as number)
      : null;

    result.sum_of_parts = {
      parts,
      gross_value: grossValue,
      holding_discount_pct: discountPct,
      value_after_discount: afterDiscount,
      net_debt: sotpNetDebt,
      other_adjustments: otherAdjustments,
      equity_value: equityValue,
      value_per_share: shares !== null && shares > 0 ? round(equityValue / shares, 4) : null,
      implied_upside_vs_market_cap_pct:
        marketCap !== null && marketCap > 0
          ? round(((equityValue - marketCap) / marketCap) * 100)
          : null,
    };

    const upside = result.sum_of_parts.implied_upside_vs_market_cap_pct;
    if (upside !== null) {
      observations.push(
        `sum-of-the-parts equity value is ${Math.abs(upside)}% ${upside >= 0 ? "above" : "below"} the current market capitalization`,
      );
    }
  } else {
    dataGaps.push("sum-of-the-parts: no segment valuations supplied");
  }

  result.status = dataGaps.length > 0 ? "partial" : "computed";
  return result;
}

/**
 * Fact-only LangChain tool: the seven-step equity analysis a minority stake is
 * underwritten on. Returns structured facts and flagged gaps; no verdict.
 */
export const financialEquityAnalysis = tool(
  async (inputs: FinancialEquityAnalysisInput) => {
    logger.debug(
      `🔧 TOOL CALLED: financial_equity_analysis(company=${inputs.company_name}, years=${inputs.financials?.length ?? 0}, peers=${inputs.peers?.length ?? 0})`,
    );
    return computeFinancialEquityAnalysis(inputs);
  },
  {
    name: "financial_equity_analysis",
    description: `Run the standard equity analysis on a company's financials — the lens a minority, non-controlling stake is underwritten through, and the quantitative backbone of any "evaluate this company" request.

Give it whatever financial information you have gathered (from get_company_details, query_files, web_search, valyu_search or the user) and it computes, deterministically:
1. Revenue growth — YoY per fiscal year and CAGR across the window
2. EBITDA and EBIT growth — YoY and CAGR
3. Relative position versus peers AND the market, split local vs global: median margins (NPM, EBITDA), growth and multiples, with the company's gap to each median, plus whether growth is sustained at the bottom line
4. Net profit growth, with the margin trend behind it
5. Valuation — P/E, EV/EBITDA, P/B, each placed against the company's own historical multiple series and reported in standard deviations from its own mean
6. Dividend yield and payout ratio
7. Sum-of-the-parts — attributable value per segment, holding discount, net debt, equity value per share and the implied gap to market cap

If the call carries no financial information at all it returns status "needs_financial_data" with the exact inputs it needs: ask the user/orchestrator for them ONCE, then call again. It never asks twice — a second call carrying anything (one fiscal year, a price, a peer set) is analyzed, with whatever is still missing listed under data_gaps. If nothing at all could be found, call again with data_request_already_made: true.

Neutral calculations only — no scores, price targets or buy/sell verdicts.`,
    schema: financialEquityAnalysisInputSchema,
  },
);

export const financialEquityAnalysisTool = financialEquityAnalysis;
