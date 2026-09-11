'use client';

import { cn } from '@/lib/utils';
import type { SheetColumn } from '@/components/sheet';
import type { FlPortfolioLedgerEntry } from '@/lib/api/fundLedger';
import {
  describeFromTo,
  derivePricePerUnit,
  entryTypeShortLabel,
  entryTypeSpec,
  formatDateNumeric,
  formatQuantity,
  sourceNamesOf,
  transferLegProblem,
  type LedgerIndex,
  type PositionRollup,
  type ResolvedPosition,
} from '@/lib/fundLedger';
import { Badge, FlowArrow, Party, SnakeCase, StatusDot, Term, signClass } from './parts';
import { useLedgerMoney, type LedgerMoney } from './useLedgerMoney';

/** Widths are fixed so a position's children line up under its own row. */
const NUM = 'tabular-nums font-mono text-[11px]';

/**
 * The ceiling for any column carrying free text — a name, an instrument, a
 * description. Past this a single long value costs more horizontal room than
 * the numbers it pushes off screen are worth, so the value is truncated
 * instead. The whole of it is a "wrap text" toggle (or an expanded row) away.
 */
const TEXT_WIDTH = 180;

function statusTone(
  entry: FlPortfolioLedgerEntry,
  index: LedgerIndex,
): { tone: 'ok' | 'warn' | 'bad'; title: string } {
  const problem = transferLegProblem(entry, index);
  if (problem) return { tone: 'bad', title: problem };
  if (entry.data_status === 'needs_verification') {
    return { tone: 'warn', title: 'Needs checking' };
  }
  return { tone: 'ok', title: 'Verified' };
}

/**
 * The type badge, carrying the reversal marker.
 *
 * The marker used to live on a Ref column showing the entry id. The id is an
 * opaque UUID that nobody reads off a row — it is in the expanded detail when
 * it is needed — but whether a row is a reversal changes how every number on it
 * should be read, so it moved here rather than going away with the column.
 */
function TypeCell({
  entry,
  showStatus = false,
  index,
}: {
  entry: FlPortfolioLedgerEntry;
  /** Also show the data-status dot — for sheets with no status column. */
  showStatus?: boolean;
  index: LedgerIndex;
}) {
  const spec = entryTypeSpec(entry.entry_type);
  const status = statusTone(entry, index);
  return (
    <span className="inline-flex items-center gap-1">
      <Badge direction={spec?.direction}>{entryTypeShortLabel(entry.entry_type)}</Badge>
      {entry.is_reversal && (
        <span
          className="text-[10px] font-semibold text-red-600 dark:text-red-400"
          title="Reversal entry"
        >
          R
        </span>
      )}
      {showStatus && status.tone !== 'ok' && (
        <span title={status.title}>
          <StatusDot tone={status.tone} />
        </span>
      )}
    </span>
  );
}

/** Units on top, the price they moved at underneath. */
function PriceCell({ entry }: { entry: FlPortfolioLedgerEntry }) {
  const money = useLedgerMoney();
  const price = derivePricePerUnit(entry.price_per_unit, entry.quantity_delta, entry.cash_delta);
  return (
    <span className={cn(NUM, 'text-muted-foreground')}>{price ? money.price(price) : '—'}</span>
  );
}

/**
 * The flat entry sheet's columns.
 *
 * `id` doubles as the filter column, so right-clicking a cell always produces a
 * filter that matches the row it came from. Columns with nothing to filter on
 * (the arrow) declare no `contextValue` and stay inert.
 */
