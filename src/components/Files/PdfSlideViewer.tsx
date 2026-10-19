'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Document, Page, type DocumentProps, type PageProps } from 'react-pdf';
import { AlertCircle, ChevronLeft, ChevronRight, GalleryHorizontal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PDF_OPTIONS } from '@/components/Files/pdfjsSetup';
import {
  clampPage,
  clickToStep,
  fitPageWidth,
  initialWheelState,
  keyToSlideAction,
  reduceWheel,
} from '@/components/Files/pdfSlideNavigation';

type PdfDocumentProxy = NonNullable<Parameters<NonNullable<DocumentProps['onLoadSuccess']>>[0]>;
type PdfPageProxy = Parameters<NonNullable<PageProps['onLoadSuccess']>>[0];

// Used until the first page reports its real dimensions.
const FALLBACK_ASPECT_RATIO = 0.5625;
// Breathing room between the slide and the stage edges.
const STAGE_PADDING_PX = 24;
const THUMBNAIL_WIDTH_PX = 128;
// The thumbnail frame's border, per side (Tailwind `border-2`).
const THUMBNAIL_BORDER_PX = 2;

const NAV_ARROW_CLASS =
  'absolute top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-foreground opacity-0 shadow transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:!opacity-0';

interface PdfSlideViewerProps {
  url: string;
  className?: string;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest('input, textarea, select');
  if (field instanceof HTMLElement) return true;
  const editable = target.closest('[contenteditable=""], [contenteditable="true"]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('button, a, [role="button"]');
}

/** Keys should not be stolen from portaled UI sitting above the viewer. */
function shouldYieldKeysToOverlay(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element) || root.contains(target)) return false;
  return !!target.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
}

/**
 * Shows a PDF the way PowerPoint shows a deck: one page per slide, fitted to
 * the stage, with a thumbnail filmstrip. Navigate with ←/→ (and the other
 * slideshow keys), the scroll wheel or a trackpad swipe, or by clicking the
 * slide — the left edge goes back, anywhere else advances.
 *
 * Only the current slide and its two neighbours mount a canvas (the
 * neighbours hidden, so the next turn is instant); thumbnails mount lazily as
 * the filmstrip scrolls them into view. The parent keys this component on
 * `url`, so a new document always starts on slide 1.
 */
