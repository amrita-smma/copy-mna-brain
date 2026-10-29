import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  findLatestByCompanyId: vi.fn(),
  findLatestByCompanyIds: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun: mocks.enqueueAgentRun }));
const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));


vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AiWorkforceQueueRepository: function AiWorkforceQueueRepository() {
      return {
        findLatestByCompanyId: mocks.findLatestByCompanyId,
        findLatestByCompanyIds: mocks.findLatestByCompanyIds,
        findById: mocks.findById,
      };
    },
  };
});

import {
  CompanyContactDiscoveryService,
  CompanyNotFoundError,
  rankForPartnership,
} from './companyContactDiscoveryService';
import { CRM_COMPANY_CONTACTS_AGENT_NAME } from '@/lib/agents/crm_contact/constants';

const COMPANY = {
  id: 'co-1',
  target: 'Acme Logistics',
  website: 'https://acme.co.id',
  crm_employer_id: null as string | null,
};
const EMPLOYER = { id: 'emp-1', name: 'Acme Logistics' };

function makeService(company: typeof COMPANY | null = COMPANY) {
  const companyRepo = {
    findByIdOrNull: vi.fn().mockResolvedValue(company),
    findByIds: vi.fn().mockResolvedValue(company ? [company] : []),
    update: vi.fn().mockResolvedValue([]),
  };
  const employerRepo = {
    findById: vi.fn().mockResolvedValue(EMPLOYER),
    findByNormalizedName: vi.fn().mockResolvedValue(undefined),
    findByIds: vi.fn().mockResolvedValue([]),
    findByNormalizedNames: vi.fn().mockResolvedValue([]),
  };
  const employerDomainRepo = {
    findByDomain: vi.fn().mockResolvedValue(null),
    findByEmployerId: vi.fn().mockResolvedValue([]),
    findByEmployerIds: vi.fn().mockResolvedValue([]),
    findManyByDomains: vi.fn().mockResolvedValue([]),
    persistMany: vi.fn().mockResolvedValue([]),
  };
  const correspondentRepo = {
    findByEmployerId: vi.fn().mockResolvedValue([]),
    findByEmployerIds: vi.fn().mockResolvedValue([]),
  };
  const crmService = {
    findOrCreateEmployer: vi.fn().mockResolvedValue({ id: 'emp-new', name: 'Acme Logistics' }),
    addContactsToEmployer: vi.fn().mockResolvedValue({ createdIds: ['c1'], merged: [] }),
  };
  const service = new CompanyContactDiscoveryService(
    companyRepo as never,
    employerRepo as never,
    employerDomainRepo as never,
    correspondentRepo as never,
    crmService as never,
    {} as never,
    'ws-1',
  );
  return { service, companyRepo, employerRepo, employerDomainRepo, correspondentRepo, crmService };
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'pending',
    error: null,
    created_at: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.enqueueAgentRun.mockReset();
  mocks.findLatestByCompanyId.mockReset().mockResolvedValue(null);
  mocks.findLatestByCompanyIds.mockReset().mockResolvedValue([]);
  mocks.findById.mockReset();
});

describe('rankForPartnership', () => {
  it('orders CEO and BD leads first, keeping CRM order within a tier', () => {
    const ranked = rankForPartnership([
      { id: 'a', title: 'Analyst' },
      { id: 'b', title: 'Business Development Manager' },
      { id: 'c', title: 'CEO' },
      { id: 'd', title: null },
      { id: 'e', title: 'Partnerships Lead' },
    ] as never);
    expect(ranked.map((c) => c.id)).toEqual(['c', 'b', 'e', 'a', 'd']);
  });
});

