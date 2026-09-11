'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Pill } from './parts';
import { applyCommas } from '@/lib/numberFormat';
import {
  flAbs,
  flIsNegative,
  flIsPositive,
  flIsZero,
  formatScaledBigInt,
  parseToScaledBigInt,
} from '@/lib/services/flDecimal';
import { buildCashHistoryRows, type CashHistoryRow, type CashHistoryCurrencyGroup } from '@/lib/fundLedger/cashHistory';
import { distinctEnglishName } from '@/lib/fundLedger/format';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger/types';

export function formatCashDisplay(val: string): string {
  try {
    const abs = flAbs(val);
    const scaled = parseToScaledBigInt(abs);
    const formatted = formatScaledBigInt(scaled, 2);
    return applyCommas(formatted);
  } catch {
    return val;
  }
}

export function CashMovementTypeBadge({
  typeLabel,
  isReversal,
}: {
  typeLabel: string;
  isReversal?: boolean;
}) {
  let badgeContent: React.ReactNode;
  switch (typeLabel) {
    case 'Paid-in':
      badgeContent = (
        <Pill className="border-emerald-200 bg-emerald-500/10 text-emerald-700">
          Paid-in
        </Pill>
      );
      break;
    case 'Buy':
      badgeContent = (
        <Pill className="border-blue-200 bg-blue-500/10 text-blue-700">
          Buy
        </Pill>
      );
      break;
    case 'Sell':
    case 'Sell (retained)':
      badgeContent = (
        <Pill className="border-purple-200 bg-purple-500/10 text-purple-700">
          {typeLabel}
        </Pill>
      );
      break;
    case 'Distribution':
      badgeContent = (
        <Pill className="border-amber-200 bg-amber-500/10 text-amber-700">
          Distribution
        </Pill>
      );
      break;
    case 'Expense':
      badgeContent = (
        <Pill className="border-rose-200 bg-rose-500/10 text-rose-700">
          Expense
        </Pill>
      );
      break;
    case 'Opening balance':
      badgeContent = (
        <Pill className="border-slate-300 bg-slate-500/10 text-slate-700">
          Opening Balance
        </Pill>
      );
      break;
    case 'FX transfer':
      badgeContent = (
        <Pill className="border-indigo-200 bg-indigo-500/10 text-indigo-700">
          FX Transfer
        </Pill>
      );
      break;
    default:
      badgeContent = <Pill>{typeLabel}</Pill>;
      break;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {badgeContent}
      {isReversal && (
        <Pill className="border-rose-300 bg-rose-500/15 text-rose-700 font-semibold text-[10px]">
          Reversal
        </Pill>
      )}
    </span>
  );
}

export interface CashHistoryTableProps {
  holder: { kind?: 'fund'; id: string; name: string; englishName?: string };
  positions?: FlPortfolioPosition[];
  entries?: FlPortfolioLedgerEntry[];
  asOfDate?: string | null;
  refreshKey?: unknown;
}

