/**
 * Deterministic data-sufficiency scoring for Fund AI Opinion.
 *
 * Used both at dispatch (to inject a sparseness note into the agent
 * instruction) and at save time (to clamp the agent's self-reported
 * confidence so a thin holding cannot land as "high").
 */

export const FUND_AI_OPINION_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type FundAiOpinionConfidence = (typeof FUND_AI_OPINION_CONFIDENCE)[number];

const CONFIDENCE_RANK: Record<FundAiOpinionConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface FundAiOpinionAssetSnapshot {
  sector?: string | null;
  country?: string | null;
  fmv_amount?: number | null;
  gross_moic?: number | null;
  gross_irr?: number | null;
  invested_capital_amount?: number | null;
  investment_description?: string | null;
}

export interface FundAiOpinionDataSufficiency {
  /** Hard ceiling the agent (and save path) must not exceed. */
  maxConfidence: FundAiOpinionConfidence;
  /** Human-readable gaps for prompt injection and UI tooltips. */
  dataGaps: string[];
  /** True when the holding lacks enough recorded data for a strong call. */
  isSparse: boolean;
}

/** Parse a tool/agent confidence string; returns null when invalid. */
export function parseFundAiOpinionConfidence(
  value: string | null | undefined,
): FundAiOpinionConfidence | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return (FUND_AI_OPINION_CONFIDENCE as readonly string[]).includes(v)
    ? (v as FundAiOpinionConfidence)
    : null;
}

/** Return the lower of two confidence levels. */
export function clampFundAiOpinionConfidence(
  agent: FundAiOpinionConfidence,
  max: FundAiOpinionConfidence,
): FundAiOpinionConfidence {
  return CONFIDENCE_RANK[agent] <= CONFIDENCE_RANK[max] ? agent : max;
}

/**
 * Score how complete a holding's recorded data is for an AI Opinion.
 *
 * Weights: valuation history is the strongest signal; missing core marks
 * (FMV / MOIC / invested capital) and identity fields (sector / country)
 * push the ceiling down. A holding with no valuations is always sparse
 * and capped at `low`.
 */
export function assessFundAiOpinionDataSufficiency(
  asset: FundAiOpinionAssetSnapshot,
  valuationCount: number,
): FundAiOpinionDataSufficiency {
  const dataGaps: string[] = [];

  if (valuationCount === 0) dataGaps.push('no valuation history');
  else if (valuationCount === 1) dataGaps.push('only one valuation mark');

  if (asset.fmv_amount == null) dataGaps.push('missing FMV');
  if (asset.gross_moic == null) dataGaps.push('missing MOIC');
  if (asset.gross_irr == null) dataGaps.push('missing IRR');
  if (asset.invested_capital_amount == null) dataGaps.push('missing invested capital');
  if (!asset.sector?.trim()) dataGaps.push('unknown sector');
  if (!asset.country?.trim()) dataGaps.push('unknown country');
  if (!asset.investment_description?.trim()) dataGaps.push('no investment description');

  let maxConfidence: FundAiOpinionConfidence;
  if (valuationCount === 0 || dataGaps.length >= 4) {
    maxConfidence = 'low';
  } else if (valuationCount < 2 || dataGaps.length >= 2) {
    maxConfidence = 'medium';
  } else {
    maxConfidence = 'high';
  }

  return {
    maxConfidence,
    dataGaps,
    isSparse: maxConfidence !== 'high',
  };
}

/** Format gaps for prompt / storage (empty string when none). */
export function formatFundAiOpinionDataGaps(gaps: string[]): string {
  return gaps.join('; ');
}

/**
 * True when a newer valuation mark landed after the opinion was written.
 * Compares date-only (valuation `as_of_date` vs the UTC day of
 * `ai_opinion_updated_at`).
 */
export function isFundAiOpinionStale(
  aiOpinionUpdatedAt: string | null | undefined,
  latestValuationAsOf: string | null | undefined,
): boolean {
  if (!aiOpinionUpdatedAt || !latestValuationAsOf) return false;
  const opinionDay = aiOpinionUpdatedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opinionDay)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latestValuationAsOf)) return false;
  return latestValuationAsOf > opinionDay;
}
