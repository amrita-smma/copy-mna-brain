import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactInsightsService } from './contactInsightsService';
import { ContactNotFoundError } from './crmContactEnrichmentService';

const mocks = vi.hoisted(() => ({
  listEmailInteractions: vi.fn(),
  listEmailTotals: vi.fn(),
  listRelatedCompaniesForContacts: vi.fn(),
  workspaceHasSyncedData: vi.fn(),
  findById: vi.fn(),
  listDealsOfVisibleContact: vi.fn(),
  getScorecards: vi.fn(),
}));

class MockInteractionRepo {
  listEmailInteractions = mocks.listEmailInteractions;
  listEmailTotals = mocks.listEmailTotals;
  listRelatedCompaniesForContacts = mocks.listRelatedCompaniesForContacts;
  workspaceHasSyncedData = mocks.workspaceHasSyncedData;
}

class MockCorrespondentRepo {
  findById = mocks.findById;
}

class MockDealContactService {
  listDealsOfVisibleContact = mocks.listDealsOfVisibleContact;
}

class MockBankerScorecardService {
  getScorecards = mocks.getScorecards;
}

function makeService() {
  return new ContactInsightsService(
    new MockInteractionRepo() as never,
    new MockCorrespondentRepo() as never,
    new MockDealContactService() as never,
    new MockBankerScorecardService() as never,
    'w1',
  );
}

const card = (correspondentId: string) => ({
  correspondentId,
  dealsBrought: 2,
  dealsInvolved: 1,
  reachedL1: 1,
  conversion: 0.5,
  stageBreakdown: [{ stageKey: 'L1', label: 'L1 · Screening', count: 1, currentCount: 1 }],
  hasDealLinks: true,
});

const email = (
  correspondentId: string,
  userId: string,
  emailsFromUs: number,
  emailsFromThem: number,
  lastEmailAt: string | null,
) => ({
  correspondentId,
  userId,
  userName: `User ${userId}`,
  userEmail: `${userId}@us.example`,
  emailsFromUs,
  emailsFromThem,
  lastEmailAt,
});

const emailTotal = (
  correspondentId: string,
  emailsFromUs: number,
  emailsFromThem: number,
  lastEmailAt: string | null,
) => ({ correspondentId, emailsFromUs, emailsFromThem, lastEmailAt });

