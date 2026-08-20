import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';

type Fund = Tables<'funds'>;
type FundAsset = Tables<'fund_assets'>;
type FundAssetTransaction = Tables<'fund_asset_transactions'>;
type FundAssetValuation = Tables<'fund_asset_valuations'>;

// Payload shapes are camelCase, matching each route's own `await req.json()`
// destructuring — NOT the snake_case DB row shape returned in responses.

export interface CreateFundInput {
  name: string;
  description?: string | null;
  vintageYear?: number | null;
  commitmentSizeAmount?: number | null;
  baseCurrency?: string;
  status?: 'investing' | 'harvesting';
  // Normally derived by FundMetricsService from the ledger, but writable as
  // manual overrides from the Fund edit modal. A later metrics recompute
  // (triggered by any asset/txn change) will overwrite whatever is set here.
  calledAmount?: number | null;
  fmvAmount?: number | null;
  realizedAmount?: number | null;
  dpi?: number | null;
  tvpi?: number | null;
  irr?: number | null;
}
export type UpdateFundInput = Partial<CreateFundInput>;

export interface CreateAssetInput {
  assetType: 'direct_investment' | 'cash' | 'fund_of_funds';
  assetName?: string | null;
  englishName?: string | null;
  legalName?: string | null;
  country?: string | null;
  fundingSource?: string | null;
  investmentType?: string | null;
  entryDate?: string | null;
  maturityDate?: string | null;
  commitmentAmount?: number | null;
  stakePct?: number | null;
  sector?: string | null;
  subSector?: string | null;
  investmentCurrency?: string | null;
  reportCurrency?: string | null;
  investmentDescription?: string | null;
  keyRights?: string | null;
  subscriptionFeeAmount?: number | null;
  mgmtFeeRatePct?: number | null;
  carryRatePct?: number | null;
  legalFeesAmount?: number | null;
  typeDetails?: unknown;
  status?: 'active' | 'exiting' | 'exited';
  currentPricePerShare?: number | null;
  fmvAmount?: number | null;
  grossMoic?: number | null;
  grossIrr?: number | null;
  dpi?: number | null;
  investedCapitalAmount?: number | null;
  netDistributionAmount?: number | null;
  shareCount?: number | null;
}
export type UpdateAssetInput = Partial<Omit<CreateAssetInput, 'assetType'>>;

import type { SellProceedsDestination } from '@/lib/sellProceedsDestination';
export type { SellProceedsDestination };

export interface CreateTransactionInput {
  txnDate: string;
  txnType: 'contribution' | 'divestment' | 'interest_income' | 'return_of_capital' | 'other';
  subTypeLabel?: string | null;
  pricePerShare?: number | null;
  shareCount?: number | null;
  valueAmount?: number | null;
  txnCurrency?: string | null;
  fxRate?: number | null;
  sellProceedsDestination?: SellProceedsDestination | null;
  notes?: string | null;
  fundId?: string | null;
  holdingEntityId?: string | null;
  fundingSourceId?: string | null;
}
export type UpdateTransactionInput = Partial<CreateTransactionInput>;

export interface UpsertValuationInput {
  asOfDate: string;
  periodLabel?: string | null;
  valuationMethod?:
    | 'at_cost'
    | 'fundraise_round'
    | 'secondary_sale'
    | 'stock_market_price'
    | 'comparables'
    | 'capital_account_statement'
    | 'other';
  currency?: string;
  marketValueAmount?: number | null;
  pricePerShare?: number | null;
  sharesOutstanding?: number | null;
  shareholdingPct?: number | null;
  investedCapitalCumAmount?: number | null;
  netDistributionAmount?: number | null;
  grossMoic?: number | null;
  dpi?: number | null;
  grossXirr?: number | null;
  notes?: string | null;
}

export function listFunds(): Promise<Fund[]> {
  return apiRequest<Fund[]>('/api/funds');
}

export interface PortfolioAsset {
  asset: FundAsset;
  txns: FundAssetTransaction[];
  valuations: FundAssetValuation[];
}

export type PortfolioFund = Fund & { assets: PortfolioAsset[] };

/**
 * One batched request for the whole portfolio: every fund with its assets and
 * each asset's full transaction/valuation ledger already attached. Replaces
 * the old per-asset `listTransactions`/`listValuations` fan-out that fired one
 * HTTP request (and one DB connection) per asset.
 */
