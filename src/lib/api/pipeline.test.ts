import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getCompaniesCount } from './pipeline';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({ count: 3 });
});

describe('getCompaniesCount', () => {
  it('sends source and excludeDropped so the count matches the Pending Confirmation tab', async () => {
    const count = await getCompaniesCount({
      stage: 'unreviewed',
      source: 'inbound',
      excludeDropped: true,
    });

    expect(count).toBe(3);
    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/companies?countOnly=true&stage=unreviewed&source=inbound&excludeDropped=true',
    );
  });

  it('omits filters that were not given', async () => {
    await getCompaniesCount({ stage: 'market_screening' });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/companies?countOnly=true&stage=market_screening',
    );
  });
});
