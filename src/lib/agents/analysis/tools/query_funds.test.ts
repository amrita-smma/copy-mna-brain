import { afterEach, describe, expect, it, vi } from 'vitest';

const listFundsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    fundService: { listFunds: listFundsMock },
  })),
}));

import { queryFunds } from './query_funds';

afterEach(() => vi.clearAllMocks());

describe('queryFunds', () => {
  it('returns an empty-state message when there are no funds', async () => {
    listFundsMock.mockResolvedValue([]);

    const result = (await queryFunds.invoke({})) as string;

    expect(result).toContain('No funds found in this workspace.');
  });

  it('renders a table row with formatted metrics for each fund', async () => {
    listFundsMock.mockResolvedValue([
      {
        id: 'f1',
        name: 'Growth Fund II',
        vintage_year: 2021,
        status: 'investing',
        commitment_size_amount: 100_000_000,
        called_amount: 60_000_000,
        fmv_amount: 80_000_000,
        realized_amount: 10_000_000,
        dpi: 0.17,
        tvpi: 1.5,
        irr: 0.185,
      },
    ]);

    const result = (await queryFunds.invoke({})) as string;

    expect(result).toContain('**Funds (1):**');
    expect(result).toContain('Growth Fund II');
    expect(result).toContain('1.50x'); // tvpi
    expect(result).toContain('18.5%'); // irr
    expect(result).toContain('100,000,000'); // commitment
  });

  it('filters by status case-insensitively', async () => {
    listFundsMock.mockResolvedValue([
      { id: 'f1', name: 'Active Fund', status: 'investing' },
      { id: 'f2', name: 'Old Fund', status: 'closed' },
    ]);

    const result = (await queryFunds.invoke({ status: 'CLOSED' })) as string;

    expect(result).toContain('Old Fund');
    expect(result).not.toContain('Active Fund');
  });

  it('reports when no fund matches the status filter', async () => {
    listFundsMock.mockResolvedValue([{ id: 'f1', name: 'Active Fund', status: 'investing' }]);

    const result = (await queryFunds.invoke({ status: 'harvesting' })) as string;

    expect(result).toContain('No funds found with status "harvesting".');
  });
});
