import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DealContactRow, UserContactActivityRow } from '@/lib/repositories';
import {
  CrmSuggestedQuestionService,
  QUESTION_MAX_CHARS,
  askBrainDate,
  buildSuggestedQuestions,
  clipWords,
  genericQuestions,
  parseStoredQuestionSet,
  type SuggestedQuestionSet,
} from './crmSuggestedQuestionService';

const mocks = vi.hoisted(() => ({
  findLatestForUser: vi.fn(),
  upsertMany: vi.fn(),
  listUserContactActivity: vi.fn(),
  hasActiveLinks: vi.fn(),
  listForContacts: vi.fn(),
  findOne: vi.fn(),
  findByWorkspaceId: vi.fn(),
}));

class MockQuestionRepo {
  findLatestForUser = mocks.findLatestForUser;
  upsertMany = mocks.upsertMany;
}
class MockInteractionRepo {
  listUserContactActivity = mocks.listUserContactActivity;
}
class MockDealContactRepo {
  hasActiveLinks = mocks.hasActiveLinks;
  listForContacts = mocks.listForContacts;
}
class MockUserWorkspaceRepo {
  findOne = mocks.findOne;
  findByWorkspaceId = mocks.findByWorkspaceId;
}

// 2026-10-17 19:00 WIB.
const NOW = new Date('2026-10-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function activity(over: Partial<UserContactActivityRow>): UserContactActivityRow {
  return {
    userId: 'u1',
    correspondentId: 'c1',
    contactName: 'Jimmy Sprinkles',
    firmName: 'Golden Sacks',
    emailsFromUs: 0,
    emailsFromThem: 0,
    lastEmailAt: null,
    recentEmails: 0,
    ...over,
  };
}

function link(over: Partial<DealContactRow>): DealContactRow {
  return {
    id: 'l1',
    workspaceId: 'w1',
    companyId: 'co1',
    correspondentId: 'c1',
    role: 'source',
    origin: 'manual',
    status: 'active',
    evidenceMessageId: null,
    createdBy: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    companyName: 'Ember Renewables',
    pipelineStage: 'l1',
    companyStatus: 'active',
    droppedAt: null,
    companyCreatedAt: daysAgo(1),
    geography: null,
    segment: null,
    ...over,
  };
}

const reconcileSmartFileLinks = vi.fn();

function makeService(workspaceId = 'w1') {
  return new CrmSuggestedQuestionService(
    new MockQuestionRepo() as never,
    new MockInteractionRepo() as never,
    new MockDealContactRepo() as never,
    new MockUserWorkspaceRepo() as never,
    { reconcileSmartFileLinks },
    workspaceId,
    () => NOW,
  );
}

const texts = (set: SuggestedQuestionSet) =>
  [...set.personalized, ...set.generic].map((q) => q.text).join(' | ');

beforeEach(() => {
  reconcileSmartFileLinks.mockReset();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.findLatestForUser.mockResolvedValue(undefined);
  mocks.upsertMany.mockResolvedValue(undefined);
  mocks.listUserContactActivity.mockResolvedValue([]);
  mocks.hasActiveLinks.mockResolvedValue(false);
  mocks.listForContacts.mockResolvedValue([]);
  mocks.findOne.mockResolvedValue({ user_id: 'u1', is_email_synced: true });
  mocks.findByWorkspaceId.mockResolvedValue([]);
});

describe('askBrainDate', () => {
  it('keys the day on Asia/Jakarta, so the 22:00 UTC cron writes the next WIB day', () => {
    expect(askBrainDate(new Date('2026-10-17T22:00:00.000Z'))).toBe('2026-10-18');
    expect(askBrainDate(new Date('2026-10-17T16:59:59.000Z'))).toBe('2026-10-17');
    expect(askBrainDate(new Date('2026-10-17T17:00:00.000Z'))).toBe('2026-10-18');
  });
});

