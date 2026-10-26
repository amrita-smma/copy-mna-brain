import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listBankers: vi.fn(),
  getContactInsights: vi.fn(),
  getConversation: vi.fn(),
  getConversationForWorkforce: vi.fn(),
  createContainer: vi.fn(),
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({ db: true })) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { NO_INTERACTION_DATA } from '@/lib/crm/displayText';
import { crmBankerInsights, MAX_RANKING_LIMIT } from './crm_banker_insights';

function bankerRow(overrides: Record<string, unknown> = {}) {
  return {
    correspondentId: 'c-jimmy',
    name: 'Jimmy Sprinkles',
    email: 'jimmy@goldensacks.example',
    title: 'Managing Director',
    firm: { employerId: 'e-gs', name: 'Golden Sacks' },
    lastContactAt: '2026-10-14T10:00:00.000Z',
    totals: { emailsFromUs: 2, emailsFromThem: 3 },
    teamMemberCount: 2,
    topTeamMembers: [{ userId: 'u-1', name: 'Alice', total: 5 }],
    dealsBrought: 2,
    dealsInvolved: 1,
    reachedL1: 1,
    conversion: 0.5,
    ...overrides,
  };
}

function listResult(rows: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    rows,
    total: rows.length,
    totalUnfiltered: 40,
    sort: 'recent',
    page: 1,
    pageSize: 10,
    hasDealLinks: true,
    hasSyncedData: true,
    ...overrides,
  };
}

