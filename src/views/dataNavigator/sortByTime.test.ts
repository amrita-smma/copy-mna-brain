import { describe, it, expect } from 'vitest';
import { sortByPublishedDesc } from './sortByTime';

const item = (id: string, published_at: string | null) => ({ id, published_at });

describe('sortByPublishedDesc', () => {
  it('returns [] for an empty list', () => {
    expect(sortByPublishedDesc([])).toEqual([]);
  });

  it('orders dated items newest first', () => {
    const out = sortByPublishedDesc([
      item('a', '2026-01-01T00:00:00Z'),
      item('b', '2026-03-01T00:00:00Z'),
      item('c', '2026-02-01T00:00:00Z'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('sinks undated items below every dated item', () => {
    const out = sortByPublishedDesc([
      item('undated', null),
      item('old', '2020-01-01T00:00:00Z'),
      item('new', '2026-01-01T00:00:00Z'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['new', 'old', 'undated']);
  });

  it('treats an unparseable timestamp as undated rather than throwing', () => {
    const out = sortByPublishedDesc([item('bad', 'not-a-date'), item('good', '2026-01-01T00:00:00Z')]);
    expect(out.map((i) => i.id)).toEqual(['good', 'bad']);
  });

  it('breaks timestamp ties on id so the order is stable across renders', () => {
    const stamp = '2026-01-01T00:00:00Z';
    const first = sortByPublishedDesc([item('a', stamp), item('c', stamp), item('b', stamp)]);
    const second = sortByPublishedDesc([item('c', stamp), item('b', stamp), item('a', stamp)]);
    expect(first.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('breaks ties on id for undated items too', () => {
    const out = sortByPublishedDesc([item('a', null), item('b', null)]);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [item('a', '2020-01-01T00:00:00Z'), item('b', '2026-01-01T00:00:00Z')];
    const snapshot = input.map((i) => i.id);
    sortByPublishedDesc(input);
    expect(input.map((i) => i.id)).toEqual(snapshot);
  });
});
