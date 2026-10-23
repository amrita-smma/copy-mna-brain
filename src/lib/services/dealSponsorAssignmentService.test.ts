import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DealSponsorAssignmentService, stageTier } from './dealSponsorAssignmentService';
import { buildStageRanker } from './bankerScorecardService';

const mocks = vi.hoisted(() => ({
  findByIds: vi.fn(),
  findOwnedDealsForSponsorMatch: vi.fn(),
  assignDealSponsorsIfEmpty: vi.fn(),
  countActiveDealsByOwners: vi.fn(),
  findByCompanyIds: vi.fn(),
  findLatestAutoSponsorLogs: vi.fn(),
  insertMany: vi.fn(),
  listActiveForCompanies: vi.fn(),
  listForContacts: vi.fn(),
  findCorrespondentsByIds: vi.fn(),
  findEmployersByIds: vi.fn(),
  listForEmployers: vi.fn(),
  findAllTracks: vi.fn(),
  findAllInWorkspace: vi.fn(),
  listStages: vi.fn(),
}));

class MockCompanyRepo {
  findByIds = mocks.findByIds;
  findOwnedDealsForSponsorMatch = mocks.findOwnedDealsForSponsorMatch;
  assignDealSponsorsIfEmpty = mocks.assignDealSponsorsIfEmpty;
  countActiveDealsByOwners = mocks.countActiveDealsByOwners;
}
class MockCompanyLogRepo {
  findByCompanyIds = mocks.findByCompanyIds;
  findLatestAutoSponsorLogs = mocks.findLatestAutoSponsorLogs;
  insertMany = mocks.insertMany;
}
class MockDealContactRepo {
  listActiveForCompanies = mocks.listActiveForCompanies;
  listForContacts = mocks.listForContacts;
}
class MockCorrespondentRepo {
  findByIds = mocks.findCorrespondentsByIds;
}
class MockEmployerRepo {
  findByIds = mocks.findEmployersByIds;
}
class MockEmployerTeamRepo {
  listForEmployers = mocks.listForEmployers;
}
class MockThesisRepo {
  findAll = mocks.findAllTracks;
}
class MockUserRepo {
  findAllInWorkspace = mocks.findAllInWorkspace;
}
class MockStageRepo {
  list = mocks.listStages;
}

function makeService() {
  return new DealSponsorAssignmentService(
    {
      companyRepo: new MockCompanyRepo() as never,
      companyLogRepo: new MockCompanyLogRepo() as never,
      dealContactRepo: new MockDealContactRepo() as never,
      correspondentRepo: new MockCorrespondentRepo() as never,
      employerRepo: new MockEmployerRepo() as never,
      employerTeamRepo: new MockEmployerTeamRepo() as never,
      thesisRepo: new MockThesisRepo() as never,
      userRepo: new MockUserRepo() as never,
      stageRepo: new MockStageRepo() as never,
    },
    'w1',
  );
}

const stage = (key: string, position: number) => ({
  id: `stage-${key}`,
  workspace_id: 'w1',
  key,
  code: key,
  name: '',
  description: '',
  position,
  deleted_at: null as string | null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});
const STAGES = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map((k, i) => stage(k, i));

const company = (over: Record<string, unknown> = {}) => ({
  id: 'new',
  target: 'NewCo',
  pipeline_stage: 'unreviewed',
  status: 'active',
  deal_sponsor: null,
  deal_captain: null,
  entered_by: 'bob',
  segment: 'Healthcare',
  geography: 'Indonesia',
  matched_track_ids: [],
  created_at: '2026-10-21 00:00:00+00',
  ...over,
});

const member = (id: string, name = id) => ({ id, name, email: `${id}@x.test`, role: 'user' });

