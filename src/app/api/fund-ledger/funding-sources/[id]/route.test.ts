import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getFundingSourceByIdMock,
  updateFundingSourceMock,
  deleteFundingSourceMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getFundingSourceByIdMock: vi.fn(),
  updateFundingSourceMock: vi.fn(),
  deleteFundingSourceMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { GET, PATCH, DELETE } from './route';
import { EntityNotFoundError } from '@/lib/services';

describe('GET, PATCH & DELETE /api/fund-ledger/funding-sources/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getFundingSourceByIdMock.mockReset();
    updateFundingSourceMock.mockReset();
    deleteFundingSourceMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        getFundingSourceById: getFundingSourceByIdMock,
        updateFundingSource: updateFundingSourceMock,
        deleteFundingSource: deleteFundingSourceMock,
      },
    });
  });

  describe('GET', () => {
    it('returns funding source when found', async () => {
      const src = { id: 'src-1', name: 'Treasury Pool' };
      getFundingSourceByIdMock.mockResolvedValueOnce(src);

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'src-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: src });
      expect(getFundingSourceByIdMock).toHaveBeenCalledWith('ws-1', 'src-1');
    });

    it('returns 404 when funding source not found', async () => {
      getFundingSourceByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'src-999' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH', () => {
    it('updates funding source and strips caller internal id', async () => {
      const updated = { id: 'src-1', name: 'New Pool Name' };
      updateFundingSourceMock.mockResolvedValueOnce(updated);

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'fake-id',
          workspace_id: 'fake-ws',
          created_by: 'fake-user',
          name: 'New Pool Name',
          source_type: 'bank_account',
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'src-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updated });
      expect(updateFundingSourceMock).toHaveBeenCalledWith('ws-1', 'src-1', {
        name: 'New Pool Name',
        source_type: 'bank_account',
      });
      expect(updateFundingSourceMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateFundingSourceMock.mock.calls[0][2]).not.toHaveProperty('workspace_id');
      expect(updateFundingSourceMock.mock.calls[0][2]).not.toHaveProperty('created_by');
    });
  });

  describe('DELETE', () => {
    it('deletes funding source when not referenced', async () => {
      deleteFundingSourceMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-1', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'src-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { success: true } });
      expect(deleteFundingSourceMock).toHaveBeenCalledWith('ws-1', 'src-1');
    });

    it('returns 422 when funding source does not exist', async () => {
      deleteFundingSourceMock.mockRejectedValueOnce(
        new EntityNotFoundError('Funding source src-999 not found in workspace ws-1'),
      );

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-999', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'src-999' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Funding source src-999 not found');
      expect(json.error_name).toBe('EntityNotFoundError');
    });

    it('surfaces error and rejects deletion when FK RESTRICT blocks in-use record', async () => {
      deleteFundingSourceMock.mockRejectedValueOnce(
        new Error('update or delete on table "fl_funding_sources" violates foreign key constraint "fl_positions_holder_source_of_fund_id_fl_funding_sources_id_fk" on table "fl_positions"'),
      );

      const req = new NextRequest('http://localhost/api/fund-ledger/funding-sources/src-1', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'src-1' }) });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain('violates foreign key constraint');
    });
  });
});
