import { describe, expect, it } from 'vitest';
import { toCompanyDTO, splitCompanyDTO, formatCompanyDisplay } from './companyDTO';
import type { Tables } from '@/lib/repositories';

function makeCompany(overrides: Partial<Tables<'companies'>> = {}): Tables<'companies'> {
  return {
    id: 'c1',
    entry_id: null,
    watchlist_id: null,
    segment: null,
    target: 'Test Co',
    project_name: null,
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
    dropped_reason: null,
    dropped_at: null,
    promoted_reasons: null,
    deal_type: null,
    entered_by: null,
    originator: null,
    deal_sponsor: null,
    deal_captain: null,
    last_activity_at: null,
    banker: null,
    doc_type: null,
    stake: null,
    deal_size: null,
    workflow_status: null,
    key_rationale: null,
    banker_source: null,
    possible_duplicate_company_id: null,
    matched_track_ids: null,
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

describe('toCompanyDTO – project_name', () => {
  it('passes through project_name when set', () => {
    const dto = toCompanyDTO(makeCompany({ project_name: 'Project Phoenix' }), [], [], null);
    expect(dto.project_name).toBe('Project Phoenix');
  });

  it('passes through null project_name', () => {
    const dto = toCompanyDTO(makeCompany({ project_name: null }), [], [], null);
    expect(dto.project_name).toBeNull();
  });
});

describe('splitCompanyDTO – project_name', () => {
  it('splits project_name into the company write fragment', () => {
    const result = splitCompanyDTO({ project_name: 'Project Alpha' });
    expect(result.company.project_name).toBe('Project Alpha');
  });

  it('preserves null project_name in the company write fragment', () => {
    const result = splitCompanyDTO({ project_name: null });
    expect(result.company.project_name).toBeNull();
  });
});

describe('toCompanyDTO – inbound pipeline fields', () => {
  it('passes through the new inbound fields when set', () => {
    const dto = toCompanyDTO(
      makeCompany({
        deal_type: 'majority',
        originator: 'JW',
        last_activity_at: '2026-06-10T00:00:00Z',
        banker: 'Goldman Sachs',
        doc_type: 'teaser',
        stake: '60%',
        deal_size: '$95M',
        workflow_status: 'Teaser review',
      }),
      [],
      [],
      null,
    );
    expect(dto.deal_type).toBe('majority');
    expect(dto.originator).toBe('JW');
    expect(dto.last_activity_at).toBe('2026-06-10T00:00:00Z');
    expect(dto.banker).toBe('Goldman Sachs');
    expect(dto.doc_type).toBe('teaser');
    expect(dto.stake).toBe('60%');
    expect(dto.deal_size).toBe('$95M');
    expect(dto.workflow_status).toBe('Teaser review');
  });

  it('defaults the new inbound fields to null', () => {
    const dto = toCompanyDTO(makeCompany(), [], [], null);
    expect(dto.deal_type).toBeNull();
    expect(dto.originator).toBeNull();
    expect(dto.last_activity_at).toBeNull();
    expect(dto.banker).toBeNull();
    expect(dto.doc_type).toBeNull();
    expect(dto.stake).toBeNull();
    expect(dto.deal_size).toBeNull();
    expect(dto.workflow_status).toBeNull();
  });
});

describe('splitCompanyDTO – inbound pipeline fields', () => {
  it('routes the new inbound fields into the company write fragment', () => {
    const result = splitCompanyDTO({
      deal_type: 'minority',
      originator: 'NK',
      last_activity_at: '2026-06-12T00:00:00Z',
      banker: 'JP Morgan',
      doc_type: 'market_study',
      stake: '25%',
      deal_size: '$48M',
      workflow_status: 'NDA pending',
    });
    expect(result.company.deal_type).toBe('minority');
    expect(result.company.originator).toBe('NK');
    expect(result.company.last_activity_at).toBe('2026-06-12T00:00:00Z');
    expect(result.company.banker).toBe('JP Morgan');
    expect(result.company.doc_type).toBe('market_study');
    expect(result.company.stake).toBe('25%');
    expect(result.company.deal_size).toBe('$48M');
    expect(result.company.workflow_status).toBe('NDA pending');
  });

  it('preserves explicit null (clearing a field) and skips undefined', () => {
    const result = splitCompanyDTO({ workflow_status: null });
    expect(result.company.workflow_status).toBeNull();
    expect('banker' in result.company).toBe(false);
  });
});

describe('toCompanyDTO – outbound pipeline fields', () => {
  it('passes through the new outbound fields when set', () => {
    const dto = toCompanyDTO(
      makeCompany({
        key_rationale: 'Dominant supplier; strong strategic adjacency.',
        workflow_status: 'Discussions ongoing',
      }),
      [],
      [],
      null,
    );
    expect(dto.key_rationale).toBe('Dominant supplier; strong strategic adjacency.');
    expect(dto.workflow_status).toBe('Discussions ongoing');
  });

  it('defaults the new outbound fields to null', () => {
    const dto = toCompanyDTO(makeCompany(), [], [], null);
    expect(dto.key_rationale).toBeNull();
  });
});

describe('splitCompanyDTO – outbound pipeline fields', () => {
  it('routes the new outbound fields into the company write fragment', () => {
    const result = splitCompanyDTO({
      key_rationale: 'Niche IC packaging; high margin.',
    });
    expect(result.company.key_rationale).toBe('Niche IC packaging; high margin.');
  });

  it('preserves explicit null and skips undefined for outbound fields', () => {
    const result = splitCompanyDTO({ key_rationale: null });
    expect(result.company.key_rationale).toBeNull();
    expect('banker' in result.company).toBe(false);
  });
});

describe('formatCompanyDisplay', () => {
  it('returns company name alone when project_name is null', () => {
    expect(formatCompanyDisplay({ target: 'Acme Corp', project_name: null })).toBe('Acme Corp');
  });

  it('returns project_name alone when target is null', () => {
    expect(formatCompanyDisplay({ target: null, project_name: 'Project Phoenix' })).toBe('Project Phoenix');
  });

  it('joins both with em-dash when both are set', () => {
    expect(formatCompanyDisplay({ target: 'Acme Corp', project_name: 'Project Phoenix' })).toBe('Acme Corp — Project Phoenix');
  });

  it('returns fallback when both are null', () => {
    expect(formatCompanyDisplay({ target: null, project_name: null })).toBe('Unknown');
    expect(formatCompanyDisplay({ target: null, project_name: null }, 'N/A')).toBe('N/A');
  });
});

describe('entered_by', () => {
  it('passes entered_by through toCompanyDTO when set', () => {
    const dto = toCompanyDTO(
      makeCompany({ entered_by: 'AI Email Scanning' }),
      [],
      [],
      null,
    );
    expect(dto.entered_by).toBe('AI Email Scanning');
  });

  it('defaults entered_by to null', () => {
    const dto = toCompanyDTO(makeCompany(), [], [], null);
    expect(dto.entered_by).toBeNull();
  });

  it('routes entered_by into the company write fragment', () => {
    const result = splitCompanyDTO({ entered_by: 'Jane Doe' });
    expect(result.company.entered_by).toBe('Jane Doe');
  });

  it('preserves explicit null (clearing entered_by) and skips undefined', () => {
    const result = splitCompanyDTO({ entered_by: null });
    expect(result.company.entered_by).toBeNull();
    expect('entered_by' in splitCompanyDTO({}).company).toBe(false);
  });
});

describe('deal_sponsor / deal_captain', () => {
  it('passes both through toCompanyDTO when set', () => {
    const dto = toCompanyDTO(
      makeCompany({ deal_sponsor: 'Dicki Sujadi', deal_captain: 'Alex Lee' }),
      [],
      [],
      null,
    );
    expect(dto.deal_sponsor).toBe('Dicki Sujadi');
    expect(dto.deal_captain).toBe('Alex Lee');
  });

  it('defaults both to null', () => {
    const dto = toCompanyDTO(makeCompany(), [], [], null);
    expect(dto.deal_sponsor).toBeNull();
    expect(dto.deal_captain).toBeNull();
  });

  it('routes both into the company write fragment', () => {
    const result = splitCompanyDTO({ deal_sponsor: 'Dicki Sujadi', deal_captain: null });
    expect(result.company.deal_sponsor).toBe('Dicki Sujadi');
    expect(result.company.deal_captain).toBeNull();
  });
});

describe('matched_track_ids', () => {
  it('passes matched_track_ids through toCompanyDTO when set', () => {
    const dto = toCompanyDTO(
      makeCompany({ matched_track_ids: ['t1', 't2'] }),
      [],
      [],
      null,
    );
    expect(dto.matched_track_ids).toEqual(['t1', 't2']);
  });

  it('defaults matched_track_ids to an empty array when null', () => {
    const dto = toCompanyDTO(makeCompany({ matched_track_ids: null }), [], [], null);
    expect(dto.matched_track_ids).toEqual([]);
  });

  it('routes matched_track_ids into the company write fragment', () => {
    const result = splitCompanyDTO({ matched_track_ids: ['t1', 't2'] });
    expect(result.company.matched_track_ids).toEqual(['t1', 't2']);
  });

  it('preserves clearing matched_track_ids to an empty array', () => {
    const result = splitCompanyDTO({ matched_track_ids: [] });
    expect(result.company.matched_track_ids).toEqual([]);
  });
});
