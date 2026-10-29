import { describe, expect, it } from 'vitest';
import {
  groupScreeningsByTrack,
  overallScreeningStatus,
  type PrePipelineScreening,
} from './PrePipelineFilterResults';

function screening(
  id: string,
  result: string,
  opts: { mustPass?: boolean; trackId?: string; min?: number | null; state?: PrePipelineScreening['state'] } = {},
): PrePipelineScreening {
  const trackId = opts.trackId ?? 't1';
  return {
    id,
    company_id: 'c1',
    criteria_id: id,
    track_id: trackId,
    state: opts.state ?? 'completed',
    result,
    remarks: null,
    created_at: '2026-01-01T00:00:00Z',
    criterias: { id, name: id, prompt: '', must_pass: opts.mustPass ?? false },
    track: { id: trackId, title: `Track ${trackId}`, min_optional_criteria_pass: opts.min ?? null },
  };
}

describe('overallScreeningStatus', () => {
  it('fails when a must-pass criterion fails even though three optional ones pass', () => {
    const rows = [
      screening('a', 'fail', { mustPass: true, min: 1 }),
      screening('b', 'pass', { min: 1 }),
      screening('c', 'pass', { min: 1 }),
      screening('d', 'pass', { min: 1 }),
    ];
    expect(overallScreeningStatus(rows)).toBe('fail');
  });

  it('fails when too few optional criteria can still pass for the minimum', () => {
    const rows = [
      screening('a', 'pass', { mustPass: true, min: 2 }),
      screening('b', 'fail', { min: 2 }),
      screening('c', 'fail', { min: 2 }),
      screening('d', 'pass', { min: 2 }),
    ];
    expect(overallScreeningStatus(rows)).toBe('fail');
  });

  it('passes when every must-pass criterion and the optional minimum pass', () => {
    const rows = [
      screening('a', 'pass', { mustPass: true, min: 1 }),
      screening('b', 'pass', { min: 1 }),
      screening('c', 'fail', { min: 1 }),
    ];
    expect(overallScreeningStatus(rows)).toBe('pass');
  });

  it('is pending while any criterion is still running', () => {
    const rows = [screening('a', 'pass'), screening('b', '', { state: 'pending' })];
    expect(overallScreeningStatus(rows)).toBe('pending');
  });
});

describe('groupScreeningsByTrack', () => {
  it('keeps each track in its own group so one track cannot decide another', () => {
    const groups = groupScreeningsByTrack([
      screening('a', 'fail', { trackId: 't1' }),
      screening('b', 'pass', { trackId: 't2' }),
      screening('c', 'pass', { trackId: 't1' }),
    ]);
    expect(groups.map((g) => [g.key, g.screenings.map((s) => s.id)])).toEqual([
      ['t1', ['a', 'c']],
      ['t2', ['b']],
    ]);
  });
});
