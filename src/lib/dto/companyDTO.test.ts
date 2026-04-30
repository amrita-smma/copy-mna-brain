import { describe, expect, it } from 'vitest';
import { toCompanyDTO } from './companyDTO';
import type { Tables } from '@/lib/repositories';

function makeCompany(overrides: Partial<Tables<'companies'>> = {}): Tables<'companies'> {
  return {
    id: 'c1',
    entry_id: null,
    watchlist_id: null,
    segment: null,
    target: 'Test Co',
    segment_related_offerings: null,
    company_focus: null,
    website: null,
    watchlist_status: null,
    comments: null,
    ownership: null,
    geography: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    pipeline_stage: 'L0',
    remarks: null,
    thesis_content: null,
    source: null,
    status: null,
    ...overrides,
  };
}

function makeFinancial(
  fiscal_year: number,
  overrides: Partial<Tables<'company_financials'>> = {},
): Tables<'company_financials'> {
  return {
    id: `fin-${fiscal_year}`,
    company_id: 'c1',
    fiscal_year,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    ebitda_margin: null,
    ev_ebitda: null,
    revenue_cagr_vs_prior: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('toCompanyDTO – financials_raw', () => {
  it('passes through all financial rows regardless of year', () => {
    const rows = [
      makeFinancial(2020, { revenue_usd_mn: 10 }),
      makeFinancial(2025, { revenue_usd_mn: 50 }),
      makeFinancial(2030, { revenue_usd_mn: 100 }),
    ];
    const dto = toCompanyDTO(makeCompany(), rows, [], null);
    expect(dto.financials_raw).toHaveLength(3);
    expect(dto.financials_raw.map((r) => r.fiscal_year)).toEqual([2020, 2025, 2030]);
  });

  it('returns an empty array when there are no financial rows', () => {
    const dto = toCompanyDTO(makeCompany(), [], [], null);
    expect(dto.financials_raw).toEqual([]);
  });

  it('preserves row order from the input array (caller provides ordered rows)', () => {
    const rows = [
      makeFinancial(2023, { revenue_usd_mn: 60 }),
      makeFinancial(2022, { revenue_usd_mn: 50 }),
      makeFinancial(2024, { revenue_usd_mn: 70 }),
    ];
    const dto = toCompanyDTO(makeCompany(), rows, [], null);
    expect(dto.financials_raw.map((r) => r.fiscal_year)).toEqual([2023, 2022, 2024]);
  });

  it('still populates the legacy flat keys for TRACKED_YEARS from the same rows', () => {
    const rows = [
      makeFinancial(2022, { revenue_usd_mn: 50 }),
      makeFinancial(2023, { revenue_usd_mn: 60 }),
      makeFinancial(2024, { revenue_usd_mn: 70 }),
    ];
    const dto = toCompanyDTO(makeCompany(), rows, [], null);
    expect(dto.revenue_2022_usd_mn).toBe(50);
    expect(dto.revenue_2023_usd_mn).toBe(60);
    expect(dto.revenue_2024_usd_mn).toBe(70);
    // 2025 is now a tracked year — should appear as a legacy flat key
    const rowsWithExtra = [...rows, makeFinancial(2025, { revenue_usd_mn: 80 })];
    const dto2 = toCompanyDTO(makeCompany(), rowsWithExtra, [], null);
    expect(dto2.financials_raw).toHaveLength(4);
    expect(dto2.revenue_2025_usd_mn).toBe(80);
  });
});