describe('clipWords', () => {
  it('keeps short values and cuts long ones at a word boundary with an ellipsis', () => {
    expect(clipWords('Golden Sacks', 20)).toBe('Golden Sacks');
    expect(clipWords('Bartholomew Montgomery-Smythe', 16)).toBe('Bartholomew…');
    expect(clipWords('Bartholomew', 6)).toBe('Barth…');
  });
});

describe('buildSuggestedQuestions', () => {
  const base = { links: [], hasSync: true, workspaceHasDealLinks: false, now: NOW };

  it('asks about the banker I interacted with most in the last 14 days, with their firm', () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [
        activity({ correspondentId: 'c1', contactName: 'Jimmy Sprinkles', recentEmails: 1, lastEmailAt: daysAgo(2) }),
        activity({
          correspondentId: 'c2',
          contactName: 'Penny Ledger',
          recentEmails: 3,
          lastEmailAt: daysAgo(3),
        }),
      ],
    });
    expect(set.personalized[0]).toEqual({
      kind: 'latest_with',
      text: "What's the latest with Penny Ledger (Golden Sacks)?",
    });
  });

  it('suggests a follow-up with my top all-time banker last contacted over 30 days ago', () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [
        activity({ correspondentId: 'c1', contactName: 'Recent Rita', emailsFromUs: 50, lastEmailAt: daysAgo(5) }),
        activity({ correspondentId: 'c2', contactName: 'Quiet Quentin', emailsFromThem: 9, lastEmailAt: daysAgo(45) }),
        activity({ correspondentId: 'c3', contactName: 'Old Olga', emailsFromThem: 2, lastEmailAt: daysAgo(90) }),
      ],
    });
    expect(set.personalized.map((q) => q.kind)).toEqual(['follow_up', 'firm_coverage']);
    expect(set.personalized[0]!.text).toBe(
      'Should I follow up with Quiet Quentin? Last contact 45 days ago.',
    );
  });

  it('skips the follow-up when every banker was contacted within 30 days', () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [activity({ emailsFromUs: 3, lastEmailAt: daysAgo(29) })],
    });
    expect(set.personalized.find((q) => q.kind === 'follow_up')).toBeUndefined();
  });

  it("asks about the most recent live deal brought by one of MY bankers only", () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [activity({ correspondentId: 'c1', emailsFromUs: 1, lastEmailAt: daysAgo(40) })],
      links: [
        link({ companyId: 'old', companyName: 'Cinder Foods', companyCreatedAt: daysAgo(10) }),
        link({ companyId: 'new', companyName: 'Ember Renewables', companyCreatedAt: daysAgo(2) }),
        link({ companyId: 'drop', companyName: 'Juniper AgriTech', companyStatus: 'dropped', companyCreatedAt: daysAgo(1) }),
        link({ companyId: 'inv', companyName: 'Halcyon Media', role: 'involved', companyCreatedAt: daysAgo(0) }),
        link({ companyId: 'gone', companyName: 'Dismissed Co', status: 'dismissed', companyCreatedAt: daysAgo(0) }),
        link({ companyId: 'other', correspondentId: 'not-mine', companyName: 'Somebody Elses Deal', companyCreatedAt: daysAgo(0) }),
      ],
    });
    expect(set.personalized.find((q) => q.kind === 'deal_progress')?.text).toBe(
      'How is Ember Renewables from Jimmy Sprinkles progressing?',
    );
    expect(texts(set)).not.toContain('Somebody Elses Deal');
  });

  it('adds the L1 question only when the workspace has deal links and I have data', () => {
    const mine = [activity({ recentEmails: 1, lastEmailAt: daysAgo(1) })];
    expect(
      buildSuggestedQuestions({ ...base, activity: mine, workspaceHasDealLinks: true }).personalized.map((q) => q.kind),
    ).toEqual(['latest_with', 'l1_leads']);
    expect(
      buildSuggestedQuestions({ ...base, activity: mine, workspaceHasDealLinks: false }).personalized.map((q) => q.kind),
    ).toEqual(['latest_with']);
    expect(
      buildSuggestedQuestions({ ...base, activity: [], workspaceHasDealLinks: true }).personalized,
    ).toEqual([]);
  });

  it('keeps a stable order and at most four personalized questions', () => {
    const input = {
      ...base,
      workspaceHasDealLinks: true,
      activity: [
        activity({ correspondentId: 'c1', recentEmails: 3, lastEmailAt: daysAgo(1) }),
        activity({ correspondentId: 'c2', contactName: 'Old Olga', emailsFromUs: 4, lastEmailAt: daysAgo(60) }),
      ],
      links: [link({})],
    };
    const first = buildSuggestedQuestions(input);
    expect(first.personalized.map((q) => q.kind)).toEqual([
      'latest_with',
      'follow_up',
      'deal_progress',
      'l1_leads',
    ]);
    expect(buildSuggestedQuestions(input)).toEqual(first);
  });

  it('without sync: generic questions only, even with interaction data', () => {
    const set = buildSuggestedQuestions({
      ...base,
      hasSync: false,
      workspaceHasDealLinks: true,
      activity: [activity({ recentEmails: 3, emailsFromUs: 3, lastEmailAt: daysAgo(1) })],
      links: [link({})],
    });
    expect(set.personalized).toEqual([]);
    expect(set.hasSync).toBe(false);
    expect(set.generic.map((q) => q.kind)).toEqual(['follow_up_week', 'most_active', 'top_firms_month']);
    expect(texts(set)).not.toContain('Jimmy Sprinkles');
    expect(texts(set)).not.toContain('Golden Sacks');
  });

  it('without data and without sync: no personalized, generic follow-up and top-firms questions', () => {
    const set = buildSuggestedQuestions({ ...base, hasSync: false, activity: [] });
    expect(set).toEqual({
      personalized: [],
      generic: [
        { kind: 'follow_up_week', text: 'Who should I follow up with this week?' },
        { kind: 'most_active', text: 'Which bankers are most active with us?' },
        { kind: 'top_firms_month', text: 'Which firms did we email most this month?' },
      ],
      hasSync: false,
    });
  });

  it('with sync on, names my top firm among the personalized questions and keeps the generic three fixed', () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [
        activity({ correspondentId: 'c1', firmName: 'Golden Sacks', emailsFromUs: 3 }),
        activity({ correspondentId: 'c2', firmName: 'Morgan Stanlee', emailsFromUs: 1 }),
      ],
    });
    expect(set.personalized).toContainEqual({
      kind: 'firm_coverage',
      text: 'Who on our team covers Golden Sacks?',
    });
    expect(set.generic.map((q) => q.text)).toEqual([
      "Summarize this week's contact sync",
      'Which bankers are most active with us?',
      'Which firms did we email most this month?',
    ]);
  });

  it('asks who covers my top firm only when a slot is free after the L1 question', () => {
    const mine = [activity({ emailsFromUs: 4, recentEmails: 1, lastEmailAt: daysAgo(1) })];
    expect(
      buildSuggestedQuestions({ ...base, activity: mine, workspaceHasDealLinks: true }).personalized.map((q) => q.kind),
    ).toEqual(['latest_with', 'l1_leads', 'firm_coverage']);
  });

  it('decodes HTML entities in names before filling and clipping the templates', () => {
    const set = buildSuggestedQuestions({
      ...base,
      activity: [
        activity({
          correspondentId: 'c1',
          contactName: 'Sean O&#39;Brien',
          firmName: 'PT Maju &amp; Jaya',
          emailsFromUs: 3,
          recentEmails: 1,
          lastEmailAt: daysAgo(1),
        }),
      ],
      links: [link({ correspondentId: 'c1', companyName: 'Smith &amp;amp; Co' })],
    });
    expect(set.personalized.map((q) => q.text)).toEqual([
      "What's the latest with Sean O'Brien (PT Maju & Jaya)?",
      "How is Smith & Co from Sean O'Brien progressing?",
      'Who on our team covers PT Maju & Jaya?',
    ]);
    expect(texts(set)).not.toMatch(/&(amp|#39);/);
  });

  it('clips long names so every question fits the length target', () => {
    const longName = 'Maximiliana Alexandra Wolfeschlegelsteinhausen-Bergerdorff';
    const longFirm = 'International Consolidated Mercantile Bank of Southeast Asia';
    const set = buildSuggestedQuestions({
      ...base,
      workspaceHasDealLinks: true,
      activity: [
        activity({ correspondentId: 'c1', contactName: longName, firmName: longFirm, recentEmails: 2, lastEmailAt: daysAgo(1) }),
        activity({ correspondentId: 'c2', contactName: longName, firmName: longFirm, emailsFromUs: 9, lastEmailAt: daysAgo(400) }),
      ],
      links: [link({ correspondentId: 'c1', companyName: 'PT Sumber Alfaria Trijaya Distribution Holdings Tbk' })],
    });
    for (const q of [...set.personalized, ...set.generic]) {
      expect(q.text.length, q.text).toBeLessThanOrEqual(QUESTION_MAX_CHARS);
    }
    expect(set.personalized[1]!.text).toMatch(/Last contact 400 days ago\.$/);
  });
});

