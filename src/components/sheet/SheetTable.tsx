'use client';

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * A dense, spreadsheet-style data sheet.
 *
 * Built for tables that are read like a ledger rather than browsed like a list:
 * fixed pixel column widths behind a horizontal scroll (so columns line up
 * between the parent rows and their nested children), a sticky header, a
 * truncate/wrap switch, rows that expand into a full-width detail panel or into
 * a nested section with its *own* column set, and a right-click hook that hands
 * the host the column and value under the cursor so it can offer filters.
 *
 * Deliberately unaware of what it is showing — no ledger, fund or currency
 * imports — so a second consumer can drive it from a different row type.
 *
 * Not to be confused with `@/components/table` (`ManagedTable`), which solves a
 * different problem: workspace-persisted column reorder/hide/group for the
 * browsable record tables. This one has fixed columns and nested rows.
 */

/** Horizontal alignment for a column's header and cells. */
export type SheetAlign = 'left' | 'right' | 'center';

export interface SheetColumn<TRow> {
  /** Stable id, also handed back by {@link SheetTableProps.onCellContextMenu}. */
  id: string;
  header: ReactNode;
  /**
   * Fixed width in pixels — the sheet scrolls rather than reflowing, and a long
   * value is cut off rather than widening its column.
   */
  width: number;
  align?: SheetAlign;
  headerClassName?: string;
  cellClassName?: string | ((row: TRow) => string);
  cell: (row: TRow, rowIndex: number) => ReactNode;
  /**
   * The plain value this cell stands for, taken from the record rather than the
   * DOM. Returning `null` (or omitting this) makes the cell non-interactive on
   * right-click — a column with nothing to filter on shouldn't offer a menu.
   */
  contextValue?: (row: TRow) => string | null;
}

/** A nested run of rows under an expanded parent, with its own columns. */
export interface SheetSection {
  /**
   * Labels for a sub-header strip above the children. Must be as long as
   * `columns`; omit for no strip.
   */
  header?: ReactNode[];
  columns: SheetColumn<never>[];
  rows: SheetRow<never>[];
}

/**
 * Build a nested section without losing type safety at the call site.
 *
 * The sheet renders sections without knowing their row type, so `SheetSection`
 * erases it; this helper is the one place that cast happens, which keeps the
 * columns and rows you pass in checked against each other.
 */
export function sheetSection<T>(section: {
  header?: ReactNode[];
  columns: SheetColumn<T>[];
  rows: SheetRow<T>[];
}): SheetSection {
  return section as unknown as SheetSection;
}

export interface SheetRow<TRow> {
  /** Stable id — the React key, and what expansion state is tracked by. */
  id: string;
  data: TRow;
  className?: string;
  /** Leading gutter cell: a row number, a chevron, or nothing. */
  gutter?: ReactNode;
  /** Trailing cell, typically a `⋮` menu. Clicks inside it never toggle the row. */
  actions?: ReactNode;
  /** Called when the row body is clicked. Absent means the row is inert. */
  onToggle?: () => void;
  expanded?: boolean;
  /** Full-width panel rendered under the row while expanded. */
  detail?: () => ReactNode;
  /** Nested rows rendered under the row while expanded. */
  section?: SheetSection;
}

export interface CellContextEvent<TRow> {
  columnId: string;
  /** The cell's value, or `null` when the column declares none. */
  value: string | null;
  row: TRow;
  clientX: number;
  clientY: number;
}

export interface SheetTableProps<TRow> {
  columns: SheetColumn<TRow>[];
  rows: SheetRow<TRow>[];
  /** Width of the leading gutter column. Pass 0 to omit it entirely. */
  gutterWidth?: number;
  /** Width of the trailing actions column. Pass 0 to omit it entirely. */
  actionsWidth?: number;
  /**
   * Show every cell in full instead of truncating. Off by default: a ledger is
   * scanned down its numeric columns, and wrapping breaks that alignment.
   */
  wrap?: boolean;
  /** Right-click on any body cell. The host positions and renders the menu. */
  onCellContextMenu?: (event: CellContextEvent<TRow>) => void;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
  /** A summary line under the sheet — row counts, totals, the active range. */
  footer?: ReactNode;
  className?: string;
  /** Accessible name for the table. */
  label?: string;
}

const ALIGN_CLASS: Record<SheetAlign, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/** Cells truncate by default so the numeric columns stay in line. */
const CELL_BASE =
  'border-b border-border/60 px-2 py-1.5 align-top text-[12px] leading-tight';

/**
 * The variable the expanded detail panel is sized by.
 *
 * Set from the scroll container's own width, so the panel spans what is
 * visible rather than the full width of the sheet behind it.
 */
const VIEWPORT_VAR = '--sheet-viewport';

