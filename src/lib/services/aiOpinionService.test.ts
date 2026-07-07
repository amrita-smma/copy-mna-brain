import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueAgentRun, findActiveByCompanyId, captureMock } = vi.hoisted(
  () => ({
    enqueueAgentRun: vi.fn(),
    findActiveByCompanyId: vi.fn(),
    captureMock: vi.fn(),
  }),
);

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture: captureMock }),
}));

vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {
    findActiveByCompanyId = findActiveByCompanyId;
  },
}));

import { AI_OPINION_AGENT_NAME, AiOpinionService } from './aiOpinionService';

function makeService(companyRepo: Record<string, ReturnType<typeof vi.fn>>) {
  return new AiOpinionService(companyRepo as never, {} as never);
}

function makeCompanyRepo() {
  return {
    findById: vi
      .fn()
      .mockResolvedValue({ id: 'co-1', target: 'Acme Corp', project_name: null }),
    update: vi.fn().mockResolvedValue([{ id: 'co-1' }]),
  };
}

describe('AiOpinionService.dispatch', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
    findActiveByCompanyId.mockReset();
    captureMock.mockReset();
    findActiveByCompanyId.mockResolvedValue(null);
    enqueueAgentRun.mockResolvedValue({ runId: 'run-9' });
  });

  it('throws without hitting the queue when companyId is missing', async () => {
    const service = makeService(makeCompanyRepo());
    await expect(service.dispatch('  ')).rejects.toThrow(
      'Missing required field: companyId',
    );
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('reuses an in-flight run instead of enqueueing a duplicate', async () => {
    findActiveByCompanyId.mockResolvedValueOnce({ id: 'run-active' });
    const companyRepo = makeCompanyRepo();
    const service = makeService(companyRepo);

    const result = await service.dispatch('co-1');

    expect(result.runId).toBe('run-active');
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', {
      ai_opinion_status: 'processing',
    });
    // A reused run is not a new opinion request — no event.
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('captures an ai_opinion_requested PostHog event attributed to the user', async () => {
    const service = makeService(makeCompanyRepo());

    await service.dispatch('co-1', 'user-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'user-1',
        event: 'ai_opinion_requested',
        properties: expect.objectContaining({
          company_id: 'co-1',
          company_name: 'Acme Corp',
          run_id: 'run-9',
        }),
      }),
    );
  });

  it('falls back to a server distinctId when no user triggered the run', async () => {
    const service = makeService(makeCompanyRepo());

    await service.dispatch('co-1');

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'server' }),
    );
  });

  it('marks the company processing, clears the stale verdict, and enqueues the run', async () => {
    const companyRepo = makeCompanyRepo();
    const service = makeService(companyRepo);

    const result = await service.dispatch('co-1', 'user-1');

    expect(result.runId).toBe('run-9');
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', {
      ai_opinion_status: 'processing',
      ai_opinion_verdict: null,
      ai_opinion_summary: null,
    });
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: AI_OPINION_AGENT_NAME,
        triggerSource: 'api',
        triggerMeta: { company_id: 'co-1' },
        triggeredByUserId: 'user-1',
      }),
    );
  });

  it('instructs the agent to form the verdict without reading the drop reason first', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain(
      'do NOT read any recorded drop reason before deciding',
    );
    expect(input.instruction).toContain(
      'only if your verdict disagrees with an existing drop decision',
    );
  });

  it('instructs the agent that track matches are organizational and low-weight', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('tracks are organizational only');
    expect(input.instruction).toContain(
      'matching no track is not a negative signal',
    );
    expect(input.instruction).toContain(
      'track fit should carry little weight',
    );
  });

  it('mirrors the instruction into input.prompt and includes the company id verbatim', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.prompt).toBe(input.instruction);
    expect(input.instruction).toContain('company_id: co-1');
    expect(input.title).toBe('AI Opinion: Acme Corp');
  });
});