describe('CompanyContactDiscoveryService.getState', () => {
  it('uses the stored CRM link and returns its contacts ranked and capped, with the total', async () => {
    const { service, correspondentRepo, employerDomainRepo } = makeService({
      ...COMPANY,
      crm_employer_id: 'emp-1',
    });
    correspondentRepo.findByEmployerId.mockResolvedValueOnce([
      { id: 'x1', title: 'Analyst' },
      { id: 'x2', title: 'CEO' },
      { id: 'x3', title: 'VP Business Development' },
    ]);
    mocks.findLatestByCompanyId.mockResolvedValueOnce(queueRow({ status: 'succeeded' }));

    const state = await service.getState('co-1', 2);

    expect(state.employer).toEqual({ id: 'emp-1', name: 'Acme Logistics', matchedBy: 'stored' });
    expect(state.contacts.map((c) => c.id)).toEqual(['x2', 'x3']);
    expect(state.totalContacts).toBe(3);
    expect(state.run).toMatchObject({ runId: 'run-1', active: false });
    expect(employerDomainRepo.findByDomain).not.toHaveBeenCalled();
    expect(mocks.findLatestByCompanyId).toHaveBeenCalledWith(CRM_COMPANY_CONTACTS_AGENT_NAME, 'co-1');
  });

  it('matches an unlinked company to the CRM by website domain without writing the link', async () => {
    const { service, employerDomainRepo, companyRepo } = makeService();
    employerDomainRepo.findByDomain.mockResolvedValueOnce({ employer_id: 'emp-1' });

    const state = await service.getState('co-1');

    expect(employerDomainRepo.findByDomain).toHaveBeenCalledWith('acme.co.id');
    expect(state.employer?.matchedBy).toBe('domain');
    expect(companyRepo.update).not.toHaveBeenCalled();
  });

  it('falls back to the normalized company name', async () => {
    const { service, employerRepo } = makeService();
    employerRepo.findByNormalizedName.mockResolvedValueOnce(EMPLOYER);

    const state = await service.getState('co-1');

    expect(employerRepo.findByNormalizedName).toHaveBeenCalledWith('acme logistics');
    expect(state.employer?.matchedBy).toBe('name');
  });

  it('rejects a same-name firm whose own domains differ from the company website', async () => {
    const { service, employerRepo, employerDomainRepo } = makeService();
    employerRepo.findByNormalizedName.mockResolvedValueOnce({ id: 'emp-bank', name: 'Acme Logistics' });
    employerDomainRepo.findByEmployerId.mockResolvedValueOnce([{ domain: 'acmebank.com', employer_id: 'emp-bank' }]);

    const state = await service.getState('co-1');

    expect(employerDomainRepo.findByEmployerId).toHaveBeenCalledWith('emp-bank');
    expect(state.employer).toBeNull();
  });

  it('reports no employer and no contacts when the CRM has never seen the company', async () => {
    const { service, correspondentRepo } = makeService();

    const state = await service.getState('co-1');

    expect(state).toMatchObject({ employer: null, contacts: [], totalContacts: 0, run: null });
    expect(correspondentRepo.findByEmployerId).not.toHaveBeenCalled();
  });

  it('throws CompanyNotFoundError for a company outside the workspace', async () => {
    const { service } = makeService(null);
    await expect(service.getState('co-x')).rejects.toBeInstanceOf(CompanyNotFoundError);
  });
});

