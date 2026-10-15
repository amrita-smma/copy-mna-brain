import { describe, it, expect } from 'vitest';
import {
  companyScreeningVerdict,
  screeningVerdict,
  tallyScreenings,
  type ScreeningLike,
} from './verdict';

const row = (
  result: string | null,
  opts: { track?: string | null; state?: ScreeningLike['state'] } = {},
): ScreeningLike => ({
  track_id: opts.track === undefined ? 't1' : opts.track,
  state: opts.state ?? (result === null ? 'pending' : 'completed'),
  result,
});

describe('tallyScreenings', () => {
  it('counts error results and failed rows as fails', () => {
    const tally = tallyScreenings([
      row('pass'),
      row('error'),
      row(null, { state: 'failed' }),
      row('inconclusive'),
      row(null),
    ]);
    expect(tally).toEqual({
      total: 5,
      completed: 4,
      passed: 1,
      failed: 2,
      inconclusive: 1,
      pending: 1,
    });
  });
});

describe('screeningVerdict', () => {
  it('passes with at least 3 passes and at most 1 fail', () => {
    expect(screeningVerdict({ passed: 3, failed: 1 })).toBe('pass');
  });

  it('fails a group with too few passes and any fail', () => {
    expect(screeningVerdict({ passed: 2, failed: 1 })).toBe('fail');
    expect(screeningVerdict({ passed: 3, failed: 2 })).toBe('fail');
  });

  it('is inconclusive with no fails and too few passes', () => {
    expect(screeningVerdict({ passed: 2, failed: 0 })).toBe('inconclusive');
  });
});

describe('companyScreeningVerdict', () => {
  it('is inconclusive with no screenings', () => {
    expect(companyScreeningVerdict([])).toBe('inconclusive');
  });

  it('is pending while any criterion is still running', () => {
    expect(
      companyScreeningVerdict([row('pass'), row('pass'), row('pass'), row(null)]),
    ).toBe('pending');
  });

  it('passes when any matched track passes', () => {
    expect(
      companyScreeningVerdict([
        row('pass', { track: 'a' }),
        row('pass', { track: 'a' }),
        row('pass', { track: 'a' }),
        row('fail', { track: 'b' }),
      ]),
    ).toBe('pass');
  });

  it('fails only when every matched track fails', () => {
    expect(
      companyScreeningVerdict([row('fail', { track: 'a' }), row('error', { track: 'b' })]),
    ).toBe('fail');
  });

  it('is inconclusive when one track fails and another is inconclusive', () => {
    expect(
      companyScreeningVerdict([
        row('fail', { track: 'a' }),
        row('inconclusive', { track: 'b' }),
      ]),
    ).toBe('inconclusive');
  });
});
