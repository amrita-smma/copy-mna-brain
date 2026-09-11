import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getAssetByIdMock,
  updateAssetMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  updateAssetMock: vi.fn(),
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

describe('GET & PATCH /api/fund-ledger/assets/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getAssetByIdMock.mockReset();
    updateAssetMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        getAssetById: getAssetByIdMock,
        updateAsset: updateAssetMock,
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
});
