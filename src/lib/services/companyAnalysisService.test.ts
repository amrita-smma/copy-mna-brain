import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyAnalysisRepository, CompanyRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { CompanyAnalysisService, COMPANY_CARD_AGENT_NAME } from './companyAnalysisService';

const {
  enqueueAgentRun,
  findActiveByCompanyId,
  findActiveCompanyIds,
  findQueueRowById,
  cancelById,
  generateCompanyCard,
} = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  findActiveByCompanyId: vi.fn(),
  findActiveCompanyIds: vi.fn(),
  findQueueRowById: vi.fn(),
  cancelById: vi.fn(),
  generateCompanyCard: vi.fn(),
}));
vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));
vi.mock('@/lib/jobs/handlers/companyAnalysis', () => ({ generateCompanyCard }));
vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {
    findActiveByCompanyId = findActiveByCompanyId;
    findActiveCompanyIds = findActiveCompanyIds;
    findById = findQueueRowById;
    cancelById = cancelById;
  },
  isTerminalWorkforceStatus: (status: string) =>
    ['succeeded', 'failed', 'rejected', 'timed_out'].includes(status),
}));

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
const deleteByCompanyId = vi.fn();
const findIdAndNameByIds = vi.fn();
const findCompletedCompanyIds = vi.fn();

