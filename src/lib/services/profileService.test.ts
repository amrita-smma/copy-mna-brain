import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileService } from './profileService';

const WORKSPACE_ID = 'ws-1';
const USER_ID = 'user-1';

function makeRepos() {
  const companyRepo = {
    findOwnedByUser: vi.fn().mockResolvedValue([]),
    countOwnedByUser: vi.fn().mockResolvedValue(0),
  };
  const insightRepo = {
    findPageWithCreator: vi.fn().mockResolvedValue([]),
    countByFilter: vi.fn().mockResolvedValue(0),
  };
  const voteRepo = {
    listOpenBallotsByVoter: vi.fn().mockResolvedValue([]),
  };
  const workforceRepo = {
    listAwaitingDecisionByUser: vi.fn().mockResolvedValue([]),
  };
  return { companyRepo, insightRepo, voteRepo, workforceRepo };
}

function makeService(repos: ReturnType<typeof makeRepos>) {
  return new ProfileService(
    repos.companyRepo as never,
    repos.insightRepo as never,
    repos.voteRepo as never,
    repos.workforceRepo as never,
    WORKSPACE_ID,
  );
}

function companyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    target: 'Acme Corp',
    project_name: 'Project Highway',
    pipeline_stage: 'L2',
    status: 'active',
    geography: 'Indonesia',
    segment: 'technology',
    last_activity_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    is_assignee: true,
    is_sponsor: false,
    is_captain: false,
    ...overrides,
  };
}