describe('parseStoredQuestionSet', () => {
  it('drops unknown kinds and rejects a non-set value', () => {
    expect(
      parseStoredQuestionSet({
        personalized: [{ kind: 'latest_with', text: 'Q' }, { kind: 'bogus', text: 'X' }],
        generic: [],
        hasSync: true,
      }),
    ).toEqual({
      personalized: [{ kind: 'latest_with', text: 'Q' }],
      generic: genericQuestions(true),
      hasSync: true,
    });
    expect(parseStoredQuestionSet(null)).toBeNull();
    expect(parseStoredQuestionSet({ personalized: 'x' })).toBeNull();
  });
});

describe('CrmSuggestedQuestionService.generateForWorkspace', () => {
  function members(n: number) {
    return Array.from({ length: n }, (_, i) => ({ user_id: `u${i}`, is_email_synced: true }));
  }
  function rowsFor(n: number) {
    return Array.from({ length: n }, (_, i) =>
      activity({
        userId: `u${i}`,
        correspondentId: `c${i}`,
        contactName: `Banker ${i}`,
        recentEmails: 1,
        lastEmailAt: daysAgo(1),
      }),
    );
  }

  it.each([2, 7])('issues the same fixed set of queries for %i members', async (n) => {
    mocks.findByWorkspaceId.mockResolvedValue(members(n));
    mocks.listUserContactActivity.mockResolvedValue(rowsFor(n));

    const result = await makeService().generateForWorkspace('2026-10-18');

    expect(result).toEqual({ forDate: '2026-10-18', members: n, generated: n });
    expect(mocks.findByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mocks.listUserContactActivity).toHaveBeenCalledTimes(1);
    expect(mocks.hasActiveLinks).toHaveBeenCalledTimes(1);
    expect(mocks.listForContacts).toHaveBeenCalledTimes(1);
    expect(mocks.upsertMany).toHaveBeenCalledTimes(1);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.findLatestForUser).not.toHaveBeenCalled();
  });

  it("fills each member's questions from their own rows only, skipping members without data", async () => {
    mocks.findByWorkspaceId.mockResolvedValue(members(3));
    mocks.listUserContactActivity.mockResolvedValue(rowsFor(2));

    await makeService().generateForWorkspace('2026-10-18');

    expect(mocks.findByWorkspaceId).toHaveBeenCalledWith('w1');
    expect(mocks.listUserContactActivity.mock.calls[0]![0]).toBe('w1');
    expect(mocks.listUserContactActivity.mock.calls[0]![1]).toEqual(['u0', 'u1', 'u2']);
    const rows = mocks.upsertMany.mock.calls[0]![0] as Array<{
      workspaceId: string;
      userId: string;
      questions: SuggestedQuestionSet;
    }>;
    expect(rows.map((r) => r.userId)).toEqual(['u0', 'u1']);
    expect(rows.every((r) => r.workspaceId === 'w1')).toBe(true);
    expect(texts(rows[0]!.questions)).toContain('Banker 0');
    expect(texts(rows[0]!.questions)).not.toContain('Banker 1');
    expect(texts(rows[1]!.questions)).toContain('Banker 1');
    expect(texts(rows[1]!.questions)).not.toContain('Banker 0');
    expect(rows.every((r) => r.questions.hasSync)).toBe(true);
  });

  it("uses each member's own sync flag and writes no row for a member without sync, so their saved questions survive", async () => {
    mocks.findByWorkspaceId.mockResolvedValue([
      { user_id: 'u0', is_email_synced: true },
      { user_id: 'u1', is_email_synced: false },
    ]);
    mocks.listUserContactActivity.mockResolvedValue(rowsFor(2));

    const result = await makeService().generateForWorkspace('2026-10-18');

    const rows = mocks.upsertMany.mock.calls[0]![0] as Array<{
      userId: string;
      questions: SuggestedQuestionSet;
    }>;
    expect(rows.map((r) => r.userId)).toEqual(['u0']);
    expect(rows[0]!.questions.personalized.length).toBeGreaterThan(0);
    expect(result).toEqual({ forDate: '2026-10-18', members: 2, generated: 1 });
    // Still one bulk read and one bulk write: no per-member lookup of saved rows.
    expect(mocks.findLatestForUser).not.toHaveBeenCalled();
    expect(mocks.upsertMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a workspace without members', async () => {
    await expect(makeService().generateForWorkspace('2026-10-18')).resolves.toEqual({
      forDate: '2026-10-18',
      members: 0,
      generated: 0,
    });
    expect(mocks.listUserContactActivity).not.toHaveBeenCalled();
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });
});

