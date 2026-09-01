'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Document, Page, pdfjs, type DocumentProps, type PageProps } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// Bundler-resolved worker asset (Turbopack/Webpack statically detect this
// `new URL(..., import.meta.url)` pattern) instead of pointing at a CDN, so
// the viewer keeps working offline/behind a firewall.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// cMaps are needed to render embedded CJK/complex-script fonts correctly;
// they're not bundled by default to keep the base package small. Only
// fetched by pdfjs when a document actually needs them.
const PDF_OPTIONS = {
  cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
  cMapPacked: true,
};

type PdfDocumentProxy = NonNullable<Parameters<NonNullable<DocumentProps['onLoadSuccess']>>[0]>;
type PdfPageProxy = Parameters<NonNullable<PageProps['onLoadSuccess']>>[0];

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.25;
// US Letter-ish fallback used for placeholder sizing until the first page
// reports its real dimensions (assumes uniform page size, true for the vast
// majority of real-world documents).
const FALLBACK_ASPECT_RATIO = 1.294;
// How far outside the viewport (in the scroll container) a page is preloaded
// before it scrolls into view, and how far it can drift out before its
// canvas is torn down again.
const RENDER_MARGIN_PX = 1000;
const SEARCH_DEBOUNCE_MS = 300;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) break;
    count += 1;
    index += needle.length;
  }
  return count;
}

interface PageMatch {
  pageNumber: number;
  count: number;
}

interface PdfViewerProps {
  url: string;
  className?: string;
}

/**
 * Renders a PDF as a continuous, virtualized scroll via react-pdf/pdfjs
 * instead of handing the whole file to the browser's native PDF plugin in an
 * iframe. Every page gets a slot (so the scrollbar reflects the true
 * document length and any page can be scrolled to directly), but only pages
 * within `RENDER_MARGIN_PX` of the viewport actually mount a `<Page>` canvas
 * — an IntersectionObserver mounts/unmounts them as the user scrolls, so
 * memory/CPU cost stays bounded regardless of document length.
 */
