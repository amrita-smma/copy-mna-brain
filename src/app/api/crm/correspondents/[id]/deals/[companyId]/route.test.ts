import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, removeLinkMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    removeLinkMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { DELETE } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { DealContactLinkNotFoundError } from '@/lib/services/dealContactService';

const params = { params: Promise.resolve({ id: 'c1', companyId: 'co1' }) };

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  removeLinkMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    dealContactService: { removeLink: removeLinkMock },
  });
});

describe('DELETE /api/crm/correspondents/[id]/deals/[companyId]', () => {
  it('dismisses the link', async () => {
    const data = { companyId: 'co1', correspondentId: 'c1', status: 'dismissed' };
    removeLinkMock.mockResolvedValueOnce(data);

    const res = await DELETE({} as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(removeLinkMock).toHaveBeenCalledWith('c1', 'co1');
  });

  it('returns 404 when the contact or the link does not exist', async () => {
    removeLinkMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));
    expect((await DELETE({} as never, params)).status).toBe(404);
    removeLinkMock.mockRejectedValueOnce(new DealContactLinkNotFoundError('c1', 'co1'));
    expect((await DELETE({} as never, params)).status).toBe(404);
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeLinkMock.mockRejectedValueOnce(new Error('boom'));
    expect((await DELETE({} as never, params)).status).toBe(500);
    errSpy.mockRestore();
  });
});
