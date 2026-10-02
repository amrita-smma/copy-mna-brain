import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import {
  deleteCorporateAction,
  getOwnershipContext,
  recordCorporateAction,
  updateCorporateAction,
} from './corporateActions';

const input = {
  action_date: '2025-06-30',
  currency: 'CNY',
  pre_money: '100',
  round_size: '10',
  participants: [{ position_id: 'pA', pct_before: '5' }],
};

describe('funding round API client', () => {
  beforeEach(() => {
    apiRequestMock.mockReset().mockResolvedValue({ ok: true });
  });

  it('getOwnershipContext reads the asset-scoped endpoint', async () => {
    await getOwnershipContext('asset-1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/asset-1/corporate-actions');
  });

  it('recordCorporateAction POSTs the round to the asset', async () => {
    await recordCorporateAction('asset-1', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/asset-1/corporate-actions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  });

  it('updateCorporateAction PUTs the replacement round', async () => {
    await updateCorporateAction('round-1', input);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/corporate-actions/round-1', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  });

  it('deleteCorporateAction DELETEs the round', async () => {
    await deleteCorporateAction('round-1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/corporate-actions/round-1', {
      method: 'DELETE',
    });
  });
});
