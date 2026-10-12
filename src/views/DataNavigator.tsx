'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as newsApi from '@/lib/api/dataNavigator';
import type { FilterOptions, NewsItem, NewsItemDetail } from '@/lib/api/dataNavigator';
import { FilterBar, type FilterState } from './dataNavigator/FilterBar';
import { NewsList } from './dataNavigator/NewsList';
import { NewsPreview } from './dataNavigator/NewsPreview';
import { sortByPublishedDesc } from './dataNavigator/sortByTime';
import { PageHeader } from '@/components/layout/PageHeader';

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
            // A hit carries only ONE headline, and the service already
            // resolved it to the English rendering server-side. So `title` and
            // `title_en` are deliberately the same string here: the original
            // is simply not part of a search result. Setting `*_en` (rather
            // than leaving them null) is what lets `hasTranslation` recognise
            // the item and badge the card — the search list has no toggle, so
            // there is nothing for the duplication to get wrong.
            language: hit.language,
            translation_status: hit.translation_status,
            title_en: hit.translation_status === 'translated' ? hit.title : null,
            summary_en: hit.translation_status === 'translated' ? hit.snippet : null,
          }),
        );
        // Relevance picked the hits; recency orders them for reading.
        const ordered = sortByPublishedDesc(asItems);
        setItems(ordered);
        setCursor(null);
        setHasMore(false);
        setSelectedId(ordered[0]?.id ?? null);
        return;
      }

      const page = await newsApi.listNewsItems(listParams);
      if (requestIdRef.current !== requestId) return; // superseded — drop it
      // Auto-select from the SAME ordering the list renders. The feed query
      // already returns published_at DESC NULLS LAST, so this normally agrees
      // with page.items[0] — but selecting off the raw array would silently
      // desync the highlighted row from the first visible row the moment the
      // two orderings disagreed. `nextCursor` still comes from the server's
      // own last row, so paging is unaffected.
      const ordered = sortByPublishedDesc(page.items);
      setItems(ordered);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setSelectedId(ordered[0]?.id ?? null);
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

  // Whatever produced `items` — feed page, appended page, or a search — the
  // rendered list is always newest first.
  const sortedItems = useMemo(() => sortByPublishedDesc(items), [items]);

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

      const index = sortedItems.findIndex((item) => item.id === selectedId);
      if (index === -1) return;
      const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      const next = sortedItems[nextIndex];
      if (!next) return;
      event.preventDefault();
      setSelectedId(next.id);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sortedItems, selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        className="shrink-0"
        title="Data Navigator"
        subtitle="Curated market news and industry coverage, newest first"
      />

      <div className="flex min-h-0 flex-1 gap-5 px-6 pb-6 lg:px-8 lg:pb-8">
        <aside className="flex min-h-0 w-[380px] shrink-0 flex-col gap-3">
          <FilterBar options={options ?? null} value={filters} onChange={setFilters} />
          {/* The scroll container owns the padding so card shadows/rings are
              not clipped at the edges of the overflow box. */}
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
            <NewsList
              items={sortedItems}
              selectedId={selectedId}
              loading={listLoading}
              hasMore={hasMore}
              onSelect={setSelectedId}
              onLoadMore={loadMore}
            />
          </div>
        </aside>

        <main className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          <NewsPreview item={selectedItem ?? null} loading={previewLoading && selectedId !== null} />
        </main>
      </div>
    </div>
  );
}
