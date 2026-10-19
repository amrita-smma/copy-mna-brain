import { describe, expect, it } from 'vitest';
import { formatBadgeCount, sourcingNavBadges, workforceNavBadges } from './navBadges';

describe('workforceNavBadges', () => {
  it('shows nothing for an idle workforce', () => {
    expect(workforceNavBadges({ unseen_failures: 0, queue: 0, running: 0 })).toEqual({
      badges: [],
      live: false,
    });
  });

  it('puts a red cross chip before the yellow queue chip and blinks while the queue has work', () => {
    const result = workforceNavBadges({ unseen_failures: 2, queue: 3, running: 1 });
    expect(result.live).toBe(true);
    expect(result.badges.map((b) => [b.tone, b.icon, b.count, b.label])).toEqual([
      ['red', 'cross', 2, '2 failed'],
      ['amber', 'live', 3, '3 in queue'],
    ]);
    expect(result.badges.map((b) => b.testId)).toEqual([
      'nav-badge-ai-workforce-failures',
      'nav-badge-ai-workforce-queue',
    ]);
  });

  it('shows only the failures chip, not blinking, when nothing is queued', () => {
    const result = workforceNavBadges({ unseen_failures: 1, queue: 0, running: 0 });
    expect(result.live).toBe(false);
    expect(result.badges).toHaveLength(1);
    expect(result.badges[0]).toMatchObject({ tone: 'red', icon: 'cross', count: 1 });
  });

  it('counts a running run in the queue chip', () => {
    const result = workforceNavBadges({ unseen_failures: 0, queue: 1, running: 1 });
    expect(result.badges).toEqual([
      expect.objectContaining({ tone: 'amber', icon: 'live', count: 1, label: '1 in queue' }),
    ]);
    expect(result.live).toBe(true);
  });
});

describe('sourcingNavBadges', () => {
  it('is empty at zero and a red pending chip above it', () => {
    expect(sourcingNavBadges(0).badges).toEqual([]);
    expect(sourcingNavBadges(4).badges).toEqual([
      { count: 4, tone: 'red', label: '4 pending', testId: 'nav-badge-sourcing' },
    ]);
  });
});

describe('formatBadgeCount', () => {
  it('caps at 99+', () => {
    expect(formatBadgeCount(7)).toBe('7');
    expect(formatBadgeCount(99)).toBe('99');
    expect(formatBadgeCount(100)).toBe('99+');
  });
});
