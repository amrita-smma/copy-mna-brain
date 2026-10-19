import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getAssetByIdMock,
  updateAssetMock,
  deleteAssetWithLedgerMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  updateAssetMock: vi.fn(),
  deleteAssetWithLedgerMock: vi.fn(),
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

import { DELETE, GET, PATCH } from './route';
import { EntityNotFoundError } from '@/lib/services';

describe('GET & PATCH /api/fund-ledger/assets/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getAssetByIdMock.mockReset();
    updateAssetMock.mockReset();
    deleteAssetWithLedgerMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        getAssetById: getAssetByIdMock,
        updateAsset: updateAssetMock,
      },
      flLedgerService: {
        deleteAssetWithLedger: deleteAssetWithLedgerMock,
      },
    });
  });

  describe('GET', () => {
    it('returns asset when found', async () => {
      const asset = { id: 'asset-1', name: 'Acme Corp' };
      getAssetByIdMock.mockResolvedValueOnce(asset);

      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'asset-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: asset });
      expect(getAssetByIdMock).toHaveBeenCalledWith('ws-1', 'asset-1');
    });

    it('returns 404 when asset not found', async () => {
      getAssetByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'asset-999' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH', () => {
    it('updates asset and strips caller internal IDs', async () => {
      const updated = { id: 'asset-1', name: 'Acme Updated' };
      updateAssetMock.mockResolvedValueOnce(updated);

      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'untrusted-id',
          workspace_id: 'untrusted-ws',
          created_by: 'untrusted-user',
          name: 'Acme Updated',
          sector: 'Technology',
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'asset-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updated });
      expect(updateAssetMock).toHaveBeenCalledWith('ws-1', 'asset-1', {
        name: 'Acme Updated',
        sector: 'Technology',
      });
      expect(updateAssetMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateAssetMock.mock.calls[0][2]).not.toHaveProperty('workspace_id');
      expect(updateAssetMock.mock.calls[0][2]).not.toHaveProperty('created_by');
    });
  });

  describe('PATCH action_items', () => {
    it('passes action_items through to the service', async () => {
      updateAssetMock.mockResolvedValueOnce({ id: 'asset-1', action_items: 'Chase Q3 report' });
      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action_items: 'Chase Q3 report' }),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id: 'asset-1' }) });
      expect(res.status).toBe(200);
      expect(updateAssetMock).toHaveBeenCalledWith('ws-1', 'asset-1', {
        action_items: 'Chase Q3 report',
      });
    });

    it('rejects a non-string action_items with 400', async () => {
      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action_items: 42 }),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id: 'asset-1' }) });
      expect(res.status).toBe(400);
      expect(updateAssetMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('hard-deletes the asset with its ledger and returns the counts', async () => {
      const counts = { entries: 4, events: 2, positions: 1 };
      deleteAssetWithLedgerMock.mockResolvedValueOnce(counts);
      const req = new NextRequest('http://localhost/api/fund-ledger/assets/asset-1', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'asset-1' }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: counts });
      expect(deleteAssetWithLedgerMock).toHaveBeenCalledWith('ws-1', 'asset-1');
    });

    it('maps domain errors to 422', async () => {
      deleteAssetWithLedgerMock.mockRejectedValueOnce(new EntityNotFoundError('Asset missing'));
      const req = new NextRequest('http://localhost/api/fund-ledger/assets/missing', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'missing' }) });
      expect(res.status).toBe(422);
    });
  });
});