describe('CompanyContactDiscoveryService.saveContacts', () => {
  const ROWS = [{ name: 'Jane Doe', title: 'CEO' }];

  it('creates the CRM firm, claims the website domain and links the company when nothing matches', async () => {
    const { service, crmService, employerDomainRepo, companyRepo } = makeService();

    const result = await service.saveContacts('co-1', ROWS, { editedBy: 'u1' });

    expect(crmService.findOrCreateEmployer).toHaveBeenCalledWith('Acme Logistics');
    expect(employerDomainRepo.persistMany).toHaveBeenCalledWith([
      { employer_id: 'emp-new', domain: 'acme.co.id', source: 'manual' },
    ]);
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', { crm_employer_id: 'emp-new' });
    expect(crmService.addContactsToEmployer).toHaveBeenCalledWith('emp-new', ROWS, {
      source: 'crm_contact',
      editedBy: 'u1',
    });
    expect(result).toMatchObject({ employer: { id: 'emp-new' }, createdIds: ['c1'] });
  });

  it('announces the company on the contacts live topic once the contacts are saved', async () => {
    const { service } = makeService();
    liveMocks.publishLiveEvent.mockClear();

    await service.saveContacts('co-1', ROWS);

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith(expect.any(String), 'contacts', ['co-1']);
  });

  it('links a domain-matched firm without creating one or re-claiming its domain', async () => {
    const { service, crmService, employerDomainRepo, companyRepo } = makeService();
    employerDomainRepo.findByDomain.mockResolvedValue({ employer_id: 'emp-1' });

    await service.saveContacts('co-1', ROWS);

    expect(crmService.findOrCreateEmployer).not.toHaveBeenCalled();
    expect(employerDomainRepo.persistMany).not.toHaveBeenCalled();
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', { crm_employer_id: 'emp-1' });
    expect(crmService.addContactsToEmployer).toHaveBeenCalledWith('emp-1', ROWS, expect.anything());
  });

  it('links a name-matched firm without claiming the website domain for it', async () => {
    const { service, employerRepo, employerDomainRepo, companyRepo, crmService } = makeService();
    employerRepo.findByNormalizedName.mockResolvedValue(EMPLOYER);

    await service.saveContacts('co-1', ROWS);

    expect(crmService.findOrCreateEmployer).not.toHaveBeenCalled();
    expect(employerDomainRepo.persistMany).not.toHaveBeenCalled();
    expect(companyRepo.update).toHaveBeenCalledWith('co-1', { crm_employer_id: 'emp-1' });
  });

  it('reports email-merged people whose record sits under another firm', async () => {
    const { service, crmService } = makeService({ ...COMPANY, crm_employer_id: 'emp-1' });
    crmService.addContactsToEmployer.mockResolvedValueOnce({
      createdIds: [],
      merged: [
        { id: 'c-here', name: 'Budi', employer_id: 'emp-1' },
        { id: 'c-there', name: 'Jane Doe', employer_id: 'emp-old' },
      ],
    });

    const result = await service.saveContacts('co-1', ROWS);

    expect(result.mergedIds).toEqual(['c-here', 'c-there']);
    expect(result.mergedElsewhere).toEqual([{ id: 'c-there', name: 'Jane Doe', employerId: 'emp-old' }]);
  });

  it('writes nothing new when the company is already linked', async () => {
    const { service, companyRepo, employerDomainRepo } = makeService({ ...COMPANY, crm_employer_id: 'emp-1' });

    await service.saveContacts('co-1', ROWS);

    expect(companyRepo.update).not.toHaveBeenCalled();
    expect(employerDomainRepo.persistMany).not.toHaveBeenCalled();
  });

  it('throws CompanyNotFoundError for a company outside the workspace', async () => {
    const { service, crmService } = makeService(null);
    await expect(service.saveContacts('co-x', ROWS)).rejects.toBeInstanceOf(CompanyNotFoundError);
    expect(crmService.addContactsToEmployer).not.toHaveBeenCalled();
  });
});

describe('CompanyContactDiscoveryService.discover', () => {
  it('joins an in-flight run instead of queueing a second one', async () => {
    const { service, companyRepo } = makeService();
    mocks.findLatestByCompanyId.mockResolvedValueOnce(queueRow({ status: 'running' }));

    const result = await service.discover('co-1');

    expect(result).toMatchObject({ created: false, run: { runId: 'run-1', active: true } });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect(companyRepo.findByIdOrNull).not.toHaveBeenCalled();
  });

  it('queues a company-contacts run keyed on company_id with the company in the prompt', async () => {
    const { service } = makeService();
    mocks.enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-2', created: true });
    mocks.findById.mockResolvedValueOnce(queueRow({ id: 'run-2' }));

    const result = await service.discover('co-1', { triggeredByUserId: 'user-1' });

    expect(result).toMatchObject({ created: true, run: { runId: 'run-2', active: true } });
    const [, input] = mocks.enqueueAgentRun.mock.calls[0];
    expect(input).toMatchObject({
      agentName: CRM_COMPANY_CONTACTS_AGENT_NAME,
      triggerMeta: { company_id: 'co-1' },
      triggeredByUserId: 'user-1',
    });
    expect(input.input.prompt).toContain('Acme Logistics');
    expect(input.input.prompt).toContain('company_id: co-1');
    expect(input.idempotencyKey).toMatch(/^crm_company_contacts:co-1:\d+$/);
  });

  it('re-enqueues keyless when the minute key collapsed onto a finished run', async () => {
    const { service } = makeService();
    mocks.findLatestByCompanyId.mockResolvedValueOnce(queueRow({ status: 'failed' }));
    mocks.enqueueAgentRun
      .mockResolvedValueOnce({ runId: 'run-old', created: false })
      .mockResolvedValueOnce({ runId: 'run-new', created: true });
    mocks.findById
      .mockResolvedValueOnce(queueRow({ id: 'run-old', status: 'succeeded' }))
      .mockResolvedValueOnce(queueRow({ id: 'run-new' }));

    const result = await service.discover('co-1');

    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueAgentRun.mock.calls[1][1].idempotencyKey).toBeNull();
    expect(result.run.runId).toBe('run-new');
  });

  it('throws CompanyNotFoundError for a company outside the workspace', async () => {
    const { service } = makeService(null);

    await expect(service.discover('co-x')).rejects.toBeInstanceOf(CompanyNotFoundError);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });
});

