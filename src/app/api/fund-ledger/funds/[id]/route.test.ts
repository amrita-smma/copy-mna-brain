import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InvalidEntryShapeError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getFundByIdMock,
  updateFundMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getFundByIdMock: vi.fn(),
  updateFundMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>();
  return {
    ...actual,
    createContainer: createContainerMock,
  };
});

import { GET, PATCH } from './route';

describe('GET & PATCH /api/fund-ledger/funds/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getFundByIdMock.mockReset();
    updateFundMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        getFundById: getFundByIdMock,
        updateFund: updateFundMock,
      },
    });
  });

  describe('GET', () => {
    it('returns fund when found', async () => {
      const fund = { id: 'f-1', name: 'Fund One' };
      getFundByIdMock.mockResolvedValueOnce(fund);

      const req = new NextRequest('http://localhost/api/fund-ledger/funds/f-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: fund });
      expect(getFundByIdMock).toHaveBeenCalledWith('ws-1', 'f-1');
    });

    it('returns 404 when fund is not found', async () => {
      getFundByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/funds/f-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'f-999' }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toEqual({ error: 'Fund not found' });
    });
  });

  describe('PATCH', () => {
    it('updates fund forwarding string rate unchanged and omitting caller id/workspace_id', async () => {
      const updated = { id: 'f-1', name: 'Updated Fund', mgmt_fee_rate: '0.020000' };
      updateFundMock.mockResolvedValueOnce(updated);

      const req = new NextRequest('http://localhost/api/fund-ledger/funds/f-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'hacker-override-id',
          workspace_id: 'hacker-override-ws',
          name: 'Updated Fund',
          mgmt_fee_rate: '0.020000',
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updated });
      expect(updateFundMock).toHaveBeenCalledWith('ws-1', 'f-1', {
        name: 'Updated Fund',
        mgmt_fee_rate: '0.020000',
      });
      expect(updateFundMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateFundMock.mock.calls[0][2]).not.toHaveProperty('workspace_id');
      expect(updateFundMock.mock.calls[0][2]).not.toHaveProperty('created_by');
      expect(typeof updateFundMock.mock.calls[0][2].mgmt_fee_rate).toBe('string');
    });

    it('forwards numeric rate without string coercion, triggering 422 InvalidEntryShapeError', async () => {
      updateFundMock.mockImplementationOnce((_wsId, _id, input) => {
        if (typeof input.mgmt_fee_rate !== 'string') {
          throw new InvalidEntryShapeError(
            `mgmt_fee_rate must be a string, received ${typeof input.mgmt_fee_rate}`,
          );
        }
        return Promise.resolve({ id: 'f-1' });
      });

      const req = new NextRequest('http://localhost/api/fund-ledger/funds/f-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mgmt_fee_rate: 0.02,
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error_name).toBe('InvalidEntryShapeError');
      expect(updateFundMock.mock.calls[0][2].mgmt_fee_rate).toBe(0.02);
    });
  });
});