function insights(overrides: Record<string, unknown> = {}) {
  return {
    interactions: {
      correspondentId: 'c-jimmy',
      lastContactAt: '2026-10-14T10:00:00.000Z',
      totalEmailsFromUs: 2,
      totalEmailsFromThem: 3,
      teamMemberCount: 2,
      team: [
        {
          userId: 'u-1',
          name: 'Alice',
          email: 'alice@us.example',
          emailsFromUs: 2,
          emailsFromThem: 2,
          lastEmailAt: '2026-10-14T10:00:00.000Z',
        },
        {
          userId: 'u-2',
          name: 'Bob',
          email: 'bob@us.example',
          emailsFromUs: 0,
          emailsFromThem: 1,
          lastEmailAt: '2026-10-12T10:00:00.000Z',
        },
      ],
      hasSyncedData: true,
    },
    relatedCompanies: [
      { companyId: 'co-9', companyName: 'Widget Co', evidenceCount: 3, lastSeenAt: '2026-10-11T00:00:00.000Z' },
    ],
    deals: [
      {
        companyId: 'co-1',
        companyName: 'Acme',
        role: 'source',
        origin: 'email_attachment',
        stage: 'L1',
        stageLabel: 'L1 · Screening',
        isDropped: false,
        linkedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        companyId: 'co-2',
        companyName: 'Beta',
        role: 'involved',
        origin: 'manual',
        stage: 'L0',
        stageLabel: 'L0 · Intake',
        isDropped: true,
        linkedAt: '2026-10-02T00:00:00.000Z',
      },
    ],
    scorecard: {
      correspondentId: 'c-jimmy',
      dealsBrought: 1,
      dealsInvolved: 1,
      reachedL1: 1,
      conversion: 1,
      stageBreakdown: [
        { stageKey: 'L0', label: 'L0', count: 0 },
        { stageKey: 'L1', label: 'L1 · Screening', count: 1 },
        { stageKey: 'L2', label: 'L2', count: 0 },
      ],
      hasDealLinks: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.listBankers.mockReset();
  mocks.getContactInsights.mockReset();
  mocks.getConversation.mockReset();
  mocks.getConversation.mockResolvedValue({
    roles: { roles: [], emailCount: 0, evidence: null },
    overview: { roleSummary: null },
    notes: [],
  });
  mocks.createContainer.mockReset();
  mocks.createContainer.mockImplementation(() => ({
    bankerListService: { listBankers: mocks.listBankers },
    contactInsightsService: { getContactInsights: mocks.getContactInsights },
    contactConversationService: {
      getConversation: mocks.getConversation,
      getConversationForWorkforce: mocks.getConversationForWorkforce,
    },
  }));
  mocks.getActiveWorkspaceId.mockClear();
});

describe('crmBankerInsights contact mode', () => {
  it('returns the one matching person’s team interactions, deals and related companies', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));
    mocks.getContactInsights.mockResolvedValue(insights());

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;

    expect(mocks.listBankers).toHaveBeenCalledWith(expect.objectContaining({ q: 'Jimmy' }));
    expect(mocks.getContactInsights).toHaveBeenCalledWith('c-jimmy');
    expect(result).toContain('Banker insights — Jimmy Sprinkles @ Golden Sacks');
    expect(result).toContain("not Golden Sacks's");
    expect(result).toContain('- Last contact: 2026-10-14\n');
    expect(result).toContain('2 email(s) from us, 3 email(s) from them');
    expect(result).toContain('| Alice (alice@us.example) | 2 | 2 | 2026-10-14 |');
    expect(result).toContain('| Bob (bob@us.example) | 0 | 1 | 2026-10-12 |');
    expect(result).not.toMatch(/meeting/i);
    expect(result).toContain('Deals brought (source): 1 · involved: 1');
    expect(result).toContain('Reached L1 (passed screening, any time): 1 of 1 brought · conversion 100%');
    // Zero-count stages (filled in for the funnel UI) stay out of the text.
    expect(result).toContain('Furthest stage reached by the deals brought: L1 · Screening ×1\n');
    expect(result).toContain('- Acme — brought — current stage L1 · Screening');
    expect(result).toContain('- Beta — involved — current stage L0 · Intake (dropped)');
    expect(result).not.toMatch(/suggestion/i);
    expect(result).toContain('- Widget Co — 3 email(s), last 2026-10-11');
  });

  it('returns a disambiguation list with firm and email when several people match, and stops', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult([
        bankerRow(),
        bankerRow({ correspondentId: 'c-penny', name: 'Penny Ledger', email: 'penny@goldensacks.example' }),
      ]),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Golden Sacks' })) as string;

    expect(result).toContain('Several people match "Golden Sacks"');
    expect(result).toContain('- Jimmy Sprinkles — Golden Sacks — jimmy@goldensacks.example');
    expect(result).toContain('- Penny Ledger — Golden Sacks — penny@goldensacks.example');
    expect(result).toContain('Do not merge their numbers');
    expect(mocks.getContactInsights).not.toHaveBeenCalled();
  });

  it('prefers the exact name or email match over partial ones', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult([
        bankerRow({ correspondentId: 'c-jim', name: 'Jim Beam', email: 'jim@x.example' }),
        bankerRow({ correspondentId: 'c-jimbo', name: 'Jimbo Jones', email: 'jimbo@x.example' }),
      ]),
    );
    mocks.getContactInsights.mockResolvedValue(insights());

    await crmBankerInsights.invoke({ mode: 'contact', contact: 'JIM@x.example' });

    expect(mocks.getContactInsights).toHaveBeenCalledWith('c-jim');
  });

  it('says it could not find the person when nobody matches', async () => {
    mocks.listBankers.mockResolvedValue(listResult([]));

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Nobody' })) as string;

    expect(result).toContain('No CRM contact in this workspace matches "Nobody"');
    expect(result).toContain('Do not guess');
    expect(mocks.getContactInsights).not.toHaveBeenCalled();
  });

  it('writes "no data" instead of 0 when nothing is synced and no deal is linked', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()], { hasSyncedData: false }));
    mocks.getContactInsights.mockResolvedValue(
      insights({
        interactions: {
          correspondentId: 'c-jimmy',
          lastContactAt: null,
          totalEmailsFromUs: 0,
          totalEmailsFromThem: 0,
          teamMemberCount: 0,
          team: [],
          hasSyncedData: false,
        },
        relatedCompanies: [],
        deals: [],
        scorecard: {
          correspondentId: 'c-jimmy',
          dealsBrought: 0,
          dealsInvolved: 0,
          reachedL1: 0,
          conversion: null,
          stageBreakdown: [],
          hasDealLinks: false,
        },
      }),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;

    expect(result).toContain(NO_INTERACTION_DATA);
    expect(result).toContain("Say you don't know who on our team has talked to this person");
    expect(result).toContain('No deal links recorded for this person');
    expect(result).not.toMatch(/Totals|Deals brought \(source\): 0|email\(s\) from us/);
  });

  it('returns each person’s own numbers for two bankers at the same firm', async () => {
    mocks.listBankers.mockImplementation(async ({ q }: { q: string }) =>
      q === 'Jimmy Sprinkles'
        ? listResult([bankerRow()])
        : listResult([bankerRow({ correspondentId: 'c-penny', name: 'Penny Ledger' })]),
    );
    mocks.getContactInsights.mockImplementation(async (id: string) =>
      id === 'c-jimmy'
        ? insights()
        : insights({
            interactions: {
              ...insights().interactions,
              correspondentId: 'c-penny',
              totalEmailsFromUs: 1,
              totalEmailsFromThem: 3,
              teamMemberCount: 1,
              team: [insights().interactions.team[1]],
            },
          }),
    );

    const jimmy = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy Sprinkles' })) as string;
    const penny = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Penny Ledger' })) as string;

    expect(jimmy).toContain('2 email(s) from us, 3 email(s) from them');
    expect(penny).toContain('Penny Ledger @ Golden Sacks');
    expect(penny).toContain('1 email(s) from us, 3 email(s) from them');
    expect(penny).not.toContain('Alice');
    expect(mocks.getContactInsights.mock.calls.map((c) => c[0])).toEqual(['c-jimmy', 'c-penny']);
  });

  // Email notes are private to the people on each email: read as the chat
  // user (or the Workforce run's creator), never as anyone, and with no user
  // the service is asked for nobody's notes.
  it("reads a banker's notes as the chat user, as nobody without one, and in full in a Workforce run", async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));
    mocks.getContactInsights.mockResolvedValue(insights());
    mocks.getConversationForWorkforce.mockReset().mockResolvedValue(null);

    await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' }, { configurable: { userId: 'u-chat' } });
    expect(mocks.getConversation).toHaveBeenLastCalledWith('c-jimmy', 'u-chat', { limit: 10 });

    await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' });
    expect(mocks.getConversation).toHaveBeenLastCalledWith('c-jimmy', '', { limit: 10 });

    // Workforce: full context (its trace redacts this output; only the report is shared).
    mocks.getConversation.mockClear();
    await crmBankerInsights.invoke(
      { mode: 'contact', contact: 'Jimmy' },
      { configurable: { agentRole: 'workforce', triggered_by_user_id: 'u-run' } },
    );
    expect(mocks.getConversationForWorkforce).toHaveBeenCalledWith('c-jimmy', { limit: 10 });
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });

  it('renders role and conversation notes, and says when there are none', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));
    mocks.getContactInsights.mockResolvedValue(insights());

    const empty = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;
    expect(empty).toContain('### Role in investment\n- No role signals recorded.');
    expect(empty).toContain('### Conversation notes\n- no conversation notes yet');

    mocks.getConversation.mockResolvedValue({
      roles: {
        roles: [
          { label: 'funding', confidence: 'high', emailCount: 4 },
          { label: 'advisory', confidence: 'medium', emailCount: 2 },
        ],
        emailCount: 5,
        evidence: 'Advised on capital raising rounds.',
      },
      overview: { roleSummary: 'Jimmy mostly brings funding rounds and asks for syndicate decks.' },
      notes: [
        {
          emailId: 'e1',
          sentAt: '2026-10-15T12:00:00Z',
          direction: 'inbound',
          teamMembers: [{ userId: 'u1', name: 'Alice' }],
          summary: 'Discussed equity syndicate participation',
          keyPoints: [],
          nextStep: 'Send syndicate deck',
          nextStepStatus: 'action',
          sentiment: 'positive',
        },
      ],
    });

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;

    expect(result).toContain('### Role in investment');
    expect(result).toContain('funding (high), advisory (medium)');
    expect(result).toContain(
      'Across their emails: Jimmy mostly brings funding rounds and asks for syndicate decks.',
    );
    expect(result).toContain('Evidence: Advised on capital raising rounds.');
    expect(result).toContain('### Conversation notes');
    expect(result).toContain('2026-10-15 (Alice): Discussed equity syndicate participation — Next step: Send syndicate deck');
  });

  it('says the roles and notes are unknown, not none, when the conversation read fails', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));
    mocks.getContactInsights.mockResolvedValue(insights());
    mocks.getConversation.mockRejectedValue(new Error('db down'));

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;

    expect(result).toContain("### Role in investment\n- Could not be read right now. Say you don't know");
    expect(result).toContain("### Conversation notes\n- Could not be read right now. Say you don't know");
    expect(result).not.toContain('No role signals recorded');
    expect(result).not.toContain('no conversation notes yet');
    // The rest of the answer still comes through.
    expect(result).toContain('Deals brought (source): 1 · involved: 1');
  });

  it('asks for the contact instead of querying when it is missing', async () => {
    const result = (await crmBankerInsights.invoke({ mode: 'contact' })) as string;

    expect(result).toContain('contact mode needs `contact`');
    expect(mocks.listBankers).not.toHaveBeenCalled();
  });

  it('returns errors as a string rather than throwing into the agent', async () => {
    mocks.listBankers.mockRejectedValue(new Error('db down'));

    const result = (await crmBankerInsights.invoke({ mode: 'contact', contact: 'Jimmy' })) as string;

    expect(result).toBe('**Error:** db down');
  });
});

