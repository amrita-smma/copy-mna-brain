"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  deleteTableLayout,
  listTableLayouts,
  saveTableLayout,
} from "@/lib/api/tableLayouts";
import type { ColumnLayoutState } from "@/lib/table/columnLayout";

/**
 * Shared access to the *workspace's* saved table layouts (column order, hidden
 * columns, collapsible groups). These are workspace settings, not per-user
 * preferences — one member rearranging a table changes it for everyone in the
 * workspace, and the arrangement follows them to any browser.
 */
export interface TableLayoutStore {
  /**
   * True once the workspace's layouts have been fetched *successfully*. Tables
   * render their declared defaults until then, and writes are suppressed —
   * saving before (or instead of) a successful read would overwrite the
   * workspace's stored layout with defaults it never actually loaded.
   */
  loaded: boolean;
  /** The workspace's saved layout for `tableId`, or null when never saved. */
  getLayout: (tableId: string) => ColumnLayoutState | null;
  /** Persist `layout` for the whole workspace (debounced, optimistic). */
  saveLayout: (tableId: string, layout: ColumnLayoutState) => void;
  /** Drop the saved layout so the table falls back to its declared defaults. */
  resetLayout: (tableId: string) => void;
}

/**
 * Fallback used when no provider is mounted (e.g. a table rendered outside the
 * workspace layout, or in a unit test). Layouts still work for the lifetime of
 * the mount; they just aren't persisted anywhere.
 */
const NOOP_STORE: TableLayoutStore = {
  loaded: true,
  getLayout: () => null,
  saveLayout: () => {},
  resetLayout: () => {},
};

const TableLayoutContext = createContext<TableLayoutStore>(NOOP_STORE);

/** Coalesce bursts of layout edits (e.g. hiding several columns) into one PUT. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Loads and persists the workspace's table layouts.
 *
 * Mount this **keyed by workspace** (`key={workspaceSlug}` in the
 * `/w/[workspaceSlug]` layout). A soft navigation between two workspaces keeps
 * client state alive, so without the key one workspace's layouts would be shown
 * — and then saved — under the other.
 */
export function TableLayoutProvider({ children }: { children: ReactNode }) {
  const [layouts, setLayouts] = useState<Record<string, ColumnLayoutState>>({});
  const [ready, setReady] = useState(false);

  // One request hydrates every table on the page — a per-table fetch would be a
  // client-side request fan-out for what is a handful of small rows.
  useEffect(() => {
    let cancelled = false;
    listTableLayouts()
      .then((data) => {
        if (cancelled) return;
        setLayouts(data ?? {});
        setReady(true);
      })
      .catch(() => {
        // Layouts are non-essential chrome — tables fall back to their declared
        // defaults. Deliberately stays un-ready so those defaults are never
        // written back over a layout we simply failed to read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-table debounce state. `pending` holds the layout each timer is going to
  // write, so an unmount can flush it instead of dropping it.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pending = useRef<Record<string, ColumnLayoutState>>({});

  const flush = useCallback((tableId: string) => {
    const layout = pending.current[tableId];
    delete pending.current[tableId];
    clearTimeout(timers.current[tableId]);
    delete timers.current[tableId];
    if (!layout) return;
    void saveTableLayout(tableId, layout).catch(() => {
      // Keep the optimistic local layout; the next edit retries the write.
    });
  }, []);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Navigating away (or switching workspace) within the debounce window must
  // still write the pending edit rather than silently discard it.
  useEffect(
    () => () => {
      Object.keys(pending.current).forEach((tableId) => flushRef.current(tableId));
    },
    [],
  );

  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;

  const readyRef = useRef(ready);
  readyRef.current = ready;

  const getLayout = useCallback(
    (tableId: string) => layoutsRef.current[tableId] ?? null,
    [],
  );

  const saveLayout = useCallback((tableId: string, layout: ColumnLayoutState) => {
    if (!readyRef.current) return;
    setLayouts((prev) => ({ ...prev, [tableId]: layout }));
    pending.current[tableId] = layout;
    clearTimeout(timers.current[tableId]);
    timers.current[tableId] = setTimeout(
      () => flushRef.current(tableId),
      SAVE_DEBOUNCE_MS,
    );
  }, []);

  const resetLayout = useCallback((tableId: string) => {
    if (!readyRef.current) return;
    setLayouts((prev) => {
      const next = { ...prev };
      delete next[tableId];
      return next;
    });
    // Drop the queued save outright — flushing it would immediately re-create
    // the row the reset is deleting.
    delete pending.current[tableId];
    clearTimeout(timers.current[tableId]);
    delete timers.current[tableId];
    void deleteTableLayout(tableId).catch(() => {});
  }, []);

  const value = useMemo<TableLayoutStore>(
    () => ({ loaded: ready, getLayout, saveLayout, resetLayout }),
    [ready, getLayout, saveLayout, resetLayout],
  );

  return (
    <TableLayoutContext.Provider value={value}>
      {children}
    </TableLayoutContext.Provider>
  );
}

export function useTableLayoutStore(): TableLayoutStore {
  return useContext(TableLayoutContext);
}
