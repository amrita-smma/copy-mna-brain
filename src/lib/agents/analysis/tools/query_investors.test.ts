import { afterEach, describe, expect, it, vi } from 'vitest';

const listHoldingEntitiesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    holdingEntityService: { listHoldingEntities: listHoldingEntitiesMock },
  })),
}));

import { queryInvestors } from './query_investors';

afterEach(() => vi.clearAllMocks());

describe('queryInvestors', () => {
  it('returns an empty-state message when there are no investors', async () => {
    listHoldingEntitiesMock.mockResolvedValue([]);

    const result = (await queryInvestors.invoke({})) as string;

    expect(result).toContain('No investors (LPs) found');
  });

  it('renders formatted metrics for each investor', async () => {
    listHoldingEntitiesMock.mockResolvedValue([
      {
        name: 'Pension Fund A',
        entity_type: 'institutional',
        invested_amount: 25_000_000,
        realized_amount: 5_000_000,
        fmv_amount: 30_000_000,
        dpi: 0.2,
        moic: 1.4,
        irr: 0.16,
      },
    ]);

    const result = (await queryInvestors.invoke({})) as string;

    expect(result).toContain('**Investors / LPs (1):**');
    expect(result).toContain('Pension Fund A');
    expect(result).toContain('institutional');
    expect(result).toContain('1.40x'); // moic
    expect(result).toContain('16.0%'); // irr
  });
});