/** Banker A (corr-a, at Firm X) sent NewCo; Alice took one of A's deals to L2. */
function arrangeHappyPath() {
  mocks.findByIds.mockImplementation(async (ids: string[]) => {
    if (ids.includes('new')) return [company()];
    return [
      company({
        id: 'past-1',
        pipeline_stage: 'L2',
        deal_sponsor: 'alice',
        created_at: '2026-08-01 00:00:00+00',
      }),
    ];
  });
  mocks.listActiveForCompanies.mockResolvedValue([
    { companyId: 'new', correspondentId: 'corr-a', role: 'source' },
  ]);
  mocks.findAllInWorkspace.mockResolvedValue([member('alice', 'Alice'), member('bob', 'Bob')]);
  mocks.findAllTracks.mockResolvedValue([]);
  mocks.listStages.mockResolvedValue(STAGES);
  mocks.listForContacts.mockResolvedValue([
    { correspondentId: 'corr-a', companyId: 'past-1', role: 'source', status: 'active' },
    { correspondentId: 'corr-a', companyId: 'new', role: 'source', status: 'active' },
  ]);
  mocks.findCorrespondentsByIds.mockResolvedValue([
    { id: 'corr-a', name: 'Banker A', employer_id: 'emp-x' },
  ]);
  mocks.findOwnedDealsForSponsorMatch.mockResolvedValue([]);
  mocks.findByCompanyIds.mockResolvedValue([]);
  mocks.findLatestAutoSponsorLogs.mockResolvedValue(new Map());
  mocks.listForEmployers.mockResolvedValue([]);
  mocks.findEmployersByIds.mockResolvedValue([{ id: 'emp-x', name: 'Firm X' }]);
  mocks.assignDealSponsorsIfEmpty.mockImplementation(async (rows: Array<{ companyId: string }>) =>
    rows.map((r) => ({ id: r.companyId })),
  );
  mocks.insertMany.mockResolvedValue(undefined);
  mocks.countActiveDealsByOwners.mockResolvedValue(new Map());
}

describe('stageTier', () => {
  const ranker = buildStageRanker(STAGES);

  it('maps pipeline stages to L0, L1–L2 and L3-onward tiers', () => {
    expect(stageTier('L0', ranker)).toBe('first');
    expect(stageTier('L2', ranker)).toBe('middle');
    expect(stageTier('L3', ranker)).toBe('captain');
    expect(stageTier('L5', ranker)).toBe('captain');
  });

  it('returns null before the pipeline', () => {
    expect(stageTier('unreviewed', ranker)).toBeNull();
    expect(stageTier('discovered', ranker)).toBeNull();
  });
});

