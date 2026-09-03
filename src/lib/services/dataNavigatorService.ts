import type { BedrockEmbeddingClient } from '@/lib/bedrock';
import type { RssCategory, RssRelevance, RssTranslationStatus } from '@/lib/db/schema';
import { clampLimit } from '@/lib/repositories';
import type {
  RssItemChunkRepository,
  RssItemCursor,
  RssItemFilters,
  RssItemListRow,
  RssItemRepository,
  Tables,
} from '@/lib/repositories';

export class RssItemNotFoundError extends Error {
  constructor(id: string) {
    super(`News item ${id} not found`);
    this.name = 'RssItemNotFoundError';
  }
}

export interface SearchOptions {
  topK?: number;
  categories?: RssItemFilters['categories'];
  from?: string;
  /** Restrict to LLM-selected items (the curated ~75/day) — see `RssItemFilters`. */
  selectedOnly?: boolean;
}

export interface NewsSearchHit {
  id: string;
  /**
   * Display headline: the English translation when the item has one, else the
   * original. A search result list has no room for both, and an untranslated
   * foreign headline is unreadable to the reader who typed an English query.
   * `language` / `translation_status` below say which one this is.
   */
  title: string;
  source_name: string;
  category: RssCategory;
  published_at: string | null;
  link: string;
  snippet: string;
  score: number;
  matchedBy: 'vector' | 'text' | 'both';
  /** The item's real curation state — never fabricated by the search merge. */
  relevance: RssRelevance;
  /** ISO 639-1 code of the item's ORIGINAL language, when it was detected. */
  language: string | null;
  translation_status: RssTranslationStatus;
}

export interface FilterOptions {
  categories: string[];
  sources: { name: string; category: string }[];
  regions: string[];
}

export interface ItemPage {
  items: RssItemListRow[];
  nextCursor: RssItemCursor | null;
}

const DEFAULT_TOP_K = 8;
/** Fixed relevance credit for a lexical hit, so exact title/author matches
 *  always surface even when they are semantically distant from the query. */
const TEXT_MATCH_SCORE = 0.6;

export class DataNavigatorService {
  constructor(
    private readonly itemRepo: RssItemRepository,
    private readonly chunkRepo: RssItemChunkRepository,
    private readonly embeddings: BedrockEmbeddingClient,
  ) {}