const GLOBEX = {
  id: 'co-2',
  target: 'Globex',
  website: 'https://globex.com',
  crm_employer_id: null as string | null,
};

describe('CompanyContactDiscoveryService.getStates', () => {
  it('returns {} without querying when no ids are given', async () => {
    const { service, companyRepo } = makeService();
    expect(await service.getStates([])).toEqual({});
    expect(companyRepo.findByIds).not.toHaveBeenCalled();
  });

  it('resolves every company in one batch: stored link, then domain, then name', async () => {
    const third = { id: 'co-3', target: 'Initech', website: null, crm_employer_id: null };
    const { service, companyRepo, employerRepo, employerDomainRepo, correspondentRepo } =
      makeService();
    companyRepo.findByIds.mockResolvedValueOnce([
      { ...COMPANY, crm_employer_id: 'emp-1' },
      GLOBEX,
      third,
    ]);
    employerDomainRepo.findManyByDomains.mockResolvedValueOnce([
      { domain: 'globex.com', employer_id: 'emp-2' },
    ]);
    employerRepo.findByIds.mockResolvedValueOnce([
      EMPLOYER,
      { id: 'emp-2', name: 'Globex Corp' },
    ]);
    employerRepo.findByNormalizedNames.mockResolvedValueOnce([
      { id: 'emp-3', name: 'Initech', normalized_name: 'initech' },
    ]);
    correspondentRepo.findByEmployerIds.mockResolvedValueOnce([
      { id: 'p1', employer_id: 'emp-1', title: 'Analyst' },
      { id: 'p2', employer_id: 'emp-1', title: 'CEO' },
      { id: 'p3', employer_id: 'emp-2', title: 'Head of Partnerships' },
    ]);
    mocks.findLatestByCompanyIds.mockResolvedValueOnce([
      { ...queueRow({ id: 'run-2', status: 'running' }), trigger_meta: { company_id: 'co-2' } },
    ]);

    const states = await service.getStates(['co-1', 'co-2', 'co-3']);

    expect(states['co-1'].employer).toEqual({ id: 'emp-1', name: 'Acme Logistics', matchedBy: 'stored' });
    expect(states['co-1'].contacts.map((c) => c.id)).toEqual(['p2', 'p1']);
    expect(states['co-1'].totalContacts).toBe(2);
    expect(states['co-1'].run).toBeNull();
    expect(states['co-2'].employer?.matchedBy).toBe('domain');
    expect(states['co-2'].run).toMatchObject({ runId: 'run-2', active: true });
    expect(states['co-3'].employer).toMatchObject({ id: 'emp-3', matchedBy: 'name' });
    expect(states['co-3'].contacts).toEqual([]);
    // One query per lookup, whatever the number of companies.
    expect(correspondentRepo.findByEmployerIds).toHaveBeenCalledTimes(1);
    expect(employerRepo.findByIds).toHaveBeenCalledTimes(1);
    expect(employerRepo.findById).not.toHaveBeenCalled();
    expect(employerDomainRepo.findByDomain).not.toHaveBeenCalled();
  });

  it('rejects a same-name firm whose own domains differ from the company website', async () => {
    const { service, companyRepo, employerRepo, employerDomainRepo } = makeService();
    companyRepo.findByIds.mockResolvedValueOnce([COMPANY]);
    employerRepo.findByNormalizedNames.mockResolvedValueOnce([
      { id: 'emp-bank', name: 'Acme Logistics', normalized_name: 'acme logistics' },
    ]);
    employerDomainRepo.findByEmployerIds.mockResolvedValueOnce([
      { domain: 'acmebank.com', employer_id: 'emp-bank' },
    ]);

    const states = await service.getStates(['co-1']);

    expect(states['co-1'].employer).toBeNull();
  });
});

