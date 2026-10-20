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
 *   - Valyu (premium search) comes with the core.
 */
import {
  getCompanyProfile,
  getMarketSignals,
  getRegulatoryContext,
  getSectorContext,
  readRelationshipGraph,
  valyuExtractContent,
} from '@/lib/agents/analysis/tools';
import { composeSectorTools } from '@/lib/agents/sector/coreTools';

export const MINERBA_EXTRA_TOOLS = [
  getRegulatoryContext,
  getMarketSignals,
  getCompanyProfile,
  getSectorContext,
  valyuExtractContent,
  readRelationshipGraph,
];

export const MINERBA_TOOLS = composeSectorTools(MINERBA_EXTRA_TOOLS);
