import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findByNameFuzzy, update, promote, createDb, createContainer, getActiveWorkspaceId } =
  vi.hoisted(() => ({
    findByNameFuzzy: vi.fn(),
    update: vi.fn(),
    promote: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return { ...actual, CompanyRepository: MockCompanyRepository };
});

import { promoteToL0 } from './promote_to_l0';

function call(args: {
  company_name: string;
  reason: string;
  note?: string;
  segment?: string;
  geography?: string;
  deal_type?: string;
  source?: string;
}) {
  return promoteToL0.invoke(args as never);
}

const DISCOVERED = {
  id: 'c-1',
  target: 'Acme',
  status: 'active',
  pipeline_stage: 'discovered',
  source: 'outbound',
};

describe('promote_to_l0 deal_type handling', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset().mockResolvedValue(DISCOVERED);
    update.mockReset().mockResolvedValue({});
    promote.mockReset().mockResolvedValue({});
    createDb.mockReset().mockReturnValue({});
    getActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
    createContainer.mockReset().mockReturnValue({ companyService: { update, promote } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('writes an enum value through unchanged', async () => {
    await call({ company_name: 'Acme', reason: 'Fits the thesis', deal_type: 'bond_issuance' });

    expect(update).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ deal_type: 'bond_issuance' }),
    );
  });

  it('normalizes the spellings a human or an LLM writes', async () => {
    // deal_type is a Postgres enum, so "Public Market Investing" written
    // straight through would fail the update.
    for (const [input, expected] of [
      ['Majority', 'majority'],
      ['Public Market Investing', 'public_market'],
      ['M&A Advisory', 'ma_advisory'],
      ['IPO', 'ipo'],
      ['Equity Crowdfunding', 'equity_crowdfunding'],
    ] as const) {
      update.mockClear();
      await call({ company_name: 'Acme', reason: 'Fits the thesis', deal_type: input });
      expect(update).toHaveBeenCalledWith('c-1', expect.objectContaining({ deal_type: expected }));
    }
  });

  it('refuses an unrecognized deal_type instead of writing it', async () => {
    const result = await call({
      company_name: 'Acme',
      reason: 'Fits the thesis',
      deal_type: 'controlling interest',
    });

    expect(String(result)).toMatch(/deal_type must be one of/);
    expect(update).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it('leaves deal_type out of the patch when it is not supplied', async () => {
    await call({ company_name: 'Acme', reason: 'Fits the thesis', segment: 'Semis' });

    const [, patch] = update.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch).not.toHaveProperty('deal_type');
    expect(patch).toMatchObject({ segment: 'Semis' });
  });
});

describe('promote_to_l0 inside an AI Screening task', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset().mockResolvedValue({ ...DISCOVERED, pipeline_stage: 'unreviewed' });
    update.mockReset().mockResolvedValue({});
    promote.mockReset().mockResolvedValue({});
    createDb.mockReset().mockReturnValue({});
    getActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
    createContainer.mockReset().mockReturnValue({ companyService: { update, promote } });
  });

  it('refuses without promoting, so the Auto promote toggle cannot be bypassed', async () => {
    const result = await promoteToL0.invoke(
      { company_name: 'Acme', reason: 'Passed AI screening' },
      { configurable: { agent_name: 'ai_screening' } },
    );

    expect(String(result)).toMatch(/not allowed in an AI Screening task/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it('still promotes for any other workforce task', async () => {
    await promoteToL0.invoke(
      { company_name: 'Acme', reason: 'Fits the thesis' },
      { configurable: { agent_name: 'workforce' } },
    );

    expect(promote).toHaveBeenCalledTimes(1);
  });
});
