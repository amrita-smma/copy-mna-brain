'use client';

import { useEffect, useState } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { InsightFrame } from './InsightFrame';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { HtmlPreviewCache } from '@/lib/insights/lruCache';

const PREVIEW_WIDTH = 380;
const PREVIEW_HEIGHT = 240;
// The frame is rendered at a realistic document width, then scaled down —
// this reads as a thumbnail of the real page, instead of the same content
// cramped and reflowed into a 380px-wide column.
const RENDER_WIDTH = 1000;
const SCALE = PREVIEW_WIDTH / RENDER_WIDTH;
const RENDER_HEIGHT = PREVIEW_HEIGHT / SCALE;

interface PreviewBodyProps {
  id: string;
  cacheKey: string;
  title: string;
  fetchHtml: (id: string) => Promise<string>;
  cache: HtmlPreviewCache;
}

/**
 * Mounted only while the hover card is open (no `forceMount`), so mounting
 * IS the hover-intent signal — no separate debounce timer needed here, that
 * comes from `HoverCard`'s own `openDelay`.
 */
function PreviewBody({ id, cacheKey, title, fetchHtml, cache }: PreviewBodyProps) {
  const [html, setHtml] = useState<string | null>(() => cache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (html !== null) return;
    let cancelled = false;
    fetchHtml(id)
      .then((fetched) => {
        if (cancelled) return;
        cache.set(cacheKey, fetched);
        setHtml(fetched);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Runs once per mount (i.e. once per hover) against the id it opened
    // with — re-running on cache/fetchHtml identity churn is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (html !== null) {
    return (
      <div
        style={{
          width: RENDER_WIDTH,
          height: RENDER_HEIGHT,
          transform: `scale(${SCALE})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      >
        <InsightFrame
          html={html}
          title={title}
          minHeight={RENDER_HEIGHT}
          maxHeight={RENDER_HEIGHT}
        />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
        <AlertTriangle className="h-4 w-4" />
        <span className="text-xs">Preview unavailable</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export interface HtmlHoverPreviewProps {
  id: string;
  /** Cache key when `id` alone can go stale — e.g. id + version for an insight
   *  whose HTML changes on publish. Defaults to `id`. */
  cacheKey?: string;
  title: string;
  fetchHtml: (id: string) => Promise<string>;
  cache: HtmlPreviewCache;
  children: React.ReactNode;
}

/**
 * Wraps `children` (an insight/template list row) with a hover-triggered
 * thumbnail preview of its HTML. Cheap by construction: the preview only
 * fetches after `openDelay`, only once per id per cache lifetime (`cache`
 * is a bounded LRU shared by the caller across rows), and renders through
 * `InsightFrame` — the same sandboxed, non-interactive iframe used
 * everywhere else insight/template HTML is shown.
 */
export function HtmlHoverPreview({
  id,
  cacheKey = id,
  title,
  fetchHtml,
  cache,
  children,
}: HtmlHoverPreviewProps) {
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-auto p-0 overflow-hidden bg-card border border-border shadow-lg"
        style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
      >
        <PreviewBody
          id={id}
          cacheKey={cacheKey}
          title={title}
          fetchHtml={fetchHtml}
          cache={cache}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
