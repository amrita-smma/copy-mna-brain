import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { RssItemRepository, RssItemChunkRepository } from '@/lib/repositories';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { DataNavigatorService } from '@/lib/services/dataNavigatorService';
import { languageLabel } from '@/lib/languageNames';
import { RSS_CATEGORIES, type RssCategory } from '@/lib/db/schema';

/**
 * search_news — hybrid semantic + keyword search over the ingested news lake.
 *
 * Lets the agent answer "what has happened recently with X" from indexed
 * articles rather than from its training data. The lake is global (not
 * workspace-scoped), so the service is built straight from `createDb()`
 * instead of going through `createContainer`.
 */
const MAX_SNIPPET = 300;

export const searchNews = tool(
  async ({
    query,
    categories,
    publishedAfter,
    topK,
  }: {
    query: string;
    categories?: RssCategory[];
    publishedAfter?: string;
    topK?: number;
  }) => {
    logger.debug(`🔧 TOOL CALLED: search_news(query='${query ?? ''}')`);

    const term = query?.trim();
    if (!term) {
      return '**Error:** query is required (what to search the news lake for).';
    }

    try {
      const db = createDb();
      const service = new DataNavigatorService(
        new RssItemRepository(db),
        new RssItemChunkRepository(db),
        new BedrockEmbeddingClient(),
      );

      const hits = await service.searchNews(term, {
        topK: topK ?? 8,
        categories,
        from: publishedAfter,
        // The agent-facing lake is described to the model as "curated" — only
        // ever surface LLM-selected items here, never pending/rejected raw
        // intake. The UI keeps its own toggle; this default is agent-only.
        selectedOnly: true,
      });

      if (hits.length === 0) {
        return `No indexed news matched "${term}". The lake only holds items ingested from the configured RSS sources — try broader wording, an earlier \`publishedAfter\`, or no category filter.`;
      }

      const lines = hits.map((hit, index) => {
        const date = hit.published_at ? hit.published_at.slice(0, 10) : 'undated';
        const snippet = hit.snippet.replace(/\s+/g, ' ').slice(0, MAX_SNIPPET);
        // The service already hands back the English rendering for a
        // translated item, but the model should know the wording is
        // machine-produced before it quotes a figure from it verbatim.
        const provenance =
          hit.translation_status === 'translated'
            ? ` · machine-translated from ${languageLabel(hit.language) ?? 'the original'}`
            : '';
        return [
          `${index + 1}. **${hit.title}**`,
          `   ${hit.source_name} · ${hit.category} · ${date}${provenance}`,
          `   ${snippet}`,
          `   ${hit.link}`,
        ].join('\n');
      });

      return `**Indexed news matching "${term}" (${hits.length}):**\n\n${lines.join('\n\n')}`;
    } catch (error) {
      // Tools must return text — a thrown error aborts the whole agent turn.
      const message = (error as Error).message;
      logger.error(`search_news failed: ${message}`);
      return `**Error:** ${message}`;
    }
  },
  {
    name: 'search_news',
    description:
      'Search the curated market-news lake — only items an LLM screening pass has already selected as genuinely useful (funding rounds, M&A and partnerships, market assessments, expert insights, industry/analyst reports), by meaning and by keyword. Never surfaces pending or rejected raw intake. Use it for recent real-world events about specific companies, sectors or deals.',
    schema: z.object({
      query: z.string().describe('What to look for, in natural language.'),
      categories: z
        .array(z.enum(RSS_CATEGORIES))
        .optional()
        .describe('Restrict the search to these news categories.'),
      publishedAfter: z
        .string()
        .optional()
        .describe('ISO date (YYYY-MM-DD); only return items published on or after it.'),
      topK: z.number().int().min(1).max(20).optional().describe('How many results (default 8).'),
    }),
  },
);
