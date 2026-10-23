import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, requestOverviewMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    requestOverviewMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { POST } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';

const params = { params: Promise.resolve({ id: 'c1' }) };

describe('POST /api/crm/correspondents/[id]/conversation/overview', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ db: true });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
    requestOverviewMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      contactConversationService: { requestOverview: requestOverviewMock },
    });
  });

  it('returns 200 with overview state', async () => {
    const mockOverview = {
      status: 'pending',
      text: 'Prior text kept',
      generatedAt: '2026-10-01T00:00:00.000Z',
      stale: true,
    };
    requestOverviewMock.mockResolvedValueOnce(mockOverview);

    const res = await POST({} as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: mockOverview });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(requestOverviewMock).toHaveBeenCalledWith('c1');
  });

  it('returns 404 when contact is not found', async () => {
    requestOverviewMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));

    const res = await POST({} as never, params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
  });

  it('returns 500 on unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestOverviewMock.mockRejectedValueOnce(new Error('Internal failure'));

    const res = await POST({} as never, params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
