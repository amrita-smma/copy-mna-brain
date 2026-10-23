import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, dismissMock } = vi.hoisted(
  () => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    dismissMock: vi.fn(),
  }),
);

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { POST } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { DealCompanyNotFoundError } from '@/lib/services/dealContactService';

const params = { params: Promise.resolve({ id: 'c1', companyId: 'co1' }) };

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  dismissMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    dealContactService: { dismissSuggestion: dismissMock },
  });
});

describe('POST /api/crm/correspondents/[id]/deals/[companyId]/dismiss', () => {
  it('dismisses the suggestion in the active workspace', async () => {
    const data = { companyId: 'co1', status: 'dismissed' };
    dismissMock.mockResolvedValueOnce(data);

    const res = await POST({} as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(dismissMock).toHaveBeenCalledWith('c1', 'co1');
  });

  it('returns 404 for an unknown contact or company', async () => {
    dismissMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));
    expect((await POST({} as never, params)).status).toBe(404);
    dismissMock.mockRejectedValueOnce(new DealCompanyNotFoundError('co1'));
    expect((await POST({} as never, params)).status).toBe(404);
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dismissMock.mockRejectedValueOnce(new Error('boom'));
    expect((await POST({} as never, params)).status).toBe(500);
    errSpy.mockRestore();
  });
});
