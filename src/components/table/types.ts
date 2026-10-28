import type { ReactNode } from "react";

/** Sort control for a column, surfaced in the right-click menu (+ header arrow). */
export interface ColumnSort {
  /** Whether this column is the active sort. */
  active: boolean;
  /** Current direction (meaningful when `active`). */
  direction: "asc" | "desc";
  /** Sort this column in the given direction. */
  onSort: (direction: "asc" | "desc") => void;
}

/** Multi-select filter control for a column, surfaced in the right-click menu. */
export interface ColumnFilter {
  options: { value: string; label?: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}

/**
 * Declarative definition of a single *managed* table column — one that can be
 * reordered, hidden, and grouped via {@link useColumnLayout}. Pinned/utility
 * columns (e.g. a leading "Ask AI" button or a trailing actions menu) are NOT
 * managed columns; the host table renders those itself around the managed set.
 */
export interface ColumnDef<T> {
  /** Stable, unique id used for ordering/hiding/grouping persistence. */
  id: string;
  /** Short human label shown in the gear config list and as the default header. */
  label: string;
  /**
   * Custom header content (rendered inside the managed `<TableHead>`). Defaults
   * to the plain `label`. NOTE: when `sort`/`filter` are provided the header
   * renders a plain label + sort arrow and left-click selects the column, so
   * `header` is mainly for legacy columns that keep inline sort/filter controls.
   */
  header?: ReactNode;
  /** Sort control — when set, sorting moves to the right-click menu. */
  sort?: ColumnSort;
  /** Filter control — when set, filtering moves to the right-click menu. */
  filter?: ColumnFilter;
  /** Cell renderer for a row. */
  cell: (row: T, index: number) => ReactNode;
  /**
   * The cell as plain text, for exports that copy the table as the user has
   * it laid out (the Pipeline "Present" deck). A column without it exports
   * as a dash.
   */
  text?: (row: T) => string;
  /** className applied to the header `<TableHead>`. */
  headerClassName?: string;
  /** className applied to each body `<TableCell>` (static or per-row). */
  cellClassName?: string | ((row: T, index: number) => string);
  /** When false, the column can't be hidden (still reorderable). Default true. */
  hideable?: boolean;
  /** When false, the column can't be dragged to reorder. Default true. */
  reorderable?: boolean;
  /** When false, the column can't be added to a header group. Default true. */
  groupable?: boolean;
}
