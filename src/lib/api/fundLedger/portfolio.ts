import { apiRequest } from '../client';
import type { FlPortfolioReadModel } from '@/lib/services/flPortfolioService';

// ---- Portfolio Read Model ----

export async function getPortfolio(asOf?: string): Promise<FlPortfolioReadModel> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  return apiRequest<FlPortfolioReadModel>(`/api/fund-ledger/portfolio${query}`);
}