describe('CrmSuggestedQuestionService.runDaily', () => {
  it("reconciles the whole workspace's Smart Files deal links before generating, and counts them", async () => {
    reconcileSmartFileLinks.mockResolvedValue([{ companyId: 'co-1' }, { companyId: 'co-2' }]);
    mocks.findByWorkspaceId.mockResolvedValue([{ user_id: 'u1', is_email_synced: true }]);

    const result = await makeService().runDaily();

    // Workspace-wide: no contact narrowing.
    expect(reconcileSmartFileLinks).toHaveBeenCalledWith();
    expect(reconcileSmartFileLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findByWorkspaceId.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      forDate: askBrainDate(NOW),
      members: 1,
      generated: 0,
      reconciled: 2,
      reconcileFailed: false,
    });
  });

  it('still generates when the reconcile fails, and reports the failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reconcileSmartFileLinks.mockRejectedValue(new Error('boom'));

    const result = await makeService().runDaily();

    expect(mocks.findByWorkspaceId).toHaveBeenCalledWith('w1');
    expect(result).toMatchObject({ reconciled: 0, reconcileFailed: true });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('CrmSuggestedQuestionService.getForUser', () => {
  const saved: SuggestedQuestionSet = {
    personalized: [{ kind: 'latest_with', text: "What's the latest with Penny Ledger?" }],
    generic: [{ kind: 'most_active', text: 'Which bankers are most active with us?' }],
    hasSync: true,
  };

  it("returns today's saved row without generating", async () => {
    mocks.findLatestForUser.mockResolvedValue({ forDate: '2026-10-17', questions: saved });

    await expect(makeService().getForUser('u1')).resolves.toEqual({
      ...saved,
      generic: genericQuestions(true),
      stale: false,
    });
    expect(mocks.findLatestForUser).toHaveBeenCalledWith('w1', 'u1', '2026-10-17');
    expect(mocks.listUserContactActivity).not.toHaveBeenCalled();
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it("generates from the caller's own rows in this workspace and saves on demand when today has no row", async () => {
    mocks.findLatestForUser.mockResolvedValue({ forDate: '2026-10-16', questions: saved });
    mocks.listUserContactActivity.mockResolvedValue([
      activity({ userId: 'u1', correspondentId: 'c1', recentEmails: 1, lastEmailAt: daysAgo(1) }),
      // A row for someone else must never shape u1's questions.
      activity({ userId: 'u2', correspondentId: 'c9', contactName: 'Colleague Banker', recentEmails: 99, lastEmailAt: daysAgo(1) }),
    ]);

    const result = await makeService().getForUser('u1');

    expect(mocks.findOne).toHaveBeenCalledWith('u1', 'w1');
    const [ws, userIds, now, since] = mocks.listUserContactActivity.mock.calls[0]!;
    expect(ws).toBe('w1');
    expect(userIds).toEqual(['u1']);
    expect(now).toEqual(NOW);
    expect((now as Date).getTime() - (since as Date).getTime()).toBe(14 * DAY);
    expect(mocks.hasActiveLinks).toHaveBeenCalledWith('w1');
    expect(mocks.listForContacts).toHaveBeenCalledWith('w1', ['c1']);
    expect(result.stale).toBe(false);
    expect(texts(result)).toContain('Jimmy Sprinkles');
    expect(texts(result)).not.toContain('Colleague Banker');
    expect(mocks.upsertMany).toHaveBeenCalledWith([
      {
        workspaceId: 'w1',
        userId: 'u1',
        forDate: '2026-10-17',
        questions: { personalized: result.personalized, generic: result.generic, hasSync: true },
      },
    ]);
  });

  it("keeps yesterday's questions, marked stale, when generation fails", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.findLatestForUser.mockResolvedValue({ forDate: '2026-10-16', questions: saved });
    mocks.listUserContactActivity.mockRejectedValue(new Error('db down'));

    await expect(makeService().getForUser('u1')).resolves.toEqual({
      ...saved,
      generic: genericQuestions(true),
      stale: true,
    });
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it('with sync turned off, keeps the last saved personalized questions (stale) and writes nothing', async () => {
    mocks.findOne.mockResolvedValue({ user_id: 'u1', is_email_synced: false });
    mocks.findLatestForUser.mockResolvedValue({ forDate: '2026-10-12', questions: saved });
    mocks.listUserContactActivity.mockResolvedValue([
      activity({ recentEmails: 1, lastEmailAt: daysAgo(1) }),
    ]);

    await expect(makeService().getForUser('u1')).resolves.toEqual({
      personalized: saved.personalized,
      // The generic three and the sync flag follow today's read.
      generic: genericQuestions(false),
      hasSync: false,
      stale: true,
    });
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it('shows generic only, and writes nothing, when sync is off and nothing personalized was ever saved', async () => {
    mocks.findOne.mockResolvedValue({ user_id: 'u1', is_email_synced: false });
    mocks.findLatestForUser.mockResolvedValue({
      forDate: '2026-10-16',
      questions: { personalized: [], generic: genericQuestions(false), hasSync: false },
    });

    await expect(makeService().getForUser('u1')).resolves.toEqual({
      personalized: [],
      generic: genericQuestions(false),
      hasSync: false,
      stale: false,
    });
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it('falls back to generic questions when generation fails and nothing is saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listUserContactActivity.mockRejectedValue(new Error('db down'));

    const result = await makeService().getForUser('u1');

    expect(result.personalized).toEqual([]);
    expect(result.generic.map((q) => q.kind)).toEqual([
      'follow_up_week',
      'most_active',
      'top_firms_month',
    ]);
    expect(result.hasSync).toBe(false);
  });

  it('still returns fresh questions when saving them fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.upsertMany.mockRejectedValue(new Error('write failed'));
    mocks.listUserContactActivity.mockResolvedValue([
      activity({ recentEmails: 1, lastEmailAt: daysAgo(1) }),
    ]);

    const result = await makeService().getForUser('u1');

    expect(result.stale).toBe(false);
    expect(result.personalized[0]!.kind).toBe('latest_with');
  });
});
