import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  findLatestByCorrespondentId: vi.fn(),
  findLatestByCorrespondentIds: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun: mocks.enqueueAgentRun }));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AiWorkforceQueueRepository: function AiWorkforceQueueRepository() {
      return {
        findLatestByCorrespondentId: mocks.findLatestByCorrespondentId,
        findLatestByCorrespondentIds: mocks.findLatestByCorrespondentIds,
        findById: mocks.findById,
      };
    },
  };
});

import {
  ContactNotFoundError,
  CrmContactEnrichmentService,
} from './crmContactEnrichmentService';
import { CRM_CONTACT_AGENT_NAME } from '@/lib/agents/crm_contact/constants';

const CONTACT = {
  id: 'corr-1',
  employer_id: 'emp-1',
  name: 'Jane Doe',
  title: null,
  phone: null,
  type: null,
  department: 'M&A',
  specialization: null,
  seniority: null,
  coverage_region: null,
  linkedin_url: null,
  bio: null,
};

function makeService() {
  const correspondentRepo = {
    findById: vi.fn().mockResolvedValue(CONTACT),
    findByEmployerId: vi.fn().mockResolvedValue([CONTACT]),
  };
  const employerRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'emp-1', name: 'Evercore' }),
  };
  const service = new CrmContactEnrichmentService(
    correspondentRepo as never,
    employerRepo as never,
    {} as never,
    'ws-1',
  );
  return { service, correspondentRepo, employerRepo };
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'pending',
    error: null,
    created_at: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.enqueueAgentRun.mockReset();
  mocks.findLatestByCorrespondentId.mockReset();
  mocks.findLatestByCorrespondentIds.mockReset();
  mocks.findById.mockReset();
});

describe('CrmContactEnrichmentService.enrich', () => {
  it('enqueues a crm_contact run carrying correspondent_id in trigger_meta', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);
    mocks.enqueueAgentRun.mockResolvedValue({ runId: 'run-1', created: true });
    mocks.findById.mockResolvedValue(queueRow());

    const { run, created } = await service.enrich('corr-1', {
      triggeredByUserId: 'user-1',
    });

    expect(created).toBe(true);
    expect(run).toMatchObject({ runId: 'run-1', status: 'pending', active: true });

    const [, input] = mocks.enqueueAgentRun.mock.calls[0];
    expect(input.agentName).toBe(CRM_CONTACT_AGENT_NAME);
    expect(input.triggerSource).toBe('api');
    // findLatestByCorrespondentId matches on this — it cannot live only in the prompt.
    expect(input.triggerMeta).toEqual({
      correspondent_id: 'corr-1',
      employer_id: 'emp-1',
    });
    expect(input.triggeredByUserId).toBe('user-1');
  });

  it('puts the contact, the firm and the actual gaps into the run prompt', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);
    mocks.enqueueAgentRun.mockResolvedValue({ runId: 'run-1', created: true });
    mocks.findById.mockResolvedValue(queueRow());

    await service.enrich('corr-1');

    const [, input] = mocks.enqueueAgentRun.mock.calls[0];
    expect(input.input.prompt).toContain('Jane Doe');
    expect(input.input.prompt).toContain('Evercore');
    expect(input.input.prompt).toContain('correspondent_id: corr-1');
    // `department` is already filled, so it is not part of the job.
    expect(input.input.prompt).toContain('title');
    expect(input.input.prompt).not.toMatch(/empty on this record are:[^\n]*department/);
    expect(input.input.title).toBe('Fill CRM contact: Jane Doe (Evercore)');
  });

  it('joins an in-flight run instead of stacking a second one', async () => {
    const { service, correspondentRepo } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(
      queueRow({ id: 'run-live', status: 'running' }),
    );

    const { run, created } = await service.enrich('corr-1');

    expect(created).toBe(false);
    expect(run.runId).toBe('run-live');
    expect(run.active).toBe(true);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(correspondentRepo.findById).not.toHaveBeenCalled();
  });

  it('starts a fresh run when the last one finished', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(
      queueRow({ id: 'run-old', status: 'succeeded' }),
    );
    mocks.enqueueAgentRun.mockResolvedValue({ runId: 'run-2', created: true });
    mocks.findById.mockResolvedValue(queueRow({ id: 'run-2' }));

    const { run, created } = await service.enrich('corr-1');

    expect(created).toBe(true);
    expect(run.runId).toBe('run-2');
  });

  it('retries without the idempotency key when it collapsed onto a finished run', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);
    mocks.enqueueAgentRun
      .mockResolvedValueOnce({ runId: 'run-dead', created: false })
      .mockResolvedValueOnce({ runId: 'run-new', created: true });
    mocks.findById
      .mockResolvedValueOnce(queueRow({ id: 'run-dead', status: 'failed' }))
      .mockResolvedValueOnce(queueRow({ id: 'run-new' }));

    const { run, created } = await service.enrich('corr-1');

    expect(created).toBe(true);
    expect(run.runId).toBe('run-new');
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueAgentRun.mock.calls[0][1].idempotencyKey).toMatch(
      /^crm_contact:corr-1:\d+$/,
    );
    expect(mocks.enqueueAgentRun.mock.calls[1][1].idempotencyKey).toBeNull();
  });

  it('keeps the collapsed run when it is still live — that is the point of the key', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);
    mocks.enqueueAgentRun.mockResolvedValue({ runId: 'run-live', created: false });
    mocks.findById.mockResolvedValue(queueRow({ id: 'run-live', status: 'running' }));

    const { run, created } = await service.enrich('corr-1');

    expect(created).toBe(false);
    expect(run.runId).toBe('run-live');
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('throws ContactNotFoundError for a contact outside this workspace', async () => {
    const { service, correspondentRepo } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);
    correspondentRepo.findById.mockResolvedValue(undefined);

    await expect(service.enrich('corr-1')).rejects.toBeInstanceOf(
      ContactNotFoundError,
    );
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe('CrmContactEnrichmentService.latestRun', () => {
  it('returns null when the contact has never been enriched', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(null);

    expect(await service.latestRun('corr-1')).toBeNull();
  });

  it('marks a terminal run inactive and surfaces its error message', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(
      queueRow({ status: 'failed', error: { message: 'no public footprint' } }),
    );

    const run = await service.latestRun('corr-1');

    expect(run).toMatchObject({
      active: false,
      status: 'failed',
      error: 'no public footprint',
    });
  });

  it('reports a run still on the queue as active', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentId.mockResolvedValue(
      queueRow({ status: 'waiting_for_human_input' }),
    );

    expect((await service.latestRun('corr-1'))?.active).toBe(true);
  });
});

