/**
 * Deal Sponsor auto-assignment scoring (MB-830). Pure and deterministic: the
 * same inputs always pick the same user. Recency is measured from the new
 * company's arrival (`created_at`), never the wall clock, so a re-run or a
 * backtest replays the original pick.
 *
 * Every candidate earns points from five signals; the highest total wins when
 * it reaches {@link SPONSOR_WEIGHTS.minScore}, otherwise nobody is assigned
 * and the card keeps falling back to the matched Track's PIC.
 */

export const SPONSOR_WEIGHTS = {
  /** Per past deal of the sending banker the user owned. */
  bankerDeal: 3,
  /** The banker was only involved in that deal, not its source. */
  bankerInvolvedFactor: 0.5,
  /** That deal was dropped. */
  droppedFactor: 0.5,
  /** The user covers the banker's firm (`employer_team_members`). */
  firmCoverage: 4,
  /** The user is PIC of a Track the company matches. */
  trackPic: 3,
  /** Per past deal the user owned in the same sector (`companies.segment`). */
  sectorDeal: 1,
  sectorCap: 4,
  /** Per past deal the user owned in the same country. */
  countryDeal: 0.25,
  countryCap: 1,
  /** The user's mailbox received the email (`companies.entered_by`). */
  mailboxOwner: 1,
  /** Below this, nobody is assigned. */
  minScore: 3,
} as const;

/** How far a past deal got: L0, L1 up to L3, L3 onward. */
export type StageTier = 'first' | 'middle' | 'captain';

const STAGE_FACTOR: Record<StageTier, number> = { first: 1, middle: 1.5, captain: 2 };

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

/** 1 under six months before arrival, 0.6 up to eighteen, 0.3 older. */
export function recencyFactor(dealCreatedAt: string, arrivalAt: string): number {
  const months = (Date.parse(arrivalAt) - Date.parse(dealCreatedAt)) / MS_PER_MONTH;
  if (months < 6) return 1;
  if (months < 18) return 0.6;
  return 0.3;
}

/**
 * Sector / country comparison key: lowercase, `&` read as "and", whitespace
 * collapsed. `companyRepository.findOwnedDealsForSponsorMatch` applies the
 * same rule in SQL — change both together.
 */
export function normalizeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.toLowerCase().replaceAll('&', ' and ').replace(/\s+/g, ' ').trim();
  return key || null;
}

/** A past deal some user owns (its Deal Captain, else its Deal Sponsor). */
export interface OwnedDeal {
  companyId: string;
  ownerId: string;
  tier: StageTier;
  dropped: boolean;
  createdAt: string;
}

/** A past deal of the sending banker. */
export interface BankerDeal extends OwnedDeal {
  role: 'source' | 'involved';
  bankerName: string;
}

/** A past deal anyone brought, matched on sector or country. */
export interface MarketDeal extends OwnedDeal {
  /** Normalised with {@link normalizeLabel}. */
  segment: string | null;
  geography: string | null;
}

export interface SponsorScoringInput {
  /** The new company's `created_at`. */
  arrivalAt: string;
  /** The new company's sector and country as stored (display form). */
  segment: string | null;
  geography: string | null;
  bankerDeals: BankerDeal[];
  coverage: Array<{ userId: string; firmName: string }>;
  trackPics: Array<{ userId: string; trackName: string }>;
  marketDeals: MarketDeal[];
  mailboxOwnerId: string | null;
  /** Workspace members who may be assigned; everyone else scores nothing. */
  eligibleUserIds: ReadonlySet<string>;
}

export interface SponsorCandidate {
  userId: string;
  /** Rounded to 4 decimals so float noise never decides a tie. */
  score: number;
  /** Why, in the order the signals are listed above. */
  reasons: string[];
  /** Newest banker-history deal the user owned, for the first tie-break. */
  latestBankerDealAt: string | null;
  isMailboxOwner: boolean;
}

