import { flAdd, flIsNegative, flIsZero, flSum, toDecimalString } from '@/lib/services/flDecimal';
import type { PositionBalances } from '@/lib/services/flBalanceService';

export type FundCashStatus = 'ok' | 'incomplete_negative';

export interface FundCashSummary {
  fund_id: string;
  holder?: { kind: 'fund' | 'investor'; id: string };
  cash_balances: Array<{ currency: string; amount: string }>;
  reporting_total: string | null;
  reporting_total_available: boolean;
  cash_status: FundCashStatus;
  fx_status: 'available' | 'pending_fx';
}

export interface FundCashSummaryParams {
  fund?: { id: string; base_currency?: string | null };
  holder?: { kind: 'fund' | 'investor'; id: string; base_currency?: string | null };
  positions: Array<any>;
  balances?: Map<string, PositionBalances> | PositionBalances[];
  entries?: Array<{
    position_id: string;
    currency: string;
    entry_date?: string;
    is_reversal?: boolean;
    cash_delta?: string | number | null;
  }>;
  asOfDate?: string | null;
}

/**
 * Computes cash balances and FX status for a fund or investor entity.
 *
 * An entity's cash balance is unconditionally the sum of cash_delta
 * over its cash positions, per currency.
 *
 * - Single-currency / base-currency only: reporting_total is available and matches sum.
 * - Multi-currency requiring conversion: reporting_total is null and fx_status is 'pending_fx'.
 * - Negative balance in any currency: cash_status is 'incomplete_negative' and reporting_total is null.
 */
export function computeFundCashSummary(params: FundCashSummaryParams): FundCashSummary {
  const { positions, asOfDate } = params;
  const holderKind: 'fund' | 'investor' = params.holder?.kind ?? 'fund';
  const holderId: string = params.holder?.id ?? params.fund?.id ?? '';
  const baseCurrency: string = params.holder?.base_currency ?? params.fund?.base_currency ?? 'USD';
  const holder = { kind: holderKind, id: holderId };

  // Build balance map
  const balanceMap = new Map<string, PositionBalances>();
  if (Array.isArray(params.balances)) {
    for (const b of params.balances) {
      balanceMap.set(b.position_id, b);
    }
  } else if (params.balances instanceof Map) {
    for (const [k, v] of params.balances.entries()) {
      balanceMap.set(k, v);
    }
  }
  // Also pick up inline pos.balance if available
  for (const p of positions) {
    if (p.balance && !balanceMap.has(p.id)) {
      balanceMap.set(p.id, p.balance);
    }
  }

  // Portfolio positions belonging to this fund or investor
  const portPositions = positions.filter((p) =>
    holderKind === 'fund'
      ? p.holder_fund_id === holderId
      : p.holder_investor_id === holderId,
  );
  const isCashPos = (p: (typeof positions)[0]) =>
    p.asset?.asset_kind === 'cash' || balanceMap.get(p.id)?.asset_kind === 'cash';

  const cashPositions = portPositions.filter(isCashPos);

  const balancesByCurrency = new Map<string, string>();

  for (const pos of cashPositions) {
    let amount = balanceMap.get(pos.id)?.cash_total;
    if (amount === undefined && params.entries) {
      let sum = '0.00000000';
      for (const e of params.entries) {
        if (e.position_id === pos.id && e.cash_delta != null) {
          if (!asOfDate || e.entry_date == null || e.entry_date <= asOfDate) {
            sum = flAdd(sum, String(e.cash_delta));
          }
        }
      }
      amount = sum;
    }
    const finalAmount = amount ?? '0.00000000';

    let ccy: string | undefined;
    if (pos.asset?.instrument_terms && typeof pos.asset.instrument_terms === 'object') {
      ccy = (pos.asset.instrument_terms as Record<string, unknown>).currency as string | undefined;
    }
    if (!ccy && (pos as any).currency) {
      ccy = (pos as any).currency;
    }
    if (!ccy && params.entries) {
      const entryWithCcy = params.entries.find((e) => e.position_id === pos.id && e.currency);
      if (entryWithCcy) {
        ccy = entryWithCcy.currency;
      }
    }
    if (!ccy) {
      ccy = baseCurrency;
    }

    balancesByCurrency.set(
      ccy,
      flAdd(balancesByCurrency.get(ccy) ?? '0.00000000', finalAmount),
    );
  }

  const cashBalances = Array.from(balancesByCurrency.entries())
    .map(([currency, amount]) => ({
      currency,
      amount: toDecimalString(amount),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // FX Boundary check
  const nonZeroBalances = cashBalances.filter((b) => !flIsZero(b.amount));
  const isPendingFx =
    nonZeroBalances.length > 0 &&
    !nonZeroBalances.every((b) => b.currency === baseCurrency);
  const fxStatus: 'available' | 'pending_fx' = isPendingFx ? 'pending_fx' : 'available';

  // Negative balance guard: negative cash balance indicates incomplete funding-side data
  const hasNegativeBalance = cashBalances.some((b) => flIsNegative(b.amount));

  if (hasNegativeBalance) {
    return {
      fund_id: holderId,
      holder,
      cash_balances: cashBalances,
      reporting_total: null,
      reporting_total_available: false,
      cash_status: 'incomplete_negative',
      fx_status: fxStatus,
    };
  }

  if (nonZeroBalances.length === 0) {
    return {
      fund_id: holderId,
      holder,
      cash_balances: cashBalances,
      reporting_total: '0.00000000',
      reporting_total_available: true,
      cash_status: 'ok',
      fx_status: 'available',
    };
  }

  const isAllBaseCurrency = nonZeroBalances.every((b) => b.currency === baseCurrency);

  if (isAllBaseCurrency) {
    const reportingTotal = flSum(cashBalances.map((b) => b.amount));
    return {
      fund_id: holderId,
      holder,
      cash_balances: cashBalances,
      reporting_total: toDecimalString(reportingTotal),
      reporting_total_available: true,
      cash_status: 'ok',
      fx_status: 'available',
    };
  }

  // Multi-currency requiring conversion: explicit pending-FX state, do not aggregate nominal amounts!
  return {
    fund_id: holderId,
    holder,
    cash_balances: cashBalances,
    reporting_total: null,
    reporting_total_available: false,
    cash_status: 'ok',
    fx_status: 'pending_fx',
  };
}
