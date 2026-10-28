import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueAgentRun, findActiveByCompanyId, captureMock } = vi.hoisted(
  () => ({
    enqueueAgentRun: vi.fn(),
    findActiveByCompanyId: vi.fn(),
    captureMock: vi.fn(),
  }),
);

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: captureMock,
}));

vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {
    findActiveByCompanyId = findActiveByCompanyId;
  },
}));

import { AI_OPINION_AGENT_NAME, AiOpinionService } from './aiOpinionService';

function makeService(
  companyRepo: Record<string, ReturnType<typeof vi.fn>>,
  aiScreeningService?: { summarizeForOpinion: ReturnType<typeof vi.fn> },
) {
  return new AiOpinionService(
    companyRepo as never,
    {} as never,
    'workspace-1',
    aiScreeningService as never,
  );
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

  it('inlines the deal team context into the instruction and tells the run to weigh it', async () => {
    const companyRepo = makeCompanyRepo();
    companyRepo.findById.mockResolvedValue({
      id: 'co-1',
      target: 'Acme Corp',
      project_name: null,
      context: '## Background\nFounder wants out; the plant was rebuilt in 2024.',
    });
    const service = makeService(companyRepo);

    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('--- CONTEXT RECORDED BY THE DEAL TEAM ---');
    expect(input.instruction).toContain('the plant was rebuilt in 2024');
    expect(input.instruction).toContain('WEIGH IT EXPLICITLY');
    // The prompt the agent actually receives must carry it too, not just the
    // instruction field the queue row displays.
    expect(input.prompt).toBe(input.instruction);
  });

  it('omits the context block entirely when the company has no context', async () => {
    const companyRepo = makeCompanyRepo();
    companyRepo.findById.mockResolvedValue({
      id: 'co-1',
      target: 'Acme Corp',
      project_name: null,
      context: '   ',
    });
    const service = makeService(companyRepo);

    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).not.toContain('CONTEXT RECORDED BY THE DEAL TEAM');
  });

  it('truncates an oversized context and points the run at get_company_details', async () => {
    const companyRepo = makeCompanyRepo();
    companyRepo.findById.mockResolvedValue({
      id: 'co-1',
      target: 'Acme Corp',
      project_name: null,
      context: `${'x'.repeat(4_100)}TAIL`,
    });
    const service = makeService(companyRepo);

    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).not.toContain('TAIL');
    expect(input.instruction).toContain('[Truncated —');
    expect(input.instruction).toContain('get_company_details');
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
        workspaceId: 'workspace-1',
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

  it('instructs the agent that track tags are organizational and low-weight', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('an organizational grouping only');
    expect(input.instruction).toContain(
      '"no matched track" is never itself a reason to fail',
    );
    expect(input.instruction).toContain(
      'track tagging should carry little weight',
    );
  });

  it('instructs the agent to weigh mandate fit before deciding', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('WEIGH MANDATE FIT EXPLICITLY');
    expect(input.instruction).toContain('call get_investment_theses');
    expect(input.instruction).toContain(
      'A target outside the mandate\'s stated scope is a strong negative signal',
    );
    expect(input.instruction).toContain('Name the mandate fit');
  });

  it('tells the agent a missing mandate is normal and not a negative signal', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('IF NO ACTIVE MANDATE IS CONFIGURED');
    expect(input.instruction).toContain('entirely normal and NOT a negative signal');
    expect(input.instruction).toContain('Drop the mandate dimension altogether');
    expect(input.instruction).toContain('Judge the company on the data you do have');
    expect(input.instruction).toContain('still commit to pass or fail');
  });

  it('routes the AI Opinion run to high effort (Opus)', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.effort).toBe('high');
  });

  it('instructs the agent to avoid tentative unless absolutely necessary', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain(
      'Do NOT use "tentative" unless',
    );
    expect(input.instruction).toContain('Commit to "pass" or "fail"');
  });

  it('mirrors the instruction into input.prompt and includes the company id verbatim', async () => {
    const service = makeService(makeCompanyRepo());
    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.prompt).toBe(input.instruction);
    expect(input.instruction).toContain('company_id: co-1');
    expect(input.title).toBe('AI Opinion: Acme Corp');
  });

  it('marks the company failed when enqueue throws after flipping to processing', async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error('queue unavailable'));
    const companyRepo = makeCompanyRepo();
    const service = makeService(companyRepo);

    await expect(service.dispatch('co-1')).rejects.toThrow('queue unavailable');
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', {
      ai_opinion_status: 'failed',
    });
  });

  it('inlines the AI Screening results, judged by each track’s pass rule', async () => {
    const summarizeForOpinion = vi
      .fn()
      .mockResolvedValue('Overall AI Screening verdict: FAIL (passes when any matched track passes).');
    const companyRepo = makeCompanyRepo();
    const service = makeService(companyRepo, { summarizeForOpinion });

    await service.dispatch('co-1');

    expect(summarizeForOpinion).toHaveBeenCalledWith(expect.objectContaining({ id: 'co-1' }));
    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).toContain('--- AI SCREENING RESULTS ---');
    expect(input.instruction).toContain('Overall AI Screening verdict: FAIL');
    expect(input.instruction).toContain('EVERY must-pass criterion passes');
    expect(input.instruction).toContain('optional criteria are not individually required');
  });

  it('omits the screening block when the company has no screening results', async () => {
    const service = makeService(makeCompanyRepo(), {
      summarizeForOpinion: vi.fn().mockResolvedValue(null),
    });

    await service.dispatch('co-1');

    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).not.toContain('AI SCREENING RESULTS');
  });

  it('still dispatches the opinion when summarising screening fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = makeService(makeCompanyRepo(), {
      summarizeForOpinion: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.dispatch('co-1')).resolves.toEqual({ runId: 'run-9' });
    const { input } = enqueueAgentRun.mock.calls[0][1];
    expect(input.instruction).not.toContain('AI SCREENING RESULTS');
    errSpy.mockRestore();
  });
});

describe('AiOpinionService.dispatch live events', () => {
  beforeEach(() => {
    liveMocks.publishLiveEvent.mockClear();
    enqueueAgentRun.mockReset().mockResolvedValue({ runId: 'run-1', created: true });
    findActiveByCompanyId.mockReset().mockResolvedValue(null);
  });

  it('publishes the company on the ai-opinion topic once it is marked processing', async () => {
    const service = makeService(makeCompanyRepo());

    await service.dispatch('co-1', 'user-1');

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith('workspace-1', 'ai-opinion', ['co-1']);
  });

  it('publishes again when the enqueue fails and the status is reset to failed', async () => {
    enqueueAgentRun.mockRejectedValue(new Error('queue down'));
    const service = makeService(makeCompanyRepo());

    await expect(service.dispatch('co-1', 'user-1')).rejects.toThrow('queue down');

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(liveMocks.publishLiveEvent).toHaveBeenLastCalledWith('workspace-1', 'ai-opinion', ['co-1']);
  });
});