function PdfViewer({ url, className }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [renderSet, setRenderSet] = useState<Set<number>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [pageAspectRatio, setPageAspectRatio] = useState<number | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<PageMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>();
  const pageWrapperRefs = useRef(new Map<number, HTMLDivElement>());
  const pageObserverRef = useRef<IntersectionObserver | null>(null);
  const renderSetRef = useRef<Set<number>>(new Set());
  const pageAspectRatiosRef = useRef(new Map<number, number>());
  const pdfProxyRef = useRef<PdfDocumentProxy | null>(null);
  const pageTextCacheRef = useRef(new Map<number, string>());

  // react-pdf reparses the whole document whenever the `file` prop changes
  // identity, so memoize it — otherwise every parent re-render would pass a
  // fresh `{ url }` object and retrigger a full reload.
  const file = useMemo(() => ({ url }), [url]);

  // A new document resets everything — otherwise state from the previous
  // file (page count, search matches, cached text) would leak into this one.
  useEffect(() => {
    setNumPages(null);
    setDocError(null);
    setFailedPages(new Set());
    setRenderSet(new Set());
    setCurrentPage(1);
    setScale(1);
    setPageAspectRatio(null);
    setSearchInput('');
    setSearchText('');
    setSearching(false);
    setMatches([]);
    setCurrentMatchIndex(0);
    pdfProxyRef.current = null;
    pageTextCacheRef.current = new Map();
    pageAspectRatiosRef.current = new Map();
    renderSetRef.current = new Set();
    // pageWrapperRefs / pageObserverRef are intentionally left alone here —
    // they're maintained by the wrapper ref callback and the observer effect
    // below as elements naturally mount/unmount when `numPages` flips to
    // null and back, which also happens as part of this same reset.
  }, [url]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Debounce the search box so typing doesn't retrigger a full-document scan
  // on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearchText(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleLoadSuccess = useCallback((pdf: PdfDocumentProxy) => {
    if (pdf.numPages < 1) {
      setDocError('This PDF has no pages');
      return;
    }
    pdfProxyRef.current = pdf;
    setNumPages(pdf.numPages);
  }, []);

  const handleLoadError = useCallback((err: Error) => {
    console.error('Failed to load PDF:', err);
    setDocError('Failed to load PDF preview');
  }, []);

  // Tracked per-page (not just from page 1) since not every document has
  // uniform page dimensions — a page that's already been measured once gets
  // an accurate placeholder height even after its canvas is virtualized out.
  const handlePageLoadSuccess = useCallback((pageNumber: number, page: PdfPageProxy) => {
    const ratio = page.originalHeight / page.originalWidth;
    pageAspectRatiosRef.current.set(pageNumber, ratio);
    setPageAspectRatio((prev) => prev ?? ratio);
  }, []);

  const handlePageError = useCallback((pageNumber: number) => {
    console.error(`Failed to render PDF page ${pageNumber}`);
    setFailedPages((prev) => {
      if (prev.has(pageNumber)) return prev;
      const next = new Set(prev);
      next.add(pageNumber);
      return next;
    });
  }, []);

  // Mount/unmount page canvases as they scroll near/away from the viewport,
  // and track the topmost visible page for the "Page X of Y" indicator.
  //
  // The observer instance is kept in `pageObserverRef` and wrapper elements
  // register themselves via the ref callback below (see `setPageWrapperRef`)
  // rather than only being observed once here — if a new document happens to
  // have the same page count as the last one, `numPages` (this effect's only
  // dependency) doesn't change, so this effect wouldn't rerun, and any page
  // wrappers created after this point would never be observed if we didn't
  // also attach them eagerly as they mount.
  useEffect(() => {
    if (!numPages) {
      pageObserverRef.current?.disconnect();
      pageObserverRef.current = null;
      return;
    }
    const root = containerRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const current = renderSetRef.current;
        let changed = false;
        for (const entry of entries) {
          const n = Number(entry.target.getAttribute('data-page-number'));
          if (!Number.isFinite(n)) continue;
          if (entry.isIntersecting) {
            if (!current.has(n)) {
              current.add(n);
              changed = true;
            }
          } else if (current.delete(n)) {
            changed = true;
          }
        }

        if (changed) {
          setRenderSet(new Set(current));

          // Pick the topmost among ALL currently-intersecting pages (not
          // just the ones in this particular callback batch) so a page
          // entering the preload margin far below the viewport can't steal
          // the "current page" indicator from what's actually on screen.
          let topPage: number | null = null;
          let topValue = Infinity;
          current.forEach((pageNum) => {
            const top = pageWrapperRefs.current.get(pageNum)?.getBoundingClientRect().top;
            if (top !== undefined && top < topValue) {
              topValue = top;
              topPage = pageNum;
            }
          });
          if (topPage !== null) setCurrentPage(topPage);
        }

        setFailedPages((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          let failedChanged = false;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const n = Number(entry.target.getAttribute('data-page-number'));
            if (next.delete(n)) failedChanged = true;
          }
          return failedChanged ? next : prev;
        });
      },
      { root, rootMargin: `${RENDER_MARGIN_PX}px 0px`, threshold: 0 },
    );

    pageObserverRef.current = observer;
    pageWrapperRefs.current.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      pageObserverRef.current = null;
    };
  }, [numPages]);

  const setPageWrapperRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    const prevEl = pageWrapperRefs.current.get(pageNumber);
    if (prevEl && prevEl !== el) pageObserverRef.current?.unobserve(prevEl);
    if (el) {
      pageWrapperRefs.current.set(pageNumber, el);
      pageObserverRef.current?.observe(el);
    } else {
      pageWrapperRefs.current.delete(pageNumber);
      renderSetRef.current.delete(pageNumber);
    }
  }, []);

  // Full-document text search — extracted per page (and cached) so repeated
  // searches against the same document don't re-run pdfjs text extraction.
  useEffect(() => {
    const pdf = pdfProxyRef.current;
    // Captured up front: if `url` changes mid-scan, the reset effect swaps
    // in a fresh Map, but this closure keeps writing to the one that was
    // live when the scan started — never the new document's cache.
    const cache = pageTextCacheRef.current;
    if (!searchText || !pdf || !numPages) {
      setMatches([]);
      setCurrentMatchIndex(0);
      setSearching(false);
      return;
    }

    let cancelled = false;
    const query = searchText.toLowerCase();

    const run = async () => {
      setSearching(true);
      try {
        const found: PageMatch[] = [];
        for (let n = 1; n <= numPages; n += 1) {
          if (cancelled) return;
          let text = cache.get(n);
          if (text === undefined) {
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            if (cancelled) return;
            text = content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ')
              .toLowerCase();
            cache.set(n, text);
            // Release pdfjs's internal per-page resources now that we've
            // pulled the text out — otherwise a full-document search would
            // undo the whole point of virtualization by keeping every page
            // resident just to answer one query.
            page.cleanup();
          }
          const count = countOccurrences(text, query);
          if (count > 0) found.push({ pageNumber: n, count });
        }
        if (!cancelled) {
          setMatches(found);
          setCurrentMatchIndex(0);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    };
    run();

    return () => {
      cancelled = true;
    };
  }, [searchText, numPages]);

  const scrollToPage = useCallback((pageNumber: number) => {
    pageWrapperRefs.current.get(pageNumber)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Jump to the first match on the next/previous page that contains one
  // (page-granularity — every occurrence on that page is highlighted once
  // its text layer renders).
  const goToMatch = useCallback(
    (delta: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (currentMatchIndex + delta + matches.length) % matches.length;
      setCurrentMatchIndex(next);
      scrollToPage(matches[next].pageNumber);
    },
    [matches, currentMatchIndex, scrollToPage],
  );

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const trimmed = searchInput.trim();
      if (trimmed !== searchText) {
        // A search is still debounced (or was just typed) — commit it right
        // away instead of waiting, rather than navigating stale results.
        setSearchText(trimmed);
        return;
      }
      goToMatch(event.shiftKey ? -1 : 1);
    },
    [searchInput, searchText, goToMatch],
  );

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setSearchText('');
  }, []);

  const customTextRenderer = useCallback(
    (textItem: { str: string }) => {
      if (!searchText) return escapeHtml(textItem.str);
      // Split/match against the raw string first, then escape each piece —
      // matching against already-HTML-escaped text would let a query
      // containing `&`, `<`, or `>` desync from the (differently-escaped)
      // rendered output, or match halfway into an entity like `&amp;`.
      const regex = new RegExp(escapeRegExp(searchText), 'gi');
      const segments = textItem.str.split(regex);
      const found = textItem.str.match(regex);
      if (!found) return escapeHtml(textItem.str);
      return segments.reduce((html, segment, i) => {
        const highlighted = i > 0 ? `<mark class="rounded-sm bg-yellow-300 text-black">${escapeHtml(found[i - 1])}</mark>` : '';
        return html + highlighted + escapeHtml(segment);
      }, '');
    },
    [searchText],
  );

  const zoomOut = useCallback(() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP)), []);
  const zoomIn = useCallback(() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP)), []);

  const aspectRatio = pageAspectRatio ?? FALLBACK_ASPECT_RATIO;
  const pageWidth = containerWidth ? containerWidth * scale : undefined;
  const totalMatchCount = matches.reduce((sum, m) => sum + m.count, 0);

  return (
    <div className={cn('flex h-full w-full flex-col', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-background p-2">
        <span className="min-w-[5rem] text-sm text-muted-foreground">
          {numPages !== null ? `Page ${currentPage} of ${numPages}` : ' '}
        </span>

        <div className="flex flex-1 items-center gap-1.5">
          <div className="relative flex-1 min-w-[10rem] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search in document"
              disabled={numPages === null}
              className="h-8 pl-8 pr-8 text-sm"
            />
            {searchInput && (
              <button
                type="button"
                onClick={clearSearch}
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {searchText && (
            <>
              <span className="min-w-[4.5rem] text-xs text-muted-foreground">
                {searching
                  ? 'Searching…'
                  : matches.length > 0
                    ? `${totalMatchCount} on ${matches.length} pg`
                    : 'No results'}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => goToMatch(-1)}
                disabled={matches.length === 0}
                title="Previous match"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => goToMatch(1)}
                disabled={matches.length === 0}
                title="Next match"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={zoomOut}
          disabled={scale <= MIN_SCALE}
          title="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="min-w-[3rem] text-center text-sm text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={zoomIn}
          disabled={scale >= MAX_SCALE}
          title="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
      </div>

      <div
        ref={containerRef}
        role="region"
        aria-label="PDF preview"
        className="flex-1 min-h-0 overflow-auto bg-muted/20 p-4"
      >
        {docError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-destructive">
            <AlertCircle className="h-8 w-8" />
            <p>{docError}</p>
          </div>
        ) : (
          // Keying on `url` forces a full remount on document change instead
          // of reusing this instance — react-pdf/pdfjs cancels the outgoing
          // load on unmount, so a slow load for the previous file can never
          // resolve into state that belongs to the new one.
          <Document
            key={url}
            file={file}
            options={PDF_OPTIONS}
            onLoadSuccess={handleLoadSuccess}
            onLoadError={handleLoadError}
            loading={
              <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            }
          >
            {numPages !== null && (
              <div className="flex w-full flex-col items-center gap-4">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
                  const slotAspectRatio = pageAspectRatiosRef.current.get(n) ?? aspectRatio;
                  const slotHeight = pageWidth ? pageWidth * slotAspectRatio : undefined;
                  return (
                    <div
                      key={n}
                      data-page-number={n}
                      ref={(el) => setPageWrapperRef(n, el)}
                      style={{ width: pageWidth, minHeight: slotHeight }}
                      className="shadow-sm"
                    >
                      {failedPages.has(n) ? (
                        <div
                          style={{ height: slotHeight }}
                          className="flex w-full flex-col items-center justify-center gap-2 border bg-background text-destructive"
                        >
                          <AlertCircle className="h-6 w-6" />
                          <p className="text-sm">Failed to render page {n}</p>
                        </div>
                      ) : renderSet.has(n) && pageWidth !== undefined ? (
                        <Page
                          pageNumber={n}
                          width={pageWidth}
                          renderAnnotationLayer={false}
                          customTextRenderer={customTextRenderer}
                          onLoadSuccess={(page) => handlePageLoadSuccess(n, page)}
                          onLoadError={() => handlePageError(n)}
                          loading={
                            <div
                              style={{ height: slotHeight }}
                              className="flex w-full items-center justify-center"
                            >
                              <Loader2 className="h-6 w-6 animate-spin text-primary" />
                            </div>
                          }
                        />
                      ) : renderSet.has(n) ? (
                        <div style={{ height: slotHeight }} className="flex w-full items-center justify-center">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        </div>
                      ) : (
                        <div style={{ height: slotHeight }} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Document>
        )}
      </div>
    </div>
  );
}

export default memo(PdfViewer);