export function buildEntryColumns(
  index: LedgerIndex,
  wrap: boolean,
  money: LedgerMoney,
): SheetColumn<FlPortfolioLedgerEntry>[] {
  return [
    {
      id: 'date',
      header: 'Date',
      width: 82,
      cell: (entry) => <span className={NUM}>{formatDateNumeric(entry.entry_date)}</span>,
      contextValue: (entry) => formatDateNumeric(entry.entry_date),
    },
    {
      id: 'from',
      header: <Term k="perspective">From</Term>,
      width: 160,
      cell: (entry) => {
        const flow = describeFromTo(entry, index);
        return <Party party={flow.from} instrument={flow.fromIsInstrument} wrap={wrap} />;
      },
      contextValue: (entry) => describeFromTo(entry, index).from.name,
    },
    {
      id: 'arrow',
      header: '',
      width: 22,
      align: 'center',
      cell: (entry) => <FlowArrow noCash={describeFromTo(entry, index).noCash} />,
    },
    {
      id: 'to',
      header: <Term k="perspective">To</Term>,
      width: 160,
      cell: (entry) => {
        const flow = describeFromTo(entry, index);
        return <Party party={flow.to} instrument={flow.toIsInstrument} wrap={wrap} />;
      },
      contextValue: (entry) => describeFromTo(entry, index).to.name,
    },
    {
      id: 'source',
      header: <Term k="sourceoffund">Source</Term>,
      width: 92,
      cellClassName: 'text-muted-foreground',
      // Every pool the row touches, whether declared on the position or named
      // in the entry's own funding split — the same set the filter matches on.
      cell: (entry) => sourceNamesOf(entry, index).join(' + ') || '—',
      contextValue: (entry) => sourceNamesOf(entry, index).join(' + '),
    },
    {
      id: 'type',
      header: 'Type',
      width: 124,
      cell: (entry) => <TypeCell entry={entry} index={index} />,
      contextValue: (entry) => entryTypeShortLabel(entry.entry_type),
    },
    {
      id: 'subType',
      header: 'Sub-type',
      width: 110,
      cellClassName: 'text-muted-foreground font-mono text-[11px]',
      cell: (entry) => (entry.sub_type ? <SnakeCase value={entry.sub_type} /> : '—'),
      contextValue: (entry) => entry.sub_type ?? '',
    },
    {
      id: 'commitment',
      header: <Term k="commitdelta">Commit Δ</Term>,
      width: 104,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.commitment_delta)),
      cell: (entry) => money.money(entry.commitment_delta),
      contextValue: () => '',
    },
    {
      id: 'quantity',
      header: <Term k="qtydelta">Qty Δ</Term>,
      width: 104,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.quantity_delta)),
      cell: (entry) => formatQuantity(entry.quantity_delta),
      contextValue: () => '',
    },
    {
      // An adjustment's whole amount lands here and nowhere else, so without
      // this column a write-off row reads as all dashes.
      id: 'valuation',
      header: <Term k="valuationdelta">Value Δ</Term>,
      width: 106,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.valuation_delta)),
      cell: (entry) => money.money(entry.valuation_delta),
      contextValue: () => '',
    },
    {
      id: 'price',
      header: <Term k="pps">Price</Term>,
      width: 80,
      align: 'right',
      cell: (entry) => <PriceCell entry={entry} />,
      contextValue: () => '',
    },
    {
      id: 'cash',
      header: <Term k="cashdelta">Cash Δ</Term>,
      width: 106,
      align: 'right',
      cellClassName: (entry) => cn(NUM, 'font-medium', signClass(entry.cash_delta)),
      cell: (entry) => money.money(entry.cash_delta),
      contextValue: () => '',
    },
    {
      id: 'status',
      header: '✓',
      width: 32,
      align: 'center',
      cell: (entry) => {
        const status = statusTone(entry, index);
        return (
          <span title={status.title}>
            <StatusDot tone={status.tone} />
          </span>
        );
      },
      contextValue: (entry) =>
        entry.data_status === 'needs_verification' ? 'Needs checking' : 'Verified',
    },
    {
      id: 'description',
      // Last on the row: the longest free text and the least often scanned, so
      // it earns the far right where truncating it costs nothing.
      header: <Term k="event">Description</Term>,
      width: TEXT_WIDTH,
      cellClassName: 'text-muted-foreground',
      cell: (entry) => (
        <span title={entry.event?.description ?? ''}>{entry.event?.description ?? '—'}</span>
      ),
      contextValue: (entry) => entry.event?.description ?? '',
    },
  ];
}

