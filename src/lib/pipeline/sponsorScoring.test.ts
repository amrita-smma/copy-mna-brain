import { describe, it, expect } from 'vitest';
import {
  compareCandidates,
  needsActiveDealTieBreak,
  normalizeLabel,
  pickSponsor,
  recencyFactor,
  scoreSponsorCandidates,
  type BankerDeal,
  type MarketDeal,
  type SponsorScoringInput,
} from './sponsorScoring';

const ARRIVAL = '2026-10-21T00:00:00.000Z';
const monthsBefore = (months: number) =>
  new Date(Date.parse(ARRIVAL) - months * 30.44 * 24 * 60 * 60 * 1000).toISOString();

const bankerDeal = (over: Partial<BankerDeal> = {}): BankerDeal => ({
  companyId: 'c1',
  ownerId: 'alice',
  tier: 'first',
  dropped: false,
  createdAt: monthsBefore(2),
  role: 'source',
  bankerName: 'Banker A',
  ...over,
});

const marketDeal = (over: Partial<MarketDeal> = {}): MarketDeal => ({
  companyId: 'm1',
  ownerId: 'alice',
  tier: 'first',
  dropped: false,
  createdAt: monthsBefore(2),
  segment: 'healthcare',
  geography: 'indonesia',
  ...over,
});

const input = (over: Partial<SponsorScoringInput> = {}): SponsorScoringInput => ({
  arrivalAt: ARRIVAL,
  segment: 'Healthcare',
  geography: 'Indonesia',
  bankerDeals: [],
  coverage: [],
  trackPics: [],
  marketDeals: [],
  mailboxOwnerId: null,
  eligibleUserIds: new Set(['alice', 'bob', 'carol']),
  ...over,
});

describe('normalizeLabel', () => {
  it('lowercases, reads & as "and" and collapses whitespace', () => {
    expect(normalizeLabel('  Food &  Beverage ')).toBe('food and beverage');
    expect(normalizeLabel('Food and Beverage')).toBe('food and beverage');
  });

  it('keeps distinct sectors distinct (no fuzzy matching)', () => {
    expect(normalizeLabel('Healthcare')).not.toBe(normalizeLabel('Healthcare IT'));
  });

  it('returns null for empty values', () => {
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel('   ')).toBeNull();
  });
});

describe('recencyFactor', () => {
  it('steps from 1 to 0.6 to 0.3 at six and eighteen months before arrival', () => {
    expect(recencyFactor(monthsBefore(5.9), ARRIVAL)).toBe(1);
    expect(recencyFactor(monthsBefore(6.1), ARRIVAL)).toBe(0.6);
    expect(recencyFactor(monthsBefore(17.9), ARRIVAL)).toBe(0.6);
    expect(recencyFactor(monthsBefore(18.1), ARRIVAL)).toBe(0.3);
  });

  it('is measured from arrival, not the wall clock', () => {
    expect(recencyFactor('2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z')).toBe(1);
  });
});

