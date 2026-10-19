import { describe, it, expect } from 'vitest';
import {
  companyScreeningVerdict,
  optionalPassThresholdPercent,
  screeningVerdict,
  tallyScreenings,
  trackPassRule,
  trackPassRuleFromRows,
  trackScreeningVerdict,
  type ScreeningLike,
  type TrackPassRule,
} from './verdict';

const row = (
  result: string | null,
  opts: { track?: string | null; state?: ScreeningLike['state']; criterion?: string } = {},
): ScreeningLike => ({
  track_id: opts.track === undefined ? 't1' : opts.track,
  criteria_id: opts.criterion ?? null,
  state: opts.state ?? (result === null ? 'pending' : 'completed'),
  result,
});

/** Criteria `m*` are must-pass, `o*` optional. */
const rule = (minOptionalPass: number | null, mustPass: string[] = []): TrackPassRule => ({
  mustPassCriteriaIds: new Set(mustPass),
  minOptionalPass,
});
const c = (criterion: string, result: string | null) => row(result, { criterion });

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

describe('trackScreeningVerdict', () => {
  it('uses the original rule for a track with no must-pass and no minimum', () => {
    const rows = [c('o1', 'pass'), c('o2', 'pass')];
    expect(trackScreeningVerdict(rows, rule(null))).toBe('inconclusive');
    expect(trackScreeningVerdict(rows)).toBe('inconclusive');
  });

  it('uses the original rule when the minimum is 0 and there are no must-pass criteria', () => {
    const rows = [c('o1', 'fail'), c('o2', 'fail'), c('o3', 'fail')];
    expect(trackScreeningVerdict(rows, rule(0))).toBe('fail');
  });

  it('passes when every must-pass passes and the optional minimum is met', () => {
    const rows = [c('m1', 'pass'), c('o1', 'pass'), c('o2', 'fail'), c('o3', 'fail')];
    expect(trackScreeningVerdict(rows, rule(1, ['m1']))).toBe('pass');
  });

  it('fails as soon as a must-pass criterion fails, however the optional ones did', () => {
    const rows = [c('m1', 'fail'), c('o1', 'pass'), c('o2', 'pass'), c('o3', 'pass')];
    expect(trackScreeningVerdict(rows, rule(1, ['m1']))).toBe('fail');
  });

  it('counts an error on a must-pass criterion as a fail', () => {
    expect(trackScreeningVerdict([c('m1', 'error'), c('o1', 'pass')], rule(0, ['m1']))).toBe(
      'fail',
    );
  });

  it('does not require any individual optional criterion', () => {
    const rows = [c('o1', 'fail'), c('o2', 'pass'), c('o3', 'pass')];
    expect(trackScreeningVerdict(rows, rule(2))).toBe('pass');
  });

  it('fails when too many optional criteria failed for the minimum to be reached', () => {
    const rows = [c('o1', 'fail'), c('o2', 'fail'), c('o3', 'pass')];
    expect(trackScreeningVerdict(rows, rule(2))).toBe('fail');
  });

  it('is inconclusive while the minimum is still reachable but not met', () => {
    const rows = [c('o1', 'pass'), c('o2', 'inconclusive'), c('o3', 'inconclusive')];
    expect(trackScreeningVerdict(rows, rule(2))).toBe('inconclusive');
  });

  it('is inconclusive when a must-pass criterion is inconclusive', () => {
    const rows = [c('m1', 'inconclusive'), c('o1', 'pass')];
    expect(trackScreeningVerdict(rows, rule(1, ['m1']))).toBe('inconclusive');
  });

  it('needs only the must-pass criteria when no minimum is set', () => {
    const rows = [c('m1', 'pass'), c('o1', 'fail'), c('o2', 'fail')];
    expect(trackScreeningVerdict(rows, rule(null, ['m1']))).toBe('pass');
  });

  it('caps a minimum above the optional count at that count', () => {
    const rows = [c('m1', 'pass'), c('o1', 'pass')];
    expect(trackScreeningVerdict(rows, rule(5, ['m1']))).toBe('pass');
  });
});

describe('companyScreeningVerdict with track rules', () => {
  it('judges each track by its own rule', () => {
    const rows = [
      row('fail', { track: 'a', criterion: 'm1' }),
      row('pass', { track: 'a', criterion: 'o1' }),
      row('pass', { track: 'a', criterion: 'o2' }),
      row('pass', { track: 'a', criterion: 'o3' }),
    ];
    // The original rule would pass 3 passes / 1 fail; the must-pass fails it.
    expect(companyScreeningVerdict(rows)).toBe('pass');
    expect(companyScreeningVerdict(rows, new Map([['a', rule(1, ['m1'])]]))).toBe('fail');
  });
});

describe('trackPassRule', () => {
  it('collects the must-pass criteria and the minimum', () => {
    const r = trackPassRule(
      [
        { id: 'm1', must_pass: true },
        { id: 'o1', must_pass: false },
      ],
      2,
    );
    expect([...r.mustPassCriteriaIds]).toEqual(['m1']);
    expect(r.minOptionalPass).toBe(2);
  });
});

describe('trackPassRuleFromRows', () => {
  it('reads must-pass off each joined criterion and the minimum off the track', () => {
    const r = trackPassRuleFromRows([
      { criteria_id: 'm1', criterias: { must_pass: true }, track: { min_optional_criteria_pass: 3 } },
      { criteria_id: 'o1', criterias: { must_pass: false }, track: { min_optional_criteria_pass: 3 } },
    ]);
    expect([...r.mustPassCriteriaIds]).toEqual(['m1']);
    expect(r.minOptionalPass).toBe(3);
  });

  it('falls back to the original rule when rows carry no rule fields', () => {
    const r = trackPassRuleFromRows([{ criteria_id: 'o1' }]);
    expect(r.mustPassCriteriaIds.size).toBe(0);
    expect(r.minOptionalPass).toBeNull();
  });
});

describe('optionalPassThresholdPercent', () => {
  it('rounds to the nearest whole percent', () => {
    expect(optionalPassThresholdPercent(2, 3)).toBe(67);
    expect(optionalPassThresholdPercent(1, 3)).toBe(33);
    expect(optionalPassThresholdPercent(1, 8)).toBe(13);
  });

  it('is 0 with no minimum or no optional criteria, and caps at 100', () => {
    expect(optionalPassThresholdPercent(null, 4)).toBe(0);
    expect(optionalPassThresholdPercent(2, 0)).toBe(0);
    expect(optionalPassThresholdPercent(9, 4)).toBe(100);
  });
});
