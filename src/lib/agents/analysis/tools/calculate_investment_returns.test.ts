import { describe, expect, it } from "vitest";
import {
  calculateInvestmentReturns,
  calculateInvestmentReturnsTool,
  computeInvestmentReturns,
  type CalculateInvestmentReturnsInput,
} from "./calculate_investment_returns";

describe("computeInvestmentReturns (pure function)", () => {
  it("calculates known-answer return scenario with hand-checked values", () => {
    // Hand calculation:
    //   ownership_at_exit = 0.10 * (1 - 0.20) = 0.08 (8%)
    //   proceeds = 50_000_000 * 0.08 = 4_000_000
    //   moic = 4_000_000 / 1_000_000 = 4.0
    //   irr = 4.0 ** (1 / 5) - 1 ≈ 0.31950791
    const inputs: CalculateInvestmentReturnsInput = {
      investment_amount: 1_000_000,
      entry_ownership_pct: 0.1,
      dilution_to_exit_pct: 0.2,
      holding_period_years: 5,
      exit_scenarios: [{ name: "base", exit_valuation: 50_000_000 }],
    };

    const result = computeInvestmentReturns(inputs);

    expect(result.assumptions.investment_amount).toBe(1_000_000);
    expect(result.assumptions.entry_ownership_pct).toBe(0.1);
    expect(result.assumptions.dilution_to_exit_pct).toBe(0.2);
    expect(result.assumptions.holding_period_years).toBe(5);
    expect(result.assumptions.ownership_at_exit_pct).toBeCloseTo(0.08);

    expect(result.scenarios).toHaveLength(1);
    const base = result.scenarios[0];
    expect(base.name).toBe("base");
    expect(base.exit_valuation).toBe(50_000_000);
    expect(base.ownership_at_exit_pct).toBeCloseTo(0.08);
    expect(base.proceeds).toBeCloseTo(4_000_000);
    expect(base.moic).toBeCloseTo(4.0);
    expect(base.irr).toBeCloseTo(0.3195, 4);
  });

  it("calculates downside, base, and upside exit scenarios accurately", () => {
    // 5-year hold, $2M invested, 15% entry, 25% dilution -> exit ownership = 0.15 * 0.75 = 0.1125 (11.25%)
    // Downside: $10M exit -> proceeds = $1.125M -> MOIC = 0.5625 -> IRR = 0.5625^(1/5) - 1 ≈ -0.1087
    // Base: $40M exit -> proceeds = $4.5M -> MOIC = 2.25 -> IRR = 2.25^(1/5) - 1 ≈ 0.1761
    // Upside: $100M exit -> proceeds = $11.25M -> MOIC = 5.625 -> IRR = 5.625^(1/5) - 1 ≈ 0.4126
    const result = computeInvestmentReturns({
      investment_amount: 2_000_000,
      entry_ownership_pct: 0.15,
      dilution_to_exit_pct: 0.25,
      holding_period_years: 5,
      exit_scenarios: [
        { name: "downside", exit_valuation: 10_000_000 },
        { name: "base", exit_valuation: 40_000_000 },
        { name: "upside", exit_valuation: 100_000_000 },
      ],
    });

    expect(result.assumptions.ownership_at_exit_pct).toBeCloseTo(0.1125);
    expect(result.scenarios).toHaveLength(3);

    const [downside, base, upside] = result.scenarios;

    expect(downside.name).toBe("downside");
    expect(downside.proceeds).toBeCloseTo(1_125_000);
    expect(downside.moic).toBeCloseTo(0.5625);
    expect(downside.irr).toBeCloseTo(-0.1087, 4);

    expect(base.name).toBe("base");
    expect(base.proceeds).toBeCloseTo(4_500_000);
    expect(base.moic).toBeCloseTo(2.25);
    expect(base.irr).toBeCloseTo(0.1761, 4);

    expect(upside.name).toBe("upside");
    expect(upside.proceeds).toBeCloseTo(11_250_000);
    expect(upside.moic).toBeCloseTo(5.625);
    expect(upside.irr).toBeCloseTo(0.4126, 4);
  });

  describe("dilution scenarios", () => {
    it("handles zero dilution (ownership remains identical to entry)", () => {
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.2,
        dilution_to_exit_pct: 0,
        holding_period_years: 3,
        exit_scenarios: [{ name: "exit", exit_valuation: 20_000_000 }],
      });

      expect(result.assumptions.ownership_at_exit_pct).toBe(0.2);
      expect(result.scenarios[0].ownership_at_exit_pct).toBe(0.2);
      expect(result.scenarios[0].proceeds).toBeCloseTo(4_000_000);
      expect(result.scenarios[0].moic).toBeCloseTo(4.0);
    });

    it("handles 100% dilution (ownership is fully diluted to 0)", () => {
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.2,
        dilution_to_exit_pct: 1.0,
        holding_period_years: 3,
        exit_scenarios: [{ name: "exit", exit_valuation: 100_000_000 }],
      });

      expect(result.assumptions.ownership_at_exit_pct).toBe(0);
      expect(result.scenarios[0].ownership_at_exit_pct).toBe(0);
      expect(result.scenarios[0].proceeds).toBe(0);
      expect(result.scenarios[0].moic).toBe(0);
      expect(result.scenarios[0].irr).toBe(-1);
    });
  });

  describe("arbitrary scenario count and order", () => {
    it("supports a single exit scenario", () => {
      const result = computeInvestmentReturns({
        investment_amount: 500_000,
        entry_ownership_pct: 0.05,
        dilution_to_exit_pct: 0.1,
        holding_period_years: 4,
        exit_scenarios: [{ name: "target_exit", exit_valuation: 25_000_000 }],
      });

      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0].name).toBe("target_exit");
    });

    it("preserves arbitrary scenario names and caller order", () => {
      const scenarioNames = [
        "liquidation",
        "bear_case",
        "management_case",
        "bull_case",
        "moonshot",
      ];
      const exitScenarios = [
        { name: "liquidation", exit_valuation: 1_000_000 },
        { name: "bear_case", exit_valuation: 10_000_000 },
        { name: "management_case", exit_valuation: 30_000_000 },
        { name: "bull_case", exit_valuation: 75_000_000 },
        { name: "moonshot", exit_valuation: 200_000_000 },
      ];

      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.1,
        dilution_to_exit_pct: 0.1,
        holding_period_years: 5,
        exit_scenarios: exitScenarios,
      });

      expect(result.scenarios.map((s) => s.name)).toEqual(scenarioNames);
    });
  });

  describe("zero exit valuation and edge returns", () => {
    it("handles zero exit valuation deterministically (moic = 0, irr = -1)", () => {
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.1,
        dilution_to_exit_pct: 0.2,
        holding_period_years: 5,
        exit_scenarios: [
          { name: "total_loss", exit_valuation: 0 },
          { name: "positive_exit", exit_valuation: 20_000_000 },
        ],
      });

      const zeroScenario = result.scenarios[0];
      expect(zeroScenario.name).toBe("total_loss");
      expect(zeroScenario.exit_valuation).toBe(0);
      expect(zeroScenario.proceeds).toBe(0);
      expect(zeroScenario.moic).toBe(0);
      expect(zeroScenario.irr).toBe(-1);

      const positiveScenario = result.scenarios[1];
      expect(positiveScenario.moic).toBeGreaterThan(0);
      expect(positiveScenario.irr).toBeGreaterThan(-1);
    });

    it("handles 0% entry ownership deterministically (moic = 0, irr = -1)", () => {
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0,
        dilution_to_exit_pct: 0,
        holding_period_years: 5,
        exit_scenarios: [{ name: "exit", exit_valuation: 50_000_000 }],
      });

      expect(result.assumptions.ownership_at_exit_pct).toBe(0);
      expect(result.scenarios[0].proceeds).toBe(0);
      expect(result.scenarios[0].moic).toBe(0);
      expect(result.scenarios[0].irr).toBe(-1);
    });

    it("calculates break-even returns accurately (moic = 1.0, irr = 0.0)", () => {
      // $1M invested, 10% ownership at exit, $10M exit -> proceeds = $1M -> MOIC = 1.0 -> IRR = 0.0
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.1,
        dilution_to_exit_pct: 0,
        holding_period_years: 4,
        exit_scenarios: [{ name: "breakeven", exit_valuation: 10_000_000 }],
      });

      expect(result.scenarios[0].proceeds).toBeCloseTo(1_000_000);
      expect(result.scenarios[0].moic).toBeCloseTo(1.0);
      expect(result.scenarios[0].irr).toBeCloseTo(0.0);
    });
  });

  describe("neutral output structure", () => {
    it("returns strictly neutral facts without hurdle, verdict, score, or recommendation fields", () => {
      const result = computeInvestmentReturns({
        investment_amount: 1_000_000,
        entry_ownership_pct: 0.1,
        dilution_to_exit_pct: 0.2,
        holding_period_years: 5,
        exit_scenarios: [{ name: "base", exit_valuation: 50_000_000 }],
      });

      const topLevelKeys = Object.keys(result);
      expect(topLevelKeys.sort()).toEqual(["assumptions", "scenarios"]);

      const assumptionKeys = Object.keys(result.assumptions);
      expect(assumptionKeys.sort()).toEqual([
        "dilution_to_exit_pct",
        "entry_ownership_pct",
        "holding_period_years",
        "investment_amount",
        "ownership_at_exit_pct",
      ]);

      const scenarioKeys = Object.keys(result.scenarios[0]);
      expect(scenarioKeys.sort()).toEqual([
        "exit_valuation",
        "irr",
        "moic",
        "name",
        "ownership_at_exit_pct",
        "proceeds",
      ]);

      const forbiddenKeys = [
        "hurdle",
        "required_return",
        "requiredReturnPct",
        "clears_hurdle",
        "clearsRequiredReturn",
        "baseCaseClearsRequiredReturn",
        "score",
        "grade",
        "recommendation",
        "verdict",
      ];

      for (const key of forbiddenKeys) {
        expect(result).not.toHaveProperty(key);
        expect(result.assumptions).not.toHaveProperty(key);
        expect(result.scenarios[0]).not.toHaveProperty(key);
      }
    });
  });

  describe("validation boundaries", () => {
    const validInputs: CalculateInvestmentReturnsInput = {
      investment_amount: 1_000_000,
      entry_ownership_pct: 0.1,
      dilution_to_exit_pct: 0.2,
      holding_period_years: 5,
      exit_scenarios: [{ name: "base", exit_valuation: 50_000_000 }],
    };

    it("throws when investment_amount is <= 0 or invalid", () => {
      expect(() =>
        computeInvestmentReturns({ ...validInputs, investment_amount: 0 }),
      ).toThrow(/investment_amount/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, investment_amount: -500_000 }),
      ).toThrow(/investment_amount/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, investment_amount: NaN }),
      ).toThrow(/investment_amount/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, investment_amount: Infinity }),
      ).toThrow(/investment_amount/);
    });

    it("throws when holding_period_years is <= 0 or invalid", () => {
      expect(() =>
        computeInvestmentReturns({ ...validInputs, holding_period_years: 0 }),
      ).toThrow(/holding_period_years/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, holding_period_years: -2 }),
      ).toThrow(/holding_period_years/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, holding_period_years: NaN }),
      ).toThrow(/holding_period_years/);
    });

    it("throws when entry_ownership_pct is outside [0, 1]", () => {
      expect(() =>
        computeInvestmentReturns({ ...validInputs, entry_ownership_pct: -0.05 }),
      ).toThrow(/entry_ownership_pct/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, entry_ownership_pct: 1.05 }),
      ).toThrow(/entry_ownership_pct/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, entry_ownership_pct: NaN }),
      ).toThrow(/entry_ownership_pct/);
    });

    it("throws when dilution_to_exit_pct is outside [0, 1]", () => {
      expect(() =>
        computeInvestmentReturns({ ...validInputs, dilution_to_exit_pct: -0.1 }),
      ).toThrow(/dilution_to_exit_pct/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, dilution_to_exit_pct: 1.1 }),
      ).toThrow(/dilution_to_exit_pct/);
      expect(() =>
        computeInvestmentReturns({ ...validInputs, dilution_to_exit_pct: NaN }),
      ).toThrow(/dilution_to_exit_pct/);
    });

    it("throws when exit_scenarios is empty", () => {
      expect(() =>
        computeInvestmentReturns({ ...validInputs, exit_scenarios: [] }),
      ).toThrow(/exit_scenarios/);
    });

    it("throws when any exit_valuation is negative", () => {
      expect(() =>
        computeInvestmentReturns({
          ...validInputs,
          exit_scenarios: [
            { name: "valid", exit_valuation: 10_000_000 },
            { name: "invalid", exit_valuation: -1 },
          ],
        }),
      ).toThrow(/exit_valuation/);
    });

    it("throws when scenario name is empty or whitespace", () => {
      expect(() =>
        computeInvestmentReturns({
          ...validInputs,
          exit_scenarios: [{ name: "", exit_valuation: 10_000_000 }],
        }),
      ).toThrow(/scenario name/);
      expect(() =>
        computeInvestmentReturns({
          ...validInputs,
          exit_scenarios: [{ name: "   ", exit_valuation: 10_000_000 }],
        }),
      ).toThrow(/scenario name/);
    });
  });
});