function makeService(): CompanyAnalysisService {
  return new CompanyAnalysisService(
    { findCompletedByCompanyId, findCompletedCompanyIds, deleteByCompanyId } as unknown as CompanyAnalysisRepository,
    { findById, findIdAndNameByIds } as unknown as CompanyRepository,
    {} as never,
    'workspace-1',
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

describe('CompanyAnalysisService.generateNowIfMissing', () => {
  let service: CompanyAnalysisService;
  const related = [{ name: 'Beta', relation_type: 'SUPPLIER' }];

  beforeEach(() => {
    findCompletedByCompanyId.mockReset().mockResolvedValue(null);
    findActiveByCompanyId.mockReset().mockResolvedValue(null);
    cancelById.mockReset().mockResolvedValue({ id: 'queue-1' });
    enqueueAgentRun.mockReset();
    generateCompanyCard.mockReset().mockResolvedValue({
      analysis: makeAnalysis(),
      companyName: 'Acme',
      relatedCompanies: related,
    });
    service = makeService();
  });

  it('does nothing when a completed card already exists', async () => {
    findCompletedByCompanyId.mockResolvedValue(makeAnalysis({ status: 'completed' }));

    await expect(service.generateNowIfMissing('company-1')).resolves.toEqual({ status: 'exists' });
    expect(findActiveByCompanyId).not.toHaveBeenCalled();
    expect(generateCompanyCard).not.toHaveBeenCalled();
  });

  it('generates the card inline in this workspace, without queueing a separate run', async () => {
    await expect(
      service.generateNowIfMissing('company-1', { source: 'pending_scan' }),
    ).resolves.toEqual({ status: 'generated', companyName: 'Acme', relatedCompanies: related });
    expect(generateCompanyCard).toHaveBeenCalledWith(
      { companyId: 'company-1', source: 'pending_scan' },
      { db: {}, workspaceId: 'workspace-1' },
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(cancelById).not.toHaveBeenCalled();
  });

  it('cancels a card run still waiting in the queue and generates inline instead', async () => {
    findActiveByCompanyId.mockResolvedValue({ id: 'queue-1', status: 'pending' });

    await expect(service.generateNowIfMissing('company-1')).resolves.toMatchObject({
      status: 'generated',
    });
    expect(findActiveByCompanyId).toHaveBeenCalledWith(COMPANY_CARD_AGENT_NAME, 'company-1');
    expect(cancelById).toHaveBeenCalledWith('queue-1', {
      reason: expect.stringMatching(/Superseded/),
    });
    expect(generateCompanyCard).toHaveBeenCalledTimes(1);
  });

  it('leaves a card run that is already executing alone', async () => {
    findActiveByCompanyId.mockResolvedValue({ id: 'queue-1', status: 'running' });

    await expect(service.generateNowIfMissing('company-1')).resolves.toEqual({
      status: 'already_running',
    });
    expect(cancelById).not.toHaveBeenCalled();
    expect(generateCompanyCard).not.toHaveBeenCalled();
  });

  it('propagates a generation failure to the caller', async () => {
    generateCompanyCard.mockRejectedValue(new Error('agent unavailable'));

    await expect(service.generateNowIfMissing('company-1')).rejects.toThrow('agent unavailable');
  });
});

describe('CompanyAnalysisService.findCompanyIdsWithCard', () => {
  it('delegates to the batched repository lookup', async () => {
    findCompletedCompanyIds.mockReset().mockResolvedValue(new Set(['c1']));

    await expect(makeService().findCompanyIdsWithCard(['c1', 'c2'])).resolves.toEqual(
      new Set(['c1']),
    );
    expect(findCompletedCompanyIds).toHaveBeenCalledWith(['c1', 'c2']);
  });
});

describe('CompanyAnalysisService.regenerate', () => {
  let service: CompanyAnalysisService;

  beforeEach(() => {
    findCompletedByCompanyId.mockReset();
    findById.mockReset();
    enqueueAgentRun.mockReset();
    findActiveByCompanyId.mockReset();
    service = makeService();
  });

  it('enqueues a fresh run even though a completed card already exists', async () => {
    // The whole point of regenerate: unlike dispatch it is NOT idempotent on a
    // completed card, because a stage move must re-research the company.
    findCompletedByCompanyId.mockResolvedValue(makeAnalysis({ status: 'completed' }));
    findActiveByCompanyId.mockResolvedValue(null);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-regen', created: true });

    const result = await service.regenerate('company-1', {
      reason: 'stage move L1 -> L2',
      source: 'stage_move',
    });

    expect(result).toEqual({ runId: 'run-regen' });
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
  });

  it('never deletes the existing card row, so its timestamp survives for the date comparison', async () => {
    findActiveByCompanyId.mockResolvedValue(null);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-regen', created: true });

    await service.regenerate('company-1');

    expect(deleteByCompanyId).not.toHaveBeenCalled();
  });

  it('skips without enqueueing when a card run is already in flight', async () => {
    findActiveByCompanyId.mockResolvedValue({ id: 'queue-1', status: 'running' });

    const result = await service.regenerate('company-1', { reason: 'stage move L1 -> L2' });

    expect(result).toEqual({ skipped: 'already_running' });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(findActiveByCompanyId).toHaveBeenCalledWith(COMPANY_CARD_AGENT_NAME, 'company-1');
  });

  it('records the reason on the queue row and tells the agent the later-dated source wins', async () => {
    findActiveByCompanyId.mockResolvedValue(null);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-regen', created: true });

    await service.regenerate('company-1', {
      reason: 'stage move L1 -> L2',
      source: 'stage_move',
      triggeredByUserId: 'user-7',
    });

    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input).toMatchObject({
      agentName: COMPANY_CARD_AGENT_NAME,
      triggerMeta: {
        company_id: 'company-1',
        source: 'stage_move',
        reason: 'stage move L1 -> L2',
      },
      triggeredByUserId: 'user-7',
    });
    expect(input.input.title).toMatch(/refresh/i);
    expect(input.input.prompt).toMatch(/REGENERATION/);
    expect(input.input.prompt).toMatch(/stage move L1 -> L2/);
    expect(input.input.prompt).toMatch(/later-dated source wins/);
    expect(input.input.prompt).toMatch(/generate_company_card/);
  });

  it('treats a blank reason as no reason', async () => {
    findActiveByCompanyId.mockResolvedValue(null);
    findById.mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockResolvedValue({ runId: 'run-regen', created: true });

    await service.regenerate('company-1', { reason: '   ' });

    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input.triggerMeta.reason).toBeNull();
    expect(input.input.title).toBe('Company card: Acme Corp');
  });
});

describe('CompanyAnalysisService.regenerate — concurrency guard', () => {
  let service: CompanyAnalysisService;

  beforeEach(() => {
    findActiveByCompanyId.mockReset().mockResolvedValue(null);
    findById.mockReset().mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockReset().mockResolvedValue({ runId: 'run-1', created: true });
    service = makeService();
  });

  it('passes an idempotency key so a concurrent request collapses at the unique index', async () => {
    // findActiveByCompanyId is a read-then-write, so two simultaneous stage
    // moves can both see "nothing running"; the key is what actually stops the
    // second insert.
    await service.regenerate('company-1');

    const [, input] = enqueueAgentRun.mock.calls[0];
    expect(input.idempotencyKey).toMatch(/^company_card:regen:company-1:\d+$/);
  });

  it('uses the same key for two requests in the same minute and the company', async () => {
    await service.regenerate('company-1');
    await service.regenerate('company-1');

    const [, first] = enqueueAgentRun.mock.calls[0];
    const [, second] = enqueueAgentRun.mock.calls[1];
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('keys separate companies separately', async () => {
    await service.regenerate('company-1');
    await service.regenerate('company-2');

    const [, first] = enqueueAgentRun.mock.calls[0];
    const [, second] = enqueueAgentRun.mock.calls[1];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe('CompanyAnalysisService.regenerateMany', () => {
  let service: CompanyAnalysisService;

  beforeEach(() => {
    findActiveCompanyIds.mockReset().mockResolvedValue(new Set());
    findById.mockReset();
    findIdAndNameByIds.mockReset().mockResolvedValue([
      { id: 'c-1', target: 'Acme Corp', project_name: null },
      { id: 'c-2', target: null, project_name: 'Project Beta' },
    ]);
    enqueueAgentRun.mockReset().mockResolvedValue({ runId: 'run-1', created: true });
    service = makeService();
  });

  it('resolves in-flight runs and names in one batched query each, not per company', async () => {
    await service.regenerateMany(['c-1', 'c-2'], { source: 'stage_move' });

    expect(findActiveCompanyIds).toHaveBeenCalledOnce();
    expect(findActiveCompanyIds).toHaveBeenCalledWith(COMPANY_CARD_AGENT_NAME, ['c-1', 'c-2']);
    expect(findIdAndNameByIds).toHaveBeenCalledOnce();
    expect(findIdAndNameByIds).toHaveBeenCalledWith(['c-1', 'c-2']);
    // No per-company row read at all.
    expect(findById).not.toHaveBeenCalled();
  });

  it('enqueues one run per company, naming each from the batched lookup', async () => {
    const result = await service.regenerateMany(['c-1', 'c-2']);

    expect(result).toEqual({ enqueued: ['c-1', 'c-2'], skipped: [] });
    expect(enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(enqueueAgentRun.mock.calls[0][1].input.prompt).toContain('Acme Corp');
    expect(enqueueAgentRun.mock.calls[1][1].input.prompt).toContain('Project Beta');
  });

  it('skips companies that already have a run in flight', async () => {
    findActiveCompanyIds.mockResolvedValue(new Set(['c-1']));

    const result = await service.regenerateMany(['c-1', 'c-2']);

    expect(result).toEqual({ enqueued: ['c-2'], skipped: ['c-1'] });
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    expect(enqueueAgentRun.mock.calls[0][1].triggerMeta.company_id).toBe('c-2');
  });

  it('applies the per-company reason and the shared later-date-wins instruction', async () => {
    await service.regenerateMany(['c-1', 'c-2'], {
      reasonById: new Map([
        ['c-1', 'stage move L1 -> L3'],
        ['c-2', 'stage move L2 -> L3'],
      ]),
      source: 'stage_move',
    });

    const [, first] = enqueueAgentRun.mock.calls[0];
    expect(first.triggerMeta).toMatchObject({
      company_id: 'c-1',
      source: 'stage_move',
      reason: 'stage move L1 -> L3',
    });
    expect(first.input.prompt).toContain('stage move L1 -> L3');
    expect(first.input.prompt).toMatch(/later-dated source wins/);

    const [, second] = enqueueAgentRun.mock.calls[1];
    expect(second.triggerMeta.reason).toBe('stage move L2 -> L3');
  });

  it('deduplicates repeated ids so one company gets one run', async () => {
    const result = await service.regenerateMany(['c-1', 'c-1']);

    expect(result.enqueued).toEqual(['c-1']);
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
  });

  it('hits the database for nothing when the id list is empty', async () => {
    const result = await service.regenerateMany([]);

    expect(result).toEqual({ enqueued: [], skipped: [] });
    expect(findActiveCompanyIds).not.toHaveBeenCalled();
    expect(findIdAndNameByIds).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('falls back to a generic label for an id the name lookup did not return', async () => {
    findIdAndNameByIds.mockResolvedValue([]);

    await service.regenerateMany(['c-1']);

    expect(enqueueAgentRun.mock.calls[0][1].input.prompt).toMatch(/the company/);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('CompanyAnalysisService.regenerate — never collapses onto a dead run', () => {
  let service: CompanyAnalysisService;

  beforeEach(() => {
    findActiveByCompanyId.mockReset().mockResolvedValue(null);
    findQueueRowById.mockReset();
    findById.mockReset().mockResolvedValue({ id: 'company-1', target: 'Acme Corp' });
    enqueueAgentRun.mockReset();
    service = makeService();
  });

  it('reuses the run when the key collapsed onto one that is still live', async () => {
    enqueueAgentRun.mockResolvedValue({ runId: 'run-live', created: false });
    findQueueRowById.mockResolvedValue({ id: 'run-live', status: 'running' });

    const result = await service.regenerate('company-1');

    expect(result).toEqual({ runId: 'run-live' });
    // One attempt only — the live run is the legitimate collapse target.
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
  });

  it('re-enqueues without a key when the minute key belongs to a cancelled run', async () => {
    // Cancelling a card run marks it `failed`, so it stays terminal but keeps
    // owning its minute's idempotency_key. Reattaching would return a 202 for
    // work that will never happen.
    enqueueAgentRun
      .mockResolvedValueOnce({ runId: 'run-dead', created: false })
      .mockResolvedValueOnce({ runId: 'run-fresh', created: true });
    findQueueRowById.mockResolvedValue({ id: 'run-dead', status: 'failed' });

    const result = await service.regenerate('company-1');

    expect(result).toEqual({ runId: 'run-fresh' });
    expect(enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(enqueueAgentRun.mock.calls[1][1].idempotencyKey).toBeNull();
  });

  it('re-enqueues when the key belongs to a run that already succeeded', async () => {
    enqueueAgentRun
      .mockResolvedValueOnce({ runId: 'run-old', created: false })
      .mockResolvedValueOnce({ runId: 'run-fresh', created: true });
    findQueueRowById.mockResolvedValue({ id: 'run-old', status: 'succeeded' });

    await expect(service.regenerate('company-1')).resolves.toEqual({ runId: 'run-fresh' });
  });

  it('re-enqueues when the conflicting row cannot be read back', async () => {
    enqueueAgentRun
      .mockResolvedValueOnce({ runId: 'run-gone', created: false })
      .mockResolvedValueOnce({ runId: 'run-fresh', created: true });
    findQueueRowById.mockResolvedValue(null);

    await expect(service.regenerate('company-1')).resolves.toEqual({ runId: 'run-fresh' });
  });

  it('does not read the queue row back when the insert created a new run', async () => {
    enqueueAgentRun.mockResolvedValue({ runId: 'run-new', created: true });

    await service.regenerate('company-1');

    expect(findQueueRowById).not.toHaveBeenCalled();
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
  });
});