export function getPortfolio(): Promise<PortfolioFund[]> {
  return apiRequest<PortfolioFund[]>('/api/funds/portfolio');
}

export function createFund(data: CreateFundInput): Promise<Fund> {
  return apiRequest<Fund>('/api/funds', { method: 'POST', body: JSON.stringify(data) });
}

export function getFund(fundId: string): Promise<Fund & { assets: FundAsset[] }> {
  return apiRequest<Fund & { assets: FundAsset[] }>(`/api/funds/${fundId}`);
}

export function updateFund(fundId: string, updates: UpdateFundInput): Promise<Fund> {
  return apiRequest<Fund>(`/api/funds/${fundId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function deleteFund(fundId: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(`/api/funds/${fundId}`, { method: 'DELETE' });
}

export function listAssets(fundId: string): Promise<FundAsset[]> {
  return apiRequest<FundAsset[]>(`/api/funds/${fundId}/assets`);
}

export function addAsset(fundId: string, data: CreateAssetInput): Promise<FundAsset> {
  return apiRequest<FundAsset>(`/api/funds/${fundId}/assets`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getAsset(fundId: string, assetId: string): Promise<FundAsset> {
  return apiRequest<FundAsset>(`/api/funds/${fundId}/assets/${assetId}`);
}

export function updateAsset(
  fundId: string,
  assetId: string,
  updates: UpdateAssetInput,
): Promise<FundAsset> {
  return apiRequest<FundAsset>(`/api/funds/${fundId}/assets/${assetId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function deleteAsset(fundId: string, assetId: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(`/api/funds/${fundId}/assets/${assetId}`, {
    method: 'DELETE',
  });
}

export function listTransactions(
  fundId: string,
  assetId: string,
): Promise<FundAssetTransaction[]> {
  return apiRequest<FundAssetTransaction[]>(
    `/api/funds/${fundId}/assets/${assetId}/transactions`,
  );
}

export function addTransaction(
  fundId: string,
  assetId: string,
  data: CreateTransactionInput,
): Promise<FundAssetTransaction> {
  return apiRequest<FundAssetTransaction>(
    `/api/funds/${fundId}/assets/${assetId}/transactions`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

export function updateTransaction(
  fundId: string,
  assetId: string,
  txnId: string,
  updates: UpdateTransactionInput,
): Promise<FundAssetTransaction> {
  return apiRequest<FundAssetTransaction>(
    `/api/funds/${fundId}/assets/${assetId}/transactions/${txnId}`,
    { method: 'PATCH', body: JSON.stringify(updates) },
  );
}

export function deleteTransaction(
  fundId: string,
  assetId: string,
  txnId: string,
): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(
    `/api/funds/${fundId}/assets/${assetId}/transactions/${txnId}`,
    { method: 'DELETE' },
  );
}

export function listValuations(fundId: string, assetId: string): Promise<FundAssetValuation[]> {
  return apiRequest<FundAssetValuation[]>(`/api/funds/${fundId}/assets/${assetId}/valuations`);
}

/** Upsert, keyed on (fund_asset_id, as_of_date) — see the route's own comment. */
export function upsertValuation(
  fundId: string,
  assetId: string,
  data: UpsertValuationInput,
): Promise<FundAssetValuation> {
  return apiRequest<FundAssetValuation>(`/api/funds/${fundId}/assets/${assetId}/valuations`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteValuation(
  fundId: string,
  assetId: string,
  valId: string,
): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(
    `/api/funds/${fundId}/assets/${assetId}/valuations/${valId}`,
    { method: 'DELETE' },
  );
}

/**
 * Enqueue a Fund AI Opinion workforce run for a holding (MB-470). Powers the
 * "Analyze AI Opinion" / "Re-evaluate" button in the Fund Management Asset
 * table. Returns immediately with the queue run id; the verdict lands on the
 * `fund_assets` row asynchronously and is picked up by re-fetching the
 * portfolio.
 */
export function analyzeFundAiOpinion(fundAssetId: string): Promise<{ runId: string }> {
  return apiRequest<{ runId: string }>('/api/funds/ai-opinion', {
    method: 'POST',
    body: JSON.stringify({ fundAssetId }),
  });
}
