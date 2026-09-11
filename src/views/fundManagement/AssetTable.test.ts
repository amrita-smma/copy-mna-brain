import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetTable } from './AssetTable';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FeatureFlagsProvider } from '@/components/layout/FeatureFlagsContext';
import type { Fund, Holding, Investor } from './types';

vi.mock('@/components/chat/ChatProvider', () => ({
  useChatContext: () => ({
    analyzeWithAI: vi.fn(),
  }),
}));

describe('AssetTable - exclude fund-target holdings', () => {
  const assetHolding: Holding = {
    id: 'holding-asset-1',
    n: 'Portfolio Co Alpha',
    targetKind: 'asset',
    tp: 'Direct Investments',
    cost: 10,
    fmv: 15,
    real: 0,
    dt: '2023-01-01',
    moic: 1.5,
    st: 'Active',
    valuationCoverage: 'complete',
  };

  const fundHolding: Holding = {
    id: 'holding-fund-1',
    n: 'Target Fund Beta',
    targetKind: 'fund',
    tp: 'Fund of funds',
    cost: 20,
    fmv: 25,
    real: 0,
    dt: '2023-01-01',
    moic: 1.25,
    st: 'Active',
    valuationCoverage: 'complete',
  };

  const mockFund: Fund = {
    id: 'fund-flagship-1',
    n: 'Flagship Growth Fund I',
    v: 2021,
    size: 100,
    called: 30,
    calledPct: 30,
    fmv: 40,
    real: 0,
    dpi: 0,
    tvpi: 1.33,
    irr: 10,
    st: 'Investing',
    h: [assetHolding, fundHolding],
  };

  const orphanHolding: Holding = {
    id: 'holding-orphan-1',
    n: 'Unlinked Direct Asset',
    targetKind: 'asset',
    tp: 'Direct Investments',
    cost: 0,
    fmv: null,
    real: 0,
    moic: null,
    st: 'Unlinked',
    dt: '2024-01-01',
    displayOnly: true,
    disclosure: 'no_holder',
  };

  const mockOrphanFund: Fund = {
    id: 'unassigned',
    n: 'Unassigned Assets',
    v: 2024,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv: null,
    real: 0,
    dpi: 0,
    tvpi: null,
    irr: 0,
    st: 'Active',
    displayOnly: true,
    disclosure: 'no_holder',
    h: [orphanHolding],
  };

  function renderTable(
    funds: Fund[],
    flags: Record<string, boolean> = {},
    investors?: Investor[],
    initialGroupBy?: 'none' | 'fund' | 'investor' | 'source',
  ) {
    return renderToStaticMarkup(
      React.createElement(FeatureFlagsProvider, {
        flags,
        children: React.createElement(
          TooltipProvider,
          null,
          React.createElement(AssetTable, {
            funds,
            investors,
            initialGroupBy,
          }),
        ),
      }),
    );
  }

  function countBodyRows(html: string): number {
    const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    return (tbody.match(/<tr\b/g) ?? []).length;
  }

  it('1. Flag on: a fund with one targetKind: "asset" holding and one targetKind: "fund" holding renders only the asset row', () => {
    const fund = {
      ...mockFund,
      h: [assetHolding, fundHolding],
    };
    const html = renderTable([fund], { FUND_VEHICLE_VIEW_ENABLED: true });

    // Asset row renders
    expect(html).toContain('Portfolio Co Alpha');
    // Fund row is excluded
    expect(html).not.toContain('Target Fund Beta');
    // Exactly 1 asset row rendered in the table body
    expect(countBodyRows(html)).toBe(1);
    // Fund.h is NOT mutated
    expect(fund.h).toHaveLength(2);
    expect(fund.h[0]).toBe(assetHolding);
    expect(fund.h[1]).toBe(fundHolding);
  });

  it('2. Flag off: both rows render', () => {
    const fund = {
      ...mockFund,
      h: [assetHolding, fundHolding],
    };
    // Ungrouped mode renders both rows
    const html = renderTable(
      [fund],
      { FUND_VEHICLE_VIEW_ENABLED: false },
      undefined,
      'none',
    );

    expect(html).toContain('Portfolio Co Alpha');
    expect(html).toContain('Target Fund Beta');
    // Exactly 2 asset rows rendered in the table body
    expect(countBodyRows(html)).toBe(2);
    // Fund.h is NOT mutated
    expect(fund.h).toHaveLength(2);

    // Also verify under default grouping when flag is off (by Investor):
    // both holdings are counted in the group subtotal
    const groupedHtml = renderTable([fund], { FUND_VEHICLE_VIEW_ENABLED: false });
    expect(groupedHtml).toContain('2 holdings');
  });

  it('3. Flag on: a group subtotal excludes the fund holding\'s cost/FMV', () => {
    const fund = {
      ...mockFund,
      h: [assetHolding, fundHolding],
    };
    // Group by fund type
    const html = renderTable(
      [fund],
      { FUND_VEHICLE_VIEW_ENABLED: true },
      undefined,
      'fund',
    );

    // Group row for the fund appears
    expect(html).toContain('Flagship Growth Fund I');
    // Only 1 holding counted in the subtotal pill
    expect(html).toContain('1 holding');
    expect(html).not.toContain('2 holdings');

    // Subtotal cost is assetHolding's cost ($10M), excluding fundHolding ($20M)
    expect(html).toContain('$10M');
    expect(html).not.toContain('$30M');

    // Subtotal FMV is assetHolding's FMV ($15M), excluding fundHolding ($25M)
    expect(html).toContain('$15M');
    expect(html).not.toContain('$40M');
  });

  it('4. Flag on: an orphan asset row (disclosure: "no_holder") still renders', () => {
    const html = renderTable([mockOrphanFund], { FUND_VEHICLE_VIEW_ENABLED: true });

    // Orphan asset name renders
    expect(html).toContain('Unlinked Direct Asset');
    // Disclosure badge renders
    expect(html).toContain('No holder linked');
  });
});
