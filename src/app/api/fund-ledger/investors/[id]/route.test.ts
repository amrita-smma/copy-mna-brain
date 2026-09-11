import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getInvestorByIdMock,
  updateInvestorMock,
  deleteInvestorMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getInvestorByIdMock: vi.fn(),
  updateInvestorMock: vi.fn(),
  deleteInvestorMock: vi.fn(),
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
import { EntityNotFoundError } from '@/lib/services';

describe('GET, PATCH & DELETE /api/fund-ledger/investors/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getInvestorByIdMock.mockReset();
    updateInvestorMock.mockReset();
    deleteInvestorMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        getInvestorById: getInvestorByIdMock,
        updateInvestor: updateInvestorMock,
        deleteInvestor: deleteInvestorMock,
      },
    });
  });

  describe('GET', () => {
    it('returns investor when found', async () => {
      const inv = { id: 'inv-1', name: 'Alice LP' };
      getInvestorByIdMock.mockResolvedValueOnce(inv);

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-1');
      const res = await GET(req, { params: Promise.resolve({ id: 'inv-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: inv });
      expect(getInvestorByIdMock).toHaveBeenCalledWith('ws-1', 'inv-1');
    });

    it('returns 404 when investor not found', async () => {
      getInvestorByIdMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-999');
      const res = await GET(req, { params: Promise.resolve({ id: 'inv-999' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH', () => {
    it('updates investor and omits caller id', async () => {
      const updated = { id: 'inv-1', name: 'Alice LP Renamed' };
      updateInvestorMock.mockResolvedValueOnce(updated);

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'fake-id',
          workspace_id: 'fake-ws',
          created_by: 'fake-user',
          name: 'Alice LP Renamed',
          investor_type: 'institution',
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: 'inv-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: updated });
      expect(updateInvestorMock).toHaveBeenCalledWith('ws-1', 'inv-1', {
        name: 'Alice LP Renamed',
        investor_type: 'institution',
      });
      expect(updateInvestorMock.mock.calls[0][2]).not.toHaveProperty('id');
      expect(updateInvestorMock.mock.calls[0][2]).not.toHaveProperty('workspace_id');
      expect(updateInvestorMock.mock.calls[0][2]).not.toHaveProperty('created_by');
    });
  });

  describe('DELETE', () => {
    it('deletes investor when not referenced', async () => {
      deleteInvestorMock.mockResolvedValueOnce(undefined);

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-1', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'inv-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { success: true } });
      expect(deleteInvestorMock).toHaveBeenCalledWith('ws-1', 'inv-1');
    });

    it('returns 422 when investor does not exist', async () => {
      deleteInvestorMock.mockRejectedValueOnce(
        new EntityNotFoundError('Investor inv-999 not found in workspace ws-1'),
      );

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-999', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'inv-999' }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Investor inv-999 not found');
      expect(json.error_name).toBe('EntityNotFoundError');
    });

    it('surfaces error and rejects deletion when FK RESTRICT blocks in-use record', async () => {
      deleteInvestorMock.mockRejectedValueOnce(
        new Error('update or delete on table "fl_investors" violates foreign key constraint "fl_positions_holder_investor_id_fl_investors_id_fk" on table "fl_positions"'),
      );

      const req = new NextRequest('http://localhost/api/fund-ledger/investors/inv-1', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'inv-1' }) });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain('violates foreign key constraint');
    });
  });
});