export interface SponsorPick {
  userId: string;
  score: number;
  /** Shown to users beside the auto-assigned sponsor. */
  reason: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A stored label as a reason shows it: trimmed, inner whitespace collapsed. */
const displayLabel = (value: string) => value.trim().replace(/\s+/g, ' ');

function dealWeight(deal: OwnedDeal, base: number, arrivalAt: string): number {
  return (
    base *
    STAGE_FACTOR[deal.tier] *
    recencyFactor(deal.createdAt, arrivalAt) *
    (deal.dropped ? SPONSOR_WEIGHTS.droppedFactor : 1)
  );
}

/** Only deals that arrived before the new company count. */
const before = (deal: OwnedDeal, arrivalAt: string) =>
  Date.parse(deal.createdAt) < Date.parse(arrivalAt);

/** Every eligible user with any points, best first (see {@link compareCandidates}). */
export function scoreSponsorCandidates(input: SponsorScoringInput): SponsorCandidate[] {
  const { arrivalAt, eligibleUserIds } = input;
  const W = SPONSOR_WEIGHTS;
  const banker = new Map<string, { points: number; byBanker: Map<string, number>; latest: string | null }>();
  const coverage = new Map<string, string[]>();
  const tracks = new Map<string, string[]>();
  const sector = new Map<string, { points: number; count: number }>();
  const country = new Map<string, { points: number; count: number }>();

  // One deal counts once for banker history even when several senders are on
  // it; `source` beats `involved`.
  const bankerByDeal = new Map<string, BankerDeal>();
  for (const deal of input.bankerDeals) {
    if (!eligibleUserIds.has(deal.ownerId) || !before(deal, arrivalAt)) continue;
    const seen = bankerByDeal.get(deal.companyId);
    if (!seen || (seen.role === 'involved' && deal.role === 'source')) {
      bankerByDeal.set(deal.companyId, deal);
    }
  }
  for (const deal of bankerByDeal.values()) {
    const roleFactor = deal.role === 'source' ? 1 : W.bankerInvolvedFactor;
    const entry = banker.get(deal.ownerId) ?? { points: 0, byBanker: new Map(), latest: null };
    entry.points += dealWeight(deal, W.bankerDeal, arrivalAt) * roleFactor;
    entry.byBanker.set(deal.bankerName, (entry.byBanker.get(deal.bankerName) ?? 0) + 1);
    // ISO, so the tie-break can compare it as a string whatever offset the row carried.
    const at = new Date(Date.parse(deal.createdAt)).toISOString();
    if (!entry.latest || at > entry.latest) entry.latest = at;
    banker.set(deal.ownerId, entry);
  }

  for (const { userId, firmName } of input.coverage) {
    if (!eligibleUserIds.has(userId)) continue;
    const firms = coverage.get(userId) ?? [];
    if (!firms.includes(firmName)) firms.push(firmName);
    coverage.set(userId, firms);
  }

  for (const { userId, trackName } of input.trackPics) {
    if (!eligibleUserIds.has(userId)) continue;
    const names = tracks.get(userId) ?? [];
    if (!names.includes(trackName)) names.push(trackName);
    tracks.set(userId, names);
  }

  // A deal already counted as banker history is not counted again here.
  const segmentKey = normalizeLabel(input.segment);
  const geographyKey = normalizeLabel(input.geography);
  const seenMarket = new Set<string>();
  for (const deal of input.marketDeals) {
    if (!eligibleUserIds.has(deal.ownerId) || !before(deal, arrivalAt)) continue;
    if (bankerByDeal.has(deal.companyId) || seenMarket.has(deal.companyId)) continue;
    seenMarket.add(deal.companyId);
    if (segmentKey && deal.segment === segmentKey) {
      const entry = sector.get(deal.ownerId) ?? { points: 0, count: 0 };
      entry.points += dealWeight(deal, W.sectorDeal, arrivalAt);
      entry.count += 1;
      sector.set(deal.ownerId, entry);
    }
    if (geographyKey && deal.geography === geographyKey) {
      const entry = country.get(deal.ownerId) ?? { points: 0, count: 0 };
      entry.points += W.countryDeal;
      entry.count += 1;
      country.set(deal.ownerId, entry);
    }
  }

  const mailboxOwnerId =
    input.mailboxOwnerId && eligibleUserIds.has(input.mailboxOwnerId) ? input.mailboxOwnerId : null;

  const userIds = new Set<string>([
    ...banker.keys(),
    ...coverage.keys(),
    ...tracks.keys(),
    ...sector.keys(),
    ...country.keys(),
    ...(mailboxOwnerId ? [mailboxOwnerId] : []),
  ]);

  const candidates: SponsorCandidate[] = [];
  for (const userId of userIds) {
    let score = 0;
    const reasons: string[] = [];
    const b = banker.get(userId);
    if (b) {
      score += b.points;
      for (const [name, count] of b.byBanker) reasons.push(`${plural(count, 'past deal')} with ${name}`);
    }
    const firms = coverage.get(userId);
    if (firms) {
      score += W.firmCoverage;
      reasons.push(`covers ${firms.join(', ')}`);
    }
    const trackNames = tracks.get(userId);
    if (trackNames) {
      score += W.trackPic;
      reasons.push(`PIC of the ${trackNames.join(', ')} ${trackNames.length === 1 ? 'Track' : 'Tracks'}`);
    }
    const s = sector.get(userId);
    if (s) {
      score += Math.min(s.points, W.sectorCap);
      reasons.push(plural(s.count, `${displayLabel(input.segment!)} deal`));
    }
    const c = country.get(userId);
    if (c) {
      score += Math.min(c.points, W.countryCap);
      reasons.push(`${plural(c.count, 'deal')} in ${displayLabel(input.geography!)}`);
    }
    const isMailboxOwner = userId === mailboxOwnerId;
    if (isMailboxOwner) {
      score += W.mailboxOwner;
      reasons.push('received the email');
    }
    candidates.push({
      userId,
      score: Math.round(score * 10_000) / 10_000,
      reasons,
      latestBankerDealAt: b?.latest ?? null,
      isMailboxOwner,
    });
  }
  return candidates.sort((x, y) => compareCandidates(x, y));
}

/**
 * Best first: higher score, then the most recent deal with this banker, then
 * the mailbox owner, then fewer active deals (when counts are given), then the
 * lowest user id — so the order never depends on input order.
 */
export function compareCandidates(
  a: SponsorCandidate,
  b: SponsorCandidate,
  activeDeals?: ReadonlyMap<string, number>,
): number {
  if (a.score !== b.score) return b.score - a.score;
  const aLatest = a.latestBankerDealAt ?? '';
  const bLatest = b.latestBankerDealAt ?? '';
  if (aLatest !== bLatest) return aLatest > bLatest ? -1 : 1;
  if (a.isMailboxOwner !== b.isMailboxOwner) return a.isMailboxOwner ? -1 : 1;
  if (activeDeals) {
    const diff = (activeDeals.get(a.userId) ?? 0) - (activeDeals.get(b.userId) ?? 0);
    if (diff !== 0) return diff;
  }
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * Whether the active-deal tie-break could change the pick: the top two
 * qualifying candidates are level on every earlier rule.
 */
export function needsActiveDealTieBreak(candidates: readonly SponsorCandidate[]): boolean {
  const [first, second] = candidates;
  if (!first || !second || first.score < SPONSOR_WEIGHTS.minScore) return false;
  return (
    first.score === second.score &&
    (first.latestBankerDealAt ?? '') === (second.latestBankerDealAt ?? '') &&
    first.isMailboxOwner === second.isMailboxOwner
  );
}

/** The winner, or `null` when nobody reaches {@link SPONSOR_WEIGHTS.minScore}. */
export function pickSponsor(
  candidates: readonly SponsorCandidate[],
  activeDeals?: ReadonlyMap<string, number>,
): SponsorPick | null {
  const [best] = [...candidates].sort((a, b) => compareCandidates(a, b, activeDeals));
  if (!best || best.score < SPONSOR_WEIGHTS.minScore) return null;
  return { userId: best.userId, score: best.score, reason: best.reasons.join(' · ') };
}