describe("calculate_investment_returns (LangChain tool)", () => {
  it("has correct tool metadata", () => {
    expect(calculateInvestmentReturns.name).toBe("calculate_investment_returns");
    expect(calculateInvestmentReturnsTool.name).toBe("calculate_investment_returns");
    expect(calculateInvestmentReturns.description).toContain("Calculate ownership at exit");
  });

  it("can be invoked via tool.invoke() and returns the structured fact result", async () => {
    const inputs: CalculateInvestmentReturnsInput = {
      investment_amount: 1_000_000,
      entry_ownership_pct: 0.1,
      dilution_to_exit_pct: 0.2,
      holding_period_years: 5,
      exit_scenarios: [
        { name: "downside", exit_valuation: 10_000_000 },
        { name: "base", exit_valuation: 50_000_000 },
        { name: "upside", exit_valuation: 100_000_000 },
      ],
    };

    const result = await calculateInvestmentReturns.invoke(inputs);

    expect(result.assumptions.investment_amount).toBe(1_000_000);
    expect(result.assumptions.ownership_at_exit_pct).toBeCloseTo(0.08);
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[1].name).toBe("base");
    expect(result.scenarios[1].moic).toBeCloseTo(4.0);
    expect(result.scenarios[1].irr).toBeCloseTo(0.3195, 4);
  });
});
