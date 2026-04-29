import { afterEach, describe, expect, it, vi } from 'vitest';

const searchForAgentMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  PastAcquisitionRepository: function PastAcquisitionRepository() {
    return { searchForAgent: searchForAgentMock };
  },
}));

import { queryPastAcquisitions } from './query_past_acquisitions';

afterEach(() => vi.clearAllMocks());

describe('queryPastAcquisitions', () => {
  it('returns the empty-state message when no deals match', async () => {
    searchForAgentMock.mockResolvedValue([]);

    const result = (await queryPastAcquisitions.invoke({ sector: 'Tech' })) as string;

    expect(result).toBe('No past acquisitions found matching your criteria.');
    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ sector: 'Tech', limit: 20 }),
    );
  });

  it('formats matching deals as a markdown table with metrics', async () => {
    searchForAgentMock.mockResolvedValue([
      {
        project_name: 'Project Alpha',
        project_type: 'Acquisition',
        sector: 'Tech',
        country: 'US',
        ev_100_pct_usd_m: '500',
        revenue_usd_m: '200',
        ebitda_usd_m: '40',
        status: 'Closed',
        year: '2024',
      },
    ]);

    const result = (await queryPastAcquisitions.invoke({})) as string;

    expect(result).toContain('Past Acquisitions (1 deals)');
    expect(result).toContain('Project Alpha');
    expect(result).toContain('Closed');
    expect(result).toContain('2024');
  });

  it('returns a formatted error message when the repository throws', async () => {
    searchForAgentMock.mockRejectedValue(new Error('db lost'));

    const result = (await queryPastAcquisitions.invoke({})) as string;

    expect(result).toContain('**Error:** db lost');
  });
});
