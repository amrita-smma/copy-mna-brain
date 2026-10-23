import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BankerListRow, PipelineStageRow } from '@/lib/repositories';
import {
  BANKER_LIST_DEFAULT_PAGE_SIZE,
  BANKER_LIST_MAX_PAGE_SIZE,
  BankerListService,
  InvalidBankerListSortError,
  pastFirstStageKeys,
} from './bankerListService';
import { buildStageRanker } from './bankerScorecardService';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const U1 = '11111111-1111-4111-8111-111111111111';

const mocks = {
  list: vi.fn(),
  count: vi.fn(),
  countVisible: vi.fn(),
  hasSyncedData: vi.fn(),
  hasActiveLinks: vi.fn(),
  stageList: vi.fn(),
  listEmailInteractions: vi.fn(),
};

function stage(key: string, position: number, deleted = false): PipelineStageRow {
  return {
    id: key,
    workspace_id: 'w1',
    key,
    code: key,
    name: key,
    description: '',
    position,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: deleted ? '2026-02-01T00:00:00.000Z' : null,
  } as PipelineStageRow;
}

function row(overrides: Partial<BankerListRow> = {}): BankerListRow {
  return {
    correspondentId: 'c1',
    name: 'Jimmy Sprinkles',
    email: 'jimmy@gs.example',
    title: 'MD',
    employerId: 'e1',
    employerName: 'Golden Sacks',
    emailsFromUs: 2,
    emailsFromThem: 3,
    lastContactAt: '2026-10-14T08:00:00.000Z',
    teamMemberCount: 4,
    dealsBrought: 3,
    dealsInvolved: 0,
    reachedL1: 2,
    ...overrides,
  };
}

/** One `mart_contact_interactions` row: a team member's emails with contact c1. */
function member(userId: string, userName: string | null, emailsFromUs: number, emailsFromThem = 0) {
  return {
    correspondentId: 'c1',
    userId,
    userName,
    userEmail: `${userId}@us.example`,
    emailsFromUs,
    emailsFromThem,
    lastEmailAt: null,
  };
}

function makeService() {
  return new BankerListService(
    { list: mocks.list, count: mocks.count, countVisible: mocks.countVisible } as never,
    {
      workspaceHasSyncedData: mocks.hasSyncedData,
      listEmailInteractions: mocks.listEmailInteractions,
    } as never,
    { hasActiveLinks: mocks.hasActiveLinks } as never,
    { list: mocks.stageList } as never,
    'w1',
    () => NOW,
  );
}

