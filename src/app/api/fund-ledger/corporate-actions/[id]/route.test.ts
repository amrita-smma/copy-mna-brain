import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { EntityNotFoundError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  flagMock,
  updateMock,
  deleteMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  flagMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/flags', () => ({ corporateActionsEnabled: flagMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { DELETE, PUT } from './route';

const params = { params: Promise.resolve({ id: 'round-1' }) };

describe('PUT, DELETE /api/fund-ledger/corporate-actions/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    flagMock.mockReset().mockResolvedValue(true);
    updateMock.mockReset();
    deleteMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flCorporateActionService: { update: updateMock, delete: deleteMock },
    });
  });

  it('returns 404 without touching the DB when the flag is off', async () => {
    flagMock.mockResolvedValue(false);

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), params);

    expect(res.status).toBe(404);
    expect(createDbMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('PUT forwards the replacement round', async () => {
    updateMock.mockResolvedValueOnce({ action: { id: 'round-1' }, warnings: [] });

    const res = await PUT(
      new NextRequest('http://localhost/x', {
        method: 'PUT',
        body: JSON.stringify({
          action_date: '2025-06-30',
          label: 'Series B',
          currency: 'CNY',
          pre_money: '100',
          round_size: '10',
          participants: [{ position_id: 'pA', pct_before: '5', pct_override: '4', override_remark: 'ratchet' }],
        }),
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('ws-1', 'round-1', {
      action_date: '2025-06-30',
      label: 'Series B',
      currency: 'CNY',
      pre_money: '100',
      round_size: '10',
      notes: null,
      participants: [
        {
          position_id: 'pA',
          pct_before: '5',
          follow_on_amount: null,
          pct_override: '4',
          override_remark: 'ratchet',
          pct_after: null,
        },
      ],
    });
  });

  it('DELETE removes the round', async () => {
    deleteMock.mockResolvedValueOnce(undefined);

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(deleteMock).toHaveBeenCalledWith('ws-1', 'round-1');
  });

  it('maps a missing round to 422', async () => {
    deleteMock.mockRejectedValueOnce(new EntityNotFoundError('Funding round round-1 not found'));

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), params);

    expect(res.status).toBe(422);
  });
});
