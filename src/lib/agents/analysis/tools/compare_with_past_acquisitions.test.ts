import { afterEach, describe, expect, it, vi } from 'vitest';

const findAllMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  PastAcquisitionRepository: function PastAcquisitionRepository() {
    return { findAll: findAllMock };
  },
}));

import { compareWithPastAcquisitions } from './compare_with_past_acquisitions';

afterEach(() => vi.clearAllMocks());

describe('compareWithPastAcquisitions', () => {
  it('reports when no past deals are available for comparison', async () => {
    findAllMock.mockResolvedValue([]);

    const result = (await compareWithPastAcquisitions.invoke({
      company_name: 'Acme',
    })) as string;

    expect(result).toBe('No past acquisitions data available for comparison.');
  });

  it('produces a comparison report with screening pass rates and metrics', async () => {
    findAllMock.mockResolvedValue([
      {
        project_name: 'Alpha',
        sector: 'Tech',
        country: 'US',
        ev_100_pct_usd_m: '500',
        revenue_usd_m: '200',
        ebitda_usd_m: '40',
        ebitda_margin_pct: '20',
        pass_l0_screening: 'yes',
        pass_all_5_l1_criteria: 'yes',
        status: 'Closed',
      },
      {
        project_name: 'Beta',
        sector: 'Tech',
        country: 'US',
        ev_100_pct_usd_m: '800',
        revenue_usd_m: '300',
        ebitda_usd_m: '50',
        ebitda_margin_pct: '17',
        pass_l0_screening: 'no',
        pass_all_5_l1_criteria: 'no',
        status: 'Dropped',
      },
    ]);

    const result = (await compareWithPastAcquisitions.invoke({
      company_name: 'Acme',
      sector: 'Tech',
      country: 'US',
      revenue_usd_m: 250,
      ebitda_usd_m: 45,
      ebitda_margin_pct: 18,
      ev_usd_m: 600,
    })) as string;

    expect(result).toContain('## Comparison Analysis: Acme');
    expect(result).toContain('**Total Past Acquisitions:** 2');
    expect(result).toContain('**L0 Screening Pass Rate:** 50.0%');
    expect(result).toContain('### Most Similar Past Deals');
    expect(result).toContain('Alpha');
    expect(result).toContain('✅ EBITDA margin >10%');
  });

  it('flags companies above the EV threshold', async () => {
    findAllMock.mockResolvedValue([
      { project_name: 'Big', sector: 'Tech', country: 'US', ev_100_pct_usd_m: '1500' },
    ]);

    const result = (await compareWithPastAcquisitions.invoke({
      company_name: 'Acme',
      ev_usd_m: 1200,
    })) as string;

    expect(result).toContain('⚠️ EV over $1B');
  });
});
