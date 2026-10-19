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
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>();
  return { ...actual, createContainer: mocks.createContainer };
});

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
import { GET, POST } from './route';
import { InvalidMasterDataError } from '@/lib/services';

describe('GET & POST /api/fund-ledger/investment-types', () => {
  beforeEach(reset);

  it('GET returns the workspace list', async () => {
    mocks.list.mockResolvedValue([{ id: 't1', name: 'Others' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 't1', name: 'Others' }] });
    expect(mocks.list).toHaveBeenCalledWith('ws-1');
  });

  it('POST creates a type from the name', async () => {
    mocks.create.mockResolvedValue({ id: 't2', name: 'Infra' });
    const res = await POST(jsonReq('POST', { name: 'Infra' }));
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith('ws-1', 'Infra');
  });

  it('POST rejects a missing name with 400 before calling the service', async () => {
    const res = await POST(jsonReq('POST', {}));
    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('POST maps a domain error to 422', async () => {
    mocks.create.mockRejectedValue(new InvalidMasterDataError('Investment type "Infra" already exists'));
    const res = await POST(jsonReq('POST', { name: 'Infra' }));
    expect(res.status).toBe(422);
  });

  it('GET returns 500 on an unexpected error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.list.mockRejectedValue(new Error('boom'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
