'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as newsApi from '@/lib/api/dataNavigator';
import type { FilterOptions, NewsItem, NewsItemDetail } from '@/lib/api/dataNavigator';
import { FilterBar, type FilterState } from './dataNavigator/FilterBar';
import { NewsList } from './dataNavigator/NewsList';
import { NewsPreview } from './dataNavigator/NewsPreview';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export default function DataNavigator() {
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    regions: [],
    query: '',
    selectedOnly: false,
  });
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<NewsItem[]>([]);
  const [cursor, setCursor] = useState<{ publishedAt: string | null; id: string } | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Guards against a slower, earlier fetch (previous keystroke/filter set)
  // resolving after a faster, later one and clobbering fresher state.
  // `loadFirstPage` and `loadMore` share this counter: whichever call bumps
  // it last is the only one allowed to write to state when it resolves.
  // Bumped to NaN on unmount so any still-in-flight request's captured id
  // can never match again (NaN !== NaN), which suppresses a post-unmount
  // state update for free with the same mechanism.
  const requestIdRef = useRef(0);
  useEffect(() => {
    return () => {
      requestIdRef.current = Number.NaN;
    };
  }, []);

  // Search hits the network on every keystroke otherwise.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters.query]);

  const { data: options } = useQuery<FilterOptions>({
    queryKey: ['data-navigator', 'filters'],
    queryFn: newsApi.listNewsFilterOptions,
    staleTime: 5 * 60 * 1000,
  });

  const listParams = useMemo(
    () => ({
      categories: filters.categories.length > 0 ? filters.categories : undefined,
      regions: filters.regions.length > 0 ? filters.regions : undefined,
      selectedOnly: filters.selectedOnly,
      limit: PAGE_SIZE,
    }),
    [filters.categories, filters.regions, filters.selectedOnly],
  );

  const loadFirstPage = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setListLoading(true);
    try {
      if (debouncedQuery.length > 0) {
        // Search replaces the feed: hybrid results are ranked by relevance,
        // not recency, and are not paginated.
        const hits = await newsApi.searchNews(debouncedQuery, {
          topK: 30,
          categories: filters.categories.length > 0 ? filters.categories : undefined,
          selectedOnly: filters.selectedOnly,
        });
        if (requestIdRef.current !== requestId) return; // superseded — drop it

        const asItems = hits.map(
          (hit): NewsItem => ({
            id: hit.id,
            category: hit.category,
            source_name: hit.source_name,
            region: null,
            feed_tier: 'curated',
            title: hit.title,
            link: hit.link,
            summary: hit.snippet,
            authors: null,
            tags: null,
            published_at: hit.published_at,
            ingested_at: hit.published_at,
            // The hit's real curation state — never fabricated here.
            relevance: hit.relevance,
            relevance_score: hit.score,
            content_status: 'fetched',
          }),
        );
        setItems(asItems);
        setCursor(null);
        setHasMore(false);
        setSelectedId(asItems[0]?.id ?? null);
        return;
      }

      const page = await newsApi.listNewsItems(listParams);
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      setItems(page.items);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setSelectedId(page.items[0]?.id ?? null);
    } finally {
      if (requestIdRef.current === requestId) setListLoading(false);
    }
  }, [debouncedQuery, filters.categories, filters.selectedOnly, listParams]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor || listLoading) return;
    const requestId = ++requestIdRef.current;
    setListLoading(true);
    try {
      const page = await newsApi.listNewsItems({ ...listParams, cursor });
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } finally {
      if (requestIdRef.current === requestId) setListLoading(false);
    }
  }, [cursor, listLoading, listParams]);

  const { data: selectedItem, isLoading: previewLoading } = useQuery<NewsItemDetail | null>({
    queryKey: ['data-navigator', 'item', selectedId],
    queryFn: () => (selectedId ? newsApi.getNewsItem(selectedId) : Promise.resolve(null)),
    enabled: selectedId !== null,
  });

  // Arrow keys move through the list without leaving the reading pane.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      const index = items.findIndex((item) => item.id === selectedId);
      if (index === -1) return;
      const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      const next = items[nextIndex];
      if (!next) return;
      event.preventDefault();
      setSelectedId(next.id);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[380px] shrink-0 flex-col border-r">
        <FilterBar options={options ?? null} value={filters} onChange={setFilters} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NewsList
            items={items}
            selectedId={selectedId}
            loading={listLoading}
            hasMore={hasMore}
            onSelect={setSelectedId}
            onLoadMore={loadMore}
          />
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <NewsPreview item={selectedItem ?? null} loading={previewLoading && selectedId !== null} />
      </main>
    </div>
  );
}
