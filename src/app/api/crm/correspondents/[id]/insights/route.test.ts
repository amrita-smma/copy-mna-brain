import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, getContactInsightsMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    getContactInsightsMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { GET } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';

const params = { params: Promise.resolve({ id: 'c1' }) };

function makeReq(url = 'https://example.com/api/crm/correspondents/c1/insights') {
  return {
    nextUrl: new URL(url),
  } as never;
}

describe('GET /api/crm/correspondents/[id]/insights', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ db: true });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
    getContactInsightsMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      contactInsightsService: { getContactInsights: getContactInsightsMock },
    });
  });

  it('returns the insights for the contact in the active workspace with default period all', async () => {
    const data = { interactions: { correspondentId: 'c1' }, relatedCompanies: [] };
    getContactInsightsMock.mockResolvedValueOnce(data);

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(getContactInsightsMock).toHaveBeenCalledWith('c1', { since: undefined });
  });

  it('passes computed since date for 30d, 90d, ytd, and 12m', async () => {
    getContactInsightsMock.mockResolvedValue({ interactions: { correspondentId: 'c1' } });

    for (const p of ['30d', '90d', 'ytd', '12m']) {
      getContactInsightsMock.mockClear();
      const res = await GET(makeReq(`https://example.com/api/crm/correspondents/c1/insights?period=${p}`), params);
      expect(res.status).toBe(200);
      expect(getContactInsightsMock).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ since: expect.any(String) }),
      );
    }
  });

  it('returns 400 on an unknown period', async () => {
    const res = await GET(
      makeReq('https://example.com/api/crm/correspondents/c1/insights?period=invalid_period'),
      params,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid period' });
    expect(getContactInsightsMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the contact is not visible in the workspace', async () => {
    getContactInsightsMock.mockRejectedValueOnce(new ContactNotFoundError('c1'));

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getContactInsightsMock.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(makeReq(), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
