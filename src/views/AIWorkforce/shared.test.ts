import { describe, expect, it } from 'vitest';
import { describeLiveness, fmtDuration } from './shared';

// A fixed "now" so every case reads as an explicit offset from the heartbeat.
const NOW = new Date('2026-09-22T15:00:00.000Z').getTime();
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe('describeLiveness', () => {
  it.each([
    ['the row has never heartbeat', null],
    ['an unparseable timestamp, rather than rendering NaN', 'not-a-date'],
  ])('returns null for %s', (_, heartbeat) => {
    expect(describeLiveness(heartbeat, NOW)).toBeNull();
  });

  it('reports a fresh heartbeat as active', () => {
    const live = describeLiveness(agoMs(12 * SECOND), NOW);
    expect(live?.label).toBe('Active · 12s ago');
    expect(live?.dot).toContain('animate-pulse');
  });

  // The heartbeat ticker runs every 60s, so a single missed beat must not be
  // reported as trouble — the run is working normally between beats.
  it('still reports active one missed beat after the last heartbeat', () => {
    expect(describeLiveness(agoMs(90 * SECOND), NOW)?.label).toBe('Active · 1m ago');
  });

  // A step that exceeds the platform function duration is killed and re-entered
  // by the workflow runtime; the heartbeat goes quiet across that gap while the
  // run is still perfectly recoverable. This band must not claim failure.
  it('reports a retry-window gap as quiet, not as stalled', () => {
    const live = describeLiveness(agoMs(6 * MINUTE), NOW);
    expect(live?.label).toBe('Quiet for 6m');
    expect(live?.title).toContain('normal for a few minutes');
  });

  it('reports stalled only once past the server reaper threshold', () => {
    expect(describeLiveness(agoMs(29 * MINUTE), NOW)?.label).toBe('Quiet for 29m');
    expect(describeLiveness(agoMs(31 * MINUTE), NOW)?.label).toBe('Stalled for 31m');
  });

  // Clock skew between the browser and the server can put the heartbeat very
  // slightly in the future; that must read as active, never as a negative age.
  it('clamps a future heartbeat to zero instead of going negative', () => {
    const live = describeLiveness(new Date(NOW + 5 * SECOND).toISOString(), NOW);
    expect(live?.label).toBe('Active · 0s ago');
  });
});

describe('fmtDuration', () => {
  it('formats sub-minute, sub-hour and multi-hour spans', () => {
    expect(fmtDuration(45 * SECOND)).toBe('45s');
    expect(fmtDuration(5 * MINUTE)).toBe('5m');
    expect(fmtDuration(125 * MINUTE)).toBe('2h 5m');
  });
});