describe('CrmContactEnrichmentService.latestRunsForEmployer', () => {
  it("keys every contact's latest run by correspondent id in one lookup", async () => {
    const { service, correspondentRepo } = makeService();
    correspondentRepo.findByEmployerId.mockResolvedValue([
      { id: 'corr-1' },
      { id: 'corr-2' },
      { id: 'corr-3' },
    ]);
    mocks.findLatestByCorrespondentIds.mockResolvedValue([
      queueRow({ id: 'run-a', trigger_meta: { correspondent_id: 'corr-1' } }),
      queueRow({
        id: 'run-b',
        status: 'succeeded',
        trigger_meta: { correspondent_id: 'corr-3' },
      }),
    ]);

    const runs = await service.latestRunsForEmployer('emp-1');

    expect(mocks.findLatestByCorrespondentIds).toHaveBeenCalledTimes(1);
    expect(mocks.findLatestByCorrespondentIds).toHaveBeenCalledWith(
      CRM_CONTACT_AGENT_NAME,
      ['corr-1', 'corr-2', 'corr-3'],
    );
    expect(runs).toEqual({
      'corr-1': expect.objectContaining({ runId: 'run-a', active: true }),
      'corr-3': expect.objectContaining({ runId: 'run-b', active: false }),
    });
    // corr-2 has never been enriched, so it is absent rather than null.
    expect(runs['corr-2']).toBeUndefined();
  });

  it('returns {} without querying the queue when the employer has no contacts', async () => {
    const { service, correspondentRepo } = makeService();
    correspondentRepo.findByEmployerId.mockResolvedValue([]);

    expect(await service.latestRunsForEmployer('emp-1')).toEqual({});
    expect(mocks.findLatestByCorrespondentIds).not.toHaveBeenCalled();
  });

  it('drops a row whose trigger_meta lost its correspondent_id', async () => {
    const { service } = makeService();
    mocks.findLatestByCorrespondentIds.mockResolvedValue([
      queueRow({ trigger_meta: {} }),
    ]);

    expect(await service.latestRunsForEmployer('emp-1')).toEqual({});
  });
});
