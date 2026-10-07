import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetTable } from './AssetTable';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FeatureFlagsProvider } from '@/components/layout/FeatureFlagsContext';
import type { Fund, Holding, Investor } from './types';

type FlagsProviderProps = React.ComponentProps<typeof FeatureFlagsProvider>;

/** Wraps `child` in the feature-flag provider. Children go positionally (not as
 * a prop); the cast only covers the props type, which declares them required. */
const withFlags = (flags: FlagsProviderProps['flags'], child: React.ReactNode) =>
  React.createElement(FeatureFlagsProvider, { flags } as FlagsProviderProps, child);

vi.mock('@/components/chat/ChatProvider', () => ({
  useChatActions: () => ({
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
      withFlags(
        flags,
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(AssetTable, {
            funds,
            investors,
            initialGroupBy,
          }),
        ),
      ),
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

describe('AssetTable - Held by breakdown', () => {
  const makeFund = (id: string, n: string, h: Holding[]): Fund => ({
    id,
    n,
    v: 2021,
    size: 100,
    called: 0,
    calledPct: 0,
    fmv: 0,
    real: 0,
    dpi: 0,
    tvpi: null,
    irr: 0,
    st: 'Investing',
    h,
  });

  const copy = (id: string, positionId: string, cost: number): Holding => ({
    id,
    n: `Asset ${id}`,
    tp: 'Equity',
    cost,
    fmv: cost,
    real: 0,
    dt: '2023-01-01',
    moic: 1,
    st: 'Active',
    valuationCoverage: 'complete',
    positionId,
  });

  const makeEntity = (id: string, n: string, holdings: Holding[]): Investor => ({
    id,
    n,
    type: 'Corporate',
    stakes: {},
    groupName: 'Startech Group',
    holdings,
    valuationCoverage: 'complete',
  });

  function renderOpen(funds: Fund[], investors: Investor[] | undefined, openAssetIds: string[]) {
    return renderToStaticMarkup(
      withFlags(
        { FUND_VEHICLE_VIEW_ENABLED: true },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(AssetTable, {
            funds,
            investors,
            initialGroupBy: 'none',
            initialOpenAssets: openAssetIds.map((id) => `all::${id}`),
          }),
        ),
      ),
    );
  }

  /** The expanded detail row is the only full-width (colspan 8) cell in the body. */
  const isExpanded = (html: string) => /<td colSpan="8"/.test(html);

  /** The inner markup of one `data-testid` element (open tag through its row). */
  function testIdRow(html: string, testId: string): string {
    const m = html.match(new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</tr>`));
    return m?.[1] ?? '';
  }

  it('shows each fund, its Invested and share, plus a total equal to the row Invested', () => {
    const html = renderOpen(
      [
        makeFund('fund-rui-man', 'Rui Man Fund', [copy('asset-sdt', 'pos-man', 12)]),
        makeFund('fund-rui-lai', 'Rui Lai Fund', [copy('asset-sdt', 'pos-lai', 21)]),
      ],
      undefined,
      ['asset-sdt'],
    );

    expect(isExpanded(html)).toBe(true);
    expect(html).toContain('data-testid="asset-held-by-asset-sdt"');
    expect(html).toContain('Held by');

    const lai = testIdRow(html, 'asset-held-by-row-fund-rui-lai');
    expect(lai).toContain('Rui Lai Fund');
    expect(lai).toContain('$21M');
    expect(lai).toContain('63.6%');

    const man = testIdRow(html, 'asset-held-by-row-fund-rui-man');
    expect(man).toContain('Rui Man Fund');
    expect(man).toContain('$12M');
    expect(man).toContain('36.4%');

    // Largest holder first.
    expect(html.indexOf('asset-held-by-row-fund-rui-lai')).toBeLessThan(
      html.indexOf('asset-held-by-row-fund-rui-man'),
    );

    const total = testIdRow(html, 'asset-held-by-total-asset-sdt');
    expect(total).toContain('Total');
    expect(total).toContain('$33M');
    expect(total).toContain('100.0%');
  });

  it('shows the single fund at 100% for an asset only one fund holds', () => {
    const html = renderOpen(
      [makeFund('fund-solo', 'Solo Fund', [copy('asset-solo', 'pos-solo', 10)])],
      undefined,
      ['asset-solo'],
    );
    expect(isExpanded(html)).toBe(true);
    expect(html).toContain('data-testid="asset-held-by-asset-solo"');
    const solo = testIdRow(html, 'asset-held-by-row-fund-solo');
    expect(solo).toContain('Solo Fund');
    expect(solo).toContain('$10M');
    expect(solo).toContain('100.0%');
    expect(testIdRow(html, 'asset-held-by-total-asset-solo')).toContain('$10M');
  });

  it('does not render for a Startech-shaped asset held by investor entities', () => {
    const html = renderOpen(
      [],
      [
        makeEntity('inv-st-1', 'Startech Ltd', [copy('asset-st', 'pos-st-1', 40)]),
        makeEntity('inv-st-2', 'Startech HK', [copy('asset-st', 'pos-st-2', 60)]),
      ],
      ['asset-st'],
    );
    expect(isExpanded(html)).toBe(true);
    expect(html).not.toContain('asset-held-by-');
    expect(html).not.toContain('Held by');
  });

  it('does not render for an asset held by a single investor entity', () => {
    const html = renderOpen(
      [],
      [makeEntity('inv-st-solo', 'Startech Ltd', [copy('asset-st-solo', 'pos-st-solo', 25)])],
      ['asset-st-solo'],
    );
    expect(isExpanded(html)).toBe(true);
    expect(html).not.toContain('asset-held-by-');
    expect(html).not.toContain('Held by');
  });

  it('lists the entity co-holder alongside a single fund so the lines reconcile', () => {
    const html = renderOpen(
      [makeFund('fund-one', 'One Fund', [copy('asset-mix', 'pos-fund', 60)])],
      [makeEntity('inv-mix', 'Startech Ltd', [copy('asset-mix', 'pos-ent', 40)])],
      ['asset-mix'],
    );
    expect(isExpanded(html)).toBe(true);
    expect(testIdRow(html, 'asset-held-by-row-fund-one')).toContain('60.0%');
    expect(testIdRow(html, 'asset-held-by-row-inv-mix')).toContain('40.0%');
    expect(testIdRow(html, 'asset-held-by-total-asset-mix')).toContain('$100M');
  });
});
