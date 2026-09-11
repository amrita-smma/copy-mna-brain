import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceCurrencyProvider } from '@/components/layout/WorkspaceCurrencyContext';
import { buildLedgerIndex, summarizeLedger } from '@/lib/fundLedger';
import { buildTestPortfolio, ENTRIES } from '@/lib/fundLedger/testFixtures';
import { buildEntryColumns } from './columns';
import { LedgerMetrics } from './LedgerMetrics';
import { useLedgerMoney, type LedgerMoney } from './useLedgerMoney';
import type { Currency } from '@/lib/currency';

/** Renders whatever the hook hands back, so the provider wiring is exercised. */
function renderProbe(currency: Currency, read: (money: LedgerMoney) => string) {
  function Probe() {
    return createElement('span', null, read(useLedgerMoney()));
  }
  return renderToStaticMarkup(
    createElement(WorkspaceCurrencyProvider, {
      currency,
      children: createElement(Probe),
    }),
  );
}

describe('useLedgerMoney', () => {
  it('labels figures with the workspace display currency', () => {
    expect(renderProbe('CNY', (money) => money.moneyAbs('8650000'))).toContain('RMB 8.65M');
    expect(renderProbe('IDR', (money) => money.money('-43780000'))).toContain('Rp43.78M');
    expect(renderProbe('USD', (money) => money.moneyAbs('8650000'))).toContain('$8.65M');
  });

  it('reports the currency code a draft is posted in', () => {
    expect(renderProbe('CNY', (money) => money.currency)).toContain('CNY');
  });

  it('prices per unit in the same currency', () => {
    expect(renderProbe('IDR', (money) => money.price('4.608') ?? '')).toContain('Rp4.6080');
  });
});

describe('buildEntryColumns', () => {
  it('formats the money columns with the currency it is handed', () => {
    const index = buildLedgerIndex(buildTestPortfolio());
    const money: LedgerMoney = {
      currency: 'CNY',
      symbol: 'RMB ',
      money: (value) => `money:${value}`,
      moneyAbs: (value) => `abs:${value}`,
      price: (value) => `price:${value}`,
    };
    const columns = buildEntryColumns(index, false, money);
    const cash = columns.find((column) => column.id === 'cash');
    expect(cash?.cell?.(ENTRIES.gotoBuy, 0)).toBe('money:-43780000');
  });
});

describe('LedgerMetrics', () => {
  it('reads its headline figures in the workspace display currency', () => {
    const index = buildLedgerIndex(buildTestPortfolio());
    const summary = summarizeLedger(index.entries, index.entries);
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceCurrencyProvider,
        {
          currency: 'CNY',
          children: createElement(
            TooltipProvider,
            null,
            createElement(LedgerMetrics, {
              summary,
              asOf: '2026-04-02',
              from: null,
              filtered: false,
            }),
          ),
        },
      ),
    );
    expect(html).toContain('RMB ');
    expect(html).not.toContain('$');
  });
});
