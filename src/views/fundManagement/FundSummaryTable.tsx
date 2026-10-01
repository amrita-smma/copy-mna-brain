'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Investor } from './types';
import { useFundMoney } from './useFundMoney';
import { Chevron, DeleteRowMenu, DisclosureBadge, DisclosureFootnote, GlossaryTerm, PartialValuationAmount, Pill } from './parts';
import { TablePager } from './TablePager';
import { useFundData } from './context';
import { CashHistoryTable } from './CashHistoryTable';
import { distinctEnglishName, formatExact } from '@/lib/fundLedger/format';
import { flIsZero } from '@/lib/services/flDecimal';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const PAGE_SIZE = 25;

export const FUND_TABLE_COL_WIDTHS = [
  '34%',
  '9.5%',
  '9.5%',
  '12%',
  '7%',
  '7%',
  '9%',
  '6%',
  '6%',
] as const;

interface ColumnDef {
  label: string;
  term?: string;
  align: 'left' | 'right';
}

const MANAGED_COLS: ColumnDef[] = [
  { label: 'Fund', align: 'left' },
  { label: 'Commitment', term: 'pledged', align: 'right' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized MV', term: 'currentvalue', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
  { label: 'IRR', term: 'irr', align: 'right' },
  { label: 'Realized', term: 'cashreturned', align: 'right' },
  { label: 'DPI', term: 'dpiT', align: 'right' },
  { label: 'Phase', align: 'left' },
];

const EXTERNAL_COLS: ColumnDef[] = [
  { label: 'Fund', align: 'left' },
  { label: 'Held by', align: 'left' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized MV', term: 'currentvalue', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
  { label: '', align: 'right' },
  { label: '', align: 'right' },
  { label: 'DPI', term: 'dpiT', align: 'right' },
  { label: '', align: 'left' },
];

interface ComputedFundRow {
  f: Fund;
  invested: number;
  fmv: number | null;
  holdingFmv: number;
  real: number;
  coverage: 'partial' | 'complete';
  moic: number | null;
  dpiVal: number;
  calledPct: number;
}

function computeFundRow(f: Fund): ComputedFundRow {
  const invested = f.h.reduce((s, h) => s + h.cost, 0);
  const hasUnvalued = f.valuationCoverage === 'partial' || f.h.some((h) => h.fmv === null);
  const coverage = hasUnvalued ? 'partial' : 'complete';
  const holdingFmv = f.h.reduce((s, h) => s + (h.fmv ?? 0), 0);
  // Unrealized MV is holdings FMV only — cash never enters it (or MOIC), so the
  // cash FX status cannot block it either. "—" until at least one holding is valued.
  const fmv = f.h.some((h) => h.fmv != null) ? holdingFmv : null;
  const real = f.h.reduce((s, h) => s + h.real, 0);
  return {
    f,
    invested,
    fmv,
    holdingFmv,
    real,
    coverage,
    moic: coverage === 'partial' || invested <= 0 || fmv == null ? null : (fmv + real) / invested,
    dpiVal: invested > 0 ? real / invested : 0,
    calledPct: f.size > 0 ? (invested / f.size) * 100 : 0,
  };
}

/** The row's holder label for externally managed funds. */
function HeldByLabel({ heldBy }: { heldBy: string[] }) {
  if (!heldBy || heldBy.length === 0) return null;
  const first = heldBy[0];
  if (heldBy.length === 1) {
    return (
      <span
        className="block truncate text-[13px] text-foreground"
        title={first}
      >
        {first}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span
        className="truncate text-[13px] text-foreground"
        title={first}
      >
        {first}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default shrink-0 whitespace-nowrap inline-block rounded border bg-muted px-1 text-[11px] font-medium text-muted-foreground">
            +{heldBy.length - 1}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px]">
          <div className="text-xs font-semibold text-foreground">Holders</div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {heldBy.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The "Fund" tab: split into Managed Funds, Fund Investments, and Liquidated Funds. */
export function FundSummaryTable({
  funds,
  investors,
  onEditFund,
  positions,
  entries,
  asOfDate,
}: {
  funds: Fund[];
  investors: Investor[];
  onEditFund?: (fund: Fund) => void;
  positions?: FlPortfolioPosition[];
  entries?: FlPortfolioLedgerEntry[];
  asOfDate?: string | null;
}) {
  const { deleteFund } = useFundData();
  const { money } = useFundMoney();
  const [page, setPage] = useState(1);
  const [openFunds, setOpenFunds] = useState<Set<string>>(new Set());
  const [openCashHistories, setOpenCashHistories] = useState<Set<string>>(new Set());
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    managed: true,
    external: true,
    liquidated: false,
  });

  const toggle = (id: string) => {
    const next = new Set(openFunds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenFunds(next);
  };

  const toggleCashHistory = (id: string) => {
    setOpenCashHistories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Filter out synthetic orphan container (id: 'unassigned' / disclosure: 'no_holder')
  const validFunds = funds.filter(
    (f) => f.id !== 'unassigned' && f.disclosure !== 'no_holder',
  );

  // Section 1: Managed Funds (no disclosure, or disclosure not in external_fund / liquidated_fund)
  const managedRows = validFunds
    .filter((f) => !f.disclosure || (f.disclosure !== 'external_fund' && f.disclosure !== 'liquidated_fund'))
    .map(computeFundRow)
    .sort((a, b) => (b.fmv ?? b.holdingFmv) - (a.fmv ?? a.holdingFmv));

  // Section 2: Fund Investments (disclosure === 'external_fund')
  const externalRows = validFunds
    .filter((f) => f.disclosure === 'external_fund')
    .map(computeFundRow)
    .sort((a, b) => (b.f.ourPosition?.fmv ?? 0) - (a.f.ourPosition?.fmv ?? 0));

  // Section 3: Liquidated Funds (disclosure === 'liquidated_fund')
  const liquidatedRows = validFunds
    .filter((f) => f.disclosure === 'liquidated_fund')
    .map(computeFundRow)
    .sort((a, b) => (b.fmv ?? b.holdingFmv) - (a.fmv ?? a.holdingFmv));

  // Section 2 subtotals from ourPosition
  let extSubtotalInvested: number | null = null;
  let extSubtotalFmv: number | null = null;
  let extHasPartial = false;

  for (const r of externalRows) {
    const pos = r.f.ourPosition;
    if (!pos || pos.pendingFx) {
      extHasPartial = true;
      continue;
    }
    if (pos.invested != null) {
      extSubtotalInvested = (extSubtotalInvested ?? 0) + pos.invested;
    }
    if (pos.fmv != null) {
      extSubtotalFmv = (extSubtotalFmv ?? 0) + pos.fmv;
    } else {
      extHasPartial = true;
    }
  }

  // Section 1 paging
  const managedStart = (Math.min(page, Math.max(1, Math.ceil(managedRows.length / PAGE_SIZE))) - 1) * PAGE_SIZE;
  const pagedManagedRows = managedRows.slice(managedStart, managedStart + PAGE_SIZE);

  // Footnote only appears for disclosures not explained by a section heading
  const isUnexplainedDisclosure = (f: Fund) =>
    Boolean(
      f.displayOnly &&
      f.disclosure &&
      f.disclosure !== 'external_fund' &&
      f.disclosure !== 'liquidated_fund',
    );

  const hasDisplayOnlyOnScreen =
    (openSections.managed && pagedManagedRows.some((r) => isUnexplainedDisclosure(r.f))) ||
    (openSections.external && externalRows.some((r) => isUnexplainedDisclosure(r.f))) ||
    (openSections.liquidated && liquidatedRows.some((r) => isUnexplainedDisclosure(r.f)));

  const renderFundRow = (
    r: ComputedFundRow,
    sectionKind: 'managed' | 'external' | 'liquidated',
  ): ReactNode[] => {
    const { f, invested, fmv, real, moic, dpiVal, calledPct, coverage } = r;
    const phaseTerm = f.st === 'Investing' ? 'investing' : 'harvesting';
    // A fund we merely hold has neither of the two expandable sub-views: we keep
    // no cash statement for someone else's vehicle and no LP register for it, so
    // expanding could only ever say "No investors committed." Leave it flat.
    const isExpandable = sectionKind !== 'external';
    const isOpen = isExpandable && openFunds.has(f.id);
    const tableRows: ReactNode[] = [];

    const showBadge = Boolean(
      f.displayOnly &&
      f.disclosure &&
      f.disclosure !== 'external_fund' &&
      f.disclosure !== 'liquidated_fund',
    );

    tableRows.push(
      <tr
        key={f.id}
        onClick={isExpandable ? () => toggle(f.id) : undefined}
        className={cn(
          'border-b [&>td]:bg-card',
          isExpandable && 'cursor-pointer hover:[&>td]:bg-muted/40',
          isOpen && '[&>td]:!bg-accent/10',
        )}
      >
        <td className="px-3 py-2.5 align-middle overflow-hidden">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {isExpandable ? (
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(f.id);
                  }}
                >
                  <Chevron open={isOpen} />
                </button>
              ) : (
                /* Keeps the name column's left edge aligned with expandable sections. */
                <span className="inline-block w-3 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="truncate text-[13px] font-medium text-foreground"
                    title={f.n}
                  >
                    {f.n}
                  </span>
                  {showBadge && (
                    <div className="shrink-0">
                      <DisclosureBadge reason={f.disclosure!} />
                    </div>
                  )}
                </div>
                {distinctEnglishName(f.n, f.englishName) && (
                  <div
                    className="truncate text-[11px] text-muted-foreground"
                    title={distinctEnglishName(f.n, f.englishName)}
                  >
                    {distinctEnglishName(f.n, f.englishName)}
                  </div>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {f.v > 0 && (
                    <Pill>
                      <GlossaryTerm term="started">Started {f.v}</GlossaryTerm>
                    </Pill>
                  )}
                  {!f.displayOnly && f.cashStatus === 'incomplete_negative' ? (
                    <span
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                      title="Recorded outflows exceed recorded inflows: funding-side data is missing."
                    >
                      Cash:{' '}
                      {f.cashBalances?.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')}
                      {' (incomplete)'}
                    </span>
                  ) : !f.displayOnly && (f.fxStatus === 'pending_fx' ||
                  f.cashBalances?.some((b) => !flIsZero(b.amount)) ||
                  (f.cashBalance != null && f.cashBalance !== 0)) ? (
                    <span
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                      title={
                        f.fxStatus === 'pending_fx'
                          ? 'Multi-currency cash balances (Pending FX)'
                          : `Cash Balance: ${f.cashBalances?.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ') || money(f.cashBalance ?? 0)}`
                      }
                    >
                      Cash:{' '}
                      {f.fxStatus === 'pending_fx'
                        ? `${f.cashBalances?.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')} (FX Pending)`
                        : f.cashBalances && f.cashBalances.length > 0
                          ? f.cashBalances.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')
                          : money(f.cashBalance ?? 0)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!f.displayOnly && onEditFund && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditFund(f);
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  ✎ edit
                </button>
              )}
              {!f.displayOnly && (
                <div onClick={(e) => e.stopPropagation()}>
                  <DeleteRowMenu
                    label="Archive / liquidate fund"
                    title={`Archive "${f.n}"?`}
                    description={`This liquidates and archives the fund from active management views. All underlying ledger entries, positions, and history are retained.`}
                    onConfirm={() => deleteFund(f)}
                  />
                </div>
              )}
            </div>
          </div>
        </td>
        <td
          className={cn(
            'px-3 py-2.5 align-middle overflow-hidden text-[13px] text-foreground',
            sectionKind === 'external' ? 'text-left' : 'text-right font-medium',
          )}
        >
          {sectionKind === 'external' ? (
            <HeldByLabel heldBy={f.ourPosition?.heldBy ?? []} />
          ) : f.displayOnly ? (
            '—'
          ) : (
            money(f.size)
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">
          {sectionKind === 'external' ? (
            f.ourPosition && !f.ourPosition.pendingFx && f.ourPosition.invested != null ? (
              money(f.ourPosition.invested)
            ) : (
              '—'
            )
          ) : f.displayOnly ? (
            '—'
          ) : (
            <>
              {money(invested)}
              <div className="text-[11px] text-muted-foreground">{calledPct.toFixed(0)}% invested</div>
            </>
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
          {sectionKind === 'external' ? (
            <PartialValuationAmount partial={Boolean(f.ourPosition?.pendingFx)}>
              {f.ourPosition && !f.ourPosition.pendingFx && f.ourPosition.fmv != null
                ? money(f.ourPosition.fmv)
                : '—'}
            </PartialValuationAmount>
          ) : f.displayOnly ? (
            '—'
          ) : (
            <PartialValuationAmount partial={coverage === 'partial' && fmv != null}>
              {fmv != null ? money(fmv) : '—'}
            </PartialValuationAmount>
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
          {sectionKind === 'external'
            ? f.ourPosition && !f.ourPosition.pendingFx && f.ourPosition.moic != null
              ? `${f.ourPosition.moic.toFixed(2)}×`
              : '—'
            : f.displayOnly
              ? '—'
              : moic != null
                ? `${moic.toFixed(2)}×`
                : '—'}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
          {sectionKind === 'external'
            ? null
            : f.displayOnly
              ? '—'
              : `${f.irr > 0 ? '+' : ''}${f.irr.toFixed(1)}%`}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">
          {sectionKind === 'external'
            ? null
            : f.displayOnly
              ? '—'
              : real > 0
                ? money(real)
                : '—'}
        </td>
        <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
          {sectionKind === 'external' ? (
            f.ourPosition && !f.ourPosition.pendingFx && f.ourPosition.dpi != null ? (
              f.ourPosition.realized === 0 && f.ourPosition.fmv == null ? (
                '—'
              ) : (
                `${f.ourPosition.dpi.toFixed(2)}×`
              )
            ) : (
              '—'
            )
          ) : f.displayOnly ? (
            '—'
          ) : real === 0 && fmv == null ? (
            '—'
          ) : (
            `${dpiVal.toFixed(2)}×`
          )}
        </td>
        <td className="px-3 py-2.5 align-middle">
          {sectionKind === 'external' ? null : (
            <Pill>
              <GlossaryTerm term={phaseTerm}>{f.st}</GlossaryTerm>
            </Pill>
          )}
        </td>
      </tr>,
    );

    const hasCash = Boolean(
      f.cashStatus === 'incomplete_negative' ||
      f.fxStatus === 'pending_fx' ||
      (f.cashBalances && f.cashBalances.length > 0),
    );
    if (isOpen && hasCash) {
      const isCashHistoryOpen = openCashHistories.has(f.id);
      tableRows.push(
        <tr
          key={`${f.id}-cash-banner`}
          className="border-b bg-muted/20 hover:bg-muted/30 transition-colors cursor-pointer select-none"
          onClick={() => toggleCashHistory(f.id)}
          data-testid={`fund-cash-banner-${f.id}`}
        >
          <td colSpan={FUND_TABLE_COL_WIDTHS.length} className="px-3 py-2 pl-10 text-[12px]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Chevron open={isCashHistoryOpen} />
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  Cash Balance:
                </span>
                {f.cashStatus === 'incomplete_negative' ? (
                  <span
                    className="font-medium text-amber-600 dark:text-amber-400"
                    title="Recorded outflows exceed recorded inflows: funding-side data is missing."
                  >
                    {f.cashBalances?.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')}
                    {' · Incomplete (missing funding data)'}
                  </span>
                ) : f.fxStatus === 'pending_fx' ? (
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {f.cashBalances?.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')} (Pending FX)
                  </span>
                ) : (
                  <span className="font-medium text-foreground">
                    {f.cashBalances && f.cashBalances.length > 0
                      ? f.cashBalances.map((b) => `${b.currency} ${formatExact(b.amount, 2)}`).join(', ')
                      : money(f.cashBalance ?? 0)}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground mr-2">
                {isCashHistoryOpen ? 'Hide statement' : 'View cash statement'}
              </span>
            </div>
          </td>
        </tr>,
      );

      if (isCashHistoryOpen) {
        tableRows.push(
          <tr key={`${f.id}-cash-history`} className="border-b" data-testid={`cash-history-row-fund-${f.id}`}>
            <td colSpan={FUND_TABLE_COL_WIDTHS.length} className="bg-background px-4 py-3">
              <div className="pl-6">
                <CashHistoryTable
                  holder={{ kind: 'fund', id: f.id, name: f.n, englishName: f.englishName }}
                  positions={positions}
                  entries={entries}
                  asOfDate={asOfDate}
                />
              </div>
            </td>
          </tr>,
        );
      }
    }

    if (isOpen && investors) {
      const relevantInvestors = investors
        .map((inv) => {
          const committed = inv.stakes[f.id] || 0;
          const s = f.size > 0 ? committed / f.size : 0;
          const invInvested = inv.invested?.[f.id] ?? 0;
          const share = s > 0 ? s : invested > 0 ? invInvested / invested : 0;
          const isPartial = f.valuationCoverage === 'partial';
          const invFmv = fmv != null ? fmv * share : null;
          const invReal = f.real * share;
          const invMoic =
            isPartial || invInvested <= 0 || invFmv == null ? null : (invFmv + invReal) / invInvested;
          const invDpi = invInvested > 0 ? invReal / invInvested : 0;

          return {
            inv,
            s,
            committed,
            invInvested,
            invFmv,
            invReal,
            invMoic,
            invDpi,
            isPartial,
          };
        })
        .filter((row) => row.committed > 0 || row.invInvested > 0);

      if (relevantInvestors.length === 0) {
        tableRows.push(
          <tr key={`${f.id}-empty`} className="border-b">
            <td colSpan={FUND_TABLE_COL_WIDTHS.length} className="px-3 py-3 pl-10 text-[13px] text-muted-foreground bg-muted/10">
              No investors committed.
            </td>
          </tr>,
        );
      } else {
        relevantInvestors.forEach((invRow) => {
          tableRows.push(
            <tr key={`${f.id}-${invRow.inv.id}`} className="border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background">
              <td className="py-2 pl-3 pr-3 align-middle">
                <div className="flex items-center">
                  <span className="w-5 shrink-0" />
                  <div className="border-l-2 border-border pl-2.5">
                    <div className="text-[13px] font-medium text-foreground">{invRow.inv.n}</div>
                    {distinctEnglishName(invRow.inv.n, invRow.inv.englishName) && (
                      <div
                        className="text-[11px] leading-tight text-muted-foreground"
                        title={distinctEnglishName(invRow.inv.n, invRow.inv.englishName)}
                      >
                        {distinctEnglishName(invRow.inv.n, invRow.inv.englishName)}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(invRow.committed)}</td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(invRow.invInvested)}</td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                <PartialValuationAmount partial={invRow.isPartial && invRow.invFmv != null}>
                  {invRow.invFmv != null ? money(invRow.invFmv) : '—'}
                </PartialValuationAmount>
              </td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                {invRow.invMoic != null ? `${invRow.invMoic.toFixed(2)}×` : '—'}
              </td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-muted-foreground">—</td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                {invRow.invReal <= 0 ? '—' : money(invRow.invReal)}
              </td>
              <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                {`${invRow.invDpi.toFixed(2)}×`}
              </td>
              <td className="px-3 py-2 align-middle text-[13px] text-muted-foreground">—</td>
            </tr>,
          );
        });
      }
    }

    return tableRows;
  };

  const hasAnySection = managedRows.length > 0 || externalRows.length > 0 || liquidatedRows.length > 0;

  if (!hasAnySection) {
    return (
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[820px] border-collapse table-fixed">
          <colgroup>
            {FUND_TABLE_COL_WIDTHS.map((width, idx) => (
              <col key={idx} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {MANAGED_COLS.map((c, i) => (
                <th
                  key={i}
                  className={cn(
                    'whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.term ? <GlossaryTerm term={c.term}>{c.label}</GlossaryTerm> : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={FUND_TABLE_COL_WIDTHS.length} className="px-3 py-10 text-center text-sm text-muted-foreground">
                No funds yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  const renderSection = (
    key: string,
    title: string,
    subheading: string,
    rows: ComputedFundRow[],
    totalCount: number,
    sectionKind: 'managed' | 'external' | 'liquidated',
    footerEl?: ReactNode,
    pagerEl?: ReactNode,
  ) => {
    if (totalCount === 0) return null;
    const isOpen = openSections[key];
    const cols = sectionKind === 'external' ? EXTERNAL_COLS : MANAGED_COLS;

    return (
      <div key={key} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-start gap-2">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleSection(key)}
              className="mt-0.5 text-muted-foreground hover:text-foreground"
            >
              <Chevron open={isOpen} />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h3
                  className="cursor-pointer text-sm font-semibold text-foreground select-none"
                  onClick={() => toggleSection(key)}
                >
                  {title}
                </h3>
                <span className="text-xs text-muted-foreground font-normal">({totalCount})</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground italic">{subheading}</p>
            </div>
          </div>
        </div>

        {isOpen && (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[820px] border-collapse table-fixed">
              <colgroup>
                {FUND_TABLE_COL_WIDTHS.map((width, idx) => (
                  <col key={idx} style={{ width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {cols.map((c, i) => (
                    <th
                      key={i}
                      className={cn(
                        'whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                        c.align === 'right' ? 'text-right' : 'text-left',
                      )}
                    >
                      {c.label ? (c.term ? <GlossaryTerm term={c.term}>{c.label}</GlossaryTerm> : c.label) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((r) => renderFundRow(r, sectionKind))}
              </tbody>
              {footerEl && <tfoot>{footerEl}</tfoot>}
            </table>
          </div>
        )}

        {isOpen && pagerEl}
      </div>
    );
  };

  const externalFooter = (
    <tr className="border-t-2 border-border bg-muted/20 font-semibold">
      <td className="px-3 py-2.5 text-left align-middle text-[13px] font-semibold text-foreground">
        Total exposure
      </td>
      <td className="px-3 py-2.5" />
      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-semibold text-foreground">
        {extSubtotalInvested != null ? money(extSubtotalInvested) : '—'}
      </td>
      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-semibold text-foreground">
        <PartialValuationAmount partial={extHasPartial}>
          {extSubtotalFmv != null ? money(extSubtotalFmv) : '—'}
        </PartialValuationAmount>
      </td>
      <td className="px-3 py-2.5" />
      <td className="px-3 py-2.5" />
      <td className="px-3 py-2.5" />
      <td className="px-3 py-2.5" />
      <td className="px-3 py-2.5" />
    </tr>
  );

  return (
    <>
      <div className="space-y-6">
        {renderSection(
          'managed',
          'Managed Funds',
          'Vehicles we operate. Included in portfolio totals.',
          pagedManagedRows,
          managedRows.length,
          'managed',
          undefined,
          <TablePager
            page={page}
            pageSize={PAGE_SIZE}
            total={managedRows.length}
            onPageChange={setPage}
            itemLabel="fund"
          />,
        )}

        {renderSection(
          'external',
          'Fund Investments',
          "Externally managed funds we hold. Figures are our exposure, not the fund's own book.",
          externalRows,
          externalRows.length,
          'external',
          externalFooter,
        )}

        {renderSection(
          'liquidated',
          'Liquidated Funds',
          'Excluded from active portfolio totals.',
          liquidatedRows,
          liquidatedRows.length,
          'liquidated',
        )}
      </div>
      {hasDisplayOnlyOnScreen && <DisclosureFootnote />}
    </>
  );
}
