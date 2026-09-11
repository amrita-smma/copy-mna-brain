import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureFlagsProvider } from "@/components/layout/FeatureFlagsContext";
import { Step1Entities } from "./Step1Entities";
import type { EntityTabKind, ReviewEntity } from "./types";

function entity(key: string, tab: EntityTabKind, name: string): ReviewEntity {
  return {
    key,
    tab,
    code: key,
    name,
    status: "new",
    isStaged: true,
    matchedId: null,
    fields: [],
    links: [],
  } as ReviewEntity;
}

const ENTITIES: ReviewEntity[] = [
  entity("asset:A1", "asset", "Asset One"),
  entity("fund:F1", "fund", "Fund One"),
  entity("investor:I1", "investor", "Investor One"),
];

const GROUPED_ENTITIES: ReviewEntity[] = [
  { ...entity("investor:G1", "investor", "Startech Growth Fund 1"), isGroup: true },
  { ...entity("investor:I1", "investor", "Investor One"), groupName: "Startech Growth Fund 1" },
  { ...entity("asset:A1", "asset", "Asset One"), groupName: "Startech Growth Fund 1" },
];

function render(
  flags: Record<string, boolean>,
  activeTab: EntityTabKind,
  entities: ReviewEntity[] = ENTITIES,
) {
  return renderToStaticMarkup(
    React.createElement(FeatureFlagsProvider, {
      flags,
      children: React.createElement(Step1Entities, {
        entities,
        activeTab,
        onTabChange: () => {},
        selectedEntityKey: null,
        onSelectEntity: () => {},
        onToggleStaged: () => {},
        onToggleAllInTab: () => {},
        onSaveRemap: () => {},
      }),
    }),
  );
}

describe("Step1Entities fund tab gating", () => {
  it("renders the Fund tab when FUND_VEHICLE_VIEW_ENABLED is on", () => {
    const html = render({ FUND_VEHICLE_VIEW_ENABLED: true }, "asset");
    expect(html).toContain("<span>Fund</span>");
  });

  it("hides the Fund tab when FUND_VEHICLE_VIEW_ENABLED is off", () => {
    const html = render({ FUND_VEHICLE_VIEW_ENABLED: false }, "asset");
    expect(html).not.toContain("<span>Fund</span>");
    expect(html).toContain("<span>Asset</span>");
    expect(html).toContain("<span>Source of Fund</span>");
  });

  it("falls back to the Asset tab when the fund tab was active and the flag is off", () => {
    const html = render({ FUND_VEHICLE_VIEW_ENABLED: false }, "fund");
    expect(html).toContain("Asset One");
    expect(html).not.toContain("Fund One");
  });
});

describe("Step1Entities grouping gating", () => {
  it("groups assets and investors by group name when FUND_VEHICLE_VIEW_ENABLED is off", () => {
    const investorHtml = render({ FUND_VEHICLE_VIEW_ENABLED: false }, "investor", GROUPED_ENTITIES);
    expect(investorHtml).toContain("Startech Growth Fund 1");
    expect(investorHtml).toContain("1 entity");

    const assetHtml = render({ FUND_VEHICLE_VIEW_ENABLED: false }, "asset", GROUPED_ENTITIES);
    expect(assetHtml).toContain("Startech Growth Fund 1");
    expect(assetHtml).toContain("1 asset");
  });

  it("renders a flat list with no group headers when FUND_VEHICLE_VIEW_ENABLED is on", () => {
    const investorHtml = render({ FUND_VEHICLE_VIEW_ENABLED: true }, "investor", GROUPED_ENTITIES);
    expect(investorHtml).toContain("Investor One");
    expect(investorHtml).not.toContain("1 entity");
    expect(investorHtml).not.toContain("Ungrouped");

    const assetHtml = render({ FUND_VEHICLE_VIEW_ENABLED: true }, "asset", GROUPED_ENTITIES);
    expect(assetHtml).toContain("Asset One");
    expect(assetHtml).not.toContain("1 asset");
    expect(assetHtml).not.toContain("Ungrouped");
  });
});
