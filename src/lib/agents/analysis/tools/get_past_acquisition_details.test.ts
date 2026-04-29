import { afterEach, describe, expect, it, vi } from 'vitest';

const findByNameFuzzyMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  PastAcquisitionRepository: function PastAcquisitionRepository() {
    return { findByNameFuzzy: findByNameFuzzyMock };
  },
}));

import { getPastAcquisitionDetails } from './get_past_acquisition_details';

afterEach(() => vi.clearAllMocks());

describe('getPastAcquisitionDetails', () => {
  it('returns a not-found message when fuzzy search misses', async () => {
    findByNameFuzzyMock.mockResolvedValue(null);

    const result = (await getPastAcquisitionDetails.invoke({
      project_name: 'Ghost',
    })) as string;

    expect(result).toContain('No past acquisition found matching "Ghost"');
  });

  it('renders deal metrics, screening sections, and historical financials', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      no: '7',
      project_name: 'Project Alpha',
      project_type: 'Acquisition',
      target_co_partner: 'Acme Corp',
      country: 'US',
      sector: 'Tech',
      year: '2023',
      ev_100_pct_usd_m: '500',
      revenue_usd_m: '200',
      ebitda_usd_m: '40',
      ebitda_margin_pct: '20',
      revenue_2021_usd_m: '150',
      revenue_2022_usd_m: '180',
      revenue_2023_usd_m: '200',
      revenue_2024_usd_m: '220',
      pass_l0_screening: 'yes',
      pass_all_5_l1_criteria: 'yes',
      comments: 'Solid pipeline',
    });

    const result = (await getPastAcquisitionDetails.invoke({
      project_name: 'Alpha',
    })) as string;

    expect(result).toContain('## Past Acquisition Details: Project Alpha');
    expect(result).toContain('**Sector:** Tech');
    expect(result).toContain('### Historical Financials');
    expect(result).toContain('150');
    expect(result).toContain('### Comments');
    expect(result).toContain('Solid pipeline');
  });
});
