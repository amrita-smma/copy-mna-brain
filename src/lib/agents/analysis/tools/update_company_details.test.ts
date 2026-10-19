import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findByIdOrNull,
  findByNameFuzzy,
  findByExactName,
  findByCompany,
  updateFromDTO,
  updateFinancials,
  createDb,
  createContainer,
  findAllTheses,
} = vi.hoisted(() => ({
  findAllTheses: vi.fn(),
  findByIdOrNull: vi.fn(),
  findByNameFuzzy: vi.fn(),
  findByExactName: vi.fn(),
  findByCompany: vi.fn(),
  updateFromDTO: vi.fn(),
  updateFinancials: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services/container", () => ({ createContainer }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByIdOrNull = findByIdOrNull;
    findByNameFuzzy = findByNameFuzzy;
    findByExactName = findByExactName;
  }
  class MockCompanyFinancialRepository {
    findByCompany = findByCompany;
  }
  class MockInvestmentThesisRepository {
    findAll = findAllTheses;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
    CompanyFinancialRepository: MockCompanyFinancialRepository,
    InvestmentThesisRepository: MockInvestmentThesisRepository,
  };
});

import { updateCompanyDetails } from "./update_company_details";

/** Widens the arg types so schema-rejection cases can pass invalid values. */
async function call(args: {
  company_id?: string;
  company_name?: string;
  fields?: Record<string, unknown>;
  financials?: Array<Record<string, unknown>>;
}) {
  return String(await updateCompanyDetails.invoke(args as never));
}

const ACME = {
  id: "c-acme",
  target: "Acme Corp",
  project_name: null,
  segment: "Specialty Chemicals",
  geography: "Korea",
  banker: null,
  advisor: "Goldman",
  source: "inbound",
  deal_type: "majority",
  is_live: true,
};

const TRACKS = [
  { id: "t-semis", title: "Semiconductors" },
  { id: "t-health", title: "Healthcare" },
  { id: "t-dup-1", title: "Consumer" },
  { id: "t-dup-2", title: "consumer" },
];