function ballotRow(overrides: Record<string, unknown> = {}) {
  return {
    ballot_id: 'b-1',
    session_id: 'vs-1',
    company_id: 'c-1',
    company_target: 'Acme Corp',
    company_project_name: 'Project Highway',
    deadline_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    agent_name: 'analyst',
    title: 'Refresh the weekly pipeline insight',
    created_at: '2026-02-20T00:00:00.000Z',
    trigger_meta: {},
    pending_intervention: {
      tool_name: 'publish_insight',
      tool_args: {},
      asked_user_id: USER_ID,
      asked_at: '2026-02-20T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('ProfileService.getMyItems', () => {
  let repos: ReturnType<typeof makeRepos>;

  beforeEach(() => {
    repos = makeRepos();
  });

  it('asks every repository for this user, in this workspace, at the requested limit', async () => {
    await makeService(repos).getMyItems(USER_ID, { limit: 5 });

    expect(repos.companyRepo.findOwnedByUser).toHaveBeenCalledWith(USER_ID, 5);
    expect(repos.companyRepo.countOwnedByUser).toHaveBeenCalledWith(USER_ID);
    expect(repos.insightRepo.findPageWithCreator).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { createdBy: USER_ID },
      { limit: 5, offset: 0 },
    );
    expect(repos.insightRepo.countByFilter).toHaveBeenCalledWith(WORKSPACE_ID, {
      createdBy: USER_ID,
    });
    expect(repos.voteRepo.listOpenBallotsByVoter).toHaveBeenCalledWith(USER_ID, 5);
    expect(repos.workforceRepo.listAwaitingDecisionByUser).toHaveBeenCalledWith(
      USER_ID,
      5,
    );
  });

  it('issues a fixed six queries regardless of how many rows come back', async () => {
    repos.companyRepo.findOwnedByUser.mockResolvedValue([
      companyRow({ id: 'c-1' }),
      companyRow({ id: 'c-2' }),
      companyRow({ id: 'c-3' }),
    ]);
    repos.voteRepo.listOpenBallotsByVoter.mockResolvedValue([
      ballotRow({ ballot_id: 'b-1' }),
      ballotRow({ ballot_id: 'b-2' }),
    ]);

    await makeService(repos).getMyItems(USER_ID);

    const totalCalls = [
      repos.companyRepo.findOwnedByUser,
      repos.companyRepo.countOwnedByUser,
      repos.insightRepo.findPageWithCreator,
      repos.insightRepo.countByFilter,
      repos.voteRepo.listOpenBallotsByVoter,
      repos.workforceRepo.listAwaitingDecisionByUser,
    ].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(totalCalls).toBe(6);
  });

  it('defaults to 10 per section and clamps an out-of-range limit', async () => {
    const service = makeService(repos);

    await service.getMyItems(USER_ID);
    expect(repos.companyRepo.findOwnedByUser).toHaveBeenLastCalledWith(USER_ID, 10);

    await service.getMyItems(USER_ID, { limit: 500 });
    expect(repos.companyRepo.findOwnedByUser).toHaveBeenLastCalledWith(USER_ID, 50);

    await service.getMyItems(USER_ID, { limit: 0 });
    expect(repos.companyRepo.findOwnedByUser).toHaveBeenLastCalledWith(USER_ID, 1);

    await service.getMyItems(USER_ID, { limit: Number.NaN });
    expect(repos.companyRepo.findOwnedByUser).toHaveBeenLastCalledWith(USER_ID, 10);
  });

  it('names a company by its target, falling back to the project name then a placeholder', async () => {
    repos.companyRepo.findOwnedByUser.mockResolvedValue([
      companyRow({ id: 'c-1', target: '  Acme Corp  ' }),
      companyRow({ id: 'c-2', target: null, project_name: 'Project Highway' }),
      companyRow({ id: 'c-3', target: null, project_name: null }),
    ]);

    const { companies } = await makeService(repos).getMyItems(USER_ID);

    expect(companies.items.map((c) => c.name)).toEqual([
      'Acme Corp',
      'Project Highway',
      'Untitled company',
    ]);
  });

  it('reports every reason a company is the user’s, most specific first', async () => {
    repos.companyRepo.findOwnedByUser.mockResolvedValue([
      companyRow({ is_assignee: true, is_sponsor: true, is_captain: true }),
    ]);

    const { companies } = await makeService(repos).getMyItems(USER_ID);

    expect(companies.items[0]!.roles).toEqual(['captain', 'sponsor', 'assignee']);
  });

  it('falls back to updated_at when a company has no activity timestamp', async () => {
    repos.companyRepo.findOwnedByUser.mockResolvedValue([
      companyRow({ last_activity_at: null, updated_at: '2026-01-01T00:00:00.000Z' }),
    ]);

    const { companies } = await makeService(repos).getMyItems(USER_ID);

    expect(companies.items[0]!.lastActivityAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports the full totals alongside the capped card lists', async () => {
    repos.companyRepo.findOwnedByUser.mockResolvedValue([companyRow()]);
    repos.companyRepo.countOwnedByUser.mockResolvedValue(42);
    repos.insightRepo.findPageWithCreator.mockResolvedValue([
      {
        id: 'i-1',
        name: 'Weekly pipeline',
        description: 'Every deal that moved',
        updated_at: '2026-02-02T00:00:00.000Z',
        is_featured: true,
      },
    ]);
    repos.insightRepo.countByFilter.mockResolvedValue(9);

    const { companies, insights } = await makeService(repos).getMyItems(USER_ID);

    expect(companies.items).toHaveLength(1);
    expect(companies.total).toBe(42);
    expect(insights.items).toEqual([
      {
        id: 'i-1',
        name: 'Weekly pipeline',
        description: 'Every deal that moved',
        updatedAt: '2026-02-02T00:00:00.000Z',
        isFeatured: true,
      },
    ]);
    expect(insights.total).toBe(9);
  });

  it('turns an open ballot into a vote action item pointing at its company', async () => {
    repos.voteRepo.listOpenBallotsByVoter.mockResolvedValue([ballotRow()]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID);

    expect(actionItems.items).toEqual([
      {
        id: 'b-1',
        kind: 'vote',
        title: 'Cast your vote on Acme Corp',
        subtitle: 'Your ballot is still a draft',
        dueAt: '2026-03-01T00:00:00.000Z',
        createdAt: null,
        companyId: 'c-1',
        taskId: null,
      },
    ]);
  });

  it('turns a paused run into an approval action item naming the gated tool', async () => {
    repos.workforceRepo.listAwaitingDecisionByUser.mockResolvedValue([
      runRow({ trigger_meta: { company_id: 'c-9' } }),
    ]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID);

    expect(actionItems.items[0]).toEqual({
      id: 'r-1',
      kind: 'approval',
      title: 'Refresh the weekly pipeline insight',
      subtitle: 'Waiting on publish_insight',
      dueAt: null,
      createdAt: '2026-02-20T00:00:00.000Z',
      companyId: 'c-9',
      taskId: 'r-1',
    });
  });

  it('falls back to the agent name when an untitled run needs approval', async () => {
    repos.workforceRepo.listAwaitingDecisionByUser.mockResolvedValue([
      runRow({ title: null, pending_intervention: null }),
    ]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID);

    expect(actionItems.items[0]!.title).toBe('analyst needs your approval');
    expect(actionItems.items[0]!.subtitle).toBe('Waiting for your decision');
  });

  it('leaves companyId null when an approval run names no company', async () => {
    repos.workforceRepo.listAwaitingDecisionByUser.mockResolvedValue([
      runRow({ trigger_meta: { company_id: 42 } }),
      runRow({ id: 'r-2', trigger_meta: {} }),
    ]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID);

    expect(actionItems.items.map((i) => i.companyId)).toEqual([null, null]);
  });

  it('orders action items by soonest deadline, then newest undated', async () => {
    repos.voteRepo.listOpenBallotsByVoter.mockResolvedValue([
      ballotRow({ ballot_id: 'b-late', deadline_at: '2026-03-10T00:00:00.000Z' }),
      ballotRow({ ballot_id: 'b-soon', deadline_at: '2026-03-01T00:00:00.000Z' }),
    ]);
    repos.workforceRepo.listAwaitingDecisionByUser.mockResolvedValue([
      runRow({ id: 'r-old', created_at: '2026-01-01T00:00:00.000Z' }),
      runRow({ id: 'r-new', created_at: '2026-02-20T00:00:00.000Z' }),
    ]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID);

    expect(actionItems.items.map((i) => i.id)).toEqual([
      'b-soon',
      'b-late',
      'r-new',
      'r-old',
    ]);
    expect(actionItems.total).toBe(4);
  });

  it('caps the merged action-item list at the per-section limit', async () => {
    repos.voteRepo.listOpenBallotsByVoter.mockResolvedValue([
      ballotRow({ ballot_id: 'b-1', deadline_at: '2026-03-01T00:00:00.000Z' }),
      ballotRow({ ballot_id: 'b-2', deadline_at: '2026-03-02T00:00:00.000Z' }),
    ]);
    repos.workforceRepo.listAwaitingDecisionByUser.mockResolvedValue([runRow()]);

    const { actionItems } = await makeService(repos).getMyItems(USER_ID, { limit: 2 });

    expect(actionItems.items.map((i) => i.id)).toEqual(['b-1', 'b-2']);
  });

  it('returns empty sections rather than throwing when the user owns nothing', async () => {
    const result = await makeService(repos).getMyItems(USER_ID);

    expect(result).toEqual({
      companies: { items: [], total: 0 },
      insights: { items: [], total: 0 },
      actionItems: { items: [], total: 0 },
    });
  });
});
