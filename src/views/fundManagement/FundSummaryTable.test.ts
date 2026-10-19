import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FundSummaryTable } from './FundSummaryTable';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Fund, Holding } from './types';

describe('FundSummaryTable - Section splitting', () => {
  const mockManagedFund: Fund = {
    id: 'fund-managed-1',
    n: 'Flagship Growth Fund I',
    v: 2021,
    size: 100,
    called: 50,
    calledPct: 50,
    fmv: 80,
    real: 10,
    dpi: 0.2,
    tvpi: 1.8,
    irr: 15.5,
    st: 'Investing',
    h: [
      {
        id: 'h-1',
        n: 'Company A',
        tp: 'Direct Investments',
        cost: 50,
        fmv: 80,
        real: 10,
        dt: '2021-01-01',
        moic: 1.8,
        st: 'Active',
        valuationCoverage: 'complete',
      },
    ],
  };

  const mockExternalFund: Fund = {
    id: 'fund-external-1',
    n: 'Partner Venture Fund II',
    v: 2022,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv: 0,
    real: 0,
    dpi: 0,
    tvpi: 0,
    irr: 0,
    st: 'Investing',
    h: [],
    displayOnly: true,
    disclosure: 'external_fund',
    ourPosition: {
      invested: 25,
      fmv: 40,
      realized: 5,
      moic: 1.8,
      dpi: 0.2,
      heldBy: ['Flagship Growth Fund I', 'Flagship Growth Fund II'],
      pendingFx: false,
      currency: 'USD',
    },
  } as unknown as Fund;

  const mockExternalPendingFx: Fund = {
    id: 'fund-external-pending',
    n: 'Pending FX Co-Invest',
    v: 2023,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv: 0,
    real: 0,
    dpi: 0,
    tvpi: 0,
    irr: 0,
    st: 'Investing',
    h: [],
    displayOnly: true,
    disclosure: 'external_fund',
    ourPosition: {
      invested: null,
      fmv: null,
      realized: null,
      moic: null,
      dpi: null,
      heldBy: ['Flagship Growth Fund I'],
      pendingFx: true,
      currency: null,
    },
  } as unknown as Fund;

  const mockLiquidatedFund: Fund = {
    id: 'fund-liquidated-1',
    n: 'Old Vintage Fund 2012',
    v: 2012,
    size: 50,
    called: 50,
    calledPct: 100,
    fmv: 0,
    real: 75,
    dpi: 1.5,
    tvpi: 1.5,
    irr: 9.0,
    st: 'Harvesting',
    h: [],
    displayOnly: true,
    disclosure: 'liquidated_fund',
  };

  const mockUnassignedFund: Fund = {
    id: 'unassigned',
    n: 'Unassigned Assets',
    v: 0,
    size: 0,
    called: 0,
    calledPct: 0,
    fmv: 0,
    real: 0,
    dpi: 0,
    tvpi: 0,
    irr: 0,
    st: 'Active',
    h: [],
    displayOnly: true,
    disclosure: 'no_holder',
  };

  function renderTable(funds: Fund[]) {
    return renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(FundSummaryTable, {
          funds,
          investors: [],
        }),
      ),
    );
  }

  it('1. All four row kinds in => the three headings render, in order, and the unassigned row does not appear', () => {
    const html = renderTable([
      mockManagedFund,
      mockExternalFund,
      mockLiquidatedFund,
      mockUnassignedFund,
    ]);

    expect(html).toContain('Managed Funds');
    expect(html).toContain('Fund Investments');
    expect(html).toContain('Liquidated Funds');

    const idxManaged = html.indexOf('Managed Funds');
    const idxExternal = html.indexOf('Fund Investments');
    const idxLiquidated = html.indexOf('Liquidated Funds');

    expect(idxManaged).toBeGreaterThan(-1);
    expect(idxExternal).toBeGreaterThan(idxManaged);
    expect(idxLiquidated).toBeGreaterThan(idxExternal);

    expect(html).not.toContain('Unassigned Assets');
    expect(html).not.toContain('unassigned');
  });

  it('2. A section with no rows renders no heading', () => {
    // Only managed
    const htmlManagedOnly = renderTable([mockManagedFund]);
    expect(htmlManagedOnly).toContain('Managed Funds');
    expect(htmlManagedOnly).not.toContain('Fund Investments');
    expect(htmlManagedOnly).not.toContain('Liquidated Funds');

    // Only external
    const htmlExternalOnly = renderTable([mockExternalFund]);
    expect(htmlExternalOnly).not.toContain('Managed Funds');
    expect(htmlExternalOnly).toContain('Fund Investments');
    expect(htmlExternalOnly).not.toContain('Liquidated Funds');

    // Only liquidated
    const htmlLiquidatedOnly = renderTable([mockLiquidatedFund]);
    expect(htmlLiquidatedOnly).not.toContain('Managed Funds');
    expect(htmlLiquidatedOnly).not.toContain('Fund Investments');
    expect(htmlLiquidatedOnly).toContain('Liquidated Funds');

    // Empty
    const htmlEmpty = renderTable([]);
    expect(htmlEmpty).not.toContain('Managed Funds');
    expect(htmlEmpty).not.toContain('Fund Investments');
    expect(htmlEmpty).not.toContain('Liquidated Funds');
    expect(htmlEmpty).toContain('No funds yet.');
  });

  it('3. An external fund row shows its ourPosition figures and its Held by label', () => {
    const html = renderTable([mockExternalFund]);

    // Name and Held by
    expect(html).toContain('Partner Venture Fund II');
    expect(html).toContain('Held by');
    expect(html).toContain('Flagship Growth Fund I');
    expect(html).toContain('+1');

    // Figures from ourPosition
    // 25 invested, 40 FMV (in $M)
    expect(html).toContain('$25M');
    expect(html).toContain('$40M');
    expect(html).toContain('1.80×');
    expect(html).toContain('0.20×');

    // No external_fund DisclosureBadge
    expect(html).not.toContain('External · not managed');
  });

  it('4. pendingFx: true => no 0 is printed for invested/FMV on that row', () => {
    const html = renderTable([mockExternalPendingFx]);

    expect(html).toContain('Pending FX Co-Invest');
    expect(html).toContain('Flagship Growth Fund I');

    // In the row, invested and FMV should render an em dash ('—'), never 0 or $0
    expect(html).not.toContain('$0');
    expect(html).not.toContain('>0<');
    expect(html).not.toContain('>0%<');
    expect(html).not.toContain('0.00×');
  });

  it('5. Liquidated section renders collapsed (its rows absent from the initial markup)', () => {
    const html = renderTable([mockLiquidatedFund]);

    // Heading exists
    expect(html).toContain('Liquidated Funds');
    expect(html).toContain('Excluded from active portfolio totals.');

    // The fund name itself is absent from initial markup
    expect(html).not.toContain('Old Vintage Fund 2012');
  });

  it('6. Both section tables render the same nine <col> widths', () => {
    const html = renderTable([mockManagedFund, mockExternalFund]);

    const colgroups = html.match(/<colgroup>[\s\S]*?<\/colgroup>/g);
    expect(colgroups).not.toBeNull();
    expect(colgroups!.length).toBe(2);

    const expectedCols = [
      'width:34%',
      'width:9.5%',
      'width:9.5%',
      'width:12%',
      'width:7%',
      'width:7%',
      'width:9%',
      'width:6%',
      'width:6%',
    ];
    for (const colgroup of colgroups!) {
      for (const w of expectedCols) {
        expect(colgroup).toContain(w);
      }
    }
    expect(colgroups![0]).toBe(colgroups![1]);
  });

  it('7. A Fund Investments row renders no "—" in the IRR / Realized / Phase tracks (they are empty) and does render the holder name in the Held by column', () => {
    const html = renderTable([mockExternalFund]);

    // Track 2 renders holder name
    expect(html).toContain('Flagship Growth Fund I');

    // Find the row for mockExternalFund
    const row = html.split('<tr').find((r) => r.includes('Partner Venture Fund II'));
    expect(row).toBeDefined();
    const rowHtml = '<tr' + row!.split('</tr>')[0] + '</tr>';

    // Tracks 6 (IRR), 7 (Realized), and 9 (Phase) are empty cells in Fund Investments row.
    // They should not contain em dashes (neither should any other cell in mockExternalFund's row)
    expect(rowHtml).not.toContain('—');
    expect(rowHtml).toContain('Flagship Growth Fund I');
    expect(rowHtml).not.toContain('$5M');
  });

  it('8. DPI is "—" for a row with realized: 0, fmv: null, and "0.00×" for a row with realized: 0 and a non-null fmv', () => {
    // Managed row with real: 0, fmv: null (pending fx)
    const managedPendingFx: Fund = {
      ...mockManagedFund,
      id: 'managed-pending-dpi',
      n: 'Managed Pending DPI',
      fxStatus: 'pending_fx',
      fmv: null,
      h: [
        {
          ...mockManagedFund.h[0],
          real: 0,
          fmv: null,
        },
      ],
    };

    // Managed row with real: 0, fmv: 80 (non-null)
    const managedValuedZeroReal: Fund = {
      ...mockManagedFund,
      id: 'managed-valued-zero-real',
      n: 'Managed Valued Zero Real',
      fmv: 80,
      h: [
        {
          ...mockManagedFund.h[0],
          real: 0,
          fmv: 80,
        },
      ],
    };

    // External row with realized: 0, fmv: null
    const externalPendingFmv: Fund = {
      ...mockExternalFund,
      id: 'ext-pending-fmv',
      n: 'External Pending FMV',
      ourPosition: {
        ...mockExternalFund.ourPosition!,
        invested: 25,
        realized: 0,
        fmv: null,
        dpi: 0,
      },
    } as unknown as Fund;

    // External row with realized: 0, fmv: 40 (non-null)
    const externalValuedZeroReal: Fund = {
      ...mockExternalFund,
      id: 'ext-valued-zero-real',
      n: 'External Valued Zero Real',
      ourPosition: {
        ...mockExternalFund.ourPosition!,
        invested: 25,
        realized: 0,
        fmv: 40,
        dpi: 0,
      },
    } as unknown as Fund;

    const html = renderTable([
      managedPendingFx,
      managedValuedZeroReal,
      externalPendingFmv,
      externalValuedZeroReal,
    ]);

    const getRow = (name: string) => {
      const rowChunk = html.split('<tr').find((r) => r.includes(name));
      expect(rowChunk).toBeDefined();
      return '<tr' + rowChunk!.split('</tr>')[0] + '</tr>';
    };

    // Managed with real: 0, fmv: null => DPI is "—"
    const rowManagedPending = getRow('Managed Pending DPI');
    expect(rowManagedPending).toContain('—');
    expect(rowManagedPending).not.toContain('0.00×');

    // Managed with real: 0, fmv: 80 => DPI is "0.00×"
    const rowManagedValued = getRow('Managed Valued Zero Real');
    expect(rowManagedValued).toContain('0.00×');

    // External with realized: 0, fmv: null => DPI is "—"
    const rowExtPending = getRow('External Pending FMV');
    expect(rowExtPending).toContain('—');
    expect(rowExtPending).not.toContain('0.00×');

    // External with realized: 0, fmv: 40 => DPI is "0.00×"
    const rowExtValued = getRow('External Valued Zero Real');
    expect(rowExtValued).toContain('0.00×');
  });

  it('9. Managed Funds renders no subtotal; Fund Investments renders a "Total exposure" footer row', () => {
    const html = renderTable([mockManagedFund, mockExternalFund]);

    // Managed Funds section contains no subtotal text
    expect(html).not.toContain('Invested: </span>');
    expect(html).not.toContain('Unrealized Market Value: </span>');
    expect(html).not.toContain('Unrealized MV: </span>');
    expect(html).not.toContain('Realized Value: </span>');
    expect(html).not.toContain('Realized: </span>');

    // Fund Investments section renders a Total exposure footer row inside <tfoot>
    const tfootMatch = html.match(/<tfoot>[\s\S]*?<\/tfoot>/);
    expect(tfootMatch).not.toBeNull();
    const tfootHtml = tfootMatch![0];

    expect(tfootHtml).toContain('Total exposure');
    expect(tfootHtml).toContain('$25M');
    expect(tfootHtml).toContain('$40M');
  });

  it('11. A Fund Investments row is not expandable, while a Managed Funds row is', () => {
    const html = renderTable([mockManagedFund, mockExternalFund]);

    const rowFor = (name: string) => {
      const row = html.split('<tr').find((r) => r.includes(name));
      expect(row).toBeDefined();
      return '<tr' + row!.split('</tr>')[0] + '</tr>';
    };

    // Neither of the two expandable sub-views (cash statement, per-investor
    // commitments) exists for a fund we merely hold, so the row carries no
    // disclosure control and no pointer affordance.
    const externalRow = rowFor('Partner Venture Fund II');
    expect(externalRow).not.toContain('aria-expanded');
    expect(externalRow).not.toContain('cursor-pointer');
    expect(externalRow).not.toContain('▸');

    const managedRow = rowFor('Flagship Growth Fund I');
    expect(managedRow).toContain('aria-expanded');
    expect(managedRow).toContain('cursor-pointer');

    // And the managed-row empty state never reaches the external section.
    expect(html).not.toContain('No investors committed.');
  });
});

