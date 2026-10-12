'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/layout/PageHeader';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { SheetTable, sheetSection, type SheetRow } from '@/components/sheet';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { FlPortfolioLedgerEntry, FlPortfolioReadModel } from '@/lib/api/fundLedger';
import {
  buildLedgerIndex,
  countByEntryType,
  createSyntheticPosition,
  entriesAsOf,
  formatDate,
  hasFilter,
  isQueryNarrowed,
  type PositionRollup,
  type ResolvedPosition,
  rollupPosition,
  sortEntriesNewestFirst,
  sortEntriesOldestFirst,
  summarizeLedger,
  toIsoDate,
  visibleEntries,
  windowEntries,
  type FilterColumn,
  type FilterOperator,
  type FlEntryType,
  type LedgerFilter,
  type LedgerQuery,
  type SearchEntity,
} from '@/lib/fundLedger';
import { flSum } from '@/lib/services/flDecimal';
import { CellFilterMenu, type CellFilterTarget } from './ledger/CellFilterMenu';
import { EntitySearch } from './ledger/EntitySearch';
import { EntryDetail } from './ledger/EntryDetail';
import { EntryRulesDialog } from './ledger/EntryRulesDialog';
import { FilterChips } from './ledger/FilterChips';
import { LedgerMetrics } from './ledger/LedgerMetrics';
import { PostEntryDialog } from './ledger/PostEntryDialog';
import { ReverseEventDialog } from './ledger/ReverseEventDialog';
import { RowMenu } from './ledger/RowMenu';
import {
  POSITION_CHILD_HEADER,
  buildEntryColumns,
  buildPositionChildColumns,
  buildPositionColumns,
  type PositionRow,
} from './ledger/columns';
import type { LedgerRange } from './ledger/LedgerDateRange';
import { LedgerToolbar, TypeFilterBar, type LedgerViewMode } from './ledger/LedgerToolbar';
import { Chevron, Term } from './ledger/parts';
import { useLedgerMoney } from './ledger/useLedgerMoney';

/**
 * The Ledger.
 *
 * Every row here is one signed movement against one position, read from the
 * holder's point of view. Nothing is stored as a balance: commitment, paid-in
 * capital, units, blended price and net cash are all counted up from the rows
 * on each redraw.
 *
 * The whole page is served by a single `GET /api/fund-ledger/portfolio` — the
 * read model already arrives with holders, instruments, events and funding
 * allocations joined — and every control after that narrows in memory. Fetching
 * per as-of date would be a request per keystroke on the date picker; fetching
 * per row would be the per-asset fan-out that exhausted the connection pool
 * before.
 */
