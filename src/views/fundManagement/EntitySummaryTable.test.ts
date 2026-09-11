import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntitySummaryTable } from './EntitySummaryTable';
import { FundSummaryTable } from './FundSummaryTable';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Investor, Fund } from './types';

describe('EntitySummaryTable - Investor cash removed', () => {
  const mockInvestor: Investor = {
    id: 'inv-1',
    n: 'Test Investor',
    type: 'institutional',
    groupName: null,
    groupId: null,
    stakes: {},
    holdings: [
      {
        id: 'h-1',
        n: 'Portfolio Co A',
        tp: 'Direct Investments',
        cost: 100000,
        fmv: 150000,
        real: 0,
        dt: '2020-01-01',
        moic: 1.5,
        st: 'Active',
        valuationCoverage: 'complete',
      },
    ],
  };

  const mockFund: Fund = {
    id: 'fund-1',
    n: 'Fund 1',
    v: 2020,
    size: 10000000,
    called: 5000000,
    calledPct: 50,
    fmv: 8000000,
    real: 1000000,
    dpi: 0.2,
    tvpi: 1.8,
    irr: 12.5,
    st: 'Active',
    h: [],
    cashStatus: 'ok',
    cashBalance: 500000,
    cashBalances: [{ currency: 'USD', amount: '500000' }],
  };

  function findElement(node: any, predicate: (el: any) => boolean): any {
    if (!node) return null;
    if (predicate(node)) return node;
    if (Array.isArray(node)) {
      for (const child of node) {
        const res = findElement(child, predicate);
        if (res) return res;
      }
    }
    if (node.props?.children) {
      return findElement(node.props.children, predicate);
    }
    return null;
  }

  it('1. Does not render cash row, chevron, or statement for investor entities', () => {
    let capturedElement: any;
    function Harness() {
      capturedElement = EntitySummaryTable({
        funds: [],
        investors: [mockInvestor],
        initialOpenInvestors: ['inv-1'],
      });
      return capturedElement;
    }

    const html = renderToStaticMarkup(
      React.createElement(TooltipProvider, null, React.createElement(Harness)),
    );

    const cashRow = findElement(
      capturedElement,
      (el) => el?.type === 'tr' && el.props?.['data-testid'] === 'investor-cash-row-inv-1',
    );
    expect(cashRow).toBeNull();
    expect(html).not.toContain('investor-cash-row-inv-1');
    expect(html).not.toContain('investor-cash-chevron-inv-1');
    expect(html).not.toContain('cash-history-row-investor-inv-1');
    expect(html).not.toContain('View cash statement');
    expect(html).not.toContain('Cash Account');

    // Direct investments category is still rendered
    expect(html).toContain('Direct Investments');
  });

  it('2. Regression: the Fund tab Cash row behaviour is unchanged', () => {
    let capturedElement: any;
    function Harness() {
      capturedElement = FundSummaryTable({
        funds: [mockFund],
        investors: [],
      });
      return capturedElement;
    }

    renderToStaticMarkup(
      React.createElement(TooltipProvider, null, React.createElement(Harness)),
    );

    // Fund row exists and click toggles fund
    const fundRow = findElement(
      capturedElement,
      (el) => el?.type === 'tr' && el.props?.onClick !== undefined,
    );
    expect(fundRow).toBeDefined();
    expect(fundRow.props.onClick.toString()).toContain('toggle(f.id)');

    // Fund tab renders correctly
    const htmlFund = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(FundSummaryTable, {
          funds: [mockFund],
          investors: [],
        }),
      ),
    );
    expect(htmlFund).toContain('Fund 1');
  });
});