/** One row of the position view: a position and what it is worth. */
export interface PositionRow {
  position: ResolvedPosition;
  rollup: PositionRollup;
  /** How many of its rows survive the current range and filters. */
  listedRows: number;
}

/**
 * The position sheet's columns.
 *
 * The balances here are counted from inception to the as-of date and are
 * deliberately *not* narrowed by the range or the filters — those change what
 * is listed, never what a position is worth.
 */
export function buildPositionColumns(
  wrap: boolean,
  money: LedgerMoney,
): SheetColumn<PositionRow>[] {
  return [
    {
      id: 'holder',
      header: <Term k="holder">Holder</Term>,
      width: TEXT_WIDTH,
      cell: (row) => <Party party={row.position.holder} wrap={wrap} />,
      contextValue: (row) => row.position.holder.name,
    },
    {
      id: 'arrow',
      header: '',
      width: 22,
      align: 'center',
      cell: () => <FlowArrow noCash={false} />,
    },
    {
      id: 'instrument',
      header: <Term k="instrument">What they hold</Term>,
      width: TEXT_WIDTH,
      cell: (row) => <Party party={row.position.instrument} instrument wrap={wrap} />,
      contextValue: (row) => row.position.instrument.name,
    },
    {
      id: 'source',
      header: <Term k="sourceoffund">Source</Term>,
      width: 96,
      cellClassName: 'text-muted-foreground',
      cell: (row) => row.position.fundingSource?.name ?? '—',
      contextValue: (row) => row.position.fundingSource?.name ?? '',
    },
    {
      id: 'rows',
      header: 'Rows',
      width: 84,
      align: 'right',
      cellClassName: 'text-muted-foreground text-[11px]',
      cell: (row) => (
        <span className="inline-flex items-center gap-1">
          {row.listedRows !== row.rollup.rowCount && `${row.listedRows}/`}
          {row.rollup.rowCount}
          {row.rollup.needsChecking > 0 && <StatusDot tone="warn" />}
        </span>
      ),
    },
    {
      id: 'commitment',
      header: 'Commit',
      width: 112,
      align: 'right',
      cellClassName: NUM,
      cell: (row) =>
        Number(row.rollup.commitment) ? (
          <>
            <div>{money.moneyAbs(row.rollup.commitment)}</div>
            <div className="text-[10px] font-normal text-muted-foreground">
              {money.moneyAbs(row.rollup.undrawn)} undrawn
            </div>
          </>
        ) : (
          '—'
        ),
      contextValue: () => '',
    },
    {
      id: 'invested',
      header: <Term k="invested">Invested</Term>,
      width: 112,
      align: 'right',
      cellClassName: cn(NUM, 'font-medium'),
      cell: (row) => (Number(row.rollup.invested) ? money.moneyAbs(row.rollup.invested) : '—'),
    },
    {
      id: 'quantity',
      header: <Term k="units">Units</Term>,
      width: 112,
      align: 'right',
      cellClassName: (row) => cn(NUM, signClass(row.rollup.units)),
      cell: (row) => formatQuantity(row.rollup.units),
      contextValue: () => '',
    },
    {
      id: 'price',
      header: <Term k="blended">Blended</Term>,
      width: 88,
      align: 'right',
      cellClassName: cn(NUM, 'text-muted-foreground'),
      cell: (row) => (row.rollup.blendedPrice ? money.price(row.rollup.blendedPrice) : '—'),
      contextValue: () => '',
    },
    {
      id: 'cash',
      header: 'Net cash',
      width: 112,
      align: 'right',
      cellClassName: (row) => cn(NUM, 'font-medium', signClass(row.rollup.netCash)),
      cell: (row) => money.money(row.rollup.netCash),
      contextValue: () => '',
    },
  ];
}

