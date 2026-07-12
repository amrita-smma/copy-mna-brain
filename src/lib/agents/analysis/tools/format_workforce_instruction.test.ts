import { describe, it, expect } from "vitest";
import { formatWorkforceInstruction } from "./format_workforce_instruction";

const invoke = (args: Parameters<typeof formatWorkforceInstruction.invoke>[0]) =>
  formatWorkforceInstruction.invoke(args);

describe("formatWorkforceInstruction — bulk_relationship_graph", () => {
  it("emits hub company name and id in the header", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "5d9e7f86-bb47-44ca-b84f-cd1fb6ebf0c4",
        counterparty_names: ["Acme", "Beta Corp"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("Hosan");
    expect(result).toContain("5d9e7f86-bb47-44ca-b84f-cd1fb6ebf0c4");
    expect(result).toContain("2 directed relationship graph edges");
  });

  it("includes project codename when provided", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "5d9e7f86-bb47-44ca-b84f-cd1fb6ebf0c4",
        hub_company_project_name: "Project Hercules",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("Project Hercules");
  });

  it("hub_to_counterparty: hub is source_company, counterparty is target_company", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme", "Beta"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain('source_company = "Hosan"');
    expect(result).toContain("target_company = <counterparty name>");
    expect(result).toContain("Hosan --[SELLS_TO]--> <counterparty>");
  });

  it("counterparty_to_hub: counterparty is source_company, hub is target_company", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme", "Beta"],
        relation_type: "SELLS_TO",
        relation_direction: "counterparty_to_hub",
      }),
    );

    expect(result).toContain('target_company = "Hosan"');
    expect(result).toContain("source_company = <counterparty name>");
    expect(result).toContain("<counterparty> --[SELLS_TO]--> Hosan");
  });

  it("lists every counterparty name verbatim", async () => {
    const names = ["Aaron Co., Ltd.", "ABC Technology", "Aegis"];
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: names,
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    for (const name of names) {
      expect(result).toContain(name);
    }
  });

  it("includes source_reference when provided", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
        source_reference: "Hercules — Direct Customers register (v2)",
      }),
    );

    expect(result).toContain("Hercules — Direct Customers register (v2)");
  });

  it("includes edge_notes when provided", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
        edge_notes: "Per v2 register",
      }),
    );

    expect(result).toContain('notes = "Per v2 register"');
  });

  it("suggests batching when counterparties exceed 100", async () => {
    const names = Array.from({ length: 204 }, (_, i) => `Company ${i + 1}`);
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: names,
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("3 batches");
    expect(result).toContain("204 total");
  });

  it("single-batch note when 100 or fewer counterparties", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `Company ${i + 1}`);
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: names,
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("single generate_relationship_graph call");
  });

  it("works without hub_company_id (hub matched by name)", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).not.toContain("**Error:**");
    expect(result).toContain("Hosan");
    expect(result).not.toContain("company_id:");
  });

  it("returns an error when hub_company_name is missing", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("**Error:**");
    expect(result).toContain("hub_company_name");
  });

  it("instructs the Workforce to pass names only and not pre-create counterparties", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme", "Beta"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("NAMES ONLY");
    expect(result).toContain("add_company");
    expect(result).toContain("discovered");
  });

  it("includes project codename without an id when only the name is given", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_project_name: "Project Hercules",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("Hosan (Project Hercules)");
    expect(result).not.toContain("company_id:");
  });

  it("returns an error when counterparty_names is an empty array", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: [],
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("**Error:**");
    expect(result).toContain("counterparty_names");
  });

  it("returns an error when counterparty_names is a whitespace-only string", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: "   \n  ;  ",
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("**Error:**");
    expect(result).toContain("counterparty_names");
  });

  it("accepts a semicolon-separated string and preserves names containing commas", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names:
          "Aaron Co., Ltd.; ABC Technology; Transene Company INC.",
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).not.toContain("**Error:**");
    expect(result).toContain("3 total");
    // Names with internal commas must survive intact (comma is not a delimiter).
    expect(result).toContain("Aaron Co., Ltd.");
    expect(result).toContain("Transene Company INC.");
  });

  it("accepts a newline-separated string", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: "Acme\nBeta\nGamma",
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    expect(result).toContain("3 total");
    expect(result).toContain("Acme; Beta; Gamma");
  });

  it("drops blank entries and de-duplicates names (string form)", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: "Acme; ; Beta; acme; Acme;;Gamma",
        relation_type: "SELLS_TO",
        relation_direction: "hub_to_counterparty",
      }),
    );

    // "Acme"/"acme" collapse to one; blanks removed → Acme, Beta, Gamma.
    expect(result).toContain("3 total");
  });

  it("returns an error when relation_direction is missing", async () => {
    const result = String(
      await invoke({
        action_type: "bulk_relationship_graph",
        hub_company_name: "Hosan",
        hub_company_id: "abc-123",
        counterparty_names: ["Acme"],
        relation_type: "SELLS_TO",
      }),
    );

    expect(result).toContain("**Error:**");
    expect(result).toContain("relation_direction");
  });
});

describe("formatWorkforceInstruction — generic", () => {
  it("returns raw_intent when no context_pairs", async () => {
    const result = String(
      await invoke({
        action_type: "generic",
        raw_intent: "Promote Acme Corp (company_id: abc-123) from L0 to L1.",
      }),
    );

    expect(result).toBe(
      "Promote Acme Corp (company_id: abc-123) from L0 to L1.",
    );
  });

  it("appends context_pairs to raw_intent", async () => {
    const result = String(
      await invoke({
        action_type: "generic",
        raw_intent: "Refresh financials for the L2 companies.",
        context_pairs: [
          { label: "Workspace", value: "MnA" },
          { label: "Target stage", value: "L2" },
        ],
      }),
    );

    expect(result).toContain("Refresh financials");
    expect(result).toContain("Workspace: MnA");
    expect(result).toContain("Target stage: L2");
  });

  it("returns an error when raw_intent is missing", async () => {
    const result = String(
      await invoke({ action_type: "generic" }),
    );

    expect(result).toContain("**Error:**");
    expect(result).toContain("raw_intent");
  });
});