describe('FundSummaryTable - Unrealized MV and MOIC exclude cash', () => {
  const holding = {
    id: 'h-cash-test',
    n: 'Company A',
    tp: 'Equity',
    cost: 50,
    fmv: 80,
    real: 10,
    dt: '2021-01-01',
    moic: 1.8,
    st: 'Active',
    valuationCoverage: 'complete',
    valuationMethod: 'mark',
  } as Holding;

  const fundWithCash: Fund = {
    id: 'fund-with-cash',
    n: 'Fund With Cash',
    v: 2021,
    size: 100,
    called: 50,
    calledPct: 50,
    // A cash-inclusive fund-level figure (80M holdings + 30M cash) must never reach the cell:
    // the row derives Unrealized MV from its holdings.
    fmv: 110,
    real: 10,
    dpi: 0.2,
    tvpi: 2.4,
    irr: 0,
    st: 'Investing',
    h: [holding],
    valuationCoverage: 'complete',
    fxStatus: 'available',
    reportingTotalAvailable: true,
    cashBalance: 30,
    cashBalances: [{ currency: 'USD', amount: '30000000.00000000' }],
  };

  function renderTable(fund: Fund): string {
    return renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(FundSummaryTable, { funds: [fund], investors: [] }),
      ),
    );
  }

  /** The fund row's cells after the Fund-name cell: Commitment, Invested, Unrealized MV, MOIC, ... */
  function renderRowCells(fund: Fund): string[] {
    const row = renderTable(fund).split('<tr').find((r) => r.includes(fund.n));
    expect(row).toBeDefined();
    return row!.split('</tr>')[0].split('<td').slice(2);
  }

  it('shows holdings FMV only as Unrealized MV and computes MOIC without cash', () => {
    const [, , mvCell, moicCell] = renderRowCells(fundWithCash);
    // Unrealized MV = 80M of holdings, not 80M + 30M cash
    expect(mvCell).toContain('$80M');
    expect(mvCell).not.toContain('$110M');
    // MOIC = (80 + 10) / 50 = 1.80×, not (110 + 10) / 50 = 2.40×
    expect(moicCell).toContain('1.80×');
  });

  it('keeps the Cash Balance visible on the fund row', () => {
    const html = renderTable(fundWithCash);
    expect(html).toContain('Cash:');
    expect(html).toContain('USD 30,000,000.00');
  });

  it('shows "—" for Unrealized MV and MOIC when no holding is valued', () => {
    const unvalued: Fund = {
      ...fundWithCash,
      id: 'fund-unvalued',
      n: 'Fund Unvalued',
      fmv: null,
      tvpi: null,
      valuationCoverage: 'partial',
      h: [{ ...holding, fmv: null, valuationMethod: null, valuationCoverage: 'partial' } as Holding],
    };
    const [, , mvCell, moicCell] = renderRowCells(unvalued);
    expect(mvCell).toContain('—');
    expect(mvCell).not.toContain('$30M');
    expect(moicCell).toContain('—');
  });

  it('shows the valued holdings with the partial marker, and no MOIC, when only some holdings are valued', () => {
    const partial: Fund = {
      ...fundWithCash,
      id: 'fund-partial',
      n: 'Fund Partial',
      valuationCoverage: 'partial',
      h: [
        holding,
        { ...holding, id: 'h-unvalued', n: 'Company B', fmv: null, valuationMethod: null, valuationCoverage: 'partial' } as Holding,
      ],
    };
    const [, , mvCell, moicCell] = renderRowCells(partial);
    expect(mvCell).toContain('$80M');
    expect(mvCell).toContain('border-dotted');
    expect(moicCell).toContain('—');
  });

  it("shows holdings FMV and MOIC when the fund's cash is pending FX", () => {
    const pendingFx: Fund = {
      ...fundWithCash,
      id: 'fund-pending-fx',
      n: 'Fund Pending FX',
      fxStatus: 'pending_fx',
      reportingTotalAvailable: false,
      cashBalance: null,
      tvpi: null,
    };
    const [, , mvCell, moicCell] = renderRowCells(pendingFx);
    expect(mvCell).toContain('$80M');
    expect(mvCell).not.toContain('FX pending');
    expect(moicCell).toContain('1.80×');
  });
});