function alignClass(align: SheetAlign | undefined): string {
  return ALIGN_CLASS[align ?? 'left'];
}

function resolveCellClassName<TRow>(column: SheetColumn<TRow>, row: TRow): string | undefined {
  return typeof column.cellClassName === 'function'
    ? column.cellClassName(row)
    : column.cellClassName;
}

/** One body row, plus whatever it expands into. */
function SheetBodyRow<TRow>({
  row,
  rowIndex,
  columns,
  gutterWidth,
  actionsWidth,
  totalColumns,
  onCellContextMenu,
}: {
  row: SheetRow<TRow>;
  rowIndex: number;
  columns: SheetColumn<TRow>[];
  gutterWidth: number;
  actionsWidth: number;
  totalColumns: number;
  onCellContextMenu?: (event: CellContextEvent<TRow>) => void;
}) {
  const interactive = !!row.onToggle;

  const handleContextMenu = (column: SheetColumn<TRow>) => (event: MouseEvent) => {
    if (!onCellContextMenu || !column.contextValue) return;
    const value = column.contextValue(row.data);
    if (value === null) return;
    event.preventDefault();
    onCellContextMenu({
      columnId: column.id,
      value,
      row: row.data,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  return (
    <Fragment>
      <tr
        className={cn(
          'group/sheet-row',
          interactive && 'cursor-pointer hover:bg-muted',
          row.expanded && 'bg-muted',
          row.className,
        )}
        onClick={interactive ? row.onToggle : undefined}
        data-sheet-row={row.id}
        data-expanded={row.expanded ? 'true' : undefined}
      >
        {gutterWidth > 0 && (
          <td
            data-sheet-gutter=""
            className={cn(
              CELL_BASE,
              'select-none overflow-visible whitespace-nowrap px-1 text-center tabular-nums text-[11px] text-muted-foreground',
            )}
          >
            {row.gutter}
          </td>
        )}
        {columns.map((column) => (
          <td
            key={column.id}
            className={cn(
              CELL_BASE,
              alignClass(column.align),
              resolveCellClassName(column, row.data),
            )}
            onContextMenu={handleContextMenu(column)}
          >
            {column.cell(row.data, rowIndex)}
          </td>
        ))}
        {actionsWidth > 0 && (
          <td
            className={cn(CELL_BASE, 'text-right')}
            // The row menu lives inside the row; opening it must not also
            // collapse the row out from under the menu.
            onClick={(event) => event.stopPropagation()}
          >
            {row.actions}
          </td>
        )}
        <td className={CELL_BASE} />
      </tr>

      {row.expanded && row.section && (
        <SheetNestedSection
          section={row.section}
          gutterWidth={gutterWidth}
          actionsWidth={actionsWidth}
          totalColumns={totalColumns}
          onCellContextMenu={
            onCellContextMenu as ((event: CellContextEvent<never>) => void) | undefined
          }
        />
      )}

      {row.expanded && row.detail && (
        <tr className="bg-background">
          {/* `data-sheet-detail` opts this cell out of the truncation rules the
              table puts on every other `td`. They are what broke the sticky
              panel: `overflow: hidden` on an ancestor makes the sticky element
              scroll with that ancestor instead of the scroll container, and
              `white-space: nowrap` forced the panel's own text onto one line. */}
          <td
            data-sheet-detail=""
            colSpan={totalColumns}
            className="overflow-visible border-b border-border/60 p-0 whitespace-normal"
          >
            {/* Sticky to the left edge of the scroll container and sized to it,
                so the panel stays put — and stays fully readable — while the
                columns behind it scroll sideways. Falls back to 100% before the
                first measurement, and on any browser without CSS variables. */}
            <div
              className="sticky left-0 px-3 py-3"
              style={{ width: `var(${VIEWPORT_VAR}, 100%)` }}
            >
              {row.detail()}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** A parent row's children, rendered against the parent's column widths. */
function SheetNestedSection({
  section,
  gutterWidth,
  actionsWidth,
  totalColumns,
  onCellContextMenu,
}: {
  section: SheetSection;
  gutterWidth: number;
  actionsWidth: number;
  totalColumns: number;
  onCellContextMenu?: (event: CellContextEvent<never>) => void;
}) {
  return (
    <Fragment>
      {section.header && (
        <tr className="bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
          {gutterWidth > 0 && <td className="border-b border-border/60 px-2 py-1" />}
          {section.header.map((label, columnIndex) => (
            <td
              key={section.columns[columnIndex]?.id ?? columnIndex}
              className={cn(
                'border-b border-border/60 px-2 py-1',
                alignClass(section.columns[columnIndex]?.align),
              )}
            >
              {label}
            </td>
          ))}
          {actionsWidth > 0 && <td className="border-b border-border/60 px-2 py-1" />}
          <td className="border-b border-border/60 px-2 py-1" />
        </tr>
      )}
      {section.rows.map((childRow, childIndex) => (
        <SheetBodyRow
          key={childRow.id}
          row={childRow}
          rowIndex={childIndex}
          columns={section.columns}
          gutterWidth={gutterWidth}
          actionsWidth={actionsWidth}
          totalColumns={totalColumns}
          onCellContextMenu={onCellContextMenu}
        />
      ))}
    </Fragment>
  );
}

export function SheetTable<TRow>({
  columns,
  rows,
  gutterWidth = 48,
  actionsWidth = 28,
  wrap = false,
  onCellContextMenu,
  empty,
  footer,
  className,
  label,
}: SheetTableProps<TRow>) {
  const widths = [
    ...(gutterWidth > 0 ? [gutterWidth] : []),
    ...columns.map((column) => column.width),
    ...(actionsWidth > 0 ? [actionsWidth] : []),
  ];
  // One unsized column trails the sheet. Under `table-fixed` a table wider than
  // its columns hands the slack out across them, which would quietly undo every
  // declared width on a wide screen; an auto column soaks it up instead, and
  // collapses to nothing once the sheet is wide enough to scroll.
  const totalColumns = widths.length + 1;
  const minWidth = widths.reduce((sum, width) => sum + width, 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);

  // The expanded detail panel is sized to the scroll container rather than to
  // the sheet, so it stays fully visible instead of running off to the right
  // with the columns. Measured rather than assumed: the container shares its
  // width with the sidebar and the copilot pane, both of which resize.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        ref={scrollRef}
        // `overflow-auto` makes this div a scroll container per the CSS
        // overflow spec, which is what scopes the header's `sticky top-0` to
        // it instead of the page — so this box, not `<main>`, must be the
        // thing that actually scrolls. `min-h-0 flex-1` (paired with a host
        // that gives `className` a bounded height, e.g. `h-full` inside a
        // flex column that fills the viewport) makes that true: the sheet
        // becomes the page's only vertical scroller, and the sticky header
        // binds to it correctly. Without a height-bearing `className` this
        // just grows to fit its content, same as before.
        className="min-h-0 flex-1 overflow-auto rounded-md border bg-background"
        style={
          viewportWidth === null
            ? undefined
            : ({ [VIEWPORT_VAR]: `${viewportWidth}px` } as CSSProperties)
        }
      >
        <table
          aria-label={label}
          className={cn(
            // `table-fixed` is what makes the colgroup binding: under auto
            // layout a long unwrapped value widens its own column, so the
            // widths below were only ever a floor and the text columns grew to
            // whatever the longest name happened to be.
            'w-full table-fixed border-collapse bg-background text-[12px]',
            // Headers are labels we chose, so they always truncate.
            '[&_th]:overflow-hidden [&_th]:text-ellipsis [&_th]:whitespace-nowrap',
            // Truncation is the default; `wrap` swaps to full contents and
            // lets snake_case values break at their underscores. Both skip the
            // full-width detail cell and the row-number gutter — a row number
            // is never allowed to render as an ellipsis.
            wrap
              ? '[&_td:not([data-sheet-detail]):not([data-sheet-gutter])]:whitespace-normal [&_td:not([data-sheet-detail]):not([data-sheet-gutter])]:break-words'
              : '[&_td:not([data-sheet-detail]):not([data-sheet-gutter])]:overflow-hidden [&_td:not([data-sheet-detail]):not([data-sheet-gutter])]:text-ellipsis [&_td:not([data-sheet-detail]):not([data-sheet-gutter])]:whitespace-nowrap',
          )}
          style={{ minWidth }}
        >
          <colgroup>
            {widths.map((width, columnIndex) => (
              <col key={columnIndex} style={{ width }} />
            ))}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {gutterWidth > 0 && <th className="border-b px-2 py-2" />}
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    'border-b px-2 py-2 font-medium',
                    alignClass(column.align),
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
              {actionsWidth > 0 && <th className="border-b px-2 py-2" />}
              <th className="border-b px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={totalColumns} className="p-0">
                  <div className="px-4 py-8 text-center">{empty}</div>
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <SheetBodyRow
                  key={row.id}
                  row={row}
                  rowIndex={rowIndex}
                  columns={columns}
                  gutterWidth={gutterWidth}
                  actionsWidth={actionsWidth}
                  totalColumns={totalColumns}
                  onCellContextMenu={onCellContextMenu}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {footer && (
        <div className="shrink-0 px-1 pt-2 text-[11px] text-muted-foreground">{footer}</div>
      )}
    </div>
  );
}