describe('crmBankerInsights ranking mode', () => {
  it('ranks by deals that reached L1 with the server-side sort', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult(
        [bankerRow(), bankerRow({ correspondentId: 'c-penny', name: 'Penny Ledger', dealsBrought: 1, reachedL1: 1, conversion: 1 })],
        { sort: 'reached_l1', total: 7 },
      ),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'reached_l1' })) as string;

    expect(mocks.listBankers).toHaveBeenCalledWith({ sort: 'reached_l1', pageSize: 10 });
    expect(result).toContain('## Bankers by deals brought that reached L1');
    expect(result).toContain('_Top 2 of 7 bankers listed.');
    expect(result).toContain(
      '1. **Jimmy Sprinkles** @ Golden Sacks (jimmy@goldensacks.example) — brought 2, involved 1, reached L1 1 (conversion 50%)',
    );
    expect(result).toContain('2. **Penny Ledger** @ Golden Sacks');
    expect(result).toContain('top team: Alice (5)');
  });

  it('says reached_l1 cannot be ranked when the workspace has no deal links', async () => {
    // The list silently falls back to `recent` without deal links.
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()], { sort: 'recent', hasDealLinks: false }));

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'reached_l1' })) as string;

    expect(result).toContain('This workspace has no deal links');
    expect(result).toContain('cannot be computed');
    expect(result).not.toContain('Jimmy Sprinkles');
  });

  it('maps metric recent_activity to the recent sort', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));

    await crmBankerInsights.invoke({ mode: 'ranking', metric: 'recent_activity' });

    expect(mocks.listBankers).toHaveBeenCalledWith(expect.objectContaining({ sort: 'recent' }));
  });

  it(`caps the limit at ${MAX_RANKING_LIMIT}`, async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));

    await crmBankerInsights.invoke({ mode: 'ranking', metric: 'emails', limit: 500 });

    expect(mocks.listBankers).toHaveBeenCalledWith(expect.objectContaining({ pageSize: MAX_RANKING_LIMIT }));
  });

  it('limits to bankers contacted within active_within_days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00.000Z'));
    try {
      mocks.listBankers.mockResolvedValue(listResult([bankerRow()]));

      const result = (await crmBankerInsights.invoke({
        mode: 'ranking',
        metric: 'emails',
        active_within_days: 7,
      })) as string;

      expect(mocks.listBankers).toHaveBeenCalledWith({
        sort: 'emails',
        pageSize: 10,
        lastContact: 'custom',
        customDate: '2026-10-10T00:00:00.000Z',
      });
      expect(result).toContain('contacted in the last 7 day(s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to rank interaction metrics when nothing is synced', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()], { hasSyncedData: false }));

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'emails' })) as string;

    expect(result).toContain(NO_INTERACTION_DATA);
    expect(result).not.toContain('Jimmy Sprinkles');
  });

  it('writes "no data" for interactions on a deal ranking when nothing is synced', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow()], { hasSyncedData: false }));

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'deals_brought' })) as string;

    expect(result).toContain(`interactions: ${NO_INTERACTION_DATA}`);
    expect(result).not.toContain('emails 2 from us');
  });

  it('writes "no deal links recorded" instead of zeros for a banker with no link', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult([bankerRow({ dealsBrought: 0, dealsInvolved: 0, reachedL1: 0, conversion: null })]),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'emails' })) as string;

    expect(result).toContain('deals: no deal links recorded');
    expect(result).not.toContain('brought 0');
  });

  it('writes n/a for conversion when nothing was brought', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult([bankerRow({ dealsBrought: 0, dealsInvolved: 2, reachedL1: 0, conversion: null })]),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'emails' })) as string;

    expect(result).toContain('conversion n/a, nothing brought');
  });

  it('leaves bankers with nothing past L0 out of a reached_l1 ranking', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult(
        [bankerRow(), bankerRow({ correspondentId: 'c-penny', name: 'Penny Ledger', dealsBrought: 0, reachedL1: 0, conversion: null })],
        { sort: 'reached_l1', total: 38 },
      ),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'reached_l1' })) as string;

    expect(result).toContain('_Top 1.');
    expect(result).toContain('Jimmy Sprinkles');
    expect(result).not.toContain('Penny Ledger');
  });

  it('says no banker matches when nobody has brought a deal', async () => {
    mocks.listBankers.mockResolvedValue(
      listResult([bankerRow({ dealsBrought: 0, reachedL1: 0, conversion: null })]),
    );

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'deals_brought' })) as string;

    expect(result).toContain('No banker matches.');
  });

  it('asks for a metric when it is missing', async () => {
    const result = (await crmBankerInsights.invoke({ mode: 'ranking' })) as string;

    expect(result).toContain('ranking mode needs `metric`');
    expect(mocks.listBankers).not.toHaveBeenCalled();
  });

  it('builds the container for the active workspace', async () => {
    mocks.getActiveWorkspaceId.mockResolvedValueOnce('ws-7');
    mocks.listBankers.mockResolvedValue(listResult([]));

    const result = (await crmBankerInsights.invoke({ mode: 'ranking', metric: 'emails' })) as string;

    expect(mocks.createContainer).toHaveBeenCalledWith({ db: true }, 'ws-7');
    expect(result).toContain('No banker matches.');
  });

  it('is batch-safe: ranking mode must not fetch notes per contact', async () => {
    mocks.listBankers.mockResolvedValue(listResult([bankerRow(), bankerRow({ correspondentId: 'c2' })]));
    await crmBankerInsights.invoke({ mode: 'ranking', metric: 'deals_brought' });
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });
});
