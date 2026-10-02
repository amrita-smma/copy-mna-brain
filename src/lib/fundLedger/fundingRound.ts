/**
 * Funding-round calculator (MB-567).
 *
 * Pure and UI-free, so the "Record funding round" dialog previews exactly the
 * figures `FlCorporateActionService` persists. A round only changes ownership %:
 * nothing here produces ledger entries or valuation marks, so invested capital,
 * realized proceeds, contributions and market value are untouched.
 *
 * Amounts are raw currency units as decimal strings; percentages are percent
 * points (12.5 = 12.5%), the same unit as a valuation's `shareholding_pct`.
 *
 *   post-money            = pre-money + round size
 *   stake w/o follow-on   = pre-round % × pre-money / post-money
 *   stake with follow-on  = (pre-round % × pre-money + follow-on) / post-money
 *   implied value         = effective % × post-money (shown, never saved)
 *
 * where the effective % is the manual override when one is given (for terms
 * the formula can't see, such as anti-dilution), otherwise the computed stake.
 */
import {
  flAdd,
  flCmp,
  flDiv,
  flGt,
  flIsZero,
  flLt,
  flMul,
  flSum,
  toDecimalString,
} from '@/lib/services/flDecimal';

const DECIMAL_RE = /^\s*[+-]?\d+(\.\d+)?\s*$/;
const HUNDRED = '100';

/**
 * Corporate actions that change our ownership %. A `funding_round` computes the
 * stake after from its terms; the other types take the stake after as entered.
 */
export const OWNERSHIP_ACTION_TYPES = ['funding_round', 'opening_stake', 'other'] as const;
export type OwnershipActionType = (typeof OWNERSHIP_ACTION_TYPES)[number];

export const OWNERSHIP_ACTION_LABELS: Record<OwnershipActionType, string> = {
  funding_round: 'Funding round',
  opening_stake: 'Opening stake',
  other: 'Other corporate action',
};

export function isOwnershipActionType(v: unknown): v is OwnershipActionType {
  return typeof v === 'string' && (OWNERSHIP_ACTION_TYPES as readonly string[]).includes(v);
}

export interface FundingRoundTerms {
  preMoney: string;
  roundSize: string;
}

export interface FundingRoundParticipantInput {
  positionId: string;
  preRoundPct: string;
  /** Follow-on cash this position put into the round; '0' when it didn't join. */
  participationAmount: string;
  overridePct?: string | null;
  overrideRemark?: string | null;
}

export interface FundingRoundParticipantResult {
  positionId: string;
  preRoundPct: string;
  participationAmount: string;
  pctWithoutParticipation: string;
  computedPct: string;
  effectivePct: string;
  overridden: boolean;
  value: string;
}

export interface FundingRoundResult {
  postMoney: string;
  dilutionFactor: string;
  totalParticipation: string;
  participants: FundingRoundParticipantResult[];
}

function isDecimal(v: string | null | undefined): v is string {
  return typeof v === 'string' && DECIMAL_RE.test(v);
}

function hasOverride(p: FundingRoundParticipantInput): boolean {
  return p.overridePct != null && p.overridePct.trim() !== '';
}

function inPctRange(v: string): boolean {
  return !flLt(v, '0') && !flGt(v, HUNDRED);
}

/**
 * Every reason the round can't be computed, as user-facing messages. Empty
 * means `computeFundingRound` will succeed.
 */
