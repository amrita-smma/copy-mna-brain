'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { clearPageContext, setPageContext } from '@/lib/chat/pageContextStore';
import { findTabByPath, toLogicalPath } from '@/lib/navigation/consoleTabs';

/**
 * Publishes what the user is looking at so the copilot's `read_page_context`
 * tool can answer "summarize this page".
 *
 * The tab and path come from the route, which this provider already sees.
 * Anything more specific — the record that's open, the active filters — has to
 * come from the view itself, via {@link useSetPageDetail}.
 */
interface PageContextValue {
  setDetail: (detail: string | null) => void;
}

const PageDetailContext = createContext<PageContextValue | null>(null);

export function PageContextProvider({ children }: { children: ReactNode }) {
  const logicalPath = toLogicalPath(usePathname());
  // Detail is stored with the path it was recorded on. A view's effect fires
  // before its parent's, so a reset-on-navigation effect here would wipe the
  // incoming view's detail; matching on path instead lets a stale detail expire
  // on its own the moment the route changes.
  const [detailEntry, setDetailEntry] = useState<{ path: string; detail: string } | null>(null);
  const pathRef = useRef(logicalPath);
  pathRef.current = logicalPath;

  const setDetail = useCallback((detail: string | null) => {
    const trimmed = detail?.trim();
    setDetailEntry(trimmed ? { path: pathRef.current, detail: trimmed } : null);
  }, []);

  const detail = detailEntry?.path === logicalPath ? detailEntry.detail : undefined;

  useEffect(() => {
    setPageContext({
      tabSlug: findTabByPath(logicalPath)?.slug ?? null,
      path: logicalPath,
      ...(detail ? { detail } : {}),
    });
  }, [logicalPath, detail]);

  useEffect(() => () => clearPageContext(), []);

  const value = useMemo<PageContextValue>(() => ({ setDetail }), [setDetail]);

  return <PageDetailContext.Provider value={value}>{children}</PageDetailContext.Provider>;
}

const NOOP: PageContextValue = { setDetail: () => {} };

/**
 * Tell the copilot what this view currently has on screen — the open record,
 * the active filters, how many rows are visible. Keep it to a couple of short
 * lines; it is injected verbatim into the model's view of the page.
 *
 * Pass `null` when there's nothing specific to report. Safe to call outside the
 * provider (it no-ops), so a view shared with a non-shell context won't crash.
 */
export function useSetPageDetail(detail: string | null): void {
  const { setDetail } = useContext(PageDetailContext) ?? NOOP;
  useEffect(() => {
    setDetail(detail);
  }, [detail, setDetail]);
}