describe('BankerListService.listBankers', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.list.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.countVisible.mockResolvedValue(0);
    mocks.hasSyncedData.mockResolvedValue(true);
    mocks.hasActiveLinks.mockResolvedValue(true);
    mocks.stageList.mockResolvedValue([stage('L0', 0), stage('L1', 1), stage('L2', 2)]);
    mocks.listEmailInteractions.mockResolvedValue([]);
  });

  it('defaults to the recent sort, page 1 and 25 rows', async () => {
    const res = await makeService().listBankers();

    const query = mocks.list.mock.calls[0][1];
    expect(mocks.list.mock.calls[0][0]).toBe('w1');
    expect(query).toMatchObject({ sort: 'recent', limit: BANKER_LIST_DEFAULT_PAGE_SIZE, offset: 0 });
    expect(res).toMatchObject({ sort: 'recent', page: 1, pageSize: 25 });
  });

  it('caps the page size at 100 and floors it at 1', async () => {
    const service = makeService();
    await service.listBankers({ pageSize: 1000, page: 3 });
    expect(mocks.list.mock.calls[0][1]).toMatchObject({ limit: BANKER_LIST_MAX_PAGE_SIZE, offset: 200 });

    await service.listBankers({ pageSize: 0, page: -4 });
    expect(mocks.list.mock.calls[1][1]).toMatchObject({ limit: 1, offset: 0 });
  });

  it('rejects a sort outside the whitelist before touching the database', async () => {
    await expect(makeService().listBankers({ sort: 'name; DROP TABLE users' })).rejects.toBeInstanceOf(
      InvalidBankerListSortError,
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('falls back to the recent sort for reached_l1 when the workspace has no deal links', async () => {
    mocks.hasActiveLinks.mockResolvedValue(false);

    const res = await makeService().listBankers({ sort: 'reached_l1' });

    expect(mocks.list.mock.calls[0][1].sort).toBe('recent');
    expect(res).toMatchObject({ sort: 'recent', hasDealLinks: false });
  });

  it('keeps reached_l1 when deal links exist', async () => {
    await makeService().listBankers({ sort: 'reached_l1' });
    expect(mocks.list.mock.calls[0][1].sort).toBe('reached_l1');
  });

  it('turns every filter into the repository query, dropping non-uuid team ids', async () => {
    await makeService().listBankers({
      q: '  golden ',
      lastContact: 'month',
      teamUserIds: [U1, 'not-a-uuid'],
      hasDeals: true,
    });

    const query = mocks.list.mock.calls[0][1];
    expect(query).toMatchObject({
      search: 'golden',
      lastContactAfter: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      lastContactBefore: undefined,
      teamUserIds: [U1],
      hasDeals: true,
      pastFirstStageKeys: ['L1', 'L2'],
    });
    // The count sees exactly the same filters.
    expect(mocks.count.mock.calls[0][1]).toEqual(query);
  });

  it.each([
    ['the active window when it is later', { lastContact: 'custom', customDate: '2026-01-01' }, 30],
    ['the last-contact preset when it is later', { lastContact: 'week' }, 7],
    ['the active window alone', {}, 30],
  ])('bounds last contact by %s', async (_label, filter, days) => {
    await makeService().listBankers({ ...filter, active30: true });

    expect(mocks.list.mock.calls[0][1].lastContactAfter).toBe(
      new Date(NOW.getTime() - days * DAY).toISOString(),
    );
  });

  it('returns an empty page with totals and flags', async () => {
    mocks.countVisible.mockResolvedValue(38);
    mocks.hasSyncedData.mockResolvedValue(false);

    const res = await makeService().listBankers({ q: 'nobody' });

    expect(res).toEqual({
      rows: [],
      total: 0,
      totalUnfiltered: 38,
      sort: 'recent',
      page: 1,
      pageSize: 25,
      hasDealLinks: true,
      hasSyncedData: false,
    });
    expect(mocks.listEmailInteractions).toHaveBeenCalledWith('w1', []);
  });

  it('builds rows with the top three team members, most emails first, from one bulk read', async () => {
    mocks.list.mockResolvedValue([row(), row({ correspondentId: 'c2', dealsBrought: 0, reachedL1: 0 })]);
    mocks.count.mockResolvedValue(2);
    mocks.listEmailInteractions.mockResolvedValue([
      member('u4', 'Di', 1),
      member('u3', 'Cy', 2),
      member('u1', 'Ann', 5, 1),
      member('u2', null, 3),
    ]);

    const res = await makeService().listBankers();

    expect(mocks.listEmailInteractions).toHaveBeenCalledExactlyOnceWith('w1', ['c1', 'c2']);
    expect(res.rows[0]).toEqual({
      correspondentId: 'c1',
      name: 'Jimmy Sprinkles',
      email: 'jimmy@gs.example',
      title: 'MD',
      firm: { employerId: 'e1', name: 'Golden Sacks' },
      lastContactAt: '2026-10-14T08:00:00.000Z',
      totals: { emailsFromUs: 2, emailsFromThem: 3 },
      teamMemberCount: 4,
      topTeamMembers: [
        { userId: 'u1', name: 'Ann', total: 6 },
        { userId: 'u2', name: 'u2@us.example', total: 3 },
        { userId: 'u3', name: 'Cy', total: 2 },
      ],
      dealsBrought: 3,
      dealsInvolved: 0,
      reachedL1: 2,
      conversion: 2 / 3,
    });
    // Nothing brought: conversion is null, never 0.
    expect(res.rows[1]).toMatchObject({ conversion: null, topTeamMembers: [] });
    expect(res.total).toBe(2);
  });

  it('decodes HTML entities in the name, title, firm name and team member names', async () => {
    mocks.list.mockResolvedValue([
      row({ name: 'Sean O&#39;Brien', title: 'Head of M&amp;amp;A', employerName: 'PT Maju &amp; Jaya' }),
      row({ correspondentId: 'c2', name: '株式会社テスト', title: null, employerName: 'A <B> "C"' }),
    ]);
    mocks.count.mockResolvedValue(2);
    mocks.listEmailInteractions.mockResolvedValue([member('u1', 'Ann O&#39;Neil', 1)]);

    const res = await makeService().listBankers();

    expect(res.rows[0]).toMatchObject({
      name: "Sean O'Brien",
      title: 'Head of M&A',
      firm: { employerId: 'e1', name: 'PT Maju & Jaya' },
      topTeamMembers: [{ userId: 'u1', name: "Ann O'Neil", total: 1 }],
    });
    expect(res.rows[1]).toMatchObject({ name: '株式会社テスト', title: null, firm: { name: 'A <B> "C"' } });
  });
});

describe('pastFirstStageKeys', () => {
  function viaRanker(rows: PipelineStageRow[], keys: string[]) {
    const ranker = buildStageRanker(rows);
    return keys.filter((k) => ranker.isPastFirstStage(k));
  }

  it('keeps the stages positioned after L0, soft-deleted ones included', () => {
    const rows = [stage('L0', 0), stage('L1', 1), stage('stg-old', 2, true), stage('L2', 3)];
    expect(pastFirstStageKeys(rows)).toEqual(['L1', 'stg-old', 'L2']);
    expect(pastFirstStageKeys(rows)).toEqual(viaRanker(rows, rows.map((r) => r.key)));
  });

  it('falls back to the built-in stages when the workspace has none', () => {
    expect(pastFirstStageKeys([])).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
  });
});