export function validateFundingRound(
  terms: FundingRoundTerms,
  participants: FundingRoundParticipantInput[],
): string[] {
  const errors: string[] = [];

  const preMoneyOk = isDecimal(terms.preMoney);
  if (!preMoneyOk || !flGt(terms.preMoney, '0')) {
    errors.push('Pre-money valuation must be greater than zero.');
  }
  const roundSizeOk = isDecimal(terms.roundSize);
  if (!roundSizeOk || flLt(terms.roundSize, '0')) {
    errors.push('Round size must be zero or more.');
  }

  if (participants.length === 0) {
    errors.push('A round must re-mark at least one position.');
  }

  const seen = new Set<string>();
  let amountsOk = true;
  for (const p of participants) {
    if (seen.has(p.positionId)) {
      errors.push(`Position ${p.positionId} appears more than once.`);
    }
    seen.add(p.positionId);

    if (!isDecimal(p.preRoundPct) || !inPctRange(p.preRoundPct)) {
      errors.push('Each pre-round stake must be between 0% and 100%.');
    }
    if (!isDecimal(p.participationAmount) || flLt(p.participationAmount, '0')) {
      amountsOk = false;
      errors.push('Each follow-on amount must be zero or more.');
    }
    if (hasOverride(p)) {
      if (!isDecimal(p.overridePct) || !inPctRange(p.overridePct)) {
        errors.push('An overridden stake must be between 0% and 100%.');
      }
      if (!p.overrideRemark?.trim()) {
        errors.push('An overridden stake needs a remark explaining why.');
      }
    }
  }

  if (roundSizeOk && amountsOk && participants.length > 0) {
    const total = flSum(participants.map((p) => p.participationAmount));
    if (flGt(total, terms.roundSize)) {
      errors.push('Our follow-on amounts add up to more than the round size.');
    }
  }

  return Array.from(new Set(errors));
}

/** Implied value of a stake (percent points) at post-money. Display only; never saved as a mark. */
export function fundingRoundPositionValue(pct: string, postMoney: string): string {
  return flDiv(flMul(pct, postMoney), HUNDRED);
}

/** Computes the round. Throws if {@link validateFundingRound} reports errors. */
export function computeFundingRound(
  terms: FundingRoundTerms,
  participants: FundingRoundParticipantInput[],
): FundingRoundResult {
  const errors = validateFundingRound(terms, participants);
  if (errors.length > 0) {
    throw new RangeError(errors.join(' '));
  }

  const preMoney = toDecimalString(terms.preMoney.trim());
  const roundSize = toDecimalString(terms.roundSize.trim());
  const postMoney = flAdd(preMoney, roundSize);
  const dilutionFactor = flDiv(preMoney, postMoney);

  const results = participants.map((p): FundingRoundParticipantResult => {
    const preRoundPct = toDecimalString(p.preRoundPct.trim());
    const participationAmount = toDecimalString(p.participationAmount.trim());
    // Multiply before dividing so the 8-dp rounding happens once, at the end.
    const ownedPreMoney = flMul(preRoundPct, preMoney);
    const pctWithoutParticipation = flDiv(ownedPreMoney, postMoney);
    const computedPct = flDiv(
      flAdd(ownedPreMoney, flMul(participationAmount, HUNDRED)),
      postMoney,
    );
    const overridden = hasOverride(p);
    const effectivePct = overridden ? toDecimalString(p.overridePct!.trim()) : computedPct;
    const value = fundingRoundPositionValue(effectivePct, postMoney);
    return {
      positionId: p.positionId,
      preRoundPct,
      participationAmount,
      pctWithoutParticipation,
      computedPct,
      effectivePct,
      overridden,
      value,
    };
  });

  return {
    postMoney,
    dilutionFactor,
    totalParticipation: flSum(results.map((r) => r.participationAmount)),
    participants: results,
  };
}

// ── Direct ownership changes (opening stake, other corporate actions) ────────

export interface DirectOwnershipInput {
  positionId: string;
  /** Stake before the action. Always 0 for an opening stake. */
  preRoundPct: string;
  pctAfter: string;
}

export interface DirectOwnershipResult {
  positionId: string;
  preRoundPct: string;
  pctAfter: string;
}

/**
 * Every reason a non-round action can't be saved, as user-facing messages.
 * Empty means {@link computeDirectOwnershipChange} will succeed.
 */
export function validateDirectOwnershipChange(
  actionType: Exclude<OwnershipActionType, 'funding_round'>,
  participants: DirectOwnershipInput[],
): string[] {
  const errors: string[] = [];
  if (participants.length === 0) {
    errors.push('An action must change at least one position.');
  }
  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p.positionId)) {
      errors.push(`Position ${p.positionId} appears more than once.`);
    }
    seen.add(p.positionId);
    if (actionType === 'other' && (!isDecimal(p.preRoundPct) || !inPctRange(p.preRoundPct))) {
      errors.push('Each stake before must be between 0% and 100%.');
    }
    if (!isDecimal(p.pctAfter) || !inPctRange(p.pctAfter)) {
      errors.push(
        actionType === 'opening_stake'
          ? 'Each opening stake must be between 0% and 100%.'
          : 'Each stake after must be between 0% and 100%.',
      );
    }
  }
  return Array.from(new Set(errors));
}