/**
 * The columns a position's own rows are listed with.
 *
 * A different set from the flat sheet — the holder and what is held are already
 * on the parent row, so the children spend that width on the movement itself,
 * and the description they all share sits on the parent's detail panel rather
 * than repeating down the column. Must stay the same *length* as
 * {@link buildPositionColumns} so both align against the one `<colgroup>`.
 */
export function buildPositionChildColumns(
  index: LedgerIndex,
  wrap: boolean,
  money: LedgerMoney,
): SheetColumn<FlPortfolioLedgerEntry>[] {
  return [
    {
      id: 'from',
      header: 'From',
      width: TEXT_WIDTH,
      cell: (entry) => {
        const flow = describeFromTo(entry, index);
        return <Party party={flow.from} instrument={flow.fromIsInstrument} wrap={wrap} />;
      },
      contextValue: (entry) => describeFromTo(entry, index).from.name,
    },
    {
      id: 'arrow',
      header: '',
      width: 22,
      align: 'center',
      cell: (entry) => <FlowArrow noCash={describeFromTo(entry, index).noCash} />,
    },
    {
      id: 'to',
      header: 'To',
      width: TEXT_WIDTH,
      cell: (entry) => {
        const flow = describeFromTo(entry, index);
        return <Party party={flow.to} instrument={flow.toIsInstrument} wrap={wrap} />;
      },
      contextValue: (entry) => describeFromTo(entry, index).to.name,
    },
    {
      id: 'date',
      header: 'Date',
      width: 96,
      cellClassName: cn(NUM, 'text-muted-foreground'),
      cell: (entry) => formatDateNumeric(entry.entry_date),
      contextValue: (entry) => formatDateNumeric(entry.entry_date),
    },
    {
      id: 'type',
      header: 'Type',
      width: 84,
      // No status column down here, so the dot rides along with the type.
      cell: (entry) => <TypeCell entry={entry} index={index} showStatus />,
      contextValue: (entry) => entryTypeShortLabel(entry.entry_type),
    },
    {
      id: 'subType',
      header: 'Sub-type',
      width: 112,
      cellClassName: 'text-muted-foreground font-mono text-[11px]',
      cell: (entry) => (entry.sub_type ? <SnakeCase value={entry.sub_type} /> : '—'),
      contextValue: (entry) => entry.sub_type ?? '',
    },
    {
      id: 'commitment',
      header: 'Commitment Δ',
      width: 112,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.commitment_delta)),
      cell: (entry) => money.money(entry.commitment_delta),
      contextValue: () => '',
    },
    {
      id: 'quantity',
      header: 'Quantity Δ',
      width: 112,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.quantity_delta)),
      cell: (entry) => formatQuantity(entry.quantity_delta),
      contextValue: () => '',
    },
    {
      id: 'valuation',
      header: 'Value Δ',
      width: 112,
      align: 'right',
      cellClassName: (entry) => cn(NUM, signClass(entry.valuation_delta)),
      cell: (entry) => money.money(entry.valuation_delta),
      contextValue: () => '',
    },
    {
      id: 'price',
      header: 'Price',
      width: 88,
      align: 'right',
      cell: (entry) => <PriceCell entry={entry} />,
      contextValue: () => '',
    },
    {
      id: 'cash',
      header: 'Cash Δ',
      width: 112,
      align: 'right',
      cellClassName: (entry) => cn(NUM, 'font-medium', signClass(entry.cash_delta)),
      cell: (entry) => money.money(entry.cash_delta),
      contextValue: () => '',
    },
  ];
}

/** The sub-header strip shown above a position's rows. */
export const POSITION_CHILD_HEADER = [
  'From',
  '',
  'To',
  'Date',
  'Type',
  'Sub-type',
  'Commitment Δ',
  'Quantity Δ',
  'Value Δ',
  'Price',
  'Cash Δ',
];