describe('CompanyContactDiscoveryService.discoverMany', () => {
  it('queues a run for each company and reports in-flight ones as already queued', async () => {
    const { service, companyRepo } = makeService();
    companyRepo.findByIds.mockResolvedValueOnce([COMPANY, GLOBEX]);
    mocks.findLatestByCompanyIds.mockResolvedValueOnce([
      { ...queueRow({ id: 'run-g', status: 'running' }), trigger_meta: { company_id: 'co-2' } },
    ]);
    mocks.enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-a', created: true });
    mocks.findById.mockResolvedValueOnce(queueRow({ id: 'run-a' }));

    const result = await service.discoverMany(['co-1', 'co-2'], { triggeredByUserId: 'u1' });

    expect(result).toEqual({ queued: ['co-1'], alreadyQueued: ['co-2'], skipped: [] });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun.mock.calls[0][1]).toMatchObject({
      triggerMeta: { company_id: 'co-1' },
      triggeredByUserId: 'u1',
    });
    // Company rows come from the one batched read, not a lookup per company.
    expect(companyRepo.findByIdOrNull).not.toHaveBeenCalled();
  });

  it('with onlyMissing, skips companies that have contacts or a finished search', async () => {
    const { service, companyRepo, employerRepo, correspondentRepo } = makeService();
    const third = { id: 'co-3', target: 'Initech', website: null, crm_employer_id: null };
    companyRepo.findByIds.mockResolvedValueOnce([
      { ...COMPANY, crm_employer_id: 'emp-1' },
      GLOBEX,
      third,
    ]);
    employerRepo.findByIds.mockResolvedValueOnce([EMPLOYER]);
    correspondentRepo.findByEmployerIds.mockResolvedValueOnce([
      { id: 'p1', employer_id: 'emp-1', title: 'CEO' },
    ]);
    mocks.findLatestByCompanyIds.mockResolvedValueOnce([
      { ...queueRow({ id: 'run-g', status: 'succeeded' }), trigger_meta: { company_id: 'co-2' } },
    ]);
    mocks.enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-3', created: true });
    mocks.findById.mockResolvedValueOnce(queueRow({ id: 'run-3' }));

    const result = await service.discoverMany(['co-1', 'co-2', 'co-3'], { onlyMissing: true });

    expect(result).toEqual({ queued: ['co-3'], alreadyQueued: [], skipped: ['co-1', 'co-2'] });
  });

  it('keeps going when one company fails to queue', async () => {
    const { service, companyRepo } = makeService();
    companyRepo.findByIds.mockResolvedValueOnce([COMPANY, GLOBEX]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.enqueueAgentRun
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce({ runId: 'run-g', created: true });
    mocks.findById.mockResolvedValueOnce(queueRow({ id: 'run-g' }));

    const result = await service.discoverMany(['co-1', 'co-2']);

    expect(result.queued).toEqual(['co-2']);
  });

  it('returns an empty result without querying for no ids', async () => {
    const { service, companyRepo } = makeService();
    expect(await service.discoverMany([])).toEqual({ queued: [], alreadyQueued: [], skipped: [] });
    expect(companyRepo.findByIds).not.toHaveBeenCalled();
  });
});