/** Normalises a non-round action. Throws if {@link validateDirectOwnershipChange} reports errors. */
export function computeDirectOwnershipChange(
  actionType: Exclude<OwnershipActionType, 'funding_round'>,
  participants: DirectOwnershipInput[],
): DirectOwnershipResult[] {
  const errors = validateDirectOwnershipChange(actionType, participants);
  if (errors.length > 0) {
    throw new RangeError(errors.join(' '));
  }
  return participants.map((p) => ({
    positionId: p.positionId,
    preRoundPct: actionType === 'opening_stake' ? toDecimalString('0') : toDecimalString(p.preRoundPct.trim()),
    pctAfter: toDecimalString(p.pctAfter.trim()),
  }));
}

// ── Staleness ────────────────────────────────────────────────────────────────

export interface FundingRoundForStaleness {
  id: string;
  roundDate: string;
  createdAt: string;
  /** An opening stake starts a position's chain, so it is never stale itself. */
  resetsChain?: boolean;
  changes: Array<{ positionId: string; preRoundPct: string; effectivePct: string }>;
}

/**
 * Rounds whose pre-round stake no longer matches the stake the previous round
 * left that position with — because an earlier round was edited, deleted, or
 * back-dated in after it. Such rounds are flagged, never recomputed: their
 * inputs were entered against what the user saw at the time.
 */
export function findStaleFundingRounds(rounds: FundingRoundForStaleness[]): Set<string> {
  const ordered = [...rounds].sort(
    (a, b) =>
      a.roundDate.localeCompare(b.roundDate) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const lastPctByPosition = new Map<string, string>();
  const stale = new Set<string>();
  for (const round of ordered) {
    for (const p of round.changes) {
      if (round.resetsChain) break;
      const prior = lastPctByPosition.get(p.positionId);
      if (prior !== undefined && flCmp(prior, p.preRoundPct) !== 0) {
        stale.add(round.id);
      }
    }
    for (const p of round.changes) {
      lastPctByPosition.set(p.positionId, p.effectivePct);
    }
  }
  return stale;
}

// ── Follow-on cross-check ────────────────────────────────────────────────────

/** Days either side of the round date a follow-on `buy` entry may fall. */
export const FOLLOW_ON_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

/**
 * Position ids that put follow-on money into the round but have no `buy`
 * ledger entry within {@link FOLLOW_ON_WINDOW_DAYS} of the round date. The
 * calculator never posts cash, so this is a reminder, not a blocker.
 */
export function positionsMissingFollowOnEntry(
  roundDate: string,
  participants: Array<{ positionId: string; participationAmount: string }>,
  entries: Array<{ position_id: string; entry_type: string; entry_date: string }>,
): string[] {
  const covered = new Set(
    entries
      .filter(
        (e) =>
          e.entry_type === 'buy' && daysBetween(e.entry_date, roundDate) <= FOLLOW_ON_WINDOW_DAYS,
      )
      .map((e) => e.position_id),
  );
  return participants
    .filter((p) => !flIsZero(p.participationAmount) && !covered.has(p.positionId))
    .map((p) => p.positionId);
}

// ── Valuation notes (a quarterly mark may carry shareholding_pct) ──────────

const SOURCE_META = 'source_meta:';

/** Reads `shareholding_pct` from a valuation's `source_meta` notes suffix. */
export function readShareholdingPct(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const idx = notes.indexOf(SOURCE_META);
  if (idx === -1) return null;
  try {
    const meta = JSON.parse(notes.slice(idx + SOURCE_META.length).trim());
    const pct = meta?.shareholding_pct;
    if (pct == null) return null;
    const str = String(pct);
    return isDecimal(str) ? toDecimalString(str) : null;
  } catch {
    return null;
  }
}