describe('DealSponsorAssignmentService.assignForNewCompanies', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    arrangeHappyPath();
  });

  it('assigns the banker-history owner and logs the pick with its reason', async () => {
    const result = await makeService().assignForNewCompanies(['new']);

    // Alice: 3 × 1.5 (L2) × 1 (2.6 months) = 4.5; Bob: mailbox owner 1.
    expect(result).toEqual([
      { companyId: 'new', userId: 'alice', reason: '1 past deal with Banker A' },
    ]);
    expect(mocks.assignDealSponsorsIfEmpty).toHaveBeenCalledWith([{ companyId: 'new', userId: 'alice' }]);
    expect(mocks.insertMany).toHaveBeenCalledWith([
      { company_id: 'new', action: 'AUTO_ASSIGNED_SPONSOR:alice', comments: '1 past deal with Banker A' },
    ]);
  });

  it('never reads history for the new company itself', async () => {
    await makeService().assignForNewCompanies(['new']);
    expect(mocks.findByIds).toHaveBeenLastCalledWith(['past-1']);
  });

  it('adds firm coverage and the mailbox owner so Bob can win', async () => {
    mocks.listForEmployers.mockResolvedValue([{ employer_id: 'emp-x', id: 'bob', name: 'Bob', email: null }]);

    const result = await makeService().assignForNewCompanies(['new']);

    // Bob: coverage 4 + mailbox 1 = 5 beats Alice's 4.5.
    expect(result).toEqual([
      { companyId: 'new', userId: 'bob', reason: 'covers Firm X · received the email' },
    ]);
  });

  it('skips companies that already have a sponsor, are in the pipeline or are dropped', async () => {
    mocks.findByIds.mockResolvedValue([
      company({ id: 'a', deal_sponsor: 'carol' }),
      company({ id: 'b', pipeline_stage: 'L0' }),
      company({ id: 'c', status: 'dropped' }),
    ]);

    expect(await makeService().assignForNewCompanies(['a', 'b', 'c'])).toEqual([]);
    expect(mocks.listActiveForCompanies).not.toHaveBeenCalled();
    expect(mocks.assignDealSponsorsIfEmpty).not.toHaveBeenCalled();
  });

  it('returns [] without hitting the DB for an empty id list', async () => {
    expect(await makeService().assignForNewCompanies([])).toEqual([]);
    expect(mocks.findByIds).not.toHaveBeenCalled();
  });

  it('leaves the sponsor empty when no one reaches the threshold', async () => {
    mocks.listActiveForCompanies.mockResolvedValue([]);
    mocks.listForContacts.mockResolvedValue([]);
    mocks.findCorrespondentsByIds.mockResolvedValue([]);

    expect(await makeService().assignForNewCompanies(['new'])).toEqual([]);
    expect(mocks.assignDealSponsorsIfEmpty).not.toHaveBeenCalled();
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('does not count a past deal whose sponsor is still an unconfirmed auto pick at L0', async () => {
    mocks.findByIds.mockImplementation(async (ids: string[]) =>
      ids.includes('new')
        ? [company()]
        : [company({ id: 'past-1', pipeline_stage: 'L0', deal_sponsor: 'alice', created_at: '2026-08-01 00:00:00+00' })],
    );
    mocks.findByCompanyIds.mockResolvedValue([
      { company_id: 'past-1', action: 'AUTO_ASSIGNED_SPONSOR:alice', created_at: '2026-08-01' },
      { company_id: 'past-1', action: 'PROMOTED_FROM_unreviewed_TO_L0', created_at: '2026-08-02' },
    ]);

    expect(await makeService().assignForNewCompanies(['new'])).toEqual([]);
  });

  it('counts an auto-picked deal once it got past L0', async () => {
    mocks.findByIds.mockImplementation(async (ids: string[]) =>
      ids.includes('new')
        ? [company()]
        : [company({ id: 'past-1', pipeline_stage: 'L1', deal_sponsor: 'alice', created_at: '2026-08-01 00:00:00+00' })],
    );
    mocks.findByCompanyIds.mockResolvedValue([
      { company_id: 'past-1', action: 'AUTO_ASSIGNED_SPONSOR:alice', created_at: '2026-08-01' },
      { company_id: 'past-1', action: 'PROMOTED_FROM_L0_TO_L1', created_at: '2026-08-05' },
    ]);

    const result = await makeService().assignForNewCompanies(['new']);
    expect(result.map((r) => r.userId)).toEqual(['alice']);
  });

  it('scores a dropped deal by the furthest stage its logs show', async () => {
    mocks.findByIds.mockImplementation(async (ids: string[]) =>
      ids.includes('new')
        ? [company()]
        : [
            company({
              id: 'past-1',
              pipeline_stage: 'L1',
              status: 'dropped',
              deal_sponsor: 'alice',
              created_at: '2026-08-01 00:00:00+00',
            }),
          ],
    );
    mocks.findByCompanyIds.mockResolvedValue([
      { company_id: 'past-1', action: 'PROMOTED_FROM_L2_TO_L3', created_at: '2026-08-05' },
      { company_id: 'past-1', action: 'DROPPED_FROM_L3', created_at: '2026-09-01' },
    ]);

    // 3 × 2 (L3) × 1 × 0.5 (dropped) = 3 — exactly the threshold.
    const result = await makeService().assignForNewCompanies(['new']);
    expect(result.map((r) => r.userId)).toEqual(['alice']);
  });

  it('credits a Track PIC only when the name matches exactly one member', async () => {
    mocks.listActiveForCompanies.mockResolvedValue([]);
    mocks.listForContacts.mockResolvedValue([]);
    mocks.findCorrespondentsByIds.mockResolvedValue([]);
    mocks.findByIds.mockResolvedValue([company({ matched_track_ids: ['t1', 't2'] })]);
    mocks.findAllTracks.mockResolvedValue([
      { id: 't1', title: 'Healthcare Rollup — SEA', content: '', pic: ' carol ' },
      { id: 't2', title: 'Clinics', content: '', pic: 'Sam' },
    ]);
    mocks.findAllInWorkspace.mockResolvedValue([
      member('carol', 'Carol'),
      member('sam-1', 'Sam'),
      member('sam-2', 'Sam'),
    ]);

    expect(await makeService().assignForNewCompanies(['new'])).toEqual([
      { companyId: 'new', userId: 'carol', reason: 'PIC of the Healthcare Rollup Track' },
    ]);
  });

  it('gives a Track PIC nothing when the company has no saved Track, even if keywords match', async () => {
    mocks.listActiveForCompanies.mockResolvedValue([]);
    mocks.listForContacts.mockResolvedValue([]);
    mocks.findCorrespondentsByIds.mockResolvedValue([]);
    mocks.findByIds.mockResolvedValue([company({ matched_track_ids: [], segment: 'Healthcare' })]);
    mocks.findAllTracks.mockResolvedValue([
      { id: 't1', title: 'Healthcare', content: 'healthcare clinics hospitals', pic: 'Carol' },
    ]);
    mocks.findAllInWorkspace.mockResolvedValue([member('carol', 'Carol')]);

    expect(await makeService().assignForNewCompanies(['new'])).toEqual([]);
  });

  it('logs only the companies whose sponsor was still empty at write time', async () => {
    mocks.assignDealSponsorsIfEmpty.mockResolvedValue([]);

    expect(await makeService().assignForNewCompanies(['new'])).toEqual([]);
    expect(mocks.insertMany).toHaveBeenCalledWith([]);
  });

  it('reads active-deal counts only when a tie survives the other rules', async () => {
    mocks.listForContacts.mockResolvedValue([]);
    mocks.listForEmployers.mockResolvedValue([
      { employer_id: 'emp-x', id: 'alice', name: 'Alice', email: null },
      { employer_id: 'emp-x', id: 'carol', name: 'Carol', email: null },
    ]);
    mocks.findAllInWorkspace.mockResolvedValue([member('alice'), member('bob'), member('carol')]);
    mocks.countActiveDealsByOwners.mockResolvedValue(new Map([['alice', 9], ['carol', 1]]));

    const result = await makeService().assignForNewCompanies(['new']);

    expect(mocks.countActiveDealsByOwners).toHaveBeenCalledWith(['alice', 'carol']);
    expect(result.map((r) => r.userId)).toEqual(['carol']);
  });

  it('skips the active-deal count when there is no tie', async () => {
    await makeService().assignForNewCompanies(['new']);
    expect(mocks.countActiveDealsByOwners).not.toHaveBeenCalled();
  });

  it('matches sector deals from any banker', async () => {
    mocks.listActiveForCompanies.mockResolvedValue([]);
    mocks.listForContacts.mockResolvedValue([]);
    mocks.findCorrespondentsByIds.mockResolvedValue([]);
    mocks.findOwnedDealsForSponsorMatch.mockResolvedValue(
      ['m1', 'm2', 'm3'].map((id) => ({
        id,
        deal_sponsor: 'carol',
        deal_captain: null,
        pipeline_stage: 'L1',
        status: 'active',
        created_at: '2026-09-01 00:00:00+00',
        segment: 'healthcare',
        geography: 'vietnam',
      })),
    );
    mocks.findAllInWorkspace.mockResolvedValue([member('bob'), member('carol')]);

    const result = await makeService().assignForNewCompanies(['new']);

    expect(mocks.findOwnedDealsForSponsorMatch).toHaveBeenCalledWith({
      segments: ['healthcare'],
      geographies: ['indonesia'],
      before: '2026-10-21T00:00:00.000Z',
      limit: 2000,
    });
    // 3 deals × 1.5 (L1) = 4.5 sector points, capped at 4; Bob has only the mailbox's 1.
    expect(result).toEqual([{ companyId: 'new', userId: 'carol', reason: '3 Healthcare deals' }]);
  });
});