export function CashHistoryTable({
  holder,
  positions: propPositions,
  entries: propEntries,
  asOfDate,
  refreshKey,
}: CashHistoryTableProps) {
  const [fetchedData, setFetchedData] = useState<{ positions: FlPortfolioPosition[]; entries: FlPortfolioLedgerEntry[] } | null>(null);
  const [loading, setLoading] = useState(propPositions === undefined || propEntries === undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (propPositions !== undefined && propEntries !== undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const readModel = await fundLedgerApi.getPortfolio(asOfDate || undefined);
      setFetchedData({
        positions: readModel.positions,
        entries: readModel.entries,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cash history');
    } finally {
      setLoading(false);
    }
  }, [asOfDate, propPositions, propEntries]);

  useEffect(() => {
    let isCancelled = false;

    if (propPositions !== undefined && propEntries !== undefined) {
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    fundLedgerApi
      .getPortfolio(asOfDate || undefined)
      .then((readModel) => {
        if (!isCancelled) {
          setFetchedData({
            positions: readModel.positions,
            entries: readModel.entries,
          });
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load cash history');
          setLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [holder.id, holder.kind, asOfDate, refreshKey, propPositions, propEntries]);

  const activePositions = propPositions !== undefined ? propPositions : fetchedData?.positions;
  const activeEntries = propEntries !== undefined ? propEntries : fetchedData?.entries;

  const currencyGroups: CashHistoryCurrencyGroup[] = useMemo(() => {
    if (!activePositions || !activeEntries) return [];
    const holderPositions = activePositions.filter(
      (p) => p.holder_fund_id === holder.id,
    );
    const cashPositions = holderPositions.filter(
      (p) => p.asset?.asset_kind === 'cash' || p.balance?.asset_kind === 'cash',
    );
    return buildCashHistoryRows(cashPositions, activeEntries, {
      asOfDate,
      positions: activePositions,
    });
  }, [activePositions, activeEntries, holder.id, asOfDate]);

  const totalMovements = currencyGroups.reduce((acc, g) => acc + g.rows.length, 0);

  return (
    <div
      className="rounded-md border bg-card p-3 space-y-3"
      data-testid={`cash-history-container-${holder.kind ?? 'fund'}-${holder.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
            Cash History
          </span>
          {holder.name && (
            <>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs font-medium text-foreground">{holder.name}</span>
              {distinctEnglishName(holder.name, holder.englishName) && (
                <span className="text-xs text-muted-foreground">
                  ({distinctEnglishName(holder.name, holder.englishName)})
                </span>
              )}
            </>
          )}
          {!loading && !error && totalMovements > 0 && (
            <Pill className="text-[10px]">
              {totalMovements} movement{totalMovements === 1 ? '' : 's'}
            </Pill>
          )}
        </div>
      </div>

      {error ? (
        <div
          className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          data-testid="cash-history-error"
        >
          <span>Failed to load cash history: {error}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div
          className="py-4 text-center text-xs text-muted-foreground"
          data-testid="cash-history-loading"
        >
          Loading cash history…
        </div>
      ) : totalMovements === 0 ? (
        <div
          className="py-4 text-center text-xs text-muted-foreground"
          data-testid="cash-history-empty"
        >
          No cash movements recorded.
        </div>
      ) : (
        <div className="space-y-4">
          {currencyGroups.map((group) => {
            const hasRows = group.rows.length > 0;
            return (
              <div
                key={group.currency}
                className="overflow-hidden rounded border bg-background"
                data-testid={`cash-history-subtable-${group.currency.toLowerCase()}`}
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2"
                  data-testid={`cash-history-currency-caption-${group.currency.toLowerCase()}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {group.currency}
                    </span>
                    <Pill className="text-[10px]">
                      {group.rows.length} movement{group.rows.length === 1 ? '' : 's'}
                    </Pill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Closing Balance:{' '}
                    <span className="font-semibold text-foreground">
                      {group.currency} {flIsNegative(group.closingBalance) ? '−' : ''}{formatCashDisplay(group.closingBalance)}
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b bg-muted/30 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-1.5">Date</th>
                        <th className="px-3 py-1.5">Type</th>
                        <th className="px-3 py-1.5">Source / Detail</th>
                        <th className="px-3 py-1.5 text-right">Amount</th>
                        <th className="px-3 py-1.5 text-right">Running Balance</th>
                        <th className="px-3 py-1.5">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!hasRows ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-3 py-4 text-center text-xs text-muted-foreground"
                          >
                            No cash movements recorded.
                          </td>
                        </tr>
                      ) : (
                        group.rows.map((row) => {
                          const isPositive = flIsPositive(row.amount);
                          const isZero = flIsZero(row.amount);
                          const isNegBal = flIsNegative(row.runningBalance);

                          return (
                            <tr
                              key={row.id}
                              className="border-b hover:bg-muted/30 last:border-b-0"
                              data-testid={`cash-history-row-${row.id}`}
                            >
                              <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                                {row.date || '—'}
                              </td>
                              <td className="whitespace-nowrap px-3 py-1.5">
                                <CashMovementTypeBadge
                                  typeLabel={row.typeLabel}
                                  isReversal={row.isReversal}
                                />
                              </td>
                              <td className="px-3 py-1.5 font-medium text-foreground">
                                {row.detail}
                              </td>
                              <td
                                className={cn(
                                  'whitespace-nowrap px-3 py-1.5 text-right font-medium',
                                  isZero
                                    ? 'text-muted-foreground'
                                    : isPositive
                                      ? 'text-success'
                                      : 'text-destructive',
                                )}
                              >
                                {isZero ? '' : isPositive ? '+' : '−'}
                                {formatCashDisplay(row.amount)}
                              </td>
                              <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium text-foreground">
                                {isNegBal ? '−' : ''}
                                {formatCashDisplay(row.runningBalance)}
                              </td>
                              <td
                                className="max-w-[200px] truncate px-3 py-1.5 text-muted-foreground"
                                title={row.notes || ''}
                              >
                                {row.notes || '—'}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
