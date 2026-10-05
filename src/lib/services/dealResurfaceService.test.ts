import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DealResurfaceService } from './dealResurfaceService';
import type {
  CompanyRepository,
  CompanyLogRepository,
  DealNoteRepository,
  UserRepository,
  InvestmentThesisRepository,
  Tables,
} from '@/lib/repositories';

const findDueForResurface = vi.fn();
const companyUpdate = vi.fn();
const logInsert = vi.fn();
const noteInsert = vi.fn();
const findByIds = vi.fn();
const findByNames = vi.fn();
const thesisFindByIds = vi.fn();
const enqueue = vi.fn();

class MockCompanyRepo {
  findDueForResurface = findDueForResurface;
  update = companyUpdate;
}
class MockCompanyLogRepo {
  insert = logInsert;
}
class MockDealNoteRepo {
  insert = noteInsert;
}
class MockUserRepo {
  findByIds = findByIds;
  findByNames = findByNames;
}
class MockThesisRepo {
  findByIds = thesisFindByIds;
}

function makeCompany(
  overrides: Partial<Tables<'companies'>> = {},
): Tables<'companies'> {
  return {
    id: 'company-1',
    target: 'Acme Corp',
    project_name: null,
    pipeline_stage: 'L1',
    status: 'dropped',
    dropped_reason: 'bad timing',
    dropped_at: '2026-04-03T00:00:00.000Z',
    resurface_at: '2026-07-03T00:00:00.000Z',
    dropped_by: 'user-dropper',
    deal_captain: null,
    deal_sponsor: null,
    matched_track_ids: [],
    ...overrides,
  } as Tables<'companies'>;
}

function buildService(): DealResurfaceService {
  return new DealResurfaceService(
    new MockCompanyRepo() as unknown as CompanyRepository,
    new MockCompanyLogRepo() as unknown as CompanyLogRepository,
    new MockDealNoteRepo() as unknown as DealNoteRepository,
    new MockUserRepo() as unknown as UserRepository,
    new MockThesisRepo() as unknown as InvestmentThesisRepository,
    enqueue,
    'https://app.example.com',
  );
}

beforeEach(() => {
  findDueForResurface.mockReset().mockResolvedValue([]);
  companyUpdate.mockReset().mockResolvedValue([]);
  logInsert.mockReset().mockResolvedValue(undefined);
  noteInsert.mockReset().mockResolvedValue(undefined);
  findByIds.mockReset().mockResolvedValue([]);
  findByNames.mockReset().mockResolvedValue([]);
  thesisFindByIds.mockReset().mockResolvedValue([]);
  enqueue.mockReset().mockResolvedValue({ messageId: 'msg-1' });
});