function PdfSlideViewer({ url, className }: PdfSlideViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [aspectRatios, setAspectRatios] = useState<Record<number, number>>({});
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const [showThumbnails, setShowThumbnails] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const filmstripRef = useRef<HTMLDivElement>(null);
  const numPagesRef = useRef<number | null>(null);
  const wheelStateRef = useRef(initialWheelState());

  // react-pdf reparses the whole document whenever `file` changes identity.
  const file = useMemo(() => ({ url }), [url]);

  const goTo = useCallback((page: number) => {
    const total = numPagesRef.current;
    if (!total) return;
    setCurrentPage(clampPage(page, total));
  }, []);

  const step = useCallback((delta: -1 | 1) => {
    const total = numPagesRef.current;
    if (!total) return;
    setCurrentPage((p) => clampPage(p + delta, total));
  }, []);

  const handleLoadSuccess = useCallback((pdf: PdfDocumentProxy) => {
    if (pdf.numPages < 1) {
      setDocError('This PDF has no pages');
      return;
    }
    numPagesRef.current = pdf.numPages;
    setNumPages(pdf.numPages);
  }, []);

  const handleLoadError = useCallback((err: Error) => {
    console.error('Failed to load PDF:', err);
    setDocError('Failed to load PDF preview');
  }, []);

  const handlePageLoadSuccess = useCallback((pageNumber: number, page: PdfPageProxy) => {
    const ratio = page.originalHeight / page.originalWidth;
    setAspectRatios((prev) => (prev[pageNumber] === ratio ? prev : { ...prev, [pageNumber]: ratio }));
  }, []);

  const handlePageError = useCallback((pageNumber: number) => {
    console.error(`Failed to render PDF page ${pageNumber}`);
    setFailedPages((prev) => (prev.has(pageNumber) ? prev : new Set(prev).add(pageNumber)));
  }, []);

  // Track the stage size so the slide is fitted on both axes, including when
  // the overlay enters fullscreen or the sidebar animates.
  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageEl]);

  // Keyboard navigation is window-level so it works without first clicking
  // into the viewer. The Presentation overlay stays mounted (display: none)
  // on other routes, so ignore keys whenever the viewer isn't on screen.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0) return;
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
      // Let Enter/Space activate a focused button instead of also turning a slide.
      if ((event.key === 'Enter' || event.key === ' ') && isActivatableTarget(event.target)) return;
      if (shouldYieldKeysToOverlay(event.target, root) || shouldYieldKeysToOverlay(document.activeElement, root)) {
        return;
      }

      const action = keyToSlideAction(event.key, event.shiftKey);
      if (!action) return;
      event.preventDefault();
      if (action.type === 'step') step(action.step);
      else if (action.type === 'first') goTo(1);
      else goTo(numPagesRef.current ?? 1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goTo, step]);

  // Wheel/trackpad turns slides on the stage only (the filmstrip keeps its
  // own native scroll). Registered natively because React's onWheel is
  // passive and can't preventDefault the page scroll.
  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    const handleWheel = (event: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel; leave it to the browser.
      if (event.ctrlKey) return;
      event.preventDefault();
      const result = reduceWheel(wheelStateRef.current, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        now: event.timeStamp,
      });
      wheelStateRef.current = result.state;
      if (result.step !== 0) step(result.step);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [stageEl, step]);

  const handleStageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (isActivatableTarget(event.target)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      step(clickToStep(event.clientX - rect.left, rect.width));
    },
    [step],
  );

  // Keep the active thumbnail visible as the deck advances.
  useEffect(() => {
    if (!showThumbnails) return;
    const thumb = filmstripRef.current?.querySelector<HTMLElement>(`[data-thumbnail="${currentPage}"]`);
    thumb?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [currentPage, showThumbnails]);

  const defaultRatio = aspectRatios[1] ?? FALLBACK_ASPECT_RATIO;
  const ratioFor = (n: number) => aspectRatios[n] ?? defaultRatio;
  const widthFor = (n: number) =>
    stageSize
      ? fitPageWidth(stageSize.width - STAGE_PADDING_PX * 2, stageSize.height - STAGE_PADDING_PX * 2, ratioFor(n))
      : undefined;

  const mountedPages = numPages
    ? [currentPage - 1, currentPage, currentPage + 1].filter((n) => n >= 1 && n <= numPages)
    : [];

  return (
    <div ref={rootRef} className={cn('flex h-full w-full flex-col bg-background', className)}>
      {docError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-muted text-destructive">
          <AlertCircle className="h-8 w-8" />
          <p>{docError}</p>
        </div>
      ) : (
        // One Document feeds both the stage and the filmstrip, so the file
        // is downloaded and parsed once.
        <Document
          file={file}
          options={PDF_OPTIONS}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          className="flex min-h-0 flex-1 flex-col"
          loading={
            <div className="flex min-h-0 flex-1 items-center justify-center bg-muted">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          }
        >
          <div
            ref={setStageEl}
            role="region"
            aria-label="PDF slides"
            aria-roledescription="slideshow"
            onClick={handleStageClick}
            className="group relative min-h-0 flex-1 cursor-pointer select-none overflow-hidden bg-muted"
          >
            {mountedPages.map((n) => {
              const width = widthFor(n);
              const isCurrent = n === currentPage;
              const height = width !== undefined ? width * ratioFor(n) : undefined;
              return (
                <div
                  key={n}
                  aria-hidden={!isCurrent}
                  aria-label={isCurrent ? `Slide ${n} of ${numPages}` : undefined}
                  className={cn(
                    'absolute inset-0 flex items-center justify-center',
                    !isCurrent && 'invisible',
                  )}
                >
                  {failedPages.has(n) ? (
                    <div
                      style={{ width, height }}
                      className="flex flex-col items-center justify-center gap-2 bg-background text-destructive shadow-lg"
                    >
                      <AlertCircle className="h-6 w-6" />
                      <p className="text-sm">Failed to render slide {n}</p>
                    </div>
                  ) : width !== undefined ? (
                    <div className="bg-background shadow-lg">
                      <Page
                        pageNumber={n}
                        width={width}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        onLoadSuccess={(page) => handlePageLoadSuccess(n, page)}
                        onLoadError={() => handlePageError(n)}
                        loading={
                          <div style={{ width, height }} className="flex items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          </div>
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}

            {numPages !== null && (
              <>
                <button
                  type="button"
                  aria-label="Previous slide"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(-1);
                  }}
                  disabled={currentPage <= 1}
                  className={NAV_ARROW_CLASS + ' left-3'}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next slide"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(1);
                  }}
                  disabled={currentPage >= numPages}
                  className={NAV_ARROW_CLASS + ' right-3'}
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>

          {numPages !== null && showThumbnails && (
            <div
              ref={filmstripRef}
              aria-label="Slide thumbnails"
              className="flex flex-shrink-0 gap-3 overflow-x-auto border-t bg-background px-4 py-3"
            >
              {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                <SlideThumbnail
                  key={n}
                  pageNumber={n}
                  aspectRatio={ratioFor(n)}
                  active={n === currentPage}
                  rootRef={filmstripRef}
                  onSelect={goTo}
                />
              ))}
            </div>
          )}
        </Document>
      )}

      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t bg-background px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-[8.5rem] justify-start gap-1.5"
          onClick={() => setShowThumbnails((v) => !v)}
          disabled={numPages === null}
          aria-pressed={showThumbnails}
        >
          <GalleryHorizontal className="h-4 w-4" />
          {showThumbnails ? 'Hide slides' : 'Show slides'}
        </Button>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => step(-1)}
            disabled={numPages === null || currentPage <= 1}
            title="Previous slide (←)"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[5.5rem] text-center text-sm tabular-nums text-muted-foreground" aria-live="polite">
            {numPages !== null ? `${currentPage} / ${numPages}` : '\u00a0'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => step(1)}
            disabled={numPages === null || currentPage >= numPages}
            title="Next slide (→)"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {/* Balances the thumbnails toggle so the pager stays centred. */}
        <span className="w-[8.5rem]" aria-hidden />
      </div>
    </div>
  );
}

