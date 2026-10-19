import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CorporateActionValidationError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  flagMock,
  getContextMock,
  recordMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  flagMock: vi.fn(),
  getContextMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/flags', () => ({ corporateActionsEnabled: flagMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';

const params = { params: Promise.resolve({ id: 'asset-1' }) };

describe('GET, POST /api/fund-ledger/assets/[id]/corporate-actions', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    flagMock.mockReset().mockResolvedValue(true);
    getContextMock.mockReset();
    recordMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flCorporateActionService: { getContext: getContextMock, record: recordMock },
    });
  });

  it('returns 404 without touching the DB when the flag is off', async () => {
    flagMock.mockResolvedValue(false);

    const res = await GET(new NextRequest('http://localhost/x'), params);

    expect(res.status).toBe(404);
    expect(createDbMock).not.toHaveBeenCalled();
    const post = await POST(
      new NextRequest('http://localhost/x', { method: 'POST', body: '{}' }),
      params,
    );
    expect(post.status).toBe(404);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('GET returns the company context', async () => {
    getContextMock.mockResolvedValueOnce({ positions: [], rounds: [] });

    const res = await GET(new NextRequest('http://localhost/x'), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { positions: [], rounds: [] } });
    expect(getContextMock).toHaveBeenCalledWith('ws-1', 'asset-1');
  });

  it('POST builds the input field by field, taking the asset from the URL', async () => {
    recordMock.mockResolvedValueOnce({ action: { id: 'r1' }, warnings: [] });

    const res = await POST(
      new NextRequest('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({
          asset_id: 'spoofed',
          workspace_id: 'spoofed',
          action_date: '2025-06-30',
          currency: 'CNY',
          pre_money: '150000000',
          round_size: '50000000',
          participants: [
            { position_id: 'pA', pct_before: '12', follow_on_amount: '5000000', valuation_id: 'x' },
          ],
        }),
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith('ws-1', {
      asset_id: 'asset-1',
      action_type: 'funding_round',
      action_date: '2025-06-30',
      label: null,
      currency: 'CNY',
      pre_money: '150000000',
      round_size: '50000000',
      notes: null,
      participants: [
        {
          position_id: 'pA',
          pct_before: '12',
          follow_on_amount: '5000000',
          pct_override: null,
          override_remark: null,
          pct_after: null,
        },
      ],
    });
  });

  it('passes an opening stake through with its stake after', async () => {
    recordMock.mockResolvedValueOnce({ action: { id: 'r' }, warnings: [] });

    const res = await POST(
      new NextRequest('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'opening_stake',
          action_date: '2023-06-09',
          participants: [{ position_id: 'pA', pct_after: '6' }],
        }),
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        action_type: 'opening_stake',
        participants: [expect.objectContaining({ position_id: 'pA', pct_after: '6' })],
      }),
    );
  });

  it('maps a domain error to 422', async () => {
    recordMock.mockRejectedValueOnce(new CorporateActionValidationError('bad round'));

    const res = await POST(
      new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ participants: [] }) }),
      params,
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'bad round', error_name: 'CorporateActionValidationError' });
  });

  it('hides unexpected errors behind a 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getContextMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await GET(new NextRequest('http://localhost/x'), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    spy.mockRestore();
  });
});
