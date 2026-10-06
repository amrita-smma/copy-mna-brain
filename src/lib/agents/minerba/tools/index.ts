/**
 * @minerba's tool set: the sector core (sector/coreTools.ts) plus these
 * read-only extras, in both roles.
 *
 *   - get_regulatory_context — the regulatory watchlist (UU 2/2025, PP 19/2025,
 *     Permen ESDM 17/2025 …) is the heart of a monthly refresh.
 *   - get_market_signals — licence, quota and ownership moves in the cohort.
 *   - get_company_profile — ownership and management of a licence holder (the
 *     control layer).
 *   - get_sector_context — commodity price and royalty-basis context.
 *   - valyu_extract_content — pull facts from IDX filings, EITI and AHU pages
 *     found by search.
 *   - read_relationship_graph — ownership chains already recorded internally
 *     (control layer: ownership chain depth, related-party offtake).
 *   - inven_paid_data_source_search / inven_paid_data_source_enrichment —
 *     premium data, granted for now while the public sources stay thin:
 *     firmographics (headcount, revenue estimate, ownership) for unlisted
 *     holders and operators. Valyu comes with the core.
 */
import {
  getCompanyProfile,
  getMarketSignals,
  getRegulatoryContext,
  getSectorContext,
  readRelationshipGraph,
  valyuExtractContent,
} from '@/lib/agents/analysis/tools';
import { invenPaidDataSourceEnrichment } from '@/lib/agents/analysis/tools/inven_paid_data_source_enrichment';
import { invenPaidDataSourceSearch } from '@/lib/agents/analysis/tools/inven_paid_data_source_search';
import { composeSectorTools } from '@/lib/agents/sector/coreTools';

export const MINERBA_EXTRA_TOOLS = [
  getRegulatoryContext,
  getMarketSignals,
  getCompanyProfile,
  getSectorContext,
  valyuExtractContent,
  readRelationshipGraph,
  invenPaidDataSourceSearch,
  invenPaidDataSourceEnrichment,
];

export const MINERBA_TOOLS = composeSectorTools(MINERBA_EXTRA_TOOLS);
