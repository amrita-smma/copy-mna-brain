import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InvalidEntryShapeError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getValuationByIdMock,
  updateValuationMock,
  deleteValuationMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getValuationByIdMock: vi.fn(),
  updateValuationMock: vi.fn(),
  deleteValuationMock: vi.fn(),
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

import { GET, PATCH, DELETE } from './route';

describe('GET, PATCH, DELETE /api/fund-ledger/valuations/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getValuationByIdMock.mockReset();
    updateValuationMock.mockReset();
    deleteValuationMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flValuationService: {
        getValuationById: getValuationByIdMock,
        update: updateValuationMock,
        delete: deleteValuationMock,
      },
    });
  });

  describe('GET', () => {
    it('returns valuation when found', async () => {
      const val = { id: 'val-1', market_value: '50000000.00000000' };
      getValuationByIdMock.mockResolvedValueOnce(val);

      const req = new NextRequest('http://localhost/api/fund-ledger/valuations/val-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'val-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: val });
      expect(getValuationByIdMock).toHaveBeenCalledWith('ws-1', 'val-1');
    });

    it('returns 404 when valuation not found', async () => {
      getValuationByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/valuations/val-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'val-999' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH', () => {
    it('updates valuation, forwards string money unchanged, and omits caller id', async () => {
      const updated = { id: 'val-1', market_value: '60000000.00000000' };
      updateValuationMock.mockResolvedValueOnce(updated);

      const req = new NextRequest('http://localhost/api/fund-ledger/valuations/val-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'untrusted-id',
          workspace_id: 'untrusted-ws',
          created_by: 'untrusted-user',
          market_value: '60000000',
          price_per_unit: '15.00',
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'val-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updated });
      expect(updateValuationMock).toHaveBeenCalledWith('ws-1', 'val-1', {
        market_value: '60000000',
        price_per_unit: '15.00',
      });
      expect(updateValuationMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateValuationMock.mock.calls[0][2]).not.toHaveProperty('workspace_id');
      expect(updateValuationMock.mock.calls[0][2]).not.toHaveProperty('created_by');
      expect(typeof updateValuationMock.mock.calls[0][2].market_value).toBe('string');
    });

    it('forwards numeric money without string coercion, triggering 422 InvalidEntryShapeError', async () => {
      updateValuationMock.mockImplementationOnce((_wsId, _id, input) => {
        if (typeof input.market_value !== 'string') {
          throw new InvalidEntryShapeError(
            `market_value must be a string, received ${typeof input.market_value}`,
          );
        }
        return Promise.resolve({ id: 'val-1' });
      });

      const req = new NextRequest('http://localhost/api/fund-ledger/valuations/val-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          market_value: 60000000,
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'val-1' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error_name).toBe('InvalidEntryShapeError');
      expect(updateValuationMock.mock.calls[0][2].market_value).toBe(60000000);
    });
  });

  describe('DELETE', () => {
    it('deletes valuation by id', async () => {
      deleteValuationMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/valuations/val-1', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: 'val-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { success: true } });
      expect(deleteValuationMock).toHaveBeenCalledWith('ws-1', 'val-1');
    });
  });
});
