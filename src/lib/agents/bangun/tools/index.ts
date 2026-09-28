/**
 * @bangun's tool set: the sector core (sector/coreTools.ts) plus these
 * read-only extras, in both roles. Its phase layer comes from internal deal
 * history, which the core already reaches (query_companies, query_files).
 *
 *   - get_sector_context — property market sizing, absorption and pricing
 *     trends by tier.
 *   - get_competitor_landscape — positioning of the cohort developers against
 *     each other.
 *   - get_market_signals — launches, marketing-sales updates and policy rate
 *     moves (a rate move triggers a refresh).
 *   - valyu_extract_content — pull figures from developer filings and
 *     BoM/rates pages found by search.
 *   - search_investments / get_fund_asset_details — the cohort includes
 *     "internally held companies".
 */
import {
  getCompetitorLandscape,
  getFundAssetDetails,
  getMarketSignals,
  getSectorContext,
  searchInvestments,
  valyuExtractContent,
} from '@/lib/agents/analysis/tools';
import { composeSectorTools } from '@/lib/agents/sector/coreTools';

export const BANGUN_EXTRA_TOOLS = [
  getSectorContext,
  getCompetitorLandscape,
  getMarketSignals,
  valyuExtractContent,
  searchInvestments,
  getFundAssetDetails,
];

export const BANGUN_TOOLS = composeSectorTools(BANGUN_EXTRA_TOOLS);
