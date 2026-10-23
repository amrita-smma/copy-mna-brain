import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, getSessionMock, confirmMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    getSessionMock: vi.fn(),
    confirmMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/server/session', () => ({ getSession: getSessionMock }));

import { POST } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { DealCompanyNotFoundError } from '@/lib/services/dealContactService';

const params = { params: Promise.resolve({ id: 'c1', companyId: 'co1' }) };

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  getSessionMock.mockReset().mockResolvedValue(null);
  confirmMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    dealContactService: { confirmSuggestion: confirmMock },
  });
});

describe('POST /api/crm/correspondents/[id]/deals/[companyId]/confirm', () => {
  it('confirms the suggestion (no session user → null creator)', async () => {
    const data = { companyId: 'co1', role: 'involved', origin: 'confirmed_suggestion', status: 'active' };
    confirmMock.mockResolvedValueOnce(data);

    const res = await POST({} as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(confirmMock).toHaveBeenCalledWith('c1', 'co1', null);
  });

  it('passes the session user', async () => {
    getSessionMock.mockResolvedValueOnce({ user: { id: 'u1' } });
    confirmMock.mockResolvedValueOnce({});
    await POST({} as never, params);
    expect(confirmMock).toHaveBeenCalledWith('c1', 'co1', 'u1');
  });

  it('returns 404 for an unknown contact or company', async () => {
    confirmMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));
    expect((await POST({} as never, params)).status).toBe(404);
    confirmMock.mockRejectedValueOnce(new DealCompanyNotFoundError('co1'));
    expect((await POST({} as never, params)).status).toBe(404);
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    confirmMock.mockRejectedValueOnce(new Error('boom'));
    expect((await POST({} as never, params)).status).toBe(500);
    errSpy.mockRestore();
  });
});
