"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createGroup as createGroupPure,
  initLayout,
  moveColumn as moveColumnPure,
  moveGroup as moveGroupPure,
  removeGroup as removeGroupPure,
  setHidden as setHiddenPure,
  showAll as showAllPure,
  toggleGroupCollapsed as toggleGroupCollapsedPure,
  visibleOrderedIds,
  groupOf,
  type ColumnLayoutState,
} from "@/lib/table/columnLayout";
import { useTableLayoutStore } from "./TableLayoutStore";
import type { ColumnDef } from "./types";

/**
 * A "layer-1" header segment covering a contiguous run of visible columns:
 * - `plain` — ungrouped columns (merged into one top cell)
 * - `group` — an EXPANDED group (its columns + a "−" collapse bar on top)
 *
 * COLLAPSED groups occupy no columns; each is recorded as a "+" marker attached
 * to the neighbouring segment (`leadingCollapsed` = the segment to its right;
 * `trailingCollapsed` = trailing groups pinned to the last segment).
 */
export interface HeaderSegment<T> {
  kind: "plain" | "group";
  groupId?: string;
  columns: ColumnDef<T>[];
  leadingCollapsed: string[];
  trailingCollapsed: string[];
}

export interface ColumnManager<T> {
  /** Visible columns in display order (excludes collapsed groups). */
  visibleColumns: ColumnDef<T>[];
  /** All managed columns keyed for the config panel, in display order. */
  orderedColumns: { def: ColumnDef<T>; hidden: boolean }[];
  /** Body-cell count for full-width rows (section headers / empty states). */
  visibleCount: number;

  // selection (click / shift-click on headers) used to build a group
  selectedIds: Set<string>;
  /** Select exactly this column (replace); toggles off if already the only one. */
  selectSingle: (id: string) => void;
  /** Add/remove a single column from the selection (⌘/Ctrl click). */
  toggleSelected: (id: string) => void;
  /** Select the visible run between the anchor and `id` (shift-click). */
  extendSelection: (id: string) => void;
  clearSelection: () => void;

  /** Layer-1 header segments (merged ungrouped runs, group bars, + markers). */
  headerSegments: HeaderSegment<T>[];
  /** True when a group exists → render the two-row (layer-1 + column) header. */
  hasHeaderLayer: boolean;
  /** Number of columns a "Group selected" action would create right now
   *  (the contiguous run between the outermost selected columns). */
  selectedGroupSize: number;

