/**
 * The overall AI-screening verdict for a (company, track) group of per-criterion
 * screenings, and for a company across all of its matched tracks.
 *
 * Dependency-free on purpose: the AI Screening progress panel (client), the
 * Pending Confirmation auto promote / auto drop pass and the AI Opinion's screening
 * summary (server) must agree on what "passed screening" means.
 */

export type ScreeningVerdict = 'pass' | 'fail' | 'inconclusive';

/** The fields of a `screenings` row the verdict reads. */
export interface ScreeningLike {
  track_id: string | null;
  /** Needed to tell a must-pass criterion from an optional one. */
  criteria_id?: string | null;
  state: 'pending' | 'completed' | 'failed';
  result: string | null;
}

/**
 * A track's screening pass rule, configured in Pipeline Settings → Criteria.
 *
 * Every criterion in `mustPassCriteriaIds` has to pass; the track's other
 * (optional) criteria have to pass at least `minOptionalPass` times. A track
 * with neither configured — no must-pass criteria and a `null` minimum —
 * keeps the original rule ({@link screeningVerdict}).
 */
export interface TrackPassRule {
  mustPassCriteriaIds: ReadonlySet<string>;
  minOptionalPass: number | null;
}

/** Build a track's rule from its criteria rows and its configured minimum. */
export function trackPassRule(
  criteria: ReadonlyArray<{ id: string; must_pass?: boolean | null }>,
  minOptionalPass: number | null | undefined,
): TrackPassRule {
  return {
    mustPassCriteriaIds: new Set(criteria.filter((c) => c.must_pass).map((c) => c.id)),
    minOptionalPass: minOptionalPass ?? null,
  };
}

/**
 * A track's rule rebuilt from one (company, track) group of screening rows as
 * `/api/screenings` returns them — each joined to its criterion's `must_pass`
 * and its track's `min_optional_criteria_pass`. What the client panels use.
 */
export function trackPassRuleFromRows(
  rows: ReadonlyArray<{
    criteria_id: string;
    criterias?: { must_pass?: boolean | null } | null;
    track?: { min_optional_criteria_pass?: number | null } | null;
  }>,
): TrackPassRule {
  return {
    mustPassCriteriaIds: new Set(
      rows.filter((r) => r.criterias?.must_pass).map((r) => r.criteria_id),
    ),
    minOptionalPass: rows.find((r) => r.track)?.track?.min_optional_criteria_pass ?? null,
  };
}

/** True when the track has opted into must-pass / minimum-optional screening. */
export function isConfiguredRule(rule: TrackPassRule | null | undefined): rule is TrackPassRule {
  if (!rule) return false;
  if (rule.mustPassCriteriaIds.size > 0) return true;
  // A minimum of 0 with no must-pass criteria is the same as "not set" — otherwise
  // every optional fail would still pass (0 optional passes required).
  return rule.minOptionalPass !== null && rule.minOptionalPass > 0;
}

/**
 * The share of optional criteria a track's minimum asks for, as a whole
 * percentage (0–100) — the bar beside the minimum in Pipeline Settings.
 * 0 when the track has no optional criteria or no minimum.
 */
export function optionalPassThresholdPercent(
  minOptionalPass: number | null | undefined,
  optionalCount: number,
): number {
  if (!minOptionalPass || optionalCount <= 0) return 0;
  return Math.round((Math.min(minOptionalPass, optionalCount) / optionalCount) * 100);
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
 * One (company, track) group's verdict under the track's rule.
 *
 * With a configured rule: **fail** as soon as a must-pass criterion fails, or
 * when too many optional criteria failed for the minimum to still be met;
 * **pass** when every must-pass criterion passed and at least the minimum of
 * optional criteria passed (a minimum above the optional count is capped at
 * it); otherwise **inconclusive**. Without one, the original rule.
 *
 * Doesn't look at `pending` — callers report a group with pending criteria as
 * pending before asking for a verdict.
 */
export function trackScreeningVerdict(
  rows: ScreeningLike[],
  rule?: TrackPassRule | null,
): ScreeningVerdict {
  if (!isConfiguredRule(rule)) return screeningVerdict(tallyScreenings(rows));

  const isMust = (r: ScreeningLike) => !!r.criteria_id && rule.mustPassCriteriaIds.has(r.criteria_id);
  const must = tallyScreenings(rows.filter(isMust));
  const optional = tallyScreenings(rows.filter((r) => !isMust(r)));
  const min = Math.min(Math.max(rule.minOptionalPass ?? 0, 0), optional.total);

  if (must.failed > 0) return 'fail';
  if (optional.total - optional.failed < min) return 'fail';
  if (must.passed === must.total && optional.passed >= min) return 'pass';
  return 'inconclusive';
}

/**
 * A company's verdict across its matched tracks, one group per track:
 * `pass` when any track passes, `fail` when every track fails, otherwise
 * `inconclusive`. `pending` while any criterion is still running, and
 * `inconclusive` with no screenings at all. `rules` holds each track's pass
 * rule by track id; a track without one uses the original rule.
 */
export function companyScreeningVerdict(
  rows: ScreeningLike[],
  rules?: ReadonlyMap<string, TrackPassRule>,
): ScreeningVerdict | 'pending' {
  if (rows.length === 0) return 'inconclusive';
  const byTrack = new Map<string, ScreeningLike[]>();
  for (const row of rows) {
    const key = row.track_id ?? 'none';
    const group = byTrack.get(key);
    if (group) group.push(row);
    else byTrack.set(key, [row]);
  }
  const groups = [...byTrack.entries()];
  if (groups.some(([, group]) => tallyScreenings(group).pending > 0)) return 'pending';
  const verdicts = groups.map(([trackId, group]) =>
    trackScreeningVerdict(group, rules?.get(trackId)),
  );
  if (verdicts.includes('pass')) return 'pass';
  if (verdicts.every((v) => v === 'fail')) return 'fail';
  return 'inconclusive';
}
