'use client';

import { useEffect, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS } from './FilterBar';
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
      <div className="p-8 text-center text-sm text-muted-foreground">
        No news matches these filters.
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="News items" className="divide-y">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={item.id === selectedId}
          onClick={() => onSelect(item.id)}
          className={cn(
            'w-full px-4 py-3 text-left transition-colors hover:bg-muted/60',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            item.id === selectedId && 'bg-muted',
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
          <div data-testid="news-item-title" className="mt-0.5 line-clamp-2 text-sm font-medium">
            {item.title}
          </div>
          {item.summary && (
            <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.summary}</div>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[item.category] ?? item.category}
            </span>
            {item.relevance === 'selected' && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                Curated
              </span>
            )}
          </div>
        </button>
      ))}

      <div ref={sentinelRef} data-testid="news-list-sentinel" className="h-8" />
      {loading && (
        <div className="p-4 text-center text-xs text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}
