import { apiRequest } from '../client';
import type { Tables } from '@/lib/repositories';
import type {
  CreateFundInput,
  UpdateFundInput,
  CreateAssetInput,
  UpdateAssetInput,
  DeleteAssetResult,
  CreateInvestorInput,
  UpdateInvestorInput,
  CreateFundingSourceInput,
  UpdateFundingSourceInput,
} from './types';

// ---- Funds ----

export async function listFunds(): Promise<Tables<'fl_funds'>[]> {
  return apiRequest<Tables<'fl_funds'>[]>('/api/fund-ledger/funds');
}

export async function getFund(id: string): Promise<Tables<'fl_funds'>> {
  return apiRequest<Tables<'fl_funds'>>(`/api/fund-ledger/funds/${id}`);
}

export async function createFund(input: CreateFundInput): Promise<Tables<'fl_funds'>> {
  return apiRequest<Tables<'fl_funds'>>('/api/fund-ledger/funds', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateFund(id: string, input: UpdateFundInput): Promise<Tables<'fl_funds'>> {
  return apiRequest<Tables<'fl_funds'>>(`/api/fund-ledger/funds/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function getFundRollup(id: string, asOf?: string) {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  return apiRequest<unknown>(`/api/fund-ledger/funds/${id}/rollup${query}`);
}

// ---- Assets ----

export async function listAssets(): Promise<Tables<'fl_assets'>[]> {
  return apiRequest<Tables<'fl_assets'>[]>('/api/fund-ledger/assets');
}

export async function getAsset(id: string): Promise<Tables<'fl_assets'>> {
  return apiRequest<Tables<'fl_assets'>>(`/api/fund-ledger/assets/${id}`);
}

export async function createAsset(input: CreateAssetInput): Promise<Tables<'fl_assets'>> {
  return apiRequest<Tables<'fl_assets'>>('/api/fund-ledger/assets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateAsset(id: string, input: UpdateAssetInput): Promise<Tables<'fl_assets'>> {
  return apiRequest<Tables<'fl_assets'>>(`/api/fund-ledger/assets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/**
 * Permanently deletes an asset with its positions, valuations and every ledger
 * event that touches it (counterpart legs included).
 */
export async function deleteAsset(id: string): Promise<DeleteAssetResult> {
  return apiRequest<DeleteAssetResult>(`/api/fund-ledger/assets/${id}`, {
    method: 'DELETE',
  });
}

// ---- Investment types ----

export async function listInvestmentTypes(): Promise<Tables<'fl_investment_types'>[]> {
  return apiRequest<Tables<'fl_investment_types'>[]>('/api/fund-ledger/investment-types');
}

export async function createInvestmentType(name: string): Promise<Tables<'fl_investment_types'>> {
  return apiRequest<Tables<'fl_investment_types'>>('/api/fund-ledger/investment-types', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function renameInvestmentType(
  id: string,
  name: string,
): Promise<Tables<'fl_investment_types'>> {
  return apiRequest<Tables<'fl_investment_types'>>(`/api/fund-ledger/investment-types/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteInvestmentType(id: string): Promise<void> {
  await apiRequest<{ success: true }>(`/api/fund-ledger/investment-types/${id}`, {
    method: 'DELETE',
  });
}

/** Assigns an asset to an investment type; `null` unassigns it. */
export async function setAssetInvestmentType(
  assetId: string,
  investmentTypeId: string | null,
): Promise<Tables<'fl_assets'>> {
  return apiRequest<Tables<'fl_assets'>>(`/api/fund-ledger/assets/${assetId}/investment-type`, {
    method: 'PUT',
    body: JSON.stringify({ investment_type_id: investmentTypeId }),
  });
}

// ---- Investors ----

export async function listInvestors(): Promise<Tables<'fl_investors'>[]> {
  return apiRequest<Tables<'fl_investors'>[]>('/api/fund-ledger/investors');
}

export async function getInvestor(id: string): Promise<Tables<'fl_investors'>> {
  return apiRequest<Tables<'fl_investors'>>(`/api/fund-ledger/investors/${id}`);
}

export async function createInvestor(input: CreateInvestorInput): Promise<Tables<'fl_investors'>> {
  return apiRequest<Tables<'fl_investors'>>('/api/fund-ledger/investors', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateInvestor(
  id: string,
  input: UpdateInvestorInput,
): Promise<Tables<'fl_investors'>> {
  return apiRequest<Tables<'fl_investors'>>(`/api/fund-ledger/investors/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteInvestor(id: string): Promise<void> {
  await apiRequest<{ success: true }>(`/api/fund-ledger/investors/${id}`, {
    method: 'DELETE',
  });
}

// ---- Funding Sources ----

export async function listFundingSources(): Promise<Tables<'fl_funding_sources'>[]> {
  return apiRequest<Tables<'fl_funding_sources'>[]>(
    '/api/fund-ledger/funding-sources',
  );
}

export async function getFundingSource(id: string): Promise<Tables<'fl_funding_sources'>> {
  return apiRequest<Tables<'fl_funding_sources'>>(
    `/api/fund-ledger/funding-sources/${id}`,
  );
}

export async function createFundingSource(
  input: CreateFundingSourceInput,
): Promise<Tables<'fl_funding_sources'>> {
  return apiRequest<Tables<'fl_funding_sources'>>(
    '/api/fund-ledger/funding-sources',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export async function updateFundingSource(
  id: string,
  input: UpdateFundingSourceInput,
): Promise<Tables<'fl_funding_sources'>> {
  return apiRequest<Tables<'fl_funding_sources'>>(
    `/api/fund-ledger/funding-sources/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export async function deleteFundingSource(id: string): Promise<void> {
  await apiRequest<{ success: true }>(`/api/fund-ledger/funding-sources/${id}`, {
    method: 'DELETE',
  });
}
