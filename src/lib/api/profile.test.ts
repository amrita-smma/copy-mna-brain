import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getProfileItems } from './profile';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('getProfileItems', () => {
  it('requests the endpoint with no query string when no limit is given', async () => {
    const items = {
      companies: { items: [], total: 0 },
      insights: { items: [], total: 0 },
      actionItems: { items: [], total: 0 },
    };
    apiRequestMock.mockResolvedValueOnce(items);

    expect(await getProfileItems()).toBe(items);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/profile/items');
  });

  it('passes the per-section limit through as a query param', async () => {
    apiRequestMock.mockResolvedValueOnce({});

    await getProfileItems({ limit: 8 });

    expect(apiRequestMock).toHaveBeenCalledWith('/api/profile/items?limit=8');
  });

  it('sends no user id — the endpoint reads the session', async () => {
    apiRequestMock.mockResolvedValueOnce({});

    await getProfileItems({ limit: 1 });

    const [url] = apiRequestMock.mock.calls[0]!;
    expect(url).not.toContain('user');
  });
});
