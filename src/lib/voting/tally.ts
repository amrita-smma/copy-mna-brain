/**
 * Pure vote-tallying rules for the company voting system. Kept out of the
 * service so the UI, the recap email and the results card all derive the same
 * headline from the same code.
 */

export const VOTE_CHOICES = [
  'hard_yes',
  'yes',
  'no',
  'inconclusive',
  'hard_no',
] as const;

export type VoteChoice = (typeof VOTE_CHOICES)[number];

export const VOTE_CHOICE_LABELS: Record<VoteChoice, string> = {
  hard_yes: 'HARD YES',
  yes: 'YES',
  no: 'NO',
  inconclusive: 'INCONCLUSIVE',
  hard_no: 'HARD NO',
};

/**
 * The choice an unsubmitted ballot is auto-submitted with at the deadline.
 * `inconclusive` — never a directional vote the voter did not cast.
 */
export const DEFAULT_UNCAST_CHOICE: VoteChoice = 'inconclusive';

export const isVoteChoice = (value: unknown): value is VoteChoice =>
  typeof value === 'string' && (VOTE_CHOICES as readonly string[]).includes(value);

/** `hard_yes` / `yes` are FOR; `hard_no` / `no` are AGAINST; the rest abstain. */
export function voteSide(choice: VoteChoice): 'for' | 'against' | 'neutral' {
  if (choice === 'hard_yes' || choice === 'yes') return 'for';
  if (choice === 'hard_no' || choice === 'no') return 'against';
  return 'neutral';
}

export type VoteOutcome = 'proceed' | 'decline' | 'split';

export interface VoteTally {
  counts: Record<VoteChoice, number>;
  /** hard_yes + yes */
  forCount: number;
  /** hard_no + no */
  againstCount: number;
  inconclusiveCount: number;
  /** Ballots that carried an actual choice. */
  castCount: number;
  outcome: VoteOutcome;
  /** e.g. `4–0 FOR`, `1–3 AGAINST`, `2–2 SPLIT`. */
  headline: string;
  /** e.g. `4 Proceed`, `3 Decline`, `Split`. */
  outcomeLabel: string;
  /** True when every cast ballot landed on the same side. */
  unanimous: boolean;
}

const EN_DASH = '–';

function emptyCounts(): Record<VoteChoice, number> {
  return { hard_yes: 0, yes: 0, no: 0, inconclusive: 0, hard_no: 0 };
}

/**
 * Tally a set of ballot choices. `null` choices (a voter who never picked one)
 * are ignored — the deadline sweep is what turns those into an explicit
 * `inconclusive`, so a mid-flight tally never invents a vote.
 */
export function tallyVotes(choices: Array<VoteChoice | null | undefined>): VoteTally {
  const counts = emptyCounts();
  for (const choice of choices) {
    if (isVoteChoice(choice)) counts[choice] += 1;
  }

  const forCount = counts.hard_yes + counts.yes;
  const againstCount = counts.hard_no + counts.no;
  const inconclusiveCount = counts.inconclusive;
  const castCount = forCount + againstCount + inconclusiveCount;

  const outcome: VoteOutcome =
    forCount > againstCount ? 'proceed' : againstCount > forCount ? 'decline' : 'split';

  const headline =
    outcome === 'proceed'
      ? `${forCount}${EN_DASH}${againstCount} FOR`
      : outcome === 'decline'
        ? `${againstCount}${EN_DASH}${forCount} AGAINST`
        : `${forCount}${EN_DASH}${againstCount} SPLIT`;

  const outcomeLabel =
    outcome === 'proceed'
      ? `${forCount} Proceed`
      : outcome === 'decline'
        ? `${againstCount} Decline`
        : 'Split';

  const unanimous =
    castCount > 0 &&
    ((forCount === castCount && againstCount === 0) ||
      (againstCount === castCount && forCount === 0));

  return {
    counts,
    forCount,
    againstCount,
    inconclusiveCount,
    castCount,
    outcome,
    headline,
    outcomeLabel,
    unanimous,
  };
}

/**
 * Turn the initiator's days/hours picker into an absolute deadline.
 *
 * Throws when the total duration is zero — a vote that expires the instant it
 * opens would be swept before anyone could read the invitation email.
 */
export function computeDeadline(
  from: Date,
  durationDays: number,
  durationHours: number,
): Date {
  const days = Math.trunc(durationDays);
  const hours = Math.trunc(durationHours);
  if (!Number.isFinite(days) || !Number.isFinite(hours) || days < 0 || hours < 0) {
    throw new Error('Vote duration must be a non-negative number of days and hours.');
  }
  const totalHours = days * 24 + hours;
  if (totalHours <= 0) {
    throw new Error('Vote duration must be at least 1 hour.');
  }
  return new Date(from.getTime() + totalHours * 60 * 60 * 1000);
}

/**
 * Map the company's standing AI Opinion verdict onto a ballot choice, so the
 * AI participates in the tally as one more voter.
 *
 * `pass`/`fail` map to the plain YES/NO, never the HARD variants: the verdict
 * expresses a direction, not the conviction a human signals by choosing HARD.
 * Anything else — `tentative`, an unrecognised verdict, or no opinion on record
 * (e.g. generation was still running when the round closed) — abstains as
 * INCONCLUSIVE rather than inventing a direction.
 */
export function aiVerdictToVoteChoice(
  verdict: string | null | undefined,
): VoteChoice {
  switch (verdict?.trim().toLowerCase()) {
    case 'pass':
      return 'yes';
    case 'fail':
      return 'no';
    default:
      return 'inconclusive';
  }
}

/** Human duration for the invitation email, e.g. `2 days 4 hours`. */
export function formatDuration(durationDays: number, durationHours: number): string {
  const parts: string[] = [];
  if (durationDays > 0) parts.push(`${durationDays} day${durationDays === 1 ? '' : 's'}`);
  if (durationHours > 0) {
    parts.push(`${durationHours} hour${durationHours === 1 ? '' : 's'}`);
  }
  return parts.join(' ') || '0 hours';
}
