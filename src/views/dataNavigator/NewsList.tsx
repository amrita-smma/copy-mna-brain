'use client';

import { useEffect, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Languages } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { languageLabel } from '@/lib/languageNames';
import { CATEGORY_LABELS } from './FilterBar';
import { displaySummary, displayTitle, hasTranslation } from './translation';
import type { NewsItem } from '@/lib/api/dataNavigator';

interface NewsListProps {
  items: NewsItem[];
  selectedId: string | null;
  loading: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}

export function NewsList({
  items,
  selectedId,
  loading,
  hasMore,
  onSelect,
  onLoadMore,
}: NewsListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Arrow-key selection lives on a window listener in the parent view, so
  // nothing moves the scroller on its own. With compact rows the next item was
  // usually already on screen; cards are tall enough that it often isn't, which
  // left the highlight off-screen while the preview silently changed.
  // `block: 'nearest'` makes this a no-op when the row is already visible, so a
  // plain mouse click never yanks the list around.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!loading && items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
        No news matches these filters.
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="News items" className="flex flex-col gap-2">
      {items.map((item) => {
        // The list always shows English: someone scanning the feed can't read
        // a Japanese headline, and there is no room for a per-card toggle.
        // The reading pane is where the original is one click away.
        const translated = hasTranslation(item);
        const original = translated ? languageLabel(item.language) : null;
        const summary = displaySummary(item);
        return (
          <button
            key={item.id}
            ref={item.id === selectedId ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={item.id === selectedId}
            onClick={() => onSelect(item.id)}
            className={cn(
              // Same shape as `Card`, but as a real <button> so the row keeps
              // its listbox option semantics and keyboard focus behaviour.
              // `bg-card` is an opaque token — the shell renders a living
              // background behind the console, and a translucent row would let
              // it bleed through the text.
              'w-full rounded-lg border bg-card px-4 py-3 text-left text-card-foreground shadow-sm',
              'transition-colors hover:bg-muted',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              item.id === selectedId && 'border-primary/60 bg-card ring-1 ring-primary/40 hover:bg-card',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-muted-foreground">
                {item.source_name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.published_at
                  ? formatDistanceToNow(new Date(item.published_at), { addSuffix: true })
                  : 'undated'}
              </span>
            </div>
            <div data-testid="news-item-title" className="mt-1 line-clamp-2 text-sm font-medium">
              {displayTitle(item)}
            </div>
            {summary && (
              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{summary}</div>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <Badge
                variant="secondary"
                className="px-2 py-0 text-[10px] font-medium uppercase tracking-wide"
              >
                {CATEGORY_LABELS[item.category] ?? item.category}
              </Badge>
              {item.relevance === 'selected' && (
                <Badge variant="outline" className="border-primary/40 px-2 py-0 text-[10px] font-medium text-primary">
                  Curated
                </Badge>
              )}
              {translated && (
                // Says the headline above is machine-translated, and from what.
                // `original` is null only if the row somehow lacks a language
                // code, in which case the icon alone still flags the item.
                <Badge
                  data-testid="news-item-translated"
                  variant="outline"
                  className="gap-1 px-2 py-0 text-[10px] font-medium text-muted-foreground"
                  title={original ? `Machine-translated from ${original}` : 'Machine-translated'}
                >
                  <Languages className="h-2.5 w-2.5" aria-hidden="true" />
                  {original ?? 'Translated'}
                </Badge>
              )}
            </div>
          </button>
        );
      })}

      <div ref={sentinelRef} data-testid="news-list-sentinel" className="h-8" />
      {loading && (
        <div className="rounded-lg border bg-card p-3 text-center text-xs text-muted-foreground shadow-sm">
          Loading…
        </div>
      )}
    </div>
  );
}