describe("update_company_details (workforce tool)", () => {
  beforeEach(() => {
    findByIdOrNull.mockReset();
    findByNameFuzzy.mockReset();
    findByExactName.mockReset().mockResolvedValue([]);
    findByCompany.mockReset().mockResolvedValue([]);
    findAllTheses.mockReset().mockResolvedValue(TRACKS);
    updateFromDTO.mockReset().mockResolvedValue({ id: "c-acme" });
    updateFinancials.mockReset().mockResolvedValue({ id: "c-acme" });
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyService: { updateFromDTO, updateFinancials },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  describe("argument validation", () => {
    it("requires either company_id or company_name", async () => {
      const result = await call({ fields: { segment: "Semiconductor" } });

      expect(result).toMatch(/either company_id or company_name is required/);
      expect(findByIdOrNull).not.toHaveBeenCalled();
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("requires at least one field or financial row", async () => {
      const result = await call({ company_id: "c-acme" });

      expect(result).toMatch(/nothing to update/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("treats an empty fields object with no financials as nothing to update", async () => {
      const result = await call({ company_id: "c-acme", fields: {}, financials: [] });

      expect(result).toMatch(/nothing to update/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    // A silently-stripped field would make the agent report a change that
    // never happened, so unsupported keys fail loudly and name the owning tool.
    it("rejects pipeline_stage and points at the stage tools", async () => {
      const result = await call({
        company_id: "c-acme",
        fields: { pipeline_stage: "L1" },
      });

      expect(result).toMatch(/cannot be set with update_company_details/);
      expect(result).toMatch(/lookup_pipeline_stage then move_stage/);
      expect(findByIdOrNull).not.toHaveBeenCalled();
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("rejects status and points at drop_company", async () => {
      const result = await call({ company_id: "c-acme", fields: { status: "dropped" } });

      expect(result).toMatch(/drop_company/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("rejects ai_opinion_verdict and points at save_ai_opinion", async () => {
      const result = await call({
        company_id: "c-acme",
        fields: { ai_opinion_verdict: "pass" },
      });

      expect(result).toMatch(/save_ai_opinion/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("redirects a flat per-year financial key to the financials array", async () => {
      const result = await call({
        company_id: "c-acme",
        fields: { revenue_2024_usd_mn: 118 },
      });

      expect(result).toMatch(/`revenue_2024_usd_mn`/);
      expect(result).toMatch(/financials: \[\{ fiscal_year: 2024/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("rejects a duplicate fiscal_year", async () => {
      const result = await call({
        company_id: "c-acme",
        financials: [
          { fiscal_year: 2024, revenue_usd_mn: 118 },
          { fiscal_year: 2024, ebitda_usd_mn: 21 },
        ],
      });

      expect(result).toMatch(/fiscal_year 2024 appears more than once/);
      expect(updateFinancials).not.toHaveBeenCalled();
    });

    it("rejects a financials row that sets no figures", async () => {
      const result = await call({
        company_id: "c-acme",
        financials: [{ fiscal_year: 2024 }],
      });

      expect(result).toMatch(/row for 2024 sets no figures/);
      expect(updateFinancials).not.toHaveBeenCalled();
    });

    it("rejects more than 20 financial rows", async () => {
      const result = await call({
        company_id: "c-acme",
        financials: Array.from({ length: 21 }, (_, i) => ({
          fiscal_year: 2000 + i,
          revenue_usd_mn: 1,
        })),
      });

      expect(result).toMatch(/at most 20 financial rows per call \(got 21\)/);
      expect(updateFinancials).not.toHaveBeenCalled();
    });

    it("rejects a malformed nbo_date via the schema layer", async () => {
      await expect(
        call({ company_id: "c-acme", fields: { nbo_date: "15 March 2026" } }),
      ).rejects.toThrow(/did not match expected schema/i);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("refuses a deal_type it cannot place, without touching the company", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { deal_type: "controlling interest" },
      });

      expect(result).toMatch(/deal_type must be one of/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("normalizes the deal_type spellings a human or an LLM writes", async () => {
      // deal_type is a Postgres enum, so the label has to be coerced before
      // the patch is built — a z.enum on the argument would have rejected it
      // before the handler ever ran.
      findByIdOrNull.mockResolvedValue(ACME);

      for (const [input, expected] of [
        ["Public Market Investing", "public_market"],
        ["M&A Advisory", "ma_advisory"],
        ["IPO", "ipo"],
      ] as const) {
        updateFromDTO.mockClear();
        await call({ company_id: "c-acme", fields: { deal_type: input } });
        expect(updateFromDTO).toHaveBeenCalledWith(
          "c-acme",
          expect.objectContaining({ deal_type: expected }),
          expect.anything(),
        );
      }
    });
  });

  describe("company resolution", () => {
    it("reports an unknown company id without creating anything", async () => {
      findByIdOrNull.mockResolvedValueOnce(null);

      const result = await call({ company_id: "c-missing", fields: { segment: "X" } });

      expect(result).toMatch(/No company found with id "c-missing"/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("reports an unmatched company name without creating anything", async () => {
      findByNameFuzzy.mockResolvedValueOnce(null);

      const result = await call({ company_name: "Nowhere Inc", fields: { segment: "X" } });

      expect(result).toMatch(/No company found matching "Nowhere Inc"/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("prefers company_id over company_name when both are given", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      await call({
        company_id: "c-acme",
        company_name: "Something Else",
        fields: { segment: "Semiconductor" },
      });

      expect(findByIdOrNull).toHaveBeenCalledWith("c-acme");
      expect(findByNameFuzzy).not.toHaveBeenCalled();
    });

    it("falls back to a fuzzy name match when no id is given", async () => {
      findByNameFuzzy.mockResolvedValueOnce(ACME);

      await call({ company_name: "  acme  ", fields: { segment: "Semiconductor" } });

      expect(findByNameFuzzy).toHaveBeenCalledWith("acme");
      expect(findByIdOrNull).not.toHaveBeenCalled();
    });
  });

  describe("core field writes", () => {
    it("writes only the changed fields and reports each old → new", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Semiconductor", geography: "Japan" },
      });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { segment: "Semiconductor", geography: "Japan" },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/Updated "Acme Corp" \(id: c-acme\)/);
      expect(result).toMatch(/segment: "Specialty Chemicals" → "Semiconductor"/);
      expect(result).toMatch(/geography: "Korea" → "Japan"/);
    });

    it("writes the Context tab's markdown through the context field", async () => {
      findByIdOrNull.mockResolvedValueOnce({ ...ACME, context: "Old background." });

      const result = await call({
        company_id: "c-acme",
        fields: { context: "## Background\nFounder wants out." },
      });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { context: "## Background\nFounder wants out." },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/context:/);
    });

    it("clears the context when null is passed", async () => {
      findByIdOrNull.mockResolvedValueOnce({ ...ACME, context: "Old background." });

      await call({ company_id: "c-acme", fields: { context: null } });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { context: null },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
    });

    it("skips values that already match what is on record", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Specialty Chemicals", geography: "Japan" },
      });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { geography: "Japan" },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).not.toMatch(/segment:/);
    });

    it("reports no changes without writing when every value already matches", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Specialty Chemicals", geography: "Korea" },
      });

      expect(result).toMatch(/No changes made to "Acme Corp"/);
      expect(updateFromDTO).not.toHaveBeenCalled();
      expect(updateFinancials).not.toHaveBeenCalled();
    });

    it("clears a field when passed null", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({ company_id: "c-acme", fields: { advisor: null } });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { advisor: null },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/advisor: "Goldman" → \(empty\)/);
    });

    it("treats a blank string as a clear", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      await call({ company_id: "c-acme", fields: { advisor: "   " } });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { advisor: null },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
    });

    it("writes a false boolean rather than treating it as absent", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({ company_id: "c-acme", fields: { is_live: false } });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { is_live: false },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/is_live: true → false/);
    });
  });

  describe("renames", () => {
    it("renames when no other company claims the new name", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { target: "Acme Holdings" },
      });

      expect(findByExactName).toHaveBeenCalledWith("Acme Holdings");
      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { target: "Acme Holdings" },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/Updated "Acme Holdings" \(id: c-acme\)/);
      expect(result).toMatch(/target: "Acme Corp" → "Acme Holdings"/);
    });

    it("renames when the only exact match is the company being renamed", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByExactName.mockResolvedValueOnce([{ id: "c-acme", target: "Acme Corporation" }]);

      const result = await call({
        company_id: "c-acme",
        fields: { target: "Acme Corporation" },
      });

      expect(updateFromDTO).toHaveBeenCalled();
      expect(result).toMatch(/target: "Acme Corp" → "Acme Corporation"/);
    });

    // Renaming onto another record would fork one company into two and break
    // every name lookup that follows, so it must not be attempted.
    it("refuses a rename that collides with a different company", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByExactName.mockResolvedValueOnce([{ id: "c-beta", target: "Beta Industries" }]);

      const result = await call({
        company_id: "c-acme",
        fields: { target: "Beta Industries", segment: "Semiconductor" },
      });

      expect(result).toMatch(/cannot rename "Acme Corp" to "Beta Industries"/);
      expect(result).toMatch(/id: c-beta/);
      expect(updateFromDTO).not.toHaveBeenCalled();
      expect(updateFinancials).not.toHaveBeenCalled();
    });

    // findByNameFuzzy strips legal suffixes and substring-matches, so using it
    // for the collision check would abort "Acme Corp" → "Acme Holdings" on an
    // unrelated "Acme Industries". Identity questions use the exact lookup.
    it("uses the exact-name lookup, never the fuzzy one, for the collision check", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      await call({ company_id: "c-acme", fields: { target: "Acme Holdings" } });

      expect(findByExactName).toHaveBeenCalledTimes(1);
      expect(findByNameFuzzy).not.toHaveBeenCalled();
    });

    it("does not run a collision check when the name is unchanged", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      await call({
        company_id: "c-acme",
        fields: { target: "Acme Corp", segment: "Semiconductor" },
      });

      expect(findByExactName).not.toHaveBeenCalled();
      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { segment: "Semiconductor" },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
    });

    it("rejects an empty target via the schema layer", async () => {
      await expect(
        call({ company_id: "c-acme", fields: { target: "   " } }),
      ).rejects.toThrow(/did not match expected schema/i);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });
  });

  describe("financial writes", () => {
    it("upserts the rows and reports each fiscal year oldest-first", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        financials: [
          { fiscal_year: 2024, revenue_usd_mn: 118, ebitda_usd_mn: 21 },
          { fiscal_year: 2023, revenue_usd_mn: 96 },
        ],
      });

      expect(updateFinancials).toHaveBeenCalledWith(
        "c-acme",
        [
          { fiscal_year: 2023, revenue_usd_mn: 96 },
          { fiscal_year: 2024, revenue_usd_mn: 118, ebitda_usd_mn: 21 },
        ],
        [],
        "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
      );
      expect(result.indexOf("FY2023")).toBeLessThan(result.indexOf("FY2024"));
      expect(result).toMatch(
        /FY2024: revenue \(empty\) → \$118M, ebitda \(empty\) → \$21M/,
      );
      expect(result).toMatch(/FY2023: revenue \(empty\) → \$96M/);
    });

    it("reports the stored figure it replaced", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByCompany.mockResolvedValueOnce([
        { fiscal_year: 2024, revenue_usd_mn: 96, ebitda_usd_mn: 18, ev_usd_mn: null },
      ]);

      const result = await call({
        company_id: "c-acme",
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 118 }],
      });

      expect(result).toMatch(/FY2024: revenue \$96M → \$118M/);
    });

    // A stored numeric can surface as a string, and "118" must not read as a
    // change from 118 — otherwise every re-run rewrites the row.
    it("skips a year whose figures already match, even when stored as strings", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByCompany.mockResolvedValueOnce([
        { fiscal_year: 2024, revenue_usd_mn: "118", ebitda_usd_mn: 21, ev_usd_mn: null },
      ]);

      const result = await call({
        company_id: "c-acme",
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 118, ebitda_usd_mn: 21 }],
      });

      expect(updateFinancials).not.toHaveBeenCalled();
      expect(result).toMatch(/No changes made to "Acme Corp"/);
    });

    it("writes only the years that actually moved", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByCompany.mockResolvedValueOnce([
        { fiscal_year: 2023, revenue_usd_mn: 96, ebitda_usd_mn: null, ev_usd_mn: null },
        { fiscal_year: 2024, revenue_usd_mn: 100, ebitda_usd_mn: null, ev_usd_mn: null },
      ]);

      const result = await call({
        company_id: "c-acme",
        financials: [
          { fiscal_year: 2023, revenue_usd_mn: 96 },
          { fiscal_year: 2024, revenue_usd_mn: 118 },
        ],
      });

      expect(updateFinancials).toHaveBeenCalledWith(
        "c-acme",
        [{ fiscal_year: 2024, revenue_usd_mn: 118 }],
        [],
        "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
      );
      expect(result).not.toMatch(/FY2023/);
      expect(result).toMatch(/FY2024: revenue \$100M → \$118M/);
    });

    it("clears a stored figure when passed null", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      findByCompany.mockResolvedValueOnce([
        { fiscal_year: 2024, revenue_usd_mn: 118, ebitda_usd_mn: null, ev_usd_mn: 640 },
      ]);

      const result = await call({
        company_id: "c-acme",
        financials: [{ fiscal_year: 2024, ev_usd_mn: null }],
      });

      expect(updateFinancials).toHaveBeenCalledWith(
        "c-acme",
        [{ fiscal_year: 2024, ev_usd_mn: null }],
        [],
        "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
      );
      expect(result).toMatch(/FY2024: ev \$640M → \(empty\)/);
    });

    it("does not read financials at all when none were submitted", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      await call({ company_id: "c-acme", fields: { segment: "Semiconductor" } });

      expect(findByCompany).not.toHaveBeenCalled();
    });

    it("applies fields and financials in a single call", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Semiconductor" },
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 118 }],
      });

      expect(updateFromDTO).toHaveBeenCalledTimes(1);
      expect(updateFinancials).toHaveBeenCalledTimes(1);
      expect(result).toMatch(/segment: "Specialty Chemicals" → "Semiconductor"/);
      expect(result).toMatch(/FY2024: revenue \(empty\) → \$118M/);
    });

    it("writes financials even when every core field already matches", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Specialty Chemicals" },
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 118 }],
      });

      expect(updateFromDTO).not.toHaveBeenCalled();
      expect(updateFinancials).toHaveBeenCalledTimes(1);
      expect(result).not.toMatch(/No changes made/);
    });
  });

  describe("error handling", () => {
    it("returns an **Error:** string when the service throws", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      updateFromDTO.mockRejectedValueOnce(new Error("db down"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await call({ company_id: "c-acme", fields: { segment: "X" } });

      expect(result).toMatch(/\*\*Error:\*\* db down/);
      errSpy.mockRestore();
    });

    // The agent must not report a clean failure when half the write landed.
    it("says the fields were saved when only the financials write fails", async () => {
      findByIdOrNull.mockResolvedValueOnce(ACME);
      updateFinancials.mockRejectedValueOnce(new Error("constraint violation"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Semiconductor" },
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 118 }],
      });

      expect(result).toMatch(
        /the detail fields were saved but the financials write failed: constraint violation/,
      );
      errSpy.mockRestore();
    });
  });

  describe("matched_track_ids", () => {
    it("replaces the matched tracks with the resolved ids and reports titles", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: ["t-health"] });

      const result = await call({
        company_id: "c-acme",
        fields: { matched_track_ids: ["t-semis", "t-health"] },
      });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { matched_track_ids: ["t-semis", "t-health"] },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toContain(
        'matched_track_ids: ["Healthcare"] → ["Semiconductors", "Healthcare"]',
      );
    });

    it("resolves an exact track title case-insensitively and de-duplicates", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: [] });

      await call({
        company_id: "c-acme",
        fields: { matched_track_ids: ["semiconductors", "t-semis"] },
      });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { matched_track_ids: ["t-semis"] },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
    });

    it("rejects the whole call when a track is unknown and lists the available tracks", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: [] });

      const result = await call({
        company_id: "c-acme",
        fields: { segment: "Semiconductor", matched_track_ids: ["t-semis", "Fintech"] },
      });

      expect(result).toMatch(/unknown track\(s\): "Fintech"/);
      expect(result).toContain("Semiconductors (id: t-semis)");
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("refuses a title shared by two tracks and asks for the id", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: [] });

      const result = await call({
        company_id: "c-acme",
        fields: { matched_track_ids: ["Consumer"] },
      });

      expect(result).toMatch(/more than one track — pass the id instead: "Consumer"/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("clears every match when passed null", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: ["t-semis"] });

      const result = await call({ company_id: "c-acme", fields: { matched_track_ids: null } });

      expect(updateFromDTO).toHaveBeenCalledWith(
        "c-acme",
        { matched_track_ids: [] },
        "UPDATED_DETAILS_BY_AI_WORKFORCE",
      );
      expect(result).toContain('matched_track_ids: ["Semiconductors"] → (empty)');
    });

    it("treats a reordered list as no change", async () => {
      findByIdOrNull.mockResolvedValue({ ...ACME, matched_track_ids: ["t-semis", "t-health"] });

      const result = await call({
        company_id: "c-acme",
        fields: { matched_track_ids: ["t-health", "t-semis"] },
      });

      expect(result).toMatch(/No changes made/);
      expect(updateFromDTO).not.toHaveBeenCalled();
    });

    it("does not read the track list when matched_track_ids is not passed", async () => {
      findByIdOrNull.mockResolvedValue(ACME);

      await call({ company_id: "c-acme", fields: { segment: "Semiconductor" } });

      expect(findAllTheses).not.toHaveBeenCalled();
    });
  });
});
