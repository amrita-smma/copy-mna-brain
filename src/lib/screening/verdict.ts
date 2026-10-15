/**
 * The overall AI-screening verdict for a (company, track) group of per-criterion
 * screenings, and for a company across all of its matched tracks.
 *
 * Dependency-free on purpose: the AI Screening progress panel (client) and the
 * Pending Confirmation auto drop/promote pass (server) must agree on what
 * "passed screening" means.
 */

export type ScreeningVerdict = 'pass' | 'fail' | 'inconclusive';

/** The fields of a `screenings` row the verdict reads. */
export interface ScreeningLike {
  track_id: string | null;
  state: 'pending' | 'completed' | 'failed';
  result: string | null;
}

export interface ScreeningTally {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  inconclusive: number;
  pending: number;
}

/**
 * Count one group's criteria. An `error` result and a `failed` row (the job
 * never produced a result) both count as a fail, as the panel always has.
 */
export function tallyScreenings(rows: ScreeningLike[]): ScreeningTally {
  const tally: ScreeningTally = {
    total: 0,
    completed: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    pending: 0,
  };
  for (const s of rows) {
    tally.total++;
    if (s.state === 'pending') {
      tally.pending++;
      continue;
    }
    tally.completed++;
    if (s.state === 'failed' || s.result === 'fail' || s.result === 'error') {
      tally.failed++;
    } else if (s.result === 'pass') {
      tally.passed++;
    } else if (s.result === 'inconclusive') {
      tally.inconclusive++;
    }
  }
  return tally;
}

/**
 * Pass: at least 3 passes and at most 1 fail.
 * Fail: at least 1 fail (and not a pass).
 * Inconclusive: everything else (e.g. too few passes, mostly inconclusive).
 */
export function screeningVerdict(
  tally: Pick<ScreeningTally, 'passed' | 'failed'>,
): ScreeningVerdict {
  if (tally.passed >= 3 && tally.failed <= 1) return 'pass';
  if (tally.failed >= 1) return 'fail';
  return 'inconclusive';
}

/**
 * A company's verdict across its matched tracks, one group per track:
 * `pass` when any track passes, `fail` when every track fails, otherwise
 * `inconclusive`. `pending` while any criterion is still running, and
 * `inconclusive` with no screenings at all.
 */
export function companyScreeningVerdict(
  rows: ScreeningLike[],
): ScreeningVerdict | 'pending' {
  if (rows.length === 0) return 'inconclusive';
  const byTrack = new Map<string, ScreeningLike[]>();
  for (const row of rows) {
    const key = row.track_id ?? 'none';
    const group = byTrack.get(key);
    if (group) group.push(row);
    else byTrack.set(key, [row]);
  }
  const tallies = [...byTrack.values()].map(tallyScreenings);
  if (tallies.some((t) => t.pending > 0)) return 'pending';
  const verdicts = tallies.map(screeningVerdict);
  if (verdicts.includes('pass')) return 'pass';
  if (verdicts.every((v) => v === 'fail')) return 'fail';
  return 'inconclusive';
}
