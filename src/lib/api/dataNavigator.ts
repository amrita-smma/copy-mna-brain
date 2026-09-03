import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';
import type {
  FilterOptions,
  ItemPage,
  NewsSearchHit,
} from '@/lib/services/dataNavigatorService';

export type NewsItem = ItemPage['items'][number];
export type NewsItemDetail = Tables<'rss_items'>;
export type { FilterOptions, NewsSearchHit };

export interface NewsListParams {
  categories?: string[];
  sources?: string[];
  regions?: string[];
  from?: string;
  to?: string;
  selectedOnly?: boolean;
  limit?: number;
  cursor?: { publishedAt: string | null; id: string } | null;
}

export function listNewsItems(params: NewsListParams = {}): Promise<ItemPage> {
  const search = new URLSearchParams();
  if (params.categories?.length) search.set('category', params.categories.join(','));
  if (params.sources?.length) search.set('source', params.sources.join(','));
  if (params.regions?.length) search.set('region', params.regions.join(','));
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.selectedOnly) search.set('selectedOnly', 'true');
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) {
    search.set('cursorId', params.cursor.id);
    if (params.cursor.publishedAt) search.set('cursorPublishedAt', params.cursor.publishedAt);
  }

  const qs = search.toString();
  return apiRequest<ItemPage>(`/api/data-navigator/items${qs ? `?${qs}` : ''}`);
}

export function getNewsItem(id: string): Promise<NewsItemDetail> {
  return apiRequest<NewsItemDetail>(`/api/data-navigator/items/${id}`);
}

export function searchNews(
  query: string,
  params: { topK?: number; categories?: string[]; from?: string; selectedOnly?: boolean } = {},
): Promise<NewsSearchHit[]> {
  const search = new URLSearchParams({ q: query });
  if (params.topK) search.set('topK', String(params.topK));
  if (params.categories?.length) search.set('category', params.categories.join(','));
  if (params.from) search.set('from', params.from);
  if (params.selectedOnly) search.set('selectedOnly', 'true');
  return apiRequest<NewsSearchHit[]>(`/api/data-navigator/search?${search.toString()}`);
}

export function listNewsFilterOptions(): Promise<FilterOptions> {
  return apiRequest<FilterOptions>('/api/data-navigator/filters');
}
