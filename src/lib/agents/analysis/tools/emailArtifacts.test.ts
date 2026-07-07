import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findForAgentStats,
  findFinancials,
  findScreening,
  findFx,
  findByIds,
  generateCompanyExcel,
  generateResearchSummaryPdf,
} = vi.hoisted(() => ({
  findForAgentStats: vi.fn(),
  findFinancials: vi.fn(),
  findScreening: vi.fn(),
  findFx: vi.fn(),
  findByIds: vi.fn(),
  generateCompanyExcel: vi.fn(),
  generateResearchSummaryPdf: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    findForAgentStats = findForAgentStats;
  },
  CompanyFinancialRepository: class {
    findByCompanies = findFinancials;
  },
  CompanyScreeningDerivedRepository: class {
    findByCompanies = findScreening;
  },
  CompanyFxAdjustmentRepository: class {
    findByCompanies = findFx;
  },
  UserRepository: class {
    findByIds = findByIds;
  },
}));

vi.mock('@/lib/companyExcel', () => ({ generateCompanyExcel }));
vi.mock('@/lib/pdfSummary', () => ({ generateResearchSummaryPdf }));

import {
  buildCompanySheets,
  buildCompanyExcelAttachment,
  buildResearchSummaryAttachment,
  summarizeFilters,
  slugifyTitle,
} from './emailArtifacts';

const COMPANY = {
  id: 'c1',
  target: 'Acme',
  project_name: 'Project A',
  deal_sponsor: 'u1',
  deal_captain: null,
  entered_by: 'u2',
  dropped_by: null,
};

beforeEach(() => {
  for (const m of [
    findForAgentStats,
    findFinancials,
    findScreening,
    findFx,
    findByIds,
    generateCompanyExcel,
    generateResearchSummaryPdf,
  ]) {
    m.mockReset();
  }
  findForAgentStats.mockResolvedValue([COMPANY]);
  findFinancials.mockResolvedValue([]);
  findScreening.mockResolvedValue([]);
  findFx.mockResolvedValue([]);
  findByIds.mockResolvedValue([
    { id: 'u1', name: 'Nico' },
    { id: 'u2', name: 'Bob' },
  ]);
  generateCompanyExcel.mockResolvedValue(Buffer.from('xlsx-bytes'));
  generateResearchSummaryPdf.mockResolvedValue(Buffer.from('%PDF-1.4'));
});

describe('slugifyTitle', () => {
  it('lowercases, hyphenates, and falls back when empty', () => {
    expect(slugifyTitle('Family-owned Japan targets', 'x')).toBe(
      'family-owned-japan-targets',
    );
    expect(slugifyTitle('!!!', 'fallback')).toBe('fallback');
  });
});

describe('summarizeFilters', () => {
  it('summarizes active filters and reports "all" when none set', () => {
    expect(summarizeFilters({})).toMatch(/All companies/i);
    expect(summarizeFilters({ stage: 'L1', geography: 'Japan' })).toBe(
      'geography=Japan, stage=L1',
    );
  });
});

describe('buildCompanySheets', () => {
  it('resolves user names, includes latest-year financials, and only adds non-empty detail sheets', () => {
    const sheets = buildCompanySheets({
      companies: [COMPANY as never],
      financials: [
        { company_id: 'c1', fiscal_year: 2023, revenue_usd_mn: 90, ebitda_margin: 0.2 } as never,
        { company_id: 'c1', fiscal_year: 2024, revenue_usd_mn: 112, ebitda_margin: 0.24 } as never,
      ],
      screening: [],
      fx: [],
      userNamesById: new Map([
        ['u1', 'Nico'],
        ['u2', 'Bob'],
      ]),
    });

    expect(sheets.map((s) => s.name)).toEqual(['Companies', 'Financials by Year']);
    const companiesRow = sheets[0].rows[0];
    expect(companiesRow.deal_sponsor).toBe('Nico');
    expect(companiesRow.entered_by).toBe('Bob');
    expect(companiesRow.latest_fy).toBe(2024);
    expect(companiesRow.latest_revenue).toBe(112);
    expect(companiesRow.latest_margin).toBe(24);
  });
});

describe('buildCompanyExcelAttachment', () => {
  it('returns null when the filter matches no companies (no workbook generated)', async () => {
    findForAgentStats.mockResolvedValue([]);
    const result = await buildCompanyExcelAttachment({ segment: 'Nonexistent' });
    expect(result).toBeNull();
    expect(generateCompanyExcel).not.toHaveBeenCalled();
  });

  it('builds a .xlsx attachment with the right content type, filename, and count', async () => {
    const result = await buildCompanyExcelAttachment({ title: 'My Export' });
    expect(result).not.toBeNull();
    expect(result!.companyCount).toBe(1);
    expect(result!.attachment.filename).toBe('my-export.xlsx');
    expect(result!.attachment.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result!.attachment.content).toBeInstanceOf(Buffer);
    expect(generateCompanyExcel).toHaveBeenCalledTimes(1);
  });
});

describe('buildResearchSummaryAttachment', () => {
  it('renders a PDF attachment and stamps the "prepared for" label into the subtitle', async () => {
    const result = await buildResearchSummaryAttachment(
      { title: 'Acme summary', sections: [{ kind: 'paragraph', text: 'x' }] },
      'nico@e.com',
    );
    expect(result.attachment.filename).toBe('acme-summary.pdf');
    expect(result.attachment.contentType).toBe('application/pdf');
    expect(generateResearchSummaryPdf).toHaveBeenCalledTimes(1);
    const arg = generateResearchSummaryPdf.mock.calls[0][0];
    expect(arg.title).toBe('Acme summary');
    expect(arg.subtitle).toMatch(/nico@e\.com/);
    expect(arg.sections).toHaveLength(1);
  });

  it('maps references with explicit null defaults for missing link/date', async () => {
    await buildResearchSummaryAttachment({
      title: 't',
      sections: [{ kind: 'paragraph', text: 'x' }],
      references: [
        { name: 'Q1 memo', link: 'https://example.com', date: '2025-03-01' },
        { name: 'Industry report' },
      ],
    });
    const arg = generateResearchSummaryPdf.mock.calls[0][0];
    expect(arg.references).toEqual([
      { name: 'Q1 memo', link: 'https://example.com', date: '2025-03-01' },
      { name: 'Industry report', link: null, date: null },
    ]);
  });
});
