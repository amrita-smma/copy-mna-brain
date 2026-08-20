import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiRequest: apiRequestMock,
}));

import {
  listCommitmentEvents,
  getCommitmentEvent,
  createCommitmentEvent,
  createCommitmentTransfer,
  updateCommitmentEvent,
  deleteCommitmentEvent,
} from './commitmentEvents';

describe('commitmentEvents API client', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('listCommitmentEvents sends query params', async () => {
    apiRequestMock.mockResolvedValueOnce([]);
    await listCommitmentEvents({ fundId: 'f1', holdingEntityId: 'h1' });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events?fundId=f1&holdingEntityId=h1');
  });

  it('getCommitmentEvent requests by id', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'e1' });
    await getCommitmentEvent('e1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events/e1');
  });

  it('createCommitmentEvent POSTs event payload', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'e1' });
    const payload = {
      fundId: 'f1',
      holdingEntityId: 'h1',
      effectiveDate: '2026-01-01',
      eventType: 'initial_commitment' as const,
      amount: 100,
    };
    await createCommitmentEvent(payload);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  });

  it('createCommitmentTransfer POSTs transfer payload', async () => {
    apiRequestMock.mockResolvedValueOnce({ transferGroupId: 'tg-1' });
    const payload = {
      fundId: 'f1',
      fromHoldingEntityId: 'seller',
      toHoldingEntityId: 'buyer',
      effectiveDate: '2026-01-01',
      amount: 25,
    };
    await createCommitmentTransfer(payload);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events/transfer', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  });

  it('updateCommitmentEvent PATCHes event payload', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'e1', amount: 150 });
    await updateCommitmentEvent('e1', { amount: 150 });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events/e1', {
      method: 'PATCH',
      body: JSON.stringify({ amount: 150 }),
    });
  });

  it('deleteCommitmentEvent DELETEs event', async () => {
    apiRequestMock.mockResolvedValueOnce({ success: true });
    await deleteCommitmentEvent('e1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/commitment-events/e1', {
      method: 'DELETE',
    });
  });
});
