import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  assignAsset: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

function reset() {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.createDb.mockReturnValue({});
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.createContainer.mockReturnValue({
    flInvestmentTypeService: {
      list: mocks.list,
      create: mocks.create,
      rename: mocks.rename,
      delete: mocks.remove,
      assignAsset: mocks.assignAsset,
    },
  });
}

const jsonReq = (method: string, body: unknown) =>
  new NextRequest('http://localhost/api', { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
import { PATCH, DELETE } from './route';
import { EntityNotFoundError } from '@/lib/services';

describe('PATCH & DELETE /api/fund-ledger/investment-types/[id]', () => {
  beforeEach(reset);

  it('PATCH renames the type', async () => {
    mocks.rename.mockResolvedValue({ id: 't1', name: 'New' });
    const res = await PATCH(jsonReq('PATCH', { name: 'New' }), params('t1'));
    expect(res.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith('ws-1', 't1', 'New');
  });

  it('PATCH rejects a non-string name with 400', async () => {
    const res = await PATCH(jsonReq('PATCH', { name: 5 }), params('t1'));
    expect(res.status).toBe(400);
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it('DELETE removes the type', async () => {
    const res = await DELETE(jsonReq('DELETE', {}), params('t1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(mocks.remove).toHaveBeenCalledWith('ws-1', 't1');
  });

  it('DELETE maps a missing type to 422', async () => {
    mocks.remove.mockRejectedValue(new EntityNotFoundError('Investment type t1 not found'));
    const res = await DELETE(jsonReq('DELETE', {}), params('t1'));
    expect(res.status).toBe(422);
  });
});
