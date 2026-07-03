"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsLeftRight,
  ChevronsRightLeft,
  EyeOff,
  Filter,
  Group,
  Ungroup,
} from "lucide-react";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useColumnManager, type HeaderSegment } from "./useColumnLayout";
import type { ColumnDef } from "./types";

const DRAG_MIME = "application/x-mna-column";
const DRAG_GROUP_MIME = "application/x-mna-group";

/** Position of a column within its (expanded) group, for the soft bracket. */
interface GroupCtx {
  groupId: string;
  isFirst: boolean;
  isLast: boolean;
}

/** Sort / filter context-menu items derived from a column's descriptors. */
function SortFilterMenuItems<T>({ col }: { col: ColumnDef<T> }) {
  const { sort, filter } = col;
  return (
    <>
      {sort && (
        <>
          <ContextMenuItem onSelect={() => sort.onSort("asc")}>
            <ArrowUp className="mr-2 h-4 w-4" />
            Sort ascending
            {sort.active && sort.direction === "asc" && (
              <span className="ml-auto text-xs text-muted-foreground">•</span>
            )}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => sort.onSort("desc")}>
            <ArrowDown className="mr-2 h-4 w-4" />
            Sort descending
            {sort.active && sort.direction === "desc" && (
              <span className="ml-auto text-xs text-muted-foreground">•</span>
            )}
          </ContextMenuItem>
        </>
      )}
      {filter && filter.options.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Filter className="mr-2 h-4 w-4" />
            Filter
            {filter.selected.length > 0 && (
              <span className="ml-auto text-xs text-primary">
                {filter.selected.length}
              </span>
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-72 w-52 overflow-auto">
            {filter.options.map((opt) => {
              const checked = filter.selected.includes(opt.value);
              return (
                <ContextMenuCheckboxItem
                  key={opt.value}
                  checked={checked}
                  onSelect={(e) => {
                    e.preventDefault();
                    filter.onChange(
                      checked
                        ? filter.selected.filter((v) => v !== opt.value)
                        : [...filter.selected, opt.value],
                    );
                  }}
                >
                  <span className="truncate">{opt.label ?? opt.value}</span>
                </ContextMenuCheckboxItem>
              );
            })}
            {filter.selected.length > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => filter.onChange([])}>
                  Clear filter
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {(sort || (filter && filter.options.length > 0)) && <ContextMenuSeparator />}
    </>
  );
}

/** A single managed (draggable / hideable / groupable) column header cell. */
function ManagedHeaderCell<T>({
  col,
  rowSpan,
  group,
}: {
  col: ColumnDef<T>;
  rowSpan?: number;
  group?: GroupCtx;
}) {
  const mgr = useColumnManager<T>();
  const [dragOver, setDragOver] = useState(false);

  const reorderable = col.reorderable !== false;
  const hideable = col.hideable !== false;
  const groupable = col.groupable !== false;
  const selected = mgr.selectedIds.has(col.id);
  const canGroup = groupable && mgr.selectedIds.size >= 2;
  // New model (no legacy inline `header`): sort/filter live in the right-click
  // menu and a plain left-click selects the column. Columns that still pass a
  // custom `header` (e.g. inline ColumnHeaderContent) keep the old behaviour.
  const menuMode = !col.header;

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const groupId = e.dataTransfer.getData(DRAG_GROUP_MIME);
    if (groupId) {
      mgr.moveGroup(groupId, col.id);
      return;
    }
    const from = e.dataTransfer.getData(DRAG_MIME);
    if (from && from !== col.id) mgr.moveColumn(from, col.id);
  };

  // Only show a sort arrow while the column is actively sorted; hide it in the
  // unsorted state (sorting is triggered from the right-click menu).
  const sortArrow =
    col.sort && col.sort.active ? (
      col.sort.direction === "asc" ? (
        <ArrowUp className="ml-1 h-3 w-3" />
      ) : (
        <ArrowDown className="ml-1 h-3 w-3" />
      )
    ) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableHead
          rowSpan={rowSpan}
          draggable={reorderable}
          data-selected={selected || undefined}
          onClick={
            menuMode && groupable
              ? (e) => {
                  // Plain click selects just this column (replacing the previous
                  // one); shift extends the range, ⌘/Ctrl adds/removes.
                  e.preventDefault();
                  if (e.shiftKey) mgr.extendSelection(col.id);
                  else if (e.metaKey || e.ctrlKey) mgr.toggleSelected(col.id);
                  else mgr.selectSingle(col.id);
                }
              : undefined
          }
          onClickCapture={
            !menuMode
              ? (e) => {
                  if (groupable && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.shiftKey) mgr.extendSelection(col.id);
                    else mgr.toggleSelected(col.id);
                  }
                }
              : undefined
          }
          onDragStart={
            reorderable
              ? (e) => {
                  e.dataTransfer.setData(DRAG_MIME, col.id);
                  e.dataTransfer.effectAllowed = "move";
                }
              : undefined
          }
          onDragOver={
            reorderable
              ? (e) => {
                  if (
                    !e.dataTransfer.types.includes(DRAG_MIME) &&
                    !e.dataTransfer.types.includes(DRAG_GROUP_MIME)
                  )
                    return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOver(true);
                }
              : undefined
          }
          onDragLeave={() => setDragOver(false)}
          onDrop={reorderable ? drop : undefined}
          className={cn(
            col.headerClassName,
            reorderable && "cursor-grab active:cursor-grabbing",
            menuMode && "select-none",
            group && "border-y border-primary/25 bg-primary/[0.04]",
            group?.isFirst && "border-l",
            group?.isLast && "border-r",
            selected && "bg-primary/10 ring-2 ring-inset ring-primary/50",
            dragOver && "border-l-2 border-l-primary",
          )}
        >
          {menuMode ? (
            <span className="flex items-center whitespace-nowrap">
              {col.label}
              {sortArrow}
              {col.filter && col.filter.selected.length > 0 && (
                <Filter className="ml-1 h-3 w-3 fill-current text-primary" />
              )}
            </span>
          ) : (
            col.header ?? <span className="whitespace-nowrap">{col.label}</span>
          )}
        </TableHead>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {menuMode && <SortFilterMenuItems col={col} />}
        {hideable && (
          <ContextMenuItem onSelect={() => mgr.setHidden(col.id, true)}>
            <EyeOff className="mr-2 h-4 w-4" />
            Hide “{col.label}”
          </ContextMenuItem>
        )}
        {canGroup && (
          <ContextMenuItem onSelect={() => mgr.groupSelected()}>
            <Group className="mr-2 h-4 w-4" />
            Group {mgr.selectedGroupSize} selected columns
          </ContextMenuItem>
        )}
        {group && (
          <>
            <ContextMenuItem
              onSelect={() => mgr.toggleGroupCollapsed(group.groupId)}
            >
              <ChevronsRightLeft className="mr-2 h-4 w-4" />
              Collapse group
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => mgr.ungroup(group.groupId)}>
              <Ungroup className="mr-2 h-4 w-4" />
              Ungroup
            </ContextMenuItem>
          </>
        )}
        {mgr.selectedIds.size > 0 && (
          <ContextMenuItem onSelect={() => mgr.clearSelection()}>
            Clear selection
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => mgr.showAll()}>
          Show all columns
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A "+" chip in the layer-1 row that expands a collapsed group in place. */
function ExpandMarker({ groupId }: { groupId: string }) {
  const mgr = useColumnManager();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title="Expand group"
          draggable
          onClick={() => mgr.toggleGroupCollapsed(groupId)}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_GROUP_MIME, groupId);
            e.dataTransfer.effectAllowed = "move";
          }}
          className="inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded border border-primary/50 bg-primary/[0.06] text-[12px] font-bold leading-none text-primary hover:bg-primary/15 active:cursor-grabbing"
        >
          +
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={() => mgr.toggleGroupCollapsed(groupId)}>
          <ChevronsLeftRight className="mr-2 h-4 w-4" />
          Expand group
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => mgr.ungroup(groupId)}>
          <Ungroup className="mr-2 h-4 w-4" />
          Ungroup
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One layer-1 (top) header cell: a merged ungrouped run or an expanded group's
 *  draggable "−" collapse bar, plus any adjacent collapsed-group "+" markers. */