export default function Ledger() {
  // Every figure on this page reads in the workspace display currency.
  const money = useLedgerMoney();
  const [portfolio, setPortfolio] = useState<FlPortfolioReadModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);

  const [mode, setMode] = useState<LedgerViewMode>('entry');
  const [range, setRange] = useState<LedgerRange | null>(null);
  const [entryType, setEntryType] = useState<FlEntryType | 'all'>('all');
  const [onlyNeedsChecking, setOnlyNeedsChecking] = useState(false);
  const [filters, setFilters] = useState<LedgerFilter[]>([]);
  const [filterSeq, setFilterSeq] = useState(0);
  const [wrap, setWrap] = useState(false);

  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [expandedPositions, setExpandedPositions] = useState<Set<string>>(new Set());

  const [menuTarget, setMenuTarget] = useState<CellFilterTarget | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [reverseEntry, setReverseEntry] = useState<FlPortfolioLedgerEntry | null>(null);

  const load = useCallback(async () => {
    try {
      // Deliberately unfiltered: the as-of date is a client control, and the
      // page has to be able to move it without another round trip.
      const readModel = await fundLedgerApi.getPortfolio();
      setPortfolio(readModel);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load the ledger');
    }
  }, []);

  useEffect(() => {
    // `today` is resolved here rather than during render so the server and the
    // client can't disagree about the date across a timezone boundary.
    const isoToday = toIsoDate(new Date());
    setToday(isoToday);
    setRange((current) => current ?? { from: null, to: isoToday, preset: 'all' });
    void load();
  }, [load]);

  const index = useMemo(
    () => (portfolio ? buildLedgerIndex(portfolio) : null),
    [portfolio],
  );

  const query: LedgerQuery | null = useMemo(
    () =>
      range
        ? { asOf: range.to, from: range.from, entryType, onlyNeedsChecking, filters }
        : null,
    [range, entryType, onlyNeedsChecking, filters],
  );

  const addFilter = useCallback(
    (candidate: { column: FilterColumn; operator: FilterOperator; value: string; display?: string }) => {
      setFilters((current) => {
        if (hasFilter(current, candidate)) return current;
        const id = `f${filterSeq + 1}`;
        setFilterSeq((seq) => seq + 1);
        return [...current, { id, ...candidate }];
      });
    },
    [filterSeq],
  );

  const pickEntity = useCallback(
    (entity: SearchEntity) => {
      if (entity.kind === 'source') {
        addFilter({ column: 'source', operator: 'is', value: entity.name });
      } else {
        addFilter({ column: 'holder', operator: 'involves', value: entity.name });
      }
    },
    [addFilter],
  );

  const toggleEntry = useCallback((entryId: string) => {
    setExpandedEntries((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  const togglePosition = useCallback((positionId: string) => {
    setExpandedPositions((current) => {
      const next = new Set(current);
      if (next.has(positionId)) next.delete(positionId);
      else next.add(positionId);
      return next;
    });
  }, []);

  /** Jump from a row to the position that holds it, in the position view. */
  const openPosition = useCallback((entry: FlPortfolioLedgerEntry) => {
    setMode('position');
    setExpandedEntries(new Set());
    setExpandedPositions(new Set([entry.position_id]));
  }, []);

  const rowMenuFor = useCallback(
    (entry: FlPortfolioLedgerEntry) => (
      <RowMenu
        entryId={entry.id}
        isReversal={entry.is_reversal || entry.event?.reversal_of_event_id != null}
        onOpenPosition={() => openPosition(entry)}
        onReverse={() => setReverseEntry(entry)}
      />
    ),
    [openPosition],
  );

  const entryColumns = useMemo(
    () => (index ? buildEntryColumns(index, wrap, money) : []),
    [index, wrap, money],
  );
  const positionColumns = useMemo(() => buildPositionColumns(wrap, money), [wrap, money]);
  const positionChildColumns = useMemo(
    () => (index ? buildPositionChildColumns(index, wrap, money) : []),
    [index, wrap, money],
  );

  if (loadError) {
    return (
      <div className="px-5 pb-16 pt-6">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}{' '}
          <button className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!portfolio || !index || !query || !range || !today) {
    return (
      <div className="px-5 pb-16 pt-6">
        <p className="py-10 text-center text-sm text-muted-foreground">Loading the ledger…</p>
      </div>
    );
  }

  const asOfSet = entriesAsOf(index, query.asOf);
  const windowSet = windowEntries(index, query);
  const listed = visibleEntries(index, query);
  const summary = summarizeLedger(asOfSet, windowSet);
  const typeCounts = countByEntryType(windowSet);

  const handleCellContext = (columnId: string, value: string | null, x: number, y: number) => {
    if (value === null) return;
    setMenuTarget({ column: columnId as FilterColumn, value, x, y });
  };

  const entryRows: SheetRow<FlPortfolioLedgerEntry>[] = sortEntriesNewestFirst(listed).map(
    (entry, entryIndex) => ({
      id: entry.id,
      data: entry,
      gutter: entryIndex + 1,
      expanded: expandedEntries.has(entry.id),
      onToggle: () => toggleEntry(entry.id),
      detail: () => <EntryDetail entry={entry} index={index} onSaved={() => void load()} />,
      actions: rowMenuFor(entry),
    }),
  );

  /** Positions with at least one row surviving the current range and filters. */
  const indexedPositionRows = [...index.positions.values()]
    .map((position) => {
      const rollup = rollupPosition(position.id, asOfSet);
      const listedForPosition = listed.filter((entry) => entry.position_id === position.id);
      return { position, rollup, listedRows: listedForPosition.length, listedForPosition };
    })
    .filter((row) => row.listedRows > 0);

  const orphanEntries = listed.filter((entry) => !index.positions.has(entry.position_id));
  const orphanPositionRows: {
    position: ResolvedPosition;
    rollup: PositionRollup;
    listedRows: number;
    listedForPosition: FlPortfolioLedgerEntry[];
  }[] = [];

  if (orphanEntries.length > 0) {
    const orphanGroups = new Map<string, FlPortfolioLedgerEntry[]>();
    for (const entry of orphanEntries) {
      const pid = entry.position_id || 'unassigned';
      const existing = orphanGroups.get(pid);
      if (existing) existing.push(entry);
      else orphanGroups.set(pid, [entry]);
    }

    for (const [pid, groupEntries] of orphanGroups) {
      const position = createSyntheticPosition(pid);
      const orphanAsOf = asOfSet.filter((e) => (e.position_id || 'unassigned') === pid);
      const rollup = rollupPosition(pid, orphanAsOf);
      orphanPositionRows.push({
        position,
        rollup,
        listedRows: groupEntries.length,
        listedForPosition: groupEntries,
      });
    }
  }

  const positionRows: SheetRow<PositionRow>[] = [...indexedPositionRows, ...orphanPositionRows]
    .sort((a, b) => Number(b.rollup.invested) - Number(a.rollup.invested))
    .map((row) => {
      const expanded = expandedPositions.has(row.position.id);
      return {
        id: row.position.id,
        data: row,
        gutter: <Chevron open={expanded} />,
        expanded,
        onToggle: () => togglePosition(row.position.id),
        // No row menu on a position: "Reverse this event" would have to pick one
        // of its rows arbitrarily. Expand it and act on the row you mean.
        actions: undefined,
        section: expanded
          ? sheetSection<FlPortfolioLedgerEntry>({
              header: POSITION_CHILD_HEADER,
              columns: positionChildColumns,
              rows: sortEntriesOldestFirst(row.listedForPosition).map((entry) => ({
                id: `${row.position.id}:${entry.id}`,
                data: entry,
                gutter: <Chevron open={expandedEntries.has(entry.id)} />,
                expanded: expandedEntries.has(entry.id),
                onToggle: () => toggleEntry(entry.id),
                detail: () => <EntryDetail entry={entry} index={index} onSaved={() => void load()} />,
                actions: rowMenuFor(entry),
              })),
            })
          : undefined,
      };
    });

  const netCash = flSum(listed.map((entry) => entry.cash_delta ?? '0'));

  const empty = (
    <>
      <div className="text-[13px] text-muted-foreground">Nothing matches these filters</div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Widen the type filter, or pick a longer date range.
      </div>
    </>
  );

  return (
    <TooltipProvider delayDuration={120}>
      {/*
        `<main>` (in AppShell) is the app's real vertical scroller — it's the
        only ancestor with a bounded height and `overflow-auto`. If this page
        just grew taller than it, `<main>` would scroll instead, and the
        sheet's sticky header (which binds to the sheet's own scroll
        container, not `<main>`) would ride away with the rest of the page.
        Filling `<main>`'s height exactly — fixed-size chrome up top, the
        sheet taking the rest via `min-h-0 flex-1` — makes the sheet itself
        the only thing that scrolls, so its sticky header actually stays put.
      */}
      <div className="flex h-full flex-col">
        <PageHeader
          className="shrink-0"
          title="Ledger"
          eyebrow={
            <>
              <WorkspaceLink href="/fund-management" className="text-primary hover:underline">
                Fund Management
              </WorkspaceLink>{' '}
              / Ledger
            </>
          }
          subtitle={
            <>
              Every posted movement against the position that holds it. Hover any{' '}
              <Term k="dotted">dotted term</Term> for a plain-English explanation.
            </>
          }
        />

        <div className="shrink-0 px-5 pt-4">
          <div className="mb-4">
            <EntitySearch index={index} onPick={pickEntity} />
          </div>

          <div className="mb-4">
            <LedgerMetrics
              summary={summary}
              asOf={query.asOf}
              from={query.from}
              filtered={filters.length > 0}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-6">
          <div className="flex shrink-0 flex-col gap-3">
            <LedgerToolbar
              mode={mode}
              onModeChange={(next) => {
                setMode(next);
                setExpandedEntries(new Set());
                setExpandedPositions(new Set());
              }}
              range={range}
              today={today}
              onRangeChange={setRange}
              wrap={wrap}
              onWrapChange={setWrap}
              onOpenRules={() => setRulesOpen(true)}
              onPostEntry={() => setPostOpen(true)}
            />

            <FilterChips
              filters={filters}
              onRemove={(id) => setFilters((current) => current.filter((f) => f.id !== id))}
              onClear={() => setFilters([])}
            />

            {mode === 'entry' && (
              <TypeFilterBar
                counts={typeCounts}
                active={entryType}
                onChange={setEntryType}
                onlyNeedsChecking={onlyNeedsChecking}
                onToggleNeedsChecking={() => setOnlyNeedsChecking((current) => !current)}
              />
            )}
          </div>

          <div className="min-h-0 flex-1">
            {mode === 'entry' ? (
              <SheetTable
                className="h-full"
                label="Ledger entries"
                columns={entryColumns}
                rows={entryRows}
                wrap={wrap}
                empty={empty}
                onCellContextMenu={(event) =>
                  handleCellContext(event.columnId, event.value, event.clientX, event.clientY)
                }
                footer={
                  <>
                    {listed.length} {listed.length === 1 ? 'entry' : 'entries'} · net cash{' '}
                    {money.money(netCash)} ·{' '}
                    {query.from
                      ? `${formatDate(query.from)} – ${formatDate(query.asOf)}`
                      : `everything up to ${formatDate(query.asOf)}`}
                  </>
                }
              />
            ) : (
              <SheetTable
                className="h-full"
                label="Ledger positions"
                columns={positionColumns}
                rows={positionRows}
                wrap={wrap}
                empty={empty}
                onCellContextMenu={(event) =>
                  handleCellContext(event.columnId, event.value, event.clientX, event.clientY)
                }
                footer={
                  <>
                    {positionRows.length}{' '}
                    {positionRows.length === 1 ? 'position' : 'positions'} · balances counted from
                    inception to {formatDate(query.asOf)} —{' '}
                    {isQueryNarrowed(query)
                      ? 'the range and filters narrow which rows are listed, not the balances'
                      : 'nothing is narrowing the view'}
                  </>
                }
              />
            )}
          </div>
        </div>
      </div>

      <CellFilterMenu
        target={menuTarget}
        filterCount={filters.length}
        onAddFilter={addFilter}
        onClearFilters={() => setFilters([])}
        onClose={() => setMenuTarget(null)}
      />

      <EntryRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />

      <PostEntryDialog
        open={postOpen}
        onOpenChange={setPostOpen}
        index={index}
        portfolio={portfolio}
        today={today}
        onPosted={() => void load()}
        onReloadPortfolio={load}
      />

      <ReverseEventDialog
        entry={reverseEntry}
        index={index}
        onOpenChange={(open) => {
          if (!open) setReverseEntry(null);
        }}
        onReversed={() => void load()}
      />
    </TooltipProvider>
  );
}
