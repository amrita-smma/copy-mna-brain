/**
 * @dikti's tool set: the sector core (sector/coreTools.ts) plus these
 * read-only extras, in both roles.
 *
 *   - get_regulatory_context — Permendikbud 7/2020, the yayasan law and the
 *     decree series.
 *   - get_market_signals — alih kelola, penggabungan and penyatuan events and
 *     operator announcements.
 *   - get_company_profile — the buyer behind a yayasan (e.g. a Triputra /
 *     PHINMA-style vehicle).
 *   - valyu_extract_content — pull facts from LLDIKTI, decree and newspaper
 *     announcement pages found by search.
 *   - read_relationship_graph — disclosed business relationships already on
 *     record (overlapping directors, operators and their schools).
 *   - search_investments / get_fund_asset_details — the cohort is "regional
 *     plus internal holdings by necessity", so the agent must reach internal
 *     holdings.
 *   - Valyu (premium search) comes with the core.
 */
import {
  getCompanyProfile,
  getFundAssetDetails,
  getMarketSignals,
  getRegulatoryContext,
  readRelationshipGraph,
  searchInvestments,
  valyuExtractContent,
} from '@/lib/agents/analysis/tools';
import { composeSectorTools } from '@/lib/agents/sector/coreTools';

export const DIKTI_EXTRA_TOOLS = [
  getRegulatoryContext,
  getMarketSignals,
  getCompanyProfile,
  valyuExtractContent,
  readRelationshipGraph,
  searchInvestments,
  getFundAssetDetails,
];

export const DIKTI_TOOLS = composeSectorTools(DIKTI_EXTRA_TOOLS);
