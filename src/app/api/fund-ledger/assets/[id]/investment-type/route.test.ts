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
import { PUT } from './route';

describe('PUT /api/fund-ledger/assets/[id]/investment-type', () => {
  beforeEach(reset);

  it('assigns the asset to a type', async () => {
    mocks.assignAsset.mockResolvedValue({ id: 'a1', investment_type_id: 't1' });
    const res = await PUT(jsonReq('PUT', { investment_type_id: 't1' }), params('a1'));
    expect(res.status).toBe(200);
    expect(mocks.assignAsset).toHaveBeenCalledWith('ws-1', 'a1', 't1');
  });

  it('unassigns with null', async () => {
    mocks.assignAsset.mockResolvedValue({ id: 'a1', investment_type_id: null });
    const res = await PUT(jsonReq('PUT', { investment_type_id: null }), params('a1'));
    expect(res.status).toBe(200);
    expect(mocks.assignAsset).toHaveBeenCalledWith('ws-1', 'a1', null);
  });

  it('rejects a non-string, non-null id with 400 before calling the service', async () => {
    const res = await PUT(jsonReq('PUT', { investment_type_id: 42 }), params('a1'));
    expect(res.status).toBe(400);
    expect(mocks.assignAsset).not.toHaveBeenCalled();
  });
});
