import { afterEach, describe, expect, it, vi } from 'vitest';

const { findBestCompanyMatchMock } = vi.hoisted(() => ({
  findBestCompanyMatchMock: vi.fn(),
}));

vi.mock('@/lib/fuzzySearch', () => ({
  findBestCompanyMatch: findBestCompanyMatchMock,
}));

import { fuzzySearchCompanyTool } from './fuzzy_search_company';

afterEach(() => vi.clearAllMocks());

describe('fuzzySearchCompanyTool', () => {
  it('returns the closest match when one is found', async () => {
    findBestCompanyMatchMock.mockResolvedValue({
      id: 'c1',
      name: 'Acme Corp',
      type: 'company',
      similarity: 0.92,
    });

    const raw = (await fuzzySearchCompanyTool.invoke({ name: 'Acme' })) as string;
    const parsed = JSON.parse(raw);

    expect(parsed.found).toBe(true);
    expect(parsed.match).toEqual({
      id: 'c1',
      name: 'Acme Corp',
      type: 'company',
      similarity: 0.92,
    });
  });

  it('returns found=false when no match is close enough', async () => {
    findBestCompanyMatchMock.mockResolvedValue(null);

    const raw = (await fuzzySearchCompanyTool.invoke({ name: 'Ghost' })) as string;
    const parsed = JSON.parse(raw);

    expect(parsed.found).toBe(false);
    expect(parsed.message).toBe('No close match found.');
  });

  it('serializes the error message when the matcher throws', async () => {
    findBestCompanyMatchMock.mockRejectedValue(new Error('lookup failed'));

    const raw = (await fuzzySearchCompanyTool.invoke({ name: 'Acme' })) as string;
    const parsed = JSON.parse(raw);

    expect(parsed.error).toBe('lookup failed');
  });
});
