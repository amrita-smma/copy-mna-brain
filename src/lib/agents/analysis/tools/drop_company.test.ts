import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findByNameFuzzy, dropDeal, createDb, createContainer, getActiveWorkspaceId } = vi.hoisted(
  () => ({
    findByNameFuzzy: vi.fn(),
    dropDeal: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
  }),
);

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

import { dropCompany } from './drop_company';

const PENDING = { id: 'c-1', target: 'Acme', status: 'active', pipeline_stage: 'unreviewed' };

describe('drop_company', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset().mockResolvedValue(PENDING);
    dropDeal.mockReset().mockResolvedValue({});
    createDb.mockReset().mockReturnValue({});
    getActiveWorkspaceId.mockReset().mockResolvedValue('ws-1');
    createContainer.mockReset().mockReturnValue({ companyService: { dropDeal } });
  });

  it('drops the company at its current stage with the reason', async () => {
    const result = await dropCompany.invoke({ company_name: 'Acme', reason: 'Out of mandate' });

    expect(dropDeal).toHaveBeenCalledWith('c-1', 'unreviewed', 'Out of mandate');
    expect(String(result)).toMatch(/Dropped "Acme"/);
  });

  it('refuses inside an AI Screening task, so the Auto drop toggle cannot be bypassed', async () => {
    const result = await dropCompany.invoke(
      { company_name: 'Acme', reason: 'Failed AI screening' },
      { configurable: { agent_name: 'ai_screening' } },
    );

    expect(String(result)).toMatch(/not allowed in an AI Screening task/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(dropDeal).not.toHaveBeenCalled();
  });

  it('reports an already-dropped company without dropping it again', async () => {
    findByNameFuzzy.mockResolvedValueOnce({ ...PENDING, status: 'dropped' });

    const result = await dropCompany.invoke({ company_name: 'Acme', reason: 'Out of mandate' });

    expect(String(result)).toMatch(/already dropped/);
    expect(dropDeal).not.toHaveBeenCalled();
  });
});