function HeaderTopCell<T>({ seg }: { seg: HeaderSegment<T> }) {
  const mgr = useColumnManager<T>();
  const isGroup = seg.kind === "group";
  const colSpan = Math.max(1, seg.columns.length);
  const [dragOver, setDragOver] = useState(false);

  const acceptDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_GROUP_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };
  const onDrop = (e: React.DragEvent) => {
    const gid = e.dataTransfer.getData(DRAG_GROUP_MIME);
    setDragOver(false);
    if (!gid) return;
    e.preventDefault();
    // Land the dragged group before this segment's first column.
    mgr.moveGroup(gid, seg.columns[0]?.id ?? null);
  };

  return (
    <TableHead
      colSpan={colSpan}
      onDragOver={acceptDrop}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn(
        "h-6 p-0 align-middle",
        isGroup
          ? "border-x border-t border-primary/25 bg-primary/[0.06]"
          : "bg-muted/20",
        dragOver && "outline outline-2 -outline-offset-2 outline-primary/60",
      )}
    >
      <div className="flex h-full items-center gap-1 px-1">
        {seg.leadingCollapsed.map((id) => (
          <ExpandMarker key={id} groupId={id} />
        ))}
        {isGroup ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                title="Drag to move group · click to collapse"
                draggable
                onClick={() => mgr.toggleGroupCollapsed(seg.groupId!)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_GROUP_MIME, seg.groupId!);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="flex min-w-0 flex-1 cursor-grab items-center justify-center gap-1 active:cursor-grabbing"
              >
                <span className="h-px flex-1 bg-primary/30" />
                <span
                  aria-hidden
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary/50 text-[12px] font-bold leading-none text-primary"
                >
                  −
                </span>
                <span className="h-px flex-1 bg-primary/30" />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-40">
              <ContextMenuItem
                onSelect={() => mgr.toggleGroupCollapsed(seg.groupId!)}
              >
                <ChevronsRightLeft className="mr-2 h-4 w-4" />
                Collapse group
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => mgr.ungroup(seg.groupId!)}>
                <Ungroup className="mr-2 h-4 w-4" />
                Ungroup
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <span className="flex-1" />
        )}
        {seg.trailingCollapsed.map((id) => (
          <ExpandMarker key={id} groupId={id} />
        ))}
      </div>
    </TableHead>
  );
}

