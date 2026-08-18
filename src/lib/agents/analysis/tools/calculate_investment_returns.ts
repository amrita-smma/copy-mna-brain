import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";

export const exitScenarioInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Scenario name (e.g. 'downside', 'base', 'upside')"),
  exit_valuation: z
    .number()
    .min(0)
    .describe(
      "Company valuation at exit, >= 0, in the same currency as investment_amount",
    ),
});

export const calculateInvestmentReturnsInputSchema = z.object({
  investment_amount: z
    .number()
    .positive()
    .describe("Total capital invested, must be > 0"),
  entry_ownership_pct: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Initial ownership percentage immediately after this investment round, decimal in [0, 1]",
    ),
  dilution_to_exit_pct: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Expected cumulative dilution percentage before exit, decimal in [0, 1]",
    ),
  holding_period_years: z
    .number()
    .positive()
    .describe("Expected holding period in years, must be > 0"),
  exit_scenarios: z
    .array(exitScenarioInputSchema)
    .min(1)
    .describe(
      "One or more named exit scenarios with nonnegative exit valuations",
    ),
});

export type ExitScenarioInput = z.infer<typeof exitScenarioInputSchema>;
export type CalculateInvestmentReturnsInput = z.infer<
  typeof calculateInvestmentReturnsInputSchema
>;

export interface ExitScenarioResult {
  name: string;
  exit_valuation: number;
  ownership_at_exit_pct: number;
  proceeds: number;
  moic: number;
  irr: number;
}

export interface CalculateInvestmentReturnsResult {
  assumptions: {
    investment_amount: number;
    entry_ownership_pct: number;
    dilution_to_exit_pct: number;
    holding_period_years: number;
    ownership_at_exit_pct: number;
  };
  scenarios: ExitScenarioResult[];
}

/**
 * Pure deterministic calculation function for VC return scenarios.
 *
 * Formulas:
 * - ownership_at_exit = entry_ownership_pct * (1 - dilution_to_exit_pct)
 * - proceeds = exit_valuation * ownership_at_exit
 * - moic = proceeds / investment_amount
 * - irr = moic ** (1 / holding_period_years) - 1 (deterministic -1 for zero exit)
 */
export function computeInvestmentReturns(
  inputs: CalculateInvestmentReturnsInput,
): CalculateInvestmentReturnsResult {
  if (
    typeof inputs.investment_amount !== "number" ||
    !Number.isFinite(inputs.investment_amount) ||
    inputs.investment_amount <= 0
  ) {
    throw new Error(
      `investment_amount must be a positive number; got ${inputs.investment_amount}`,
    );
  }

  if (
    typeof inputs.holding_period_years !== "number" ||
    !Number.isFinite(inputs.holding_period_years) ||
    inputs.holding_period_years <= 0
  ) {
    throw new Error(
      `holding_period_years must be a positive number; got ${inputs.holding_period_years}`,
    );
  }

  if (
    typeof inputs.entry_ownership_pct !== "number" ||
    !Number.isFinite(inputs.entry_ownership_pct) ||
    inputs.entry_ownership_pct < 0 ||
    inputs.entry_ownership_pct > 1
  ) {
    throw new Error(
      `entry_ownership_pct must be in [0, 1]; got ${inputs.entry_ownership_pct}`,
    );
  }

  if (
    typeof inputs.dilution_to_exit_pct !== "number" ||
    !Number.isFinite(inputs.dilution_to_exit_pct) ||
    inputs.dilution_to_exit_pct < 0 ||
    inputs.dilution_to_exit_pct > 1
  ) {
    throw new Error(
      `dilution_to_exit_pct must be in [0, 1]; got ${inputs.dilution_to_exit_pct}`,
    );
  }

  if (!Array.isArray(inputs.exit_scenarios) || inputs.exit_scenarios.length === 0) {
    throw new Error("exit_scenarios must be a non-empty array");
  }

  for (const scenario of inputs.exit_scenarios) {
    if (!scenario || typeof scenario.name !== "string" || scenario.name.trim().length === 0) {
      throw new Error("scenario name must be a non-empty string");
    }
    if (
      typeof scenario.exit_valuation !== "number" ||
      !Number.isFinite(scenario.exit_valuation) ||
      scenario.exit_valuation < 0
    ) {
      throw new Error(
        `exit_valuation must be >= 0 for scenario "${scenario?.name}"; got ${scenario?.exit_valuation}`,
      );
    }
  }

  const ownership_at_exit_pct =
    inputs.entry_ownership_pct * (1 - inputs.dilution_to_exit_pct);

  const scenarios: ExitScenarioResult[] = inputs.exit_scenarios.map((scenario) => {
    const proceeds = scenario.exit_valuation * ownership_at_exit_pct;
    const moic = scenario.exit_valuation === 0 ? 0 : proceeds / inputs.investment_amount;
    const irr =
      scenario.exit_valuation === 0 || moic === 0
        ? -1
        : Math.pow(moic, 1 / inputs.holding_period_years) - 1;

    return {
      name: scenario.name,
      exit_valuation: scenario.exit_valuation,
      ownership_at_exit_pct,
      proceeds,
      moic,
      irr,
    };
  });

  return {
    assumptions: {
      investment_amount: inputs.investment_amount,
      entry_ownership_pct: inputs.entry_ownership_pct,
      dilution_to_exit_pct: inputs.dilution_to_exit_pct,
      holding_period_years: inputs.holding_period_years,
      ownership_at_exit_pct,
    },
    scenarios,
  };
}

export const calculateInvestmentReturnsPure = computeInvestmentReturns;

/**
 * Fact-only LangChain tool that calculates ownership at exit, proceeds, MOIC,
 * and annualized IRR for arbitrary named exit scenarios.
 */
export const calculateInvestmentReturns = tool(
  async (inputs: CalculateInvestmentReturnsInput) => {
    logger.debug(
      `🔧 TOOL CALLED: calculate_investment_returns(investment_amount=${inputs.investment_amount}, scenarios=${inputs.exit_scenarios?.length})`,
    );
    return computeInvestmentReturns(inputs);
  },
  {
    name: "calculate_investment_returns",
    description: `Calculate ownership at exit, proceeds, MOIC, and annualized IRR across one or more named exit valuation scenarios.

Takes positive investment amount, entry ownership percentage [0, 1], dilution to exit percentage [0, 1], holding period in years (> 0), and a list of named exit scenarios with nonnegative exit valuations.

Returns a structured fact object containing echoed assumptions and per-scenario results (exit valuation, ownership at exit, proceeds, MOIC, and annualized IRR). Neutral calculations only; does not include hurdle rates, scores, or investment verdicts.`,
    schema: calculateInvestmentReturnsInputSchema,
  },
);

export const calculateInvestmentReturnsTool = calculateInvestmentReturns;