describe('ContactInsightsService.getInteractionSummaries', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.listEmailInteractions.mockResolvedValue([]);
    mocks.listEmailTotals.mockResolvedValue([]);
    mocks.listRelatedCompaniesForContacts.mockResolvedValue([]);
    mocks.workspaceHasSyncedData.mockResolvedValue(true);
  });

  it('returns an empty map without hitting the DB when the id list is empty', async () => {
    const result = await makeService().getInteractionSummaries([]);
    expect(result.size).toBe(0);
    expect(mocks.listEmailInteractions).not.toHaveBeenCalled();
    expect(mocks.workspaceHasSyncedData).not.toHaveBeenCalled();
  });

  it('issues one bulk read per kind for the whole (deduped) id list', async () => {
    await makeService().getInteractionSummaries(['c1', 'c2', 'c1']);
    expect(mocks.listEmailInteractions).toHaveBeenCalledExactlyOnceWith('w1', ['c1', 'c2']);
    expect(mocks.listEmailTotals).toHaveBeenCalledExactlyOnceWith('w1', ['c1', 'c2']);
    expect(mocks.workspaceHasSyncedData).toHaveBeenCalledExactlyOnceWith('w1');
  });

  it('builds one row per team member from the email rows and totals them', async () => {
    mocks.listEmailInteractions.mockResolvedValue([email('c1', 'u1', 3, 2, '2026-10-01T00:00:00.000Z')]);
    mocks.listEmailTotals.mockResolvedValue([emailTotal('c1', 3, 2, '2026-10-01T00:00:00.000Z')]);

    const summary = (await makeService().getInteractionSummaries(['c1'])).get('c1')!;

    expect(summary.team).toEqual([
      {
        userId: 'u1',
        name: 'User u1',
        email: 'u1@us.example',
        emailsFromUs: 3,
        emailsFromThem: 2,
        lastEmailAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    expect(summary).toMatchObject({
      totalEmailsFromUs: 3,
      totalEmailsFromThem: 2,
      teamMemberCount: 1,
      lastContactAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('sorts the team by total interactions, most first', async () => {
    mocks.listEmailInteractions.mockResolvedValue([
      email('c1', 'quiet', 1, 0, '2026-10-10T00:00:00.000Z'),
      email('c1', 'busy', 4, 4, '2026-09-10T00:00:00.000Z'),
    ]);

    const summary = (await makeService().getInteractionSummaries(['c1'])).get('c1')!;
    expect(summary.team.map((t) => t.userId)).toEqual(['busy', 'quiet']);
  });

  it('keeps absent dates null and gives every requested contact a summary', async () => {
    mocks.workspaceHasSyncedData.mockResolvedValue(false);

    const summary = (await makeService().getInteractionSummaries(['c-none'])).get('c-none');

    expect(summary).toEqual({
      correspondentId: 'c-none',
      lastContactAt: null,
      totalEmailsFromUs: 0,
      totalEmailsFromThem: 0,
      teamMemberCount: 0,
      team: [],
      hasSyncedData: false,
    });
  });

  it('counts a banker email to two colleagues once in the totals, once per colleague in the team', async () => {
    // The banker sent one email to u1 and u2: each member's row has it, the
    // per-contact totals mart has it once.
    mocks.listEmailInteractions.mockResolvedValue([
      email('c1', 'u1', 0, 1, '2026-10-01T00:00:00.000Z'),
      email('c1', 'u2', 0, 1, '2026-10-01T00:00:00.000Z'),
    ]);
    mocks.listEmailTotals.mockResolvedValue([emailTotal('c1', 0, 1, '2026-10-01T00:00:00.000Z')]);

    const summary = (await makeService().getInteractionSummaries(['c1'])).get('c1')!;

    expect(summary.team.map((t) => t.emailsFromThem)).toEqual([1, 1]);
    expect(summary.totalEmailsFromThem).toBe(1);
    expect(summary.totalEmailsFromUs).toBe(0);
    expect(summary.teamMemberCount).toBe(2);
    expect(summary.lastContactAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('takes the email totals from the per-contact rollup, not the sum of team rows', async () => {
    mocks.listEmailInteractions.mockResolvedValue([email('c1', 'u1', 9, 9, '2026-09-01T00:00:00.000Z')]);
    mocks.listEmailTotals.mockResolvedValue([emailTotal('c1', 2, 3, '2026-10-02T00:00:00.000Z')]);

    const summary = (await makeService().getInteractionSummaries(['c1'])).get('c1')!;

    expect(summary).toMatchObject({
      totalEmailsFromUs: 2,
      totalEmailsFromThem: 3,
      lastContactAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('keeps two contacts at the same firm separate', async () => {
    mocks.listEmailInteractions.mockResolvedValue([
      email('alice', 'u1', 5, 1, '2026-10-01T00:00:00.000Z'),
      email('bob', 'u1', 1, 3, '2026-09-01T00:00:00.000Z'),
      email('bob', 'u2', 2, 0, '2026-09-02T00:00:00.000Z'),
    ]);
    mocks.listEmailTotals.mockResolvedValue([
      emailTotal('alice', 5, 1, '2026-10-01T00:00:00.000Z'),
      emailTotal('bob', 3, 3, '2026-09-02T00:00:00.000Z'),
    ]);

    const result = await makeService().getInteractionSummaries(['alice', 'bob']);

    expect(result.get('alice')).toMatchObject({ totalEmailsFromUs: 5, totalEmailsFromThem: 1, teamMemberCount: 1 });
    expect(result.get('bob')).toMatchObject({ totalEmailsFromUs: 3, totalEmailsFromThem: 3, teamMemberCount: 2 });
  });

  it('decodes HTML entities in team member names', async () => {
    mocks.listEmailInteractions.mockResolvedValue([
      { ...email('c1', 'u1', 1, 0, null), userName: 'Sean O&#39;Brien' },
      { ...email('c1', 'u2', 1, 0, null), userName: '株式会社テスト' },
    ]);

    const result = await makeService().getInteractionSummaries(['c1']);

    expect(result.get('c1')!.team.map((t) => t.name).sort()).toEqual(["Sean O'Brien", '株式会社テスト']);
  });
});

describe('ContactInsightsService.getContactInsights', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.listEmailInteractions.mockResolvedValue([]);
    mocks.listEmailTotals.mockResolvedValue([]);
    mocks.listRelatedCompaniesForContacts.mockResolvedValue([]);
    mocks.workspaceHasSyncedData.mockResolvedValue(true);
    mocks.listDealsOfVisibleContact.mockResolvedValue({ deals: [] });
    mocks.getScorecards.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, card(id)])));
  });

  it('throws ContactNotFoundError when the contact is not visible in the workspace', async () => {
    mocks.findById.mockResolvedValue(undefined);
    await expect(makeService().getContactInsights('c1')).rejects.toBeInstanceOf(ContactNotFoundError);
    expect(mocks.findById).toHaveBeenCalledWith('c1', 'w1');
    expect(mocks.listEmailInteractions).not.toHaveBeenCalled();
    expect(mocks.listDealsOfVisibleContact).not.toHaveBeenCalled();
  });

  it('returns the summary and the person-level related companies', async () => {
    mocks.findById.mockResolvedValue({ id: 'c1' });
    mocks.listEmailInteractions.mockResolvedValue([email('c1', 'u1', 1, 1, '2026-10-01T00:00:00.000Z')]);
    mocks.listEmailTotals.mockResolvedValue([emailTotal('c1', 1, 1, '2026-10-01T00:00:00.000Z')]);
    mocks.listRelatedCompaniesForContacts.mockResolvedValue([
      { correspondentId: 'c1', companyId: 'co1', companyName: 'Acme', evidenceCount: 2, lastSeenAt: null },
    ]);

    const insights = await makeService().getContactInsights('c1');

    expect(mocks.listRelatedCompaniesForContacts).toHaveBeenCalledWith('w1', ['c1']);
    expect(insights.interactions).toMatchObject({ correspondentId: 'c1', totalEmailsFromUs: 1, teamMemberCount: 1 });
    expect(insights.relatedCompanies).toEqual([
      { companyId: 'co1', companyName: 'Acme', evidenceCount: 2, lastSeenAt: null },
    ]);
  });

  it('returns the contact and its related companies with HTML entities decoded', async () => {
    mocks.findById.mockResolvedValue({
      id: 'c1',
      name: 'A <B> "C" &amp;amp; Co',
      email: 'a@b.example',
      title: 'Head of M&amp;A',
    });
    mocks.listRelatedCompaniesForContacts.mockResolvedValue([
      { correspondentId: 'c1', companyId: 'co1', companyName: 'PT Maju &amp; Jaya', evidenceCount: 1, lastSeenAt: null },
    ]);

    const insights = await makeService().getContactInsights('c1');

    expect(insights.contact).toEqual({
      id: 'c1',
      name: 'A <B> "C" & Co',
      email: 'a@b.example',
      title: 'Head of M&A',
    });
    expect(insights.relatedCompanies[0]!.companyName).toBe('PT Maju & Jaya');
  });

  it('adds the contact\'s deal links from DealContactService', async () => {
    mocks.findById.mockResolvedValue({ id: 'c1' });
    const deal = {
      companyId: 'co1',
      companyName: 'Acme',
      role: 'source',
      origin: 'email_attachment',
      stage: 'L3',
      stageLabel: 'L3 · Due Diligence',
      isDropped: false,
      linkedAt: '2026-10-01T00:00:00.000Z',
    };
    mocks.listDealsOfVisibleContact.mockResolvedValue({ deals: [deal] });

    const insights = await makeService().getContactInsights('c1');

    // The contact was just found: the deal read does not check it again.
    expect(mocks.listDealsOfVisibleContact).toHaveBeenCalledWith('c1');
    expect(mocks.findById).toHaveBeenCalledTimes(1);
    expect(insights.deals).toEqual([deal]);
    expect(insights).not.toHaveProperty('dealSuggestions');
  });

  it('adds the scorecard for the period after the deal read has reconciled the links', async () => {
    mocks.findById.mockResolvedValue({ id: 'c1' });
    const order: string[] = [];
    mocks.listDealsOfVisibleContact.mockImplementation(async () => {
      order.push('deals');
      return { deals: [] };
    });
    mocks.getScorecards.mockImplementation(async () => {
      order.push('scorecard');
      return new Map([['c1', card('c1')]]);
    });

    const insights = await makeService().getContactInsights('c1', {
      since: '2026-01-01T00:00:00.000Z',
    });

    expect(mocks.getScorecards).toHaveBeenCalledWith(['c1'], { since: '2026-01-01T00:00:00.000Z' });
    expect(order).toEqual(['deals', 'scorecard']);
    expect(insights.scorecard).toEqual(card('c1'));
  });
});
