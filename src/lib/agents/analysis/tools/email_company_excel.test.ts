import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const {
  findForAgentStats,
  findFinancials,
  findScreening,
  findFx,
  findAll,
  findByIds,
  generateCompanyExcel,
  sendCompanyExcelEmail,
} = vi.hoisted(() => ({
  findForAgentStats: vi.fn(),
  findFinancials: vi.fn(),
  findScreening: vi.fn(),
  findFx: vi.fn(),
  findAll: vi.fn(),
  findByIds: vi.fn(),
  generateCompanyExcel: vi.fn(),
  sendCompanyExcelEmail: vi.fn(),
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
    findAll = findAll;
    findByIds = findByIds;
  },
}));

vi.mock('@/lib/companyExcel', () => ({ generateCompanyExcel }));

vi.mock('@/lib/services/emailService', () => ({
  EmailService: class {
    sendCompanyExcelEmail = sendCompanyExcelEmail;
  },
}));

import { emailCompanyExcel, buildCompanySheets } from './email_company_excel';

function invoke(args: Record<string, unknown>, config?: RunnableConfig) {
  return emailCompanyExcel.invoke(args, config);
}

const PLATFORM_USERS = [
  { id: 'u1', name: 'Nico', email: 'nico@e.com', role: null },
  { id: 'u2', name: 'Bob', email: 'bob@e.com', role: null },
];

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
    findAll,
    findByIds,
    generateCompanyExcel,
    sendCompanyExcelEmail,
  ]) {
    m.mockReset();
  }
  findAll.mockResolvedValue(PLATFORM_USERS);
  findForAgentStats.mockResolvedValue([COMPANY]);
  findFinancials.mockResolvedValue([]);
  findScreening.mockResolvedValue([]);
  findFx.mockResolvedValue([]);
  findByIds.mockResolvedValue([
    { id: 'u1', name: 'Nico', email: 'nico@e.com' },
    { id: 'u2', name: 'Bob', email: 'bob@e.com' },
  ]);
  generateCompanyExcel.mockResolvedValue(Buffer.from('xlsx-bytes'));
  sendCompanyExcelEmail.mockResolvedValue({ messageId: 'msg-1' });
});

describe('email_company_excel', () => {
  it('errors when no recipients are given and no signed-in user is on the runtime', async () => {
    const result = String(await invoke({}, { configurable: {} }));
    expect(result).toMatch(/no signed-in user email/i);
    expect(sendCompanyExcelEmail).not.toHaveBeenCalled();
  });

  it('defaults to the signed-in user when recipients are omitted', async () => {
    const result = String(
      await invoke({}, { configurable: { userEmail: 'nico@e.com' } }),
    );
    expect(sendCompanyExcelEmail).toHaveBeenCalledTimes(1);
    expect(sendCompanyExcelEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'nico@e.com', companyCount: 1 }),
    );
    expect(result).toMatch(/Emailed an Excel export of 1 company to: nico@e\.com/);
  });

  it('returns a no-match message (and sends nothing) when the filter matches no companies', async () => {
    findForAgentStats.mockResolvedValue([]);
    const result = String(
      await invoke({ segment: 'Nonexistent' }, { configurable: { userEmail: 'nico@e.com' } }),
    );
    expect(result).toMatch(/No companies matched/i);
    expect(generateCompanyExcel).not.toHaveBeenCalled();
    expect(sendCompanyExcelEmail).not.toHaveBeenCalled();
  });

  it('sends to explicit platform-user recipients and skips non-platform ones', async () => {
    const result = String(
      await invoke({ recipients: ['bob@e.com', 'stranger@x.com'] }),
    );
    expect(sendCompanyExcelEmail).toHaveBeenCalledTimes(1);
    expect(sendCompanyExcelEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@e.com' }),
    );
    expect(result).toMatch(/bob@e\.com/);
    expect(result).toMatch(/Skipped 1 address/i);
    expect(result).toMatch(/stranger@x\.com/);
  });

  it('errors when none of the explicit recipients are platform users', async () => {
    const result = String(await invoke({ recipients: ['stranger@x.com'] }));
    expect(sendCompanyExcelEmail).not.toHaveBeenCalled();
    expect(result).toMatch(/^\*\*Error:\*\*/);
    expect(result).toMatch(/registered platform users/i);
  });

  it('rejects malformed recipient addresses', async () => {
    const result = String(await invoke({ recipients: ['not-an-email'] }));
    expect(result).toMatch(/malformed/i);
    expect(generateCompanyExcel).not.toHaveBeenCalled();
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

    // Only Companies + Financials sheets (screening/fx empty).
    expect(sheets.map((s) => s.name)).toEqual(['Companies', 'Financials by Year']);

    const companiesRow = sheets[0].rows[0];
    expect(companiesRow.deal_sponsor).toBe('Nico');
    expect(companiesRow.entered_by).toBe('Bob');
    // Latest fiscal year (2024) is used for the summary columns.
    expect(companiesRow.latest_fy).toBe(2024);
    expect(companiesRow.latest_revenue).toBe(112);
    expect(companiesRow.latest_margin).toBe(24);
  });
});