  // mutations
  moveColumn: (fromId: string, toId: string | null) => void;
  /** Move a whole group's columns as a block before `toId` (or to the end). */
  moveGroup: (groupId: string, toId: string | null) => void;
  setHidden: (id: string, hidden: boolean) => void;
  showAll: () => void;
  groupSelected: () => void;
  ungroup: (groupId: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  reset: () => void;

  // lookups
  labelFor: (id: string) => string;
  groupIdOf: (id: string) => string | null;
}

/**
 * React state for a table's column layout, built on the pure logic in
 * `@/lib/table/columnLayout` and persisted to *workspace settings* (see
 * {@link useTableLayoutStore}) rather than to the browser — the arrangement is
 * shared by every member of the workspace and follows them across devices.
 * Reconciles the stored layout against the live column set once the workspace's
 * layouts have loaded, and whenever the column ids change.
 */
export function useColumnLayout<T>(
  tableId: string,
  columns: ColumnDef<T>[],
): ColumnManager<T> {
  const store = useTableLayoutStore();
  const { loaded, getLayout, saveLayout, resetLayout } = store;
  const byId = useMemo(() => {
    const m = new Map<string, ColumnDef<T>>();
    columns.forEach((c) => m.set(c.id, c));
    return m;
  }, [columns]);

  const allIds = useMemo(() => columns.map((c) => c.id), [columns]);
  const allIdsKey = allIds.join("|");

  // Initialise from declared order first (stable for SSR), then reconcile
  // against the workspace's saved layout once it has loaded.
  const [state, setState] = useState<ColumnLayoutState>(() =>
    initLayout(allIds),
  );

  useEffect(() => {
    setState(initLayout(allIds, loaded ? getLayout(tableId) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, allIdsKey, loaded, getLayout]);

  // Always-current state, for callbacks that must read it without re-creating.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Only user edits are written back. Hydration/reconciliation must not save,
  // or merely opening a table would overwrite the workspace's stored layout
  // (and, with several tables mounted, fire a burst of pointless writes).
  //
  // The pending save records *which* table it was made for: the pipeline tables
  // swap tableId with the view mode (`pipeline-inbound:${viewMode}`), and a save
  // must never be attributed to whichever table id happens to be current when
  // the effect runs.
  const pendingSaveFor = useRef<string | null>(null);
  useEffect(() => {
    if (pendingSaveFor.current !== tableId) return;
    pendingSaveFor.current = null;
    saveLayout(tableId, state);
  }, [tableId, state, saveLayout]);

  const tableIdRef = useRef(tableId);
  tableIdRef.current = tableId;

  /** Apply a pure layout transition and persist the result to the workspace. */
  const mutate = useCallback(
    (fn: (s: ColumnLayoutState) => ColumnLayoutState) => {
      setState((s) => {
        const next = fn(s);
        // The pure helpers return the same object for a no-op (e.g. grouping
        // fewer than two columns). React bails out of the re-render then, so
        // the marker must be cleared here or it would leak into the next render.
        pendingSaveFor.current = next !== s ? tableIdRef.current : null;
        return next;
      });
    },
    [],
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorId = useRef<string | null>(null);

  // Plain click: select exactly this column (replacing any previous selection),
  // toggling it off when it is already the sole selected column.
  const selectSingle = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.size === 1 && prev.has(id) ? new Set() : new Set([id]),
    );
    anchorId.current = id;
  }, []);

  // ⌘/Ctrl click: add/remove a single column from the current selection.
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorId.current = id;
  }, []);

  // Shift click: select the whole visible run between the anchor and `id` so the
  // jumped-over columns are highlighted too.
  const extendSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const visible = visibleOrderedIds(stateRef.current);
      const from = anchorId.current ?? id;
      const a = visible.indexOf(from);
      const b = visible.indexOf(id);
      const next = new Set(prev);
      if (a < 0 || b < 0) {
        next.add(id);
        return next;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) next.add(visible[i]);
      return next;
    });
    if (anchorId.current === null) anchorId.current = id;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorId.current = null;
  }, []);

  const moveColumn = useCallback(
    (fromId: string, toId: string | null) =>
      mutate((s) => moveColumnPure(s, fromId, toId)),
    [mutate],
  );

  const moveGroup = useCallback(
    (groupId: string, toId: string | null) =>
      mutate((s) => moveGroupPure(s, groupId, toId)),
    [mutate],
  );

  const setHidden = useCallback(
    (id: string, hidden: boolean) =>
      mutate((s) => setHiddenPure(s, id, hidden)),
    [mutate],
  );

  const showAll = useCallback(() => mutate((s) => showAllPure(s)), [mutate]);

  const groupSelected = useCallback(() => {
    mutate((s) => {
      // Grow the selection to the contiguous run between the leftmost and
      // rightmost selected columns, so picking the ends (a … c) also groups
      // the columns in between (b).
      const visible = visibleOrderedIds(s);
      const idxs = Array.from(selectedIds)
        .map((id) => visible.indexOf(id))
        .filter((i) => i >= 0);
      if (idxs.length < 2) return s;
      const min = Math.min(...idxs);
      const max = Math.max(...idxs);
      return createGroupPure(s, visible.slice(min, max + 1));
    });
    clearSelection();
  }, [mutate, selectedIds, clearSelection]);

  const ungroup = useCallback(
    (groupId: string) => mutate((s) => removeGroupPure(s, groupId)),
    [mutate],
  );

  const toggleGroupCollapsed = useCallback(
    (groupId: string) =>
      mutate((s) => toggleGroupCollapsedPure(s, groupId)),
    [mutate],
  );

  // Reset clears the workspace's saved layout outright rather than saving the
  // defaults back, so the table follows any future change to its declared
  // column set instead of freezing today's order.
  const reset = useCallback(() => {
    setState(initLayout(allIds));
    resetLayout(tableId);
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, allIdsKey, resetLayout, clearSelection]);

  const visibleIds = visibleOrderedIds(state);
  const visibleColumns = useMemo(
    () =>
      visibleIds
        .map((id) => byId.get(id))
        .filter((c): c is ColumnDef<T> => Boolean(c)),
    // visibleIds derives from state; join for a stable dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, visibleIds.join("|")],
  );

  const orderedColumns = useMemo(() => {
    const hiddenSet = new Set(state.hidden);
    return state.order
      .map((id) => byId.get(id))
      .filter((c): c is ColumnDef<T> => Boolean(c))
      .map((def) => ({ def, hidden: hiddenSet.has(def.id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, state.order.join("|"), state.hidden.join("|")]);

  // Layer-1 header segments in display order: merged runs of ungrouped columns
  // ("plain"), expanded groups ("group"), and "+" markers for collapsed groups
  // attached to the following segment. Explicitly-hidden columns are skipped.
  const headerSegments = useMemo<HeaderSegment<T>[]>(() => {
    const hiddenSet = new Set(state.hidden);
    const segs: HeaderSegment<T>[] = [];
    let pending: string[] = []; // collapsed group ids awaiting the next segment
    let lastCollapsed: string | null = null;

    const pushCol = (col: ColumnDef<T>, groupId?: string) => {
      const last = segs[segs.length - 1];
      const canAppend =
        pending.length === 0 &&
        !!last &&
        (groupId
          ? last.kind === "group" && last.groupId === groupId
          : last.kind === "plain");
      if (canAppend) {
        last!.columns.push(col);
      } else {
        segs.push({
          kind: groupId ? "group" : "plain",
          groupId,
          columns: [col],
          leadingCollapsed: pending,
          trailingCollapsed: [],
        });
        pending = [];
      }
    };

    for (const id of state.order) {
      const group = groupOf(state, id);
      if (group?.collapsed) {
        if (lastCollapsed !== group.id) {
          pending.push(group.id);
          lastCollapsed = group.id;
        }
        continue;
      }
      lastCollapsed = null;
      if (hiddenSet.has(id)) continue;
      const col = byId.get(id);
      if (col) pushCol(col, group?.id);
    }
    if (pending.length) {
      if (segs.length) segs[segs.length - 1].trailingCollapsed.push(...pending);
      else
        segs.push({
          kind: "plain",
          columns: [],
          leadingCollapsed: [],
          trailingCollapsed: pending,
        });
    }
    return segs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, state.order.join("|"), state.hidden.join("|"), state.groups]);

  const hasHeaderLayer = headerSegments.some(
    (s) =>
      s.kind === "group" ||
      s.leadingCollapsed.length > 0 ||
      s.trailingCollapsed.length > 0,
  );
  const visibleCount = headerSegments.reduce((n, s) => n + s.columns.length, 0);

  // Size of the group a "Group selected" action would create right now.
  const selectedGroupSize = useMemo(() => {
    if (selectedIds.size < 2) return selectedIds.size;
    const idxs = Array.from(selectedIds)
      .map((id) => visibleIds.indexOf(id))
      .filter((i) => i >= 0);
    if (idxs.length < 2) return selectedIds.size;
    return Math.max(...idxs) - Math.min(...idxs) + 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, visibleIds.join("|")]);

  return {
    visibleColumns,
    orderedColumns,
    visibleCount,
    headerSegments,
    hasHeaderLayer,
    selectedGroupSize,
    selectedIds,
    selectSingle,
    toggleSelected,
    extendSelection,
    clearSelection,
    moveColumn,
    moveGroup,
    setHidden,
    showAll,
    groupSelected,
    ungroup,
    toggleGroupCollapsed,
    reset,
    labelFor: (id) => byId.get(id)?.label ?? id,
    groupIdOf: (id) => groupOf(state, id)?.id ?? null,
  };
}

// Context so header cells and the gear config can share one manager instance
// without prop-drilling. The generic is erased at the context boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ColumnManagerContext = createContext<ColumnManager<any> | null>(null);

export const ColumnManagerProvider = ColumnManagerContext.Provider;

export function useColumnManager<T>(): ColumnManager<T> {
  const ctx = useContext(ColumnManagerContext);
  if (!ctx) {
    throw new Error(
      "useColumnManager must be used within a <ColumnManagerProvider>",
    );
  }
  return ctx as ColumnManager<T>;
}
