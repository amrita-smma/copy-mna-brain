import { describe, it, expect } from 'vitest';
import {
  categorizeCommit,
  cleanSubject,
  commitsToEntries,
  groupChangelogByDay,
  latestChangelogDate,
  hasUnseenChanges,
  formatChangelogDate,
  type RawCommit,
  type ChangelogEntry,
} from './changelog';

function commit(overrides: Partial<RawCommit> = {}): RawCommit {
  return {
    hash: 'abc123',
    date: '2026-07-24T10:00:00+07:00',
    author: 'Dicki',
    subject: 'Do a thing',
    ...overrides,
  };
}

describe('categorizeCommit', () => {
  it('classifies fixes', () => {
    expect(categorizeCommit('Asset bug fix')).toBe('fix');
    expect(categorizeCommit('fix: broken dropdown')).toBe('fix');
    expect(categorizeCommit('hotfix login')).toBe('fix');
    expect(categorizeCommit('Revert "feat: x"')).toBe('fix');
  });

  it('classifies features', () => {
    expect(categorizeCommit('feat: yen to RMB')).toBe('feature');
    expect(categorizeCommit('Add investor fund dropdown')).toBe('feature');
    expect(categorizeCommit('feat/mb 458 investor fund dropdown')).toBe('feature');
  });

  it('falls back to improvement', () => {
    expect(categorizeCommit('Enable iframe embedding in the Brain Launcher')).toBe('improvement');
    expect(categorizeCommit('Tidy up the sidebar')).toBe('improvement');
  });

  it('prefers fix when a subject mentions both', () => {
    expect(categorizeCommit('feat: add fix for the thing')).toBe('fix');
  });
});

describe('cleanSubject', () => {
  it('strips a trailing PR reference', () => {
    expect(cleanSubject('Investor fund dropdown (#487)')).toBe('Investor fund dropdown');
  });

  it('strips a leading conventional-commit prefix', () => {
    expect(cleanSubject('feat: yen to RMB')).toBe('yen to RMB');
    expect(cleanSubject('fix(scope): broken thing')).toBe('broken thing');
  });

  it('strips both prefix and PR ref together', () => {
    expect(cleanSubject('feat: yen to RMB (#483)')).toBe('yen to RMB');
  });

  it('leaves an unconventional subject as-is (minus PR ref)', () => {
    expect(cleanSubject('Enable iframe embedding (#479)')).toBe('Enable iframe embedding');
  });

  it('falls back to the original when cleaning would empty it', () => {
    expect(cleanSubject('feat:')).toBe('feat:');
  });
});

describe('commitsToEntries', () => {
  it('maps a commit to an entry with cleaned subject, category, and day', () => {
    const [entry] = commitsToEntries([commit({ subject: 'feat: yen to RMB (#483)' })]);
    expect(entry).toEqual({
      hash: 'abc123',
      date: '2026-07-24',
      subject: 'yen to RMB',
      category: 'feature',
    });
  });

  it('drops merge commits, the Action\'s own commits, and empty subjects', () => {
    const entries = commitsToEntries([
      commit({ hash: 'm', subject: 'Merge pull request #1 from x' }),
      commit({ hash: 'bot', author: 'github-actions[bot]', subject: 'chore: update changelog' }),
      commit({ hash: 'skip', subject: 'something [skip ci]' }),
      commit({ hash: 'blank', subject: '   ' }),
      commit({ hash: 'good', subject: 'Real change' }),
    ]);
    expect(entries.map((e) => e.hash)).toEqual(['good']);
  });

  it('drops commits whose date cannot be parsed', () => {
    const entries = commitsToEntries([
      commit({ hash: 'bad', date: 'not-a-date' }),
      commit({ hash: 'good' }),
    ]);
    expect(entries.map((e) => e.hash)).toEqual(['good']);
  });

  it('sorts newest-first and caps to maxEntries', () => {
    const raw = [
      commit({ hash: 'a', date: '2026-07-20T00:00:00Z' }),
      commit({ hash: 'b', date: '2026-07-24T00:00:00Z' }),
      commit({ hash: 'c', date: '2026-07-22T00:00:00Z' }),
    ];
    expect(commitsToEntries(raw).map((e) => e.hash)).toEqual(['b', 'c', 'a']);
    expect(commitsToEntries(raw, 2).map((e) => e.hash)).toEqual(['b', 'c']);
  });
});

describe('groupChangelogByDay', () => {
  const entries: ChangelogEntry[] = [
    { hash: 'b', date: '2026-07-24', subject: 'B', category: 'fix' },
    { hash: 'a', date: '2026-07-21', subject: 'A', category: 'feature' },
    { hash: 'c', date: '2026-07-21', subject: 'C', category: 'improvement' },
  ];

  it('groups by day, newest day first, entries in order within a day', () => {
    const grouped = groupChangelogByDay(entries);
    expect(grouped.map((d) => d.date)).toEqual(['2026-07-24', '2026-07-21']);
    expect(grouped[1].entries.map((e) => e.hash)).toEqual(['a', 'c']);
  });

  it('returns an empty array for no entries', () => {
    expect(groupChangelogByDay([])).toEqual([]);
  });
});

describe('latestChangelogDate / hasUnseenChanges', () => {
  const entries: ChangelogEntry[] = [
    { hash: 'b', date: '2026-07-24', subject: 'B', category: 'fix' },
    { hash: 'a', date: '2026-07-21', subject: 'A', category: 'feature' },
  ];

  it('returns the most recent date', () => {
    expect(latestChangelogDate(entries)).toBe('2026-07-24');
    expect(latestChangelogDate([])).toBeNull();
  });

  it('detects unseen changes', () => {
    expect(hasUnseenChanges(null, entries)).toBe(true);
    expect(hasUnseenChanges('2026-07-21', entries)).toBe(true);
    expect(hasUnseenChanges('2026-07-24', entries)).toBe(false);
    expect(hasUnseenChanges(null, [])).toBe(false);
  });
});

describe('formatChangelogDate', () => {
  it('formats an ISO day as a readable label', () => {
    expect(formatChangelogDate('2026-07-24')).toBe('Jul 24, 2026');
    expect(formatChangelogDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('returns the raw input when not a valid ISO day', () => {
    expect(formatChangelogDate('not-a-date')).toBe('not-a-date');
    expect(formatChangelogDate('2026-13-01')).toBe('2026-13-01');
  });
});