interface ManagedTableHeaderProps {
  /** Pinned `<TableHead>` cells rendered to the LEFT of the managed columns. */
  leading?: ReactNode;
  /** Pinned `<TableHead>` cells rendered to the RIGHT (e.g. actions). */
  trailing?: ReactNode;
  /** className for the header `<TableRow>`(s). */
  rowClassName?: string;
}

/** Give pinned leading/trailing heads a rowSpan so they span both header rows. */
function withRowSpan(nodes: ReactNode, rowSpan: number): ReactNode {
  if (rowSpan <= 1) return nodes;
  return Children.map(nodes, (child) =>
    isValidElement(child)
      ? cloneElement(child as ReactElement<{ rowSpan?: number }>, { rowSpan })
      : child,
  );
}

/**
 * Renders the `<TableHeader>` for a managed table.
 *
 * - No groups → a single header row.
 * - Any group present → a layer-1 row on top (merged ungrouped runs, each
 *   expanded group's draggable "−" bar, and "+" markers for collapsed groups
 *   placed at the neighbouring cell), and a layer-2 row with the individual
 *   column headers. Ungrouped/pinned columns span both rows.
 */
export function ManagedTableHeader<T>({
  leading,
  trailing,
  rowClassName,
}: ManagedTableHeaderProps) {
  const mgr = useColumnManager<T>();

  if (!mgr.hasHeaderLayer) {
    return (
      <TableHeader>
        <TableRow className={rowClassName}>
          {leading}
          {mgr.visibleColumns.map((col) => (
            <ManagedHeaderCell key={col.id} col={col} />
          ))}
          {trailing}
        </TableRow>
      </TableHeader>
    );
  }

  return (
    <TableHeader>
      {/* Layer 1: merged runs / group bars / collapsed "+" markers. */}
      <TableRow className={rowClassName}>
        {withRowSpan(leading, 2)}
        {mgr.headerSegments.map((seg, i) => (
          <HeaderTopCell key={seg.groupId ?? `plain-${i}`} seg={seg} />
        ))}
        {withRowSpan(trailing, 2)}
      </TableRow>
      {/* Layer 2: individual column headers. */}
      <TableRow className={rowClassName}>
        {mgr.headerSegments.flatMap((seg) =>
          seg.columns.map((col, idx) => (
            <ManagedHeaderCell
              key={col.id}
              col={col}
              group={
                seg.kind === "group"
                  ? {
                      groupId: seg.groupId!,
                      isFirst: idx === 0,
                      isLast: idx === seg.columns.length - 1,
                    }
                  : undefined
              }
            />
          )),
        )}
      </TableRow>
    </TableHeader>
  );
}

/**
 * Renders the body `<TableCell>`s for one row, in the same order as the column
 * headers (collapsed groups contribute no cells).
 */
export function ManagedRowCells<T>({
  row,
  index,
}: {
  row: T;
  index: number;
}) {
  const mgr = useColumnManager<T>();
  return (
    <>
      {mgr.headerSegments.flatMap((seg) =>
        seg.columns.map((col, idx) => {
          const className =
            typeof col.cellClassName === "function"
              ? col.cellClassName(row, index)
              : col.cellClassName;
          const grouped = seg.kind === "group";
          const selected = mgr.selectedIds.has(col.id);
          return (
            <TableCell
              key={col.id}
              className={cn(
                className,
                grouped && "bg-primary/[0.02]",
                grouped && idx === 0 && "border-l border-primary/20",
                grouped &&
                  idx === seg.columns.length - 1 &&
                  "border-r border-primary/20",
                // Whole-column highlight when the column is selected.
                selected && "bg-primary/10",
              )}
            >
              {col.cell(row, index)}
            </TableCell>
          );
        }),
      )}
    </>
  );
}
