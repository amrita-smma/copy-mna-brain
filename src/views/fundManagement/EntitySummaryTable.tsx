'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Holding, Investor, ValuationCoverage } from './types';
import { useFundMoney } from './useFundMoney';
import { Chevron, DeleteRowMenu, DisclosureBadge, DisclosureFootnote, GlossaryTerm, GroupSectionRow, PartialValuationAmount, Pill } from './parts';
import { InlineCommitmentHistory } from './CommitmentHistoryTable';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger/types';
import { filterEntityInvestors } from './adapters';
import { distinctEnglishName } from '@/lib/fundLedger/format';

const COLS: { label: string; term?: string; align: 'left' | 'right' }[] = [
  { label: 'Investment Entity', align: 'left' },
  { label: 'Commitment', term: 'pledged', align: 'right' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized Market Value', term: 'currentvalue', align: 'right' },
  { label: 'Net Gain', term: 'netgain', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
];

interface EntityComputedRow {
  inv: Investor;
  commit: number;
  coverage: ValuationCoverage;
  a: {
    cost: number;
    fmv: number;
    real: number;
    gain: number | null;
    moic: number | null;
    count: number;
    valuationCoverage: ValuationCoverage;
  };
}

/** Section heading for entities that belong to no investor group. */
const UNGROUPED_SECTION = 'Other entities';

/** The "Investment Entity" tab: an aggregate row per entity, grouped into collapsible sections. */
export function EntitySummaryTable({
  funds,
  investors,
  onEditStakes,
  onEditInvestor,
  onDeleteInvestor,
  onMoveInvestor,
  commitmentNonce,
  positions,
  entries,
  asOfDate,
  initialOpenInvestors,
}: {
  funds: Fund[];
  investors: Investor[];
  onEditStakes?: (investorId: string, fundId?: string) => void;
  onEditInvestor?: (investor: Investor) => void;
  onDeleteInvestor?: (investorId: string) => Promise<void>;
  onMoveInvestor?: (investor: Investor) => void;
  commitmentNonce?: number;
  positions?: FlPortfolioPosition[];
  entries?: FlPortfolioLedgerEntry[];
  asOfDate?: string | null;
  initialOpenInvestors?: string[];
}) {
  const { money } = useFundMoney();
  const [openInvestors, setOpenInvestors] = useState<Set<string>>(
    () => new Set(initialOpenInvestors ?? []),
  );
  const [openHoldingTypes, setOpenHoldingTypes] = useState<Set<string>>(new Set());
  const [openFundHistories, setOpenFundHistories] = useState<Set<string>>(new Set());
  // Group sections start open; this tracks the ones the user collapsed.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (name: string) => {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggle = (id: string) => {
    const next = new Set(openInvestors);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenInvestors(next);
  };

  const toggleHoldingType = (key: string) => {
    setOpenHoldingTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFundHistory = (key: string) => {
    setOpenFundHistories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleInvestors = useMemo(() => filterEntityInvestors(investors), [investors]);
  const hasDisplayOnlyOnScreen = useMemo(() => {
    return visibleInvestors.some((inv) =>
      openInvestors.has(inv.id) &&
      (inv.holdings ?? []).some((h) => h.displayOnly || h.disclosure),
    );
  }, [visibleInvestors, openInvestors]);

  const rows: EntityComputedRow[] = visibleInvestors.map((inv) => {
    let fundCost = 0;
    let fundFmv = 0;
    let fundReal = 0;
    let commit = 0;
    let anyUnvalued = false;

    // Fund stakes portion (if any)
    funds.forEach((f) => {
      const committed = inv.stakes[f.id] || 0;
      commit += committed;
      const s = f.size > 0 ? committed / f.size : 0;
      const fundInvested = f.h.reduce((acc, h) => acc + h.cost, 0);
      const ledgerInvested = inv.invested?.[f.id] ?? 0;
      const invested = ledgerInvested;

      if (committed > 0 || invested > 0) {
        const share = s > 0 ? s : fundInvested > 0 ? invested / fundInvested : 0;
        fundCost += invested;
        fundReal += inv.distributed?.[f.id] ?? 0;
        if (f.fmv === null || f.valuationCoverage === 'partial' || f.h.some((h) => h.fmv === null)) {
          anyUnvalued = true;
        } else {
          fundFmv += f.fmv * share;
        }
      }
    });

    // Direct holdings portion (if any)
    let directCost = 0;
    let directFmv = 0;
    let directReal = 0;
    (inv.holdings ?? []).forEach((h) => {
      directCost += h.cost;
      directReal += h.real;
      if (h.fmv === null || h.valuationCoverage === 'partial') {
        anyUnvalued = true;
      } else {
        directFmv += h.fmv;
      }
    });

    if (inv.fxStatus === 'pending_fx') {
      anyUnvalued = true;
    }

    const cost = fundCost + directCost;
    const real = fundReal + directReal;
    const fmv = fundFmv + directFmv;
    const coverage: ValuationCoverage = anyUnvalued ? 'partial' : 'complete';
    const gain = coverage === 'partial' ? null : fmv + real - cost;
    const moic = coverage === 'partial' || cost <= 0 ? null : (fmv + real) / cost;

    return {
      inv,
      commit,
      coverage,
      a: { cost, fmv, real, gain, moic, count: (inv.holdings ?? []).length, valuationCoverage: coverage },
    };
  });

  // Group entities by groupName
  const parentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const inv of investors ?? []) {
      if (inv.id && inv.n) {
        map.set(inv.id, inv.n);
      }
    }
    return map;
  }, [investors]);

  const groupMap = new Map<string, { name: string; rows: EntityComputedRow[]; totalFmv: number }>();
  const ungroupedRows: EntityComputedRow[] = [];

  for (const r of rows) {
    const groupName =
      r.inv.groupName ||
      (r.inv.groupId ? parentNameById.get(r.inv.groupId) : null);
    if (groupName) {
      let g = groupMap.get(groupName);
      if (!g) {
        g = { name: groupName, rows: [], totalFmv: 0 };
        groupMap.set(groupName, g);
      }
      g.rows.push(r);
      g.totalFmv += r.a.fmv;
    } else {
      ungroupedRows.push(r);
    }
  }

  // Sort groups descending by total unrealized market value
  const sortedGroups = Array.from(groupMap.values()).sort((a, b) => b.totalFmv - a.totalFmv);
  // Sort entities within each group descending by FMV
  for (const g of sortedGroups) {
    g.rows.sort((a, b) => b.a.fmv - a.a.fmv);
  }
  // Sort ungrouped entities descending by FMV
  ungroupedRows.sort((a, b) => b.a.fmv - a.a.fmv);

  const hasGroups = sortedGroups.length > 0;

  /** The group name is a parent entity's own name, so its English name resolves
   *  against the same list. */
  const groupEnglishName = (name: string) => {
    const parent = investors.find((inv) => inv.n === name);
    return parent ? distinctEnglishName(parent.n, parent.englishName) : undefined;
  };

  // Helper to render expanded contents for an entity
  const renderEntitySubRows = (inv: Investor): ReactNode[] => {
    const subRows: ReactNode[] = [];

    // 1. Holding categories: Direct Investments / Fund of funds
    const directHoldings: Holding[] = [];
    const fofHoldings: Holding[] = [];

    for (const h of inv.holdings ?? []) {
      if (h.tp === 'Fund of funds') {
        fofHoldings.push(h);
      } else if (h.tp !== 'Cash') {
        directHoldings.push(h);
      }
    }

    // 2. Fund stakes (if any)
    const relevantFunds = funds
      .map((f) => {
        const committed = inv.stakes[f.id] || 0;
        const s = f.size > 0 ? committed / f.size : 0;
        const fundInvested = f.h.reduce((acc, h) => acc + h.cost, 0);
        const ledgerInvested = inv.invested?.[f.id] ?? 0;
        const invested = ledgerInvested;
        const share = s > 0 ? s : fundInvested > 0 ? invested / fundInvested : 0;
        const isPartial =
          f.fmv === null || f.valuationCoverage === 'partial' || f.h.some((h) => h.fmv === null);
        const fmv = f.fmv !== null ? f.fmv * share : null;
        const real = inv.distributed?.[f.id] ?? 0;
        const gain = isPartial || fmv === null ? null : fmv + real - invested;
        const moic = isPartial || invested <= 0 || fmv === null ? null : (fmv + real) / invested;

        return { f, committed, invested, fmv, real, gain, moic, isPartial };
      })
      .filter((r) => r.committed > 0 || r.invested > 0);

    const hasAnyContent =
      directHoldings.length > 0 || fofHoldings.length > 0 || relevantFunds.length > 0;

    if (!hasAnyContent) {
      subRows.push(
        <tr key={`${inv.id}-empty`} className="border-b">
          <td
            colSpan={COLS.length}
            className="bg-muted/10 px-3 py-3 pl-10 text-[13px] text-muted-foreground"
          >
            No holdings or commitments.
          </td>
        </tr>,
      );
      return subRows;
    }

    // Direct Investments section
    if (directHoldings.length > 0) {
      const typeKey = `${inv.id}-Direct Investments`;
      const isTypeOpen = openHoldingTypes.has(typeKey);
      const typeCost = directHoldings.reduce((s, h) => s + h.cost, 0);
      const typeReal = directHoldings.reduce((s, h) => s + h.real, 0);
      const hasUnvalued = directHoldings.some((h) => h.fmv === null || h.valuationCoverage === 'partial');
      const typeFmv = hasUnvalued ? null : directHoldings.reduce((s, h) => s + (h.fmv ?? 0), 0);
      const typeGain = hasUnvalued || typeFmv === null ? null : typeFmv + typeReal - typeCost;
      const typeMoic = hasUnvalued || typeCost <= 0 || typeFmv === null ? null : (typeFmv + typeReal) / typeCost;

      subRows.push(
        <tr
          key={typeKey}
          onClick={() => toggleHoldingType(typeKey)}
          className={cn(
            'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
            isTypeOpen && '[&>td]:!bg-accent/10',
          )}
        >
          <td className="py-2 pl-3 pr-3 align-middle">
            <div className="flex items-center">
              <span className="w-5 shrink-0" />
              <span className="mr-1.5 w-3 shrink-0 text-[11px] text-muted-foreground">
                {isTypeOpen ? '▾' : '▸'}
              </span>
              <div className="flex items-center gap-2 border-l-2 border-border pl-2.5">
                <span className="text-[13px] font-medium text-foreground">Direct Investments</span>
                <span className="text-[11px] text-muted-foreground">({directHoldings.length})</span>
              </div>
            </div>
          </td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-muted-foreground">—</td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(typeCost)}</td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
            <PartialValuationAmount partial={hasUnvalued}>
              {typeFmv !== null ? money(typeFmv) : '—'}
            </PartialValuationAmount>
          </td>
          <td
            className={cn(
              'px-3 py-2 text-right align-middle text-[13px]',
              typeGain == null
                ? 'text-muted-foreground'
                : typeGain >= 0
                  ? 'text-success'
                  : 'text-destructive',
            )}
          >
            {typeGain != null ? `${typeGain >= 0 ? '+' : '−'}${money(Math.abs(typeGain))}` : '—'}
          </td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
            {typeMoic != null ? `${typeMoic.toFixed(2)}×` : '—'}
          </td>
        </tr>,
      );

      if (isTypeOpen) {
        directHoldings.forEach((h, idx) => {
          const hGain = h.fmv != null ? h.fmv + h.real - h.cost : null;
          subRows.push(
            <tr key={`${typeKey}-holding-${h.id ?? idx}`} className="border-b [&>td]:bg-muted/5">
              <td className="py-1.5 pl-3 pr-3 align-middle">
                <div className="flex items-center pl-10">
                  <div className="flex items-center gap-1.5 border-l-2 border-muted-foreground/30 pl-3">
                    <span className="text-[13px] text-foreground">{h.n}</span>
                    {distinctEnglishName(h.n, h.englishName) && (
                      <span className="text-[12px] text-muted-foreground">
                        ({distinctEnglishName(h.n, h.englishName)})
                      </span>
                    )}
                    {h.d?.sector && <Pill>{h.d.sector}</Pill>}
                    {h.disclosure && <DisclosureBadge reason={h.disclosure} />}
                  </div>
                </div>
              </td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-muted-foreground">—</td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">{money(h.cost)}</td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">
                <PartialValuationAmount partial={h.fmv === null || h.valuationCoverage === 'partial'}>
                  {h.fmv != null ? money(h.fmv) : '—'}
                </PartialValuationAmount>
              </td>
              <td
                className={cn(
                  'px-3 py-1.5 text-right align-middle text-[13px]',
                  hGain == null
                    ? 'text-muted-foreground'
                    : hGain >= 0
                      ? 'text-success'
                      : 'text-destructive',
                )}
              >
                {hGain != null ? `${hGain >= 0 ? '+' : '−'}${money(Math.abs(hGain))}` : '—'}
              </td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">
                {h.moic != null ? `${h.moic.toFixed(2)}×` : '—'}
              </td>
            </tr>,
          );
        });
      }
    }

    // Fund of funds section
    if (fofHoldings.length > 0) {
      const typeKey = `${inv.id}-Fund of funds`;
      const isTypeOpen = openHoldingTypes.has(typeKey);
      const typeCost = fofHoldings.reduce((s, h) => s + h.cost, 0);
      const typeReal = fofHoldings.reduce((s, h) => s + h.real, 0);
      const hasUnvalued = fofHoldings.some((h) => h.fmv === null || h.valuationCoverage === 'partial');
      const typeFmv = hasUnvalued ? null : fofHoldings.reduce((s, h) => s + (h.fmv ?? 0), 0);
      const typeGain = hasUnvalued || typeFmv === null ? null : typeFmv + typeReal - typeCost;
      const typeMoic = hasUnvalued || typeCost <= 0 || typeFmv === null ? null : (typeFmv + typeReal) / typeCost;

      subRows.push(
        <tr
          key={typeKey}
          onClick={() => toggleHoldingType(typeKey)}
          className={cn(
            'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
            isTypeOpen && '[&>td]:!bg-accent/10',
          )}
        >
          <td className="py-2 pl-3 pr-3 align-middle">
            <div className="flex items-center">
              <span className="w-5 shrink-0" />
              <span className="mr-1.5 w-3 shrink-0 text-[11px] text-muted-foreground">
                {isTypeOpen ? '▾' : '▸'}
              </span>
              <div className="flex items-center gap-2 border-l-2 border-border pl-2.5">
                <span className="text-[13px] font-medium text-foreground">Fund of funds</span>
                <span className="text-[11px] text-muted-foreground">({fofHoldings.length})</span>
              </div>
            </div>
          </td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-muted-foreground">—</td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(typeCost)}</td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
            <PartialValuationAmount partial={hasUnvalued}>
              {typeFmv !== null ? money(typeFmv) : '—'}
            </PartialValuationAmount>
          </td>
          <td
            className={cn(
              'px-3 py-2 text-right align-middle text-[13px]',
              typeGain == null
                ? 'text-muted-foreground'
                : typeGain >= 0
                  ? 'text-success'
                  : 'text-destructive',
            )}
          >
            {typeGain != null ? `${typeGain >= 0 ? '+' : '−'}${money(Math.abs(typeGain))}` : '—'}
          </td>
          <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
            {typeMoic != null ? `${typeMoic.toFixed(2)}×` : '—'}
          </td>
        </tr>,
      );

      if (isTypeOpen) {
        fofHoldings.forEach((h, idx) => {
          const hGain = h.fmv != null ? h.fmv + h.real - h.cost : null;
          subRows.push(
            <tr key={`${typeKey}-holding-${h.id ?? idx}`} className="border-b [&>td]:bg-muted/5">
              <td className="py-1.5 pl-3 pr-3 align-middle">
                <div className="flex items-center pl-10">
                  <div className="flex items-center gap-1.5 border-l-2 border-muted-foreground/30 pl-3">
                    <span className="text-[13px] text-foreground">{h.n}</span>
                    {distinctEnglishName(h.n, h.englishName) && (
                      <span className="text-[12px] text-muted-foreground">
                        ({distinctEnglishName(h.n, h.englishName)})
                      </span>
                    )}
                    {h.disclosure && <DisclosureBadge reason={h.disclosure} />}
                  </div>
                </div>
              </td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-muted-foreground">—</td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">{money(h.cost)}</td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">
                <PartialValuationAmount partial={h.fmv === null || h.valuationCoverage === 'partial'}>
                  {h.fmv != null ? money(h.fmv) : '—'}
                </PartialValuationAmount>
              </td>
              <td
                className={cn(
                  'px-3 py-1.5 text-right align-middle text-[13px]',
                  hGain == null
                    ? 'text-muted-foreground'
                    : hGain >= 0
                      ? 'text-success'
                      : 'text-destructive',
                )}
              >
                {hGain != null ? `${hGain >= 0 ? '+' : '−'}${money(Math.abs(hGain))}` : '—'}
              </td>
              <td className="px-3 py-1.5 text-right align-middle text-[13px] text-foreground">
                {h.moic != null ? `${h.moic.toFixed(2)}×` : '—'}
              </td>
            </tr>,
          );
        });
      }
    }

    // Relevant funds section (legacy LP stakes)
    if (relevantFunds.length > 0) {
      relevantFunds.forEach((r) => {
        const historyKey = `${inv.id}-${r.f.id}`;
        const isHistoryOpen = openFundHistories.has(historyKey);

        subRows.push(
          <tr
            key={historyKey}
            onClick={() => toggleFundHistory(historyKey)}
            className={cn(
              'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
              isHistoryOpen && '[&>td]:!bg-accent/10',
            )}
          >
            <td className="py-2 pl-3 pr-3 align-middle">
              <div className="flex items-center">
                <span className="w-5 shrink-0" />
                <span className="mr-1.5 w-3 shrink-0 text-[11px] text-muted-foreground">
                  {isHistoryOpen ? '▾' : '▸'}
                </span>
                <div className="flex items-center gap-2 border-l-2 border-border pl-2.5">
                  <span className="text-[13px] font-medium text-foreground">{r.f.n}</span>
                  {distinctEnglishName(r.f.n, r.f.englishName) && (
                    <span className="text-[12px] font-normal text-muted-foreground">
                      ({distinctEnglishName(r.f.n, r.f.englishName)})
                    </span>
                  )}
                  <button
                    type="button"
                    aria-expanded={isHistoryOpen}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFundHistory(historyKey);
                    }}
                    className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Commitment history
                  </button>
                  {onEditStakes && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditStakes(inv.id, r.f.id);
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      ✎ Edit
                    </button>
                  )}
                </div>
              </div>
            </td>

            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.committed)}</td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.invested)}</td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              <PartialValuationAmount partial={r.isPartial}>
                {r.fmv != null ? money(r.fmv) : '—'}
              </PartialValuationAmount>
            </td>
            <td
              className={cn(
                'px-3 py-2 text-right align-middle text-[13px]',
                r.gain == null
                  ? 'text-muted-foreground'
                  : r.gain >= 0
                    ? 'text-success'
                    : 'text-destructive',
              )}
            >
              {r.gain != null ? `${r.gain >= 0 ? '+' : '−'}${money(Math.abs(r.gain))}` : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {r.moic != null ? `${r.moic.toFixed(2)}×` : '—'}
            </td>
          </tr>,
        );

        if (isHistoryOpen) {
          subRows.push(
            <tr key={`${historyKey}-history`} className="border-b">
              <td colSpan={COLS.length} className="bg-background px-4 py-3">
                <div className="pl-6">
                  <InlineCommitmentHistory
                    fundId={r.f.id}
                    fundName={r.f.n}
                    holdingEntityId={inv.id}
                    investorName={inv.n}
                    refreshKey={`${r.committed}-${commitmentNonce ?? 0}`}
                    onOpenDialog={onEditStakes ? () => onEditStakes(inv.id, r.f.id) : undefined}
                  />
                </div>
              </td>
            </tr>,
          );
        }
      });
    }

    return subRows;
  };

  const renderEntityRowCells = (
    inv: Investor,
    commit: number,
    a: EntityComputedRow['a'],
    isOpen: boolean,
  ) => (
    <>
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                toggle(inv.id);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Chevron open={isOpen} />
            </button>
            <span className="text-[13px] font-medium text-foreground">{inv.n}</span>
            {distinctEnglishName(inv.n, inv.englishName) && (
              <span className="text-[12px] font-normal text-muted-foreground">
                ({distinctEnglishName(inv.n, inv.englishName)})
              </span>
            )}
            {onEditInvestor && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditInvestor(inv);
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                ✎ edit
              </button>
            )}
            {onEditStakes && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditStakes(inv.id);
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                ✎ commitments
              </button>
            )}
            {inv.type && <Pill>{inv.type}</Pill>}
          </div>
          {(onDeleteInvestor || onMoveInvestor) && (
            <div onClick={(e) => e.stopPropagation()}>
              <DeleteRowMenu
                label="Delete entity"
                title={`Delete "${inv.n}"?`}
                description="Only unused investment entities with no positions or commitments can be deleted. If this entity is in use, reassign or settle its positions first. This action cannot be undone."
                onConfirm={onDeleteInvestor ? () => onDeleteInvestor(inv.id) : async () => {}}
                onMove={onMoveInvestor ? () => onMoveInvestor(inv) : undefined}
              />
            </div>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
        {money(commit)}
      </td>
      <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">{money(a.cost)}</td>
      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
        <PartialValuationAmount partial={a.valuationCoverage === 'partial'}>
          {money(a.fmv)}
        </PartialValuationAmount>
      </td>
      <td
        className={cn(
          'px-3 py-2.5 text-right align-middle text-[13px] font-medium',
          a.gain == null
            ? 'text-muted-foreground'
            : a.gain >= 0
              ? 'text-success'
              : 'text-destructive',
        )}
      >
        {a.gain != null ? `${a.gain >= 0 ? '+' : '−'}${money(Math.abs(a.gain))}` : '—'}
      </td>
      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
        {a.moic != null ? `${a.moic.toFixed(2)}×` : '—'}
      </td>
    </>
  );

  const renderEntityRows = (r: EntityComputedRow) => {
    const isOpen = openInvestors.has(r.inv.id);
    return (
      <Fragment key={r.inv.id}>
        <tr
          onClick={() => toggle(r.inv.id)}
          className={cn(
            'cursor-pointer border-b [&>td]:bg-card hover:[&>td]:bg-muted/40',
            isOpen && '[&>td]:!bg-accent/10',
          )}
        >
          {renderEntityRowCells(r.inv, r.commit, r.a, isOpen)}
        </tr>
        {isOpen && renderEntitySubRows(r.inv)}
      </Fragment>
    );
  };

  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.label}
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  No investment entities yet.
                </td>
              </tr>
            )}

            {/* Each investor group is a collapsible section, like the Fund Vehicles view. */}
            {sortedGroups.map((g) => {
              const open = !closedGroups.has(g.name);
              return (
                <Fragment key={`group:${g.name}`}>
                  <GroupSectionRow
                    colSpan={COLS.length}
                    title={g.name}
                    subtitle={groupEnglishName(g.name)}
                    count={g.rows.length}
                    open={open}
                    onToggle={() => toggleGroup(g.name)}
                  />
                  {open && g.rows.map(renderEntityRows)}
                </Fragment>
              );
            })}

            {/* Entities with no group. Only headed when there are groups to set them apart from. */}
            {hasGroups && ungroupedRows.length > 0 && (
              <GroupSectionRow
                colSpan={COLS.length}
                title={UNGROUPED_SECTION}
                count={ungroupedRows.length}
                open={!closedGroups.has(UNGROUPED_SECTION)}
                onToggle={() => toggleGroup(UNGROUPED_SECTION)}
              />
            )}
            {(!hasGroups || !closedGroups.has(UNGROUPED_SECTION)) && ungroupedRows.map(renderEntityRows)}
          </tbody>
        </table>
      </div>
      {hasDisplayOnlyOnScreen && <DisclosureFootnote />}
      <div className="mt-2 text-right text-[11px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? 'entity' : 'entities'}
      </div>
    </>
  );
}
