import { describe, expect, it } from "vitest";
import {
  blankToNull,
  contactFormToPayload,
  contactToFormValues,
  safeProfileUrl,
} from "./utils";
import type { ContactFormValues, Correspondent } from "./types";

const EMPTY: ContactFormValues = {
  name: "",
  title: "",
  email: "",
  phone: "",
  type: "",
  department: "",
  specialization: "",
  seniority: "",
  coverage_region: "",
  linkedin_url: "",
};

describe("safeProfileUrl", () => {
  it("passes an https profile URL through", () => {
    expect(safeProfileUrl("https://www.linkedin.com/in/jane")).toBe(
      "https://www.linkedin.com/in/jane",
    );
  });

  it("upgrades a scheme-less value to https, which is how people paste it", () => {
    expect(safeProfileUrl("linkedin.com/in/jane")).toBe(
      "https://linkedin.com/in/jane",
    );
  });

  it("rejects a javascript: URL so it never becomes a clickable href", () => {
    expect(safeProfileUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: and other non-http schemes", () => {
    expect(safeProfileUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeProfileUrl("file:///etc/passwd")).toBeNull();
  });

  it("returns null for blank, whitespace, and null input", () => {
    expect(safeProfileUrl(null)).toBeNull();
    expect(safeProfileUrl("")).toBeNull();
    expect(safeProfileUrl("   ")).toBeNull();
  });
});

describe("blankToNull", () => {
  it("trims a value and nulls a whitespace-only one", () => {
    expect(blankToNull("  M&A  ")).toBe("M&A");
    expect(blankToNull("   ")).toBeNull();
  });
});

describe("contactFormToPayload", () => {
  it("sends every blank profile field as null so the editor can clear it", () => {
    expect(contactFormToPayload({ ...EMPTY, name: "  Jane  " })).toEqual({
      name: "Jane",
      title: null,
      email: null,
      phone: null,
      type: null,
      department: null,
      specialization: null,
      seniority: null,
      coverage_region: null,
      linkedin_url: null,
    });
  });

  it("never sends the bio — it is the AI-generated profile, not a form field", () => {
    expect(contactFormToPayload({ ...EMPTY, name: "Jane" })).not.toHaveProperty("bio");
  });

  it("carries every profile field through under its API name", () => {
    expect(
      contactFormToPayload({
        ...EMPTY,
        name: "Jane",
        department: "M&A",
        specialization: "Semiconductors",
        seniority: "Managing Director",
        coverage_region: "Asia Pacific",
        linkedin_url: "https://linkedin.com/in/jane",
      }),
    ).toMatchObject({
      department: "M&A",
      specialization: "Semiconductors",
      seniority: "Managing Director",
      coverage_region: "Asia Pacific",
      linkedin_url: "https://linkedin.com/in/jane",
    });
  });
});

describe("contactToFormValues", () => {
  it("turns every null column into an empty string so inputs stay controlled", () => {
    const contact: Correspondent = {
      id: "c1",
      employer_id: "e1",
      name: "Jane",
      title: null,
      email: null,
      phone: null,
      type: null,
      department: null,
      specialization: null,
      seniority: null,
      coverage_region: null,
      linkedin_url: null,
      bio: null,
      is_primary: true,
      source: "manual",
    };
    expect(contactToFormValues(contact)).toEqual({ ...EMPTY, name: "Jane" });
  });

  it("round-trips a fully populated contact back to the same payload", () => {
    const contact: Correspondent = {
      id: "c1",
      employer_id: "e1",
      name: "Jane",
      title: "MD, TMT",
      email: "jane@bank.com",
      phone: "+65 1234",
      type: "external",
      department: "M&A",
      specialization: "Semiconductors",
      seniority: "Managing Director",
      coverage_region: "Asia Pacific",
      linkedin_url: "https://linkedin.com/in/jane",
      bio: "Ex-Lazard.",
      is_primary: false,
      source: "manual",
    };
    expect(contactFormToPayload(contactToFormValues(contact))).toEqual({
      name: "Jane",
      title: "MD, TMT",
      email: "jane@bank.com",
      phone: "+65 1234",
      type: "external",
      department: "M&A",
      specialization: "Semiconductors",
      seniority: "Managing Director",
      coverage_region: "Asia Pacific",
      linkedin_url: "https://linkedin.com/in/jane",
    });
  });
});
