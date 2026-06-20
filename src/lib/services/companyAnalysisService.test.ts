import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyAnalysisRepository, CompanyRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { CompanyAnalysisService, COMPANY_CARD_AGENT_NAME } from './companyAnalysisService';

const { enqueueAgentRun } = vi.hoisted(() => ({ enqueueAgentRun: vi.fn() }));
vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

type Analysis = Tables<'company_analyses'>;

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    id: 'analysis-1',
    company_id: 'company-1',
    status: 'completed',
    business_overview: null,
    business_model_summary: null,
    key_takeaways: null,
    investment_highlights: null,
    investment_risks: null,
    diligence_priorities: null,
    sources: null,
    error_message: null,
    job_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Analysis;
}

const findCompletedByCompanyId = vi.fn();
const findById = vi.fn();

function makeService(): CompanyAnalysisService {
  return new CompanyAnalysisService(
    { findCompletedByCompanyId } as unknown as CompanyAnalysisRepository,
    { findById } as unknown as CompanyRepository,
    {} as never,
  );
}

describe('CompanyAnalysisService.dispatch', () => {
  let service: CompanyAnalysisService;

  beforeEach(() => {
    findCompletedByCompanyId.mockReset();
    findById.mockReset();
    enqueueAgentRun.mockReset();
    service = makeService();
  });

  it('returns the existing analysis when one is already completed (idempotent)', async () => {
    const existing = makeAnalysis({ status: 'completed' });
    findCompletedByCompanyId.mockResolvedValue(existing);

    const result = await service.dispatch({ companyId: 'company-1' });

    expect(result).toEqual({ existing });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('enqueues an AI Workforce run when no completed analysis exists', async () => {
    findCompletedByCompanyId.mockResolvedValue(undefined);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-new', created: true });

    const result = await service.dispatch(
      { companyId: 'company-1', source: 'files' },
      'user-42',
    );

    expect(result).toEqual({ runId: 'run-new' });
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input).toMatchObject({
      agentName: COMPANY_CARD_AGENT_NAME,
      triggerSource: 'api',
      triggerMeta: { company_id: 'company-1', source: 'files' },
      // The run is owned by the user who triggered it, not "System".
      triggeredByUserId: 'user-42',
    });
    // The instruction names the company and the tool + id the worker must call.
    expect(input.input.company_id).toBe('company-1');
    expect(input.input.prompt).toMatch(/Acme Corp/);
    expect(input.input.prompt).toMatch(/generate_company_card/);
    expect(input.input.prompt).toContain('company-1');
  });

  it('defaults triggeredByUserId to null when no user is provided', async () => {
    findCompletedByCompanyId.mockResolvedValue(undefined);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-new', created: true });

    await service.dispatch({ companyId: 'company-1' });

    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input.triggeredByUserId).toBeNull();
  });

  it('falls back to a generic company label when the company row is missing', async () => {
    findCompletedByCompanyId.mockResolvedValue(undefined);
    findById.mockResolvedValue(null);
    enqueueAgentRun.mockResolvedValue({ runId: 'run-2', created: true });

    await service.dispatch({ companyId: 'company-9' });

    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input.input.prompt).toMatch(/the company/);
  });
});