interface SlideThumbnailProps {
  pageNumber: number;
  aspectRatio: number;
  active: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  onSelect: (page: number) => void;
}

/** A filmstrip entry that only mounts its canvas once scrolled near view. */
const SlideThumbnail = memo(function SlideThumbnail({
  pageNumber,
  aspectRatio,
  active,
  rootRef,
  onSelect,
}: SlideThumbnailProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: rootRef.current, rootMargin: '0px 400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef, visible]);

  const innerWidth = THUMBNAIL_WIDTH_PX - THUMBNAIL_BORDER_PX * 2;
  const height = Math.round(innerWidth * aspectRatio) + THUMBNAIL_BORDER_PX * 2;

  return (
    <button
      ref={ref}
      type="button"
      data-thumbnail={pageNumber}
      onClick={() => onSelect(pageNumber)}
      aria-label={`Go to slide ${pageNumber}`}
      aria-current={active ? 'true' : undefined}
      className="flex flex-shrink-0 flex-col items-center gap-1 focus-visible:outline-none"
    >
      <span
        style={{ width: THUMBNAIL_WIDTH_PX, height }}
        className={cn(
          'block overflow-hidden rounded-sm border-2 bg-card transition-colors',
          active ? 'border-primary' : 'border-transparent hover:border-muted-foreground/40',
        )}
      >
        {visible && (
          <Page
            pageNumber={pageNumber}
            width={innerWidth}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={null}
            error={null}
          />
        )}
      </span>
      <span className={cn('text-xs tabular-nums', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {pageNumber}
      </span>
    </button>
  );
});

export default memo(PdfSlideViewer);
