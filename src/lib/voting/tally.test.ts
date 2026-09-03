import { describe, it, expect } from 'vitest';
import {
  aiVerdictToVoteChoice,
  computeDeadline,
  formatDuration,
  isVoteChoice,
  tallyVotes,
  voteSide,
} from './tally';

describe('voteSide', () => {
  it('groups hard_yes and yes as FOR', () => {
    expect(voteSide('hard_yes')).toBe('for');
    expect(voteSide('yes')).toBe('for');
  });

  it('groups hard_no and no as AGAINST', () => {
    expect(voteSide('hard_no')).toBe('against');
    expect(voteSide('no')).toBe('against');
  });

  it('treats inconclusive as neither side', () => {
    expect(voteSide('inconclusive')).toBe('neutral');
  });
});

describe('isVoteChoice', () => {
  it('accepts the five defined choices', () => {
    for (const choice of ['hard_yes', 'yes', 'no', 'inconclusive', 'hard_no']) {
      expect(isVoteChoice(choice)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isVoteChoice('maybe')).toBe(false);
    expect(isVoteChoice(null)).toBe(false);
    expect(isVoteChoice(3)).toBe(false);
  });
});

describe('tallyVotes', () => {
  it('reports a unanimous FOR result as "N Proceed"', () => {
    const tally = tallyVotes(['yes', 'yes', 'hard_yes', 'yes']);

    expect(tally.forCount).toBe(4);
    expect(tally.againstCount).toBe(0);
    expect(tally.outcome).toBe('proceed');
    expect(tally.headline).toBe('4–0 FOR');
    expect(tally.outcomeLabel).toBe('4 Proceed');
    expect(tally.unanimous).toBe(true);
  });

  it('reports an AGAINST majority with the against count first', () => {
    const tally = tallyVotes(['no', 'hard_no', 'hard_no', 'yes']);

    expect(tally.outcome).toBe('decline');
    expect(tally.headline).toBe('3–1 AGAINST');
    expect(tally.outcomeLabel).toBe('3 Decline');
    expect(tally.unanimous).toBe(false);
  });

  it('reports an even split as SPLIT', () => {
    const tally = tallyVotes(['yes', 'yes', 'no', 'hard_no']);

    expect(tally.outcome).toBe('split');
    expect(tally.headline).toBe('2–2 SPLIT');
    expect(tally.outcomeLabel).toBe('Split');
  });

  it('counts inconclusive separately and never toward either side', () => {
    const tally = tallyVotes(['inconclusive', 'inconclusive', 'yes']);

    expect(tally.inconclusiveCount).toBe(2);
    expect(tally.forCount).toBe(1);
    expect(tally.againstCount).toBe(0);
    expect(tally.outcome).toBe('proceed');
    // Not unanimous: two ballots abstained.
    expect(tally.unanimous).toBe(false);
  });

  it('ignores null choices so a mid-flight tally invents no votes', () => {
    const tally = tallyVotes([null, undefined, 'yes']);

    expect(tally.castCount).toBe(1);
    expect(tally.forCount).toBe(1);
  });

  it('returns an all-zero split for no ballots at all', () => {
    const tally = tallyVotes([]);

    expect(tally.castCount).toBe(0);
    expect(tally.outcome).toBe('split');
    expect(tally.unanimous).toBe(false);
  });

  it('keeps per-choice counts for the results breakdown', () => {
    const tally = tallyVotes(['hard_yes', 'yes', 'no', 'hard_no', 'inconclusive']);

    expect(tally.counts).toEqual({
      hard_yes: 1,
      yes: 1,
      no: 1,
      hard_no: 1,
      inconclusive: 1,
    });
  });
});

describe('computeDeadline', () => {
  const from = new Date('2026-09-03T00:00:00.000Z');

  it('adds days and hours to the start instant', () => {
    expect(computeDeadline(from, 2, 4).toISOString()).toBe('2026-09-05T04:00:00.000Z');
  });

  it('supports an hours-only duration', () => {
    expect(computeDeadline(from, 0, 6).toISOString()).toBe('2026-09-03T06:00:00.000Z');
  });

  it('rejects a zero duration', () => {
    expect(() => computeDeadline(from, 0, 0)).toThrow(/at least 1 hour/);
  });

  it('rejects a negative duration', () => {
    expect(() => computeDeadline(from, -1, 0)).toThrow(/non-negative/);
  });
});

describe('formatDuration', () => {
  it('renders days and hours together', () => {
    expect(formatDuration(2, 4)).toBe('2 days 4 hours');
  });

  it('singularizes a one-day / one-hour duration', () => {
    expect(formatDuration(1, 1)).toBe('1 day 1 hour');
  });

  it('omits a zero component', () => {
    expect(formatDuration(3, 0)).toBe('3 days');
    expect(formatDuration(0, 5)).toBe('5 hours');
  });
});

describe('aiVerdictToVoteChoice', () => {
  it('maps pass to YES and fail to NO', () => {
    expect(aiVerdictToVoteChoice('pass')).toBe('yes');
    expect(aiVerdictToVoteChoice('fail')).toBe('no');
  });

  it('never maps to a HARD variant — the verdict carries no conviction', () => {
    expect(aiVerdictToVoteChoice('pass')).not.toBe('hard_yes');
    expect(aiVerdictToVoteChoice('fail')).not.toBe('hard_no');
  });

  it('abstains on tentative', () => {
    expect(aiVerdictToVoteChoice('tentative')).toBe('inconclusive');
  });

  it('abstains when no opinion is on record', () => {
    expect(aiVerdictToVoteChoice(null)).toBe('inconclusive');
    expect(aiVerdictToVoteChoice(undefined)).toBe('inconclusive');
    expect(aiVerdictToVoteChoice('')).toBe('inconclusive');
  });

  it('abstains on an unrecognised verdict rather than guessing a direction', () => {
    expect(aiVerdictToVoteChoice('probably-fine')).toBe('inconclusive');
  });

  it('tolerates casing and surrounding whitespace', () => {
    expect(aiVerdictToVoteChoice('  PASS ')).toBe('yes');
    expect(aiVerdictToVoteChoice('Fail')).toBe('no');
  });
});