  async listItems(filters: RssItemFilters = {}): Promise<ItemPage> {
    const items = await this.itemRepo.listItems(filters);
    // The repository silently clamps an oversized `limit` to MAX_PAGE_SIZE
    // before applying it, so "did we get a full page" must compare against
    // that EFFECTIVE limit — comparing against the raw requested limit would
    // make every page look short whenever a caller asks for more than the
    // cap, silently stranding the remaining rows with no cursor and no error.
    const effectiveLimit = clampLimit(filters.limit);
    // A short page means we reached the end; only a full page can have more.
    const last = items.length === effectiveLimit ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? { publishedAt: last.published_at, id: last.id } : null,
    };
  }

  async getItem(id: string): Promise<Tables<'rss_items'>> {
    const item = await this.itemRepo.findById(id);
    if (!item) throw new RssItemNotFoundError(id);
    return item;
  }

  /**
   * Hybrid search: semantic (pgvector) plus lexical (trigram ILIKE), merged.
   *
   * Both halves run because they fail differently — embeddings miss an exact
   * surname or ticker, ILIKE misses a paraphrase. Each hit's score is the sum
   * of the credit it earns from every half that matched it (vector: a 0..1
   * cosine similarity; text: a flat `TEXT_MATCH_SCORE`), so a both-match
   * generally outranks a single-half match — but not unconditionally: a
   * near-exact vector match (similarity ~1.0) can still outscore a weak
   * both-match (e.g. similarity 0.1 + TEXT_MATCH_SCORE), which is fine since
   * a very close semantic match arguably should win. Either half can also
   * fail independently — a Bedrock outage or a Postgres error — without
   * taking the other down, so search degrades rather than breaks.
   */
  async searchNews(query: string, opts: SearchOptions = {}): Promise<NewsSearchHit[]> {
    const term = query.trim();
    if (term.length === 0) return [];

    const topK = opts.topK ?? DEFAULT_TOP_K;
    const filters: RssItemFilters = {
      categories: opts.categories,
      from: opts.from,
      selectedOnly: opts.selectedOnly,
    };

    const [vectorHits, textHits] = await Promise.all([
      this.vectorHalf(term, topK, filters),
      this.lexicalHalf(term, topK, filters),
    ]);

    const scores = new Map<
      string,
      { score: number; snippet?: string; vector: boolean; text: boolean }
    >();

    for (const hit of vectorHits) {
      // Cosine distance 0..2 → similarity 0..1.
      const similarity = Math.max(0, 1 - hit.distance);
      scores.set(hit.item_id, {
        score: similarity,
        snippet: hit.chunk_text,
        vector: true,
        text: false,
      });
    }
    for (const item of textHits) {
      const existing = scores.get(item.id);
      if (existing) {
        existing.text = true;
        existing.score += TEXT_MATCH_SCORE;
      } else {
        scores.set(item.id, { score: TEXT_MATCH_SCORE, vector: false, text: true });
      }
    }

    if (scores.size === 0) return [];

    // One batched hydrate for every hit — never a lookup per hit.
    const rows = await this.itemRepo.findByIds([...scores.keys()]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return [...scores.entries()]
      .map(([id, entry]) => {
        const row = byId.get(id);
        if (!row) return null;
        return {
          id: row.id,
          // English when we have it — see `NewsSearchHit.title`.
          title: row.title_en ?? row.title,
          source_name: row.source_name,
          category: row.category,
          published_at: row.published_at,
          link: row.link,
          // A vector snippet is already English: the enrich pipeline embeds
          // the translated text precisely so these chunks are searchable and
          // readable. The summary fallback has to pick the English rendering
          // itself.
          snippet: (entry.snippet ?? row.summary_en ?? row.summary ?? '').slice(0, 400),
          score: Number(entry.score.toFixed(4)),
          matchedBy: (entry.vector && entry.text
            ? 'both'
            : entry.vector
              ? 'vector'
              : 'text') as NewsSearchHit['matchedBy'],
          // The row's real curation state — never fabricated by the caller.
          relevance: row.relevance,
          language: row.language,
          translation_status: row.translation_status,
        };
      })
      .filter((hit): hit is NewsSearchHit => hit !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async listFilterOptions(): Promise<FilterOptions> {
    const facets = await this.itemRepo.listFilterOptions();
    const categories = new Set<string>();
    const regions = new Set<string>();
    const sources: { name: string; category: string }[] = [];

    for (const facet of facets) {
      categories.add(facet.category);
      if (facet.region) regions.add(facet.region);
      sources.push({ name: facet.source_name, category: facet.category });
    }

    return {
      categories: [...categories].sort(),
      sources,
      regions: [...regions].sort(),
    };
  }

  /** Vector half, isolated so a Bedrock outage can't take search down. */
  private async vectorHalf(
    term: string,
    topK: number,
    filters: RssItemFilters,
  ): Promise<{ item_id: string; chunk_text: string; distance: number }[]> {
    try {
      const embedding = await this.embeddings.embed(term);
      return await this.chunkRepo.vectorSearch(embedding, topK, filters);
    } catch (err) {
      console.error('[data-navigator] vector search unavailable:', err);
      return [];
    }
  }

  /** Lexical half, isolated so a Postgres outage can't take search down. */
  private async lexicalHalf(
    term: string,
    topK: number,
    filters: RssItemFilters,
  ): Promise<RssItemListRow[]> {
    try {
      return await this.itemRepo.textSearch(term, filters, topK);
    } catch (err) {
      console.error('[data-navigator] lexical search unavailable:', err);
      return [];
    }
  }
}
