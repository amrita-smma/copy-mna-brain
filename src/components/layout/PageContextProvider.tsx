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
  setCompanyId: (companyId: string) => void;
  /** Clear only if `companyId` is still the published one (see the hook). */
  clearCompanyId: (companyId: string) => void;
}

const PageDetailContext = createContext<PageContextValue | null>(null);

export function PageContextProvider({ children }: { children: ReactNode }) {
  const logicalPath = toLogicalPath(usePathname());
  // Detail is stored with the path it was recorded on. A view's effect fires
  // before its parent's, so a reset-on-navigation effect here would wipe the
  // incoming view's detail; matching on path instead lets a stale detail expire
  // on its own the moment the route changes.
  const [detailEntry, setDetailEntry] = useState<{ path: string; detail: string } | null>(null);
  // The open deal's id, path-scoped for the same reason as `detail`. Kept in
  // its own slot so a view can publish the id without owning the detail text —
  // the pipeline table sets the detail while its open dialog sets the id.
  const [companyEntry, setCompanyEntry] = useState<{ path: string; companyId: string } | null>(
    null,
  );
  const pathRef = useRef(logicalPath);
  pathRef.current = logicalPath;

  const setDetail = useCallback((detail: string | null) => {
    const trimmed = detail?.trim();
    setDetailEntry(trimmed ? { path: pathRef.current, detail: trimmed } : null);
  }, []);

  const setCompanyId = useCallback((companyId: string) => {
    const trimmed = companyId.trim();
    if (!trimmed) return;
    setCompanyEntry({ path: pathRef.current, companyId: trimmed });
  }, []);

  // Compare-and-clear: a route can host more than one dialog (the Dashboard
  // mounts two), so a closing one must not wipe an id a sibling just published.
  const clearCompanyId = useCallback((companyId: string) => {
    const trimmed = companyId.trim();
    setCompanyEntry((prev) => (prev && prev.companyId === trimmed ? null : prev));
  }, []);

  const detail = detailEntry?.path === logicalPath ? detailEntry.detail : undefined;
  const companyId = companyEntry?.path === logicalPath ? companyEntry.companyId : undefined;

  useEffect(() => {
    setPageContext({
      tabSlug: findTabByPath(logicalPath)?.slug ?? null,
      path: logicalPath,
      ...(detail ? { detail } : {}),
      ...(companyId ? { companyId } : {}),
    });
  }, [logicalPath, detail, companyId]);

  useEffect(() => () => clearPageContext(), []);

  const value = useMemo<PageContextValue>(
    () => ({ setDetail, setCompanyId, clearCompanyId }),
    [setDetail, setCompanyId, clearCompanyId],
  );

  return <PageDetailContext.Provider value={value}>{children}</PageDetailContext.Provider>;
}

const NOOP: PageContextValue = {
  setDetail: () => {},
  setCompanyId: () => {},
  clearCompanyId: () => {},
};

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

/**
 * Publish the `companies.id` of the deal this view has open, so the copilot can
 * pass it straight to a company_id-taking tool instead of re-resolving the
 * company from its name — which lands on the wrong record when two companies
 * share a near-identical name.
 *
 * Pass `null` when no deal is open. A `null` caller stays silent rather than
 * writing one: a route can mount several dialogs (the Dashboard mounts two) and
 * a closed one must not clear the id an open sibling just published. Clearing
 * is likewise compare-and-clear, on close and on unmount.
 *
 * Safe to call outside the provider, where it no-ops.
 */
export function useSetPageCompanyId(companyId: string | null): void {
  const { setCompanyId, clearCompanyId } = useContext(PageDetailContext) ?? NOOP;
  useEffect(() => {
    if (!companyId) return;
    setCompanyId(companyId);
    return () => clearCompanyId(companyId);
  }, [companyId, setCompanyId, clearCompanyId]);
}