describe('scoreSponsorCandidates', () => {
  it('picks Bob (5.9) over Alice (4.5) in the worked example', () => {
    const candidates = scoreSponsorCandidates(
      input({
        bankerDeals: [
          bankerDeal({ companyId: 'c1', ownerId: 'alice', tier: 'middle', createdAt: monthsBefore(4) }),
          bankerDeal({ companyId: 'c2', ownerId: 'bob', tier: 'first', dropped: true, createdAt: monthsBefore(12) }),
        ],
        coverage: [{ userId: 'bob', firmName: 'Firm X' }],
        mailboxOwnerId: 'bob',
      }),
    );
    expect(candidates.map((c) => [c.userId, c.score])).toEqual([
      ['bob', 5.9],
      ['alice', 4.5],
    ]);
    expect(pickSponsor(candidates)).toEqual({
      userId: 'bob',
      score: 5.9,
      reason: '1 past deal with Banker A · covers Firm X · received the email',
    });
  });

  it('weights L3+ deals double and halves deals the banker was only involved in', () => {
    const [alice] = scoreSponsorCandidates(
      input({ bankerDeals: [bankerDeal({ tier: 'captain', role: 'involved' })] }),
    );
    expect(alice.score).toBe(3);
  });

  it('counts a deal once when several senders are on it, as source over involved', () => {
    const [alice] = scoreSponsorCandidates(
      input({
        bankerDeals: [
          bankerDeal({ role: 'involved', bankerName: 'Banker B' }),
          bankerDeal({ role: 'source', bankerName: 'Banker A' }),
        ],
      }),
    );
    expect(alice.score).toBe(3);
    expect(alice.reasons).toEqual(['1 past deal with Banker A']);
  });

  it('caps the sector signal at 4 and the country signal at 1', () => {
    const deals = Array.from({ length: 10 }, (_, i) => marketDeal({ companyId: `m${i}`, tier: 'captain' }));
    const [alice] = scoreSponsorCandidates(input({ marketDeals: deals }));
    expect(alice.score).toBe(5);
    expect(alice.reasons).toEqual(['10 Healthcare deals', '10 deals in Indonesia']);
  });

  it('shows the sector and country tidied in the reason', () => {
    const [alice] = scoreSponsorCandidates(
      input({ segment: ' Food  and Beverage ', geography: ' Indonesia ', marketDeals: [marketDeal({ segment: 'food and beverage' })] }),
    );
    expect(alice.reasons).toEqual(['1 Food and Beverage deal', '1 deal in Indonesia']);
  });

  it('does not count a banker-history deal again as a sector deal', () => {
    const [alice] = scoreSponsorCandidates(
      input({
        bankerDeals: [bankerDeal({ companyId: 'c1' })],
        marketDeals: [marketDeal({ companyId: 'c1' })],
      }),
    );
    expect(alice.score).toBe(3);
  });

  it('ignores deals that arrived after the new company', () => {
    const candidates = scoreSponsorCandidates(
      input({ bankerDeals: [bankerDeal({ createdAt: '2026-11-01T00:00:00Z' })] }),
    );
    expect(candidates).toEqual([]);
  });

  it('gives nothing to users outside the workspace', () => {
    const candidates = scoreSponsorCandidates(
      input({
        bankerDeals: [bankerDeal({ ownerId: 'outsider' })],
        coverage: [{ userId: 'outsider', firmName: 'Firm X' }],
        mailboxOwnerId: 'outsider',
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('credits the Track PIC', () => {
    const [carol] = scoreSponsorCandidates(
      input({ trackPics: [{ userId: 'carol', trackName: 'Healthcare Rollup' }] }),
    );
    expect(carol).toMatchObject({ userId: 'carol', score: 3, reasons: ['PIC of the Healthcare Rollup Track'] });
  });
});

describe('pickSponsor', () => {
  it('assigns nobody when the best score is below 3', () => {
    const candidates = scoreSponsorCandidates(input({ mailboxOwnerId: 'bob' }));
    expect(candidates).toHaveLength(1);
    expect(pickSponsor(candidates)).toBeNull();
  });

  it('assigns nobody when there are no candidates', () => {
    expect(pickSponsor([])).toBeNull();
  });

  it('breaks a score tie on the most recent deal with this banker', () => {
    const candidates = scoreSponsorCandidates(
      input({
        bankerDeals: [
          bankerDeal({ companyId: 'c1', ownerId: 'alice', createdAt: monthsBefore(3) }),
          bankerDeal({ companyId: 'c2', ownerId: 'bob', createdAt: monthsBefore(1) }),
        ],
      }),
    );
    expect(pickSponsor(candidates)?.userId).toBe('bob');
  });

  it('then on fewer active deals, then on the lowest user id', () => {
    const candidates = scoreSponsorCandidates(
      input({
        coverage: [
          { userId: 'bob', firmName: 'Firm X' },
          { userId: 'alice', firmName: 'Firm X' },
        ],
      }),
    );
    expect(needsActiveDealTieBreak(candidates)).toBe(true);
    expect(pickSponsor(candidates)?.userId).toBe('alice');
    expect(pickSponsor(candidates, new Map([['alice', 5], ['bob', 2]]))?.userId).toBe('bob');
  });

  it('does not depend on input order', () => {
    const a = scoreSponsorCandidates(
      input({ coverage: [{ userId: 'bob', firmName: 'X' }, { userId: 'alice', firmName: 'X' }] }),
    );
    const b = scoreSponsorCandidates(
      input({ coverage: [{ userId: 'alice', firmName: 'X' }, { userId: 'bob', firmName: 'X' }] }),
    );
    expect(pickSponsor(a)).toEqual(pickSponsor(b));
  });
});

describe('compareCandidates', () => {
  it('prefers the mailbox owner on an otherwise level tie', () => {
    const base = { score: 4, reasons: [], latestBankerDealAt: null };
    expect(
      compareCandidates(
        { ...base, userId: 'a', isMailboxOwner: false },
        { ...base, userId: 'b', isMailboxOwner: true },
      ),
    ).toBeGreaterThan(0);
  });
});
