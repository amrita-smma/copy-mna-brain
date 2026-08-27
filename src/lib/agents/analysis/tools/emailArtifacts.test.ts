import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findForAgentStats,
  findFinancials,
  findScreening,
  findFx,
  findByIds,
  findByNameFuzzy,
  getConnectedCompanies,
  getGraphData,
  createContainer,
  generateCompanyExcel,
  generateResearchSummaryPdf,
} = vi.hoisted(() => ({
  findForAgentStats: vi.fn(),
  findFinancials: vi.fn(),
  findScreening: vi.fn(),
  findFx: vi.fn(),
  findByIds: vi.fn(),
  findByNameFuzzy: vi.fn(),
  getConnectedCompanies: vi.fn(),
  getGraphData: vi.fn(),
  createContainer: vi.fn(),
  generateCompanyExcel: vi.fn(),
  generateResearchSummaryPdf: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    findForAgentStats = findForAgentStats;
    findByNameFuzzy = findByNameFuzzy;
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

vi.mock('@/lib/services/container', () => ({ createContainer }));
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
  findByNameFuzzy.mockReset().mockResolvedValue({ id: 'anchor', target: 'Acme' });
  getConnectedCompanies.mockReset().mockResolvedValue([
    { company: { id: 'c1', name: 'Beta' }, type: 'PARTNER', direction: 'outgoing' },
  ]);
  getGraphData.mockReset().mockResolvedValue({ nodes: [], links: [] });
  createContainer.mockReset().mockReturnValue({
    companyGraphService: { getConnectedCompanies, getGraphData },
  });
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

  // The is_live column is null for the common case of a deal that is live only
  // because an advisor is engaged; exporting it raw would contradict both the
  // app and the `is_live` filter the same cohort was selected with.
  it('exports the effective live status, not the raw override column', () => {
    const rows = (companies: unknown[]) =>
      buildCompanySheets({
        companies: companies as never,
        financials: [],
        screening: [],
        fx: [],
        userNamesById: new Map(),
      })[0].rows;

    expect(rows([{ id: 'a', is_live: null, advisor: 'Goldman' }])[0].is_live).toBe(true);
    expect(rows([{ id: 'b', is_live: null, advisor: '  ' }])[0].is_live).toBe(false);
    expect(rows([{ id: 'c', is_live: false, advisor: 'Goldman' }])[0].is_live).toBe(false);
  });

  it('renders the resolved Dropped By name it already looks up', () => {
    const sheets = buildCompanySheets({
      companies: [{ id: 'a', dropped_by: 'u3' } as never],
      financials: [],
      screening: [],
      fx: [],
      userNamesById: new Map([['u3', 'Dana']]),
    });

    expect(sheets[0].columns.map((c) => c.key)).toContain('dropped_by');
    expect(sheets[0].rows[0].dropped_by).toBe('Dana');
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

  // The export shares query_companies' filter vocabulary so any cohort the
  // agent can list, it can also export — including the exact rows it listed.
  it('scopes the export to the ids query_companies returned', async () => {
    await buildCompanyExcelAttachment({ company_ids: ['c1', 'c2'] });

    expect(findForAgentStats).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['c1', 'c2'] }),
    );
  });

  it('forwards the full filter vocabulary, not just the legacy subset', async () => {
    await buildCompanyExcelAttachment({
      workflow_status: 'NDA signed',
      is_live: true,
      advisor: 'Goldman',
      last_activity_after: '2026-01-01',
      deal_captain: 'Nico',
      entered_by: 'Bob',
    });

    expect(findForAgentStats).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowStatus: 'NDA signed',
        isLive: true,
        advisor: 'Goldman',
        lastActivityAfter: '2026-01-01',
        dealCaptain: 'Nico',
        enteredBy: 'Bob',
      }),
    );
  });

  // An unfiltered "email me the pipeline" must stay unfiltered — unlike the
  // read tools, the export deliberately has no L0–L5 stage default.
  it('does not narrow an unfiltered export to the L0–L5 funnel', async () => {
    await buildCompanyExcelAttachment({});

    expect(findForAgentStats.mock.calls[0][0].stageIn).toBeUndefined();
  });

  // findForAgentStats drops `discovered` stubs unless a stage filter names them,
  // so include_pre_pipeline has to spell the stages out to mean anything here.
  it('names every stage so include_pre_pipeline actually reaches discovered rows', async () => {
    await buildCompanyExcelAttachment({ include_pre_pipeline: true });

    expect(findForAgentStats.mock.calls[0][0].stageIn).toContain('discovered');
  });

  it('lets an explicit stage win over include_pre_pipeline', async () => {
    await buildCompanyExcelAttachment({ include_pre_pipeline: true, stage: 'L1' });

    const passed = findForAgentStats.mock.calls[0][0];
    expect(passed.stage).toBe('L1');
    expect(passed.stageIn).toBeUndefined();
  });

  it('surfaces the graph-filter note alongside the workbook', async () => {
    const result = await buildCompanyExcelAttachment({ connected_to: 'Acme' });

    expect(result!.notes.join(' ')).toContain('directly connected to Acme');
    expect(findForAgentStats).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['c1'] }),
    );
  });

  it('throws rather than exporting the wrong cohort when connected_to is unknown', async () => {
    findByNameFuzzy.mockResolvedValue(null);

    await expect(buildCompanyExcelAttachment({ connected_to: 'Ghost' })).rejects.toThrow(
      /Ghost/,
    );
    expect(generateCompanyExcel).not.toHaveBeenCalled();
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