describe('DealResurfaceService.processDue', () => {
  it('does nothing when no deals are due', async () => {
    const result = await buildService().processDue();

    expect(result).toEqual({ resurfaced: 0, notified: 0, failed: [] });
    expect(companyUpdate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queries with the provided sweep time', async () => {
    const now = new Date('2026-07-03T12:00:00.000Z');
    await buildService().processDue(now);

    expect(findDueForResurface).toHaveBeenCalledWith(now.toISOString());
  });

  it('reactivates the deal, clears drop + schedule fields, and logs the stage', async () => {
    findDueForResurface.mockResolvedValue([makeCompany()]);

    const result = await buildService().processDue();

    expect(companyUpdate).toHaveBeenCalledWith('company-1', {
      status: 'active',
      dropped_reason: null,
      dropped_at: null,
      resurface_at: null,
      dropped_by: null,
    });
    expect(logInsert).toHaveBeenCalledWith({
      company_id: 'company-1',
      action: 'RESURFACED_TO_L1',
    });
    expect(result.resurfaced).toBe(1);
  });

  it('appends a note explaining the automatic resurface and the original drop reason', async () => {
    findDueForResurface.mockResolvedValue([makeCompany()]);

    await buildService().processDue();

    expect(noteInsert).toHaveBeenCalledWith({
      deal_id: 'company-1',
      content: expect.stringContaining('automatically added back'),
      stage: 'L1',
    });
    const { content } = noteInsert.mock.calls[0][0];
    expect(content).toContain('dropped on April 3, 2026');
    expect(content).toContain('Original drop reason: bad timing');
  });

  it('omits the drop-reason line from the note when no reason was recorded', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ dropped_reason: null }),
    ]);

    await buildService().processDue();

    const { content } = noteInsert.mock.calls[0][0];
    expect(content).not.toContain('Original drop reason');
  });

  it('emails the user who dropped the deal', async () => {
    findDueForResurface.mockResolvedValue([makeCompany()]);
    findByIds.mockResolvedValue([
      { id: 'user-dropper', name: 'Dana', email: 'dana@fund.com' },
    ]);

    const result = await buildService().processDue();

    expect(findByIds).toHaveBeenCalledWith(['user-dropper']);
    expect(enqueue).toHaveBeenCalledWith({
      kind: 'deal_resurfaced',
      to: 'dana@fund.com',
      companyName: 'Acme Corp',
      stage: 'L1',
      droppedAtLabel: 'April 3, 2026',
      dropReason: 'bad timing',
      companyUrl: 'https://app.example.com/pipeline',
    });
    expect(result.notified).toBe(1);
  });

  it('emails the PIC resolved from the deal_captain user id', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ dropped_by: null, deal_captain: 'user-pic' }),
    ]);
    findByIds.mockResolvedValue([
      { id: 'user-pic', name: 'Pat Lee', email: 'pat@fund.com' },
    ]);

    const result = await buildService().processDue();

    expect(findByIds).toHaveBeenCalledWith(['user-pic']);
    expect(findByNames).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pat@fund.com' }),
    );
    expect(result.notified).toBe(1);
  });

  it('resolves the dropper and PIC in a single batch lookup', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ deal_captain: null, deal_sponsor: 'user-pic' }),
    ]);
    findByIds.mockResolvedValue([
      { id: 'user-dropper', name: 'Dana', email: 'dana@fund.com' },
      { id: 'user-pic', name: 'Pat Lee', email: 'pat@fund.com' },
    ]);

    const result = await buildService().processDue();

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findByIds).toHaveBeenCalledWith(['user-dropper', 'user-pic']);
    expect(result.notified).toBe(2);
  });

  it('falls back to the matched Track PIC name when no per-deal PIC is set', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({
        dropped_by: null,
        deal_captain: null,
        deal_sponsor: null,
        matched_track_ids: ['track-2', 'track-1'],
      }),
    ]);
    thesisFindByIds.mockResolvedValue([
      { id: 'track-1', pic: 'Second Pick' },
      { id: 'track-2', pic: 'First Pick' },
    ]);
    findByNames.mockResolvedValue([
      { id: 'u1', name: 'First Pick', email: 'first@fund.com' },
    ]);

    await buildService().processDue();

    // track-2 is first in matched_track_ids, so its PIC wins.
    expect(findByNames).toHaveBeenCalledWith(['First Pick']);
  });

  it('dedupes when the dropper is also the PIC', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ deal_captain: 'user-dropper' }),
    ]);
    findByIds.mockResolvedValue([
      { id: 'user-dropper', name: 'Dana', email: 'Dana@Fund.com' },
    ]);

    const result = await buildService().processDue();

    expect(findByIds).toHaveBeenCalledWith(['user-dropper']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(1);
  });

  it('still resurfaces the deal when no recipient can be resolved', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ dropped_by: null }),
    ]);

    const result = await buildService().processDue();

    expect(companyUpdate).toHaveBeenCalled();
    expect(noteInsert).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ resurfaced: 1, notified: 0, failed: [] });
  });

  it('still counts the resurface when enqueueing the email fails', async () => {
    findDueForResurface.mockResolvedValue([makeCompany()]);
    findByIds.mockResolvedValue([
      { id: 'user-dropper', name: 'Dana', email: 'dana@fund.com' },
    ]);
    enqueue.mockRejectedValue(new Error('queue down'));

    const result = await buildService().processDue();

    expect(result).toEqual({ resurfaced: 1, notified: 0, failed: [] });
  });

  it('processes remaining deals when one fails, reporting the failed id', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ id: 'company-bad' }),
      makeCompany({ id: 'company-good', dropped_by: null }),
    ]);
    companyUpdate
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValue([]);

    const result = await buildService().processDue();

    expect(result.failed).toEqual(['company-bad']);
    expect(result.resurfaced).toBe(1);
    expect(noteInsert).toHaveBeenCalledTimes(1);
  });

  it('falls back to project_name, then a placeholder, for the company name', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ target: null, project_name: 'Project Falcon' }),
    ]);
    findByIds.mockResolvedValue([
      { id: 'user-dropper', name: 'Dana', email: 'dana@fund.com' },
    ]);

    await buildService().processDue();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ companyName: 'Project Falcon' }),
    );
  });
});

describe('DealResurfaceService — deleted stages', () => {
  function buildWithStages(deletedRefs: string[]) {
    const findDeletedStageRefs = vi.fn().mockResolvedValue(new Set(deletedRefs));
    const service = new DealResurfaceService(
      new MockCompanyRepo() as unknown as CompanyRepository,
      new MockCompanyLogRepo() as unknown as CompanyLogRepository,
      new MockDealNoteRepo() as unknown as DealNoteRepository,
      new MockUserRepo() as unknown as UserRepository,
      new MockThesisRepo() as unknown as InvestmentThesisRepository,
      enqueue,
      'https://app.example.com',
      { findDeletedStageRefs } as never,
    );
    return { service, findDeletedStageRefs };
  }

  it('resurfaces a deal whose stage was deleted into L0 and says why', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ id: 'c1', workspace_id: 'ws-a', pipeline_stage: 'L2' } as never),
    ]);
    const { service } = buildWithStages(['ws-a:L2']);

    await service.processDue(new Date('2026-07-04T00:00:00.000Z'));

    expect(companyUpdate).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ status: 'active', pipeline_stage: 'L0' }),
    );
    expect(logInsert).toHaveBeenCalledWith({ company_id: 'c1', action: 'RESURFACED_TO_L0' });
    expect(noteInsert.mock.calls[0][0].content).toContain('was deleted');
  });

  it('keeps a deal at its live stage and looks stages up once for the whole sweep', async () => {
    findDueForResurface.mockResolvedValue([
      makeCompany({ id: 'c1', workspace_id: 'ws-a', pipeline_stage: 'L1' } as never),
      makeCompany({ id: 'c2', workspace_id: 'ws-b', pipeline_stage: 'L1' } as never),
    ]);
    // L1 is deleted in ws-b only.
    const { service, findDeletedStageRefs } = buildWithStages(['ws-b:L1']);

    await service.processDue(new Date('2026-07-04T00:00:00.000Z'));

    expect(findDeletedStageRefs).toHaveBeenCalledTimes(1);
    expect(findDeletedStageRefs).toHaveBeenCalledWith(['ws-a', 'ws-b'], ['L1']);
    const c1 = companyUpdate.mock.calls.find((c) => c[0] === 'c1')![1];
    const c2 = companyUpdate.mock.calls.find((c) => c[0] === 'c2')![1];
    expect(c1).not.toHaveProperty('pipeline_stage');
    expect(c2).toMatchObject({ pipeline_stage: 'L0' });
  });
});
