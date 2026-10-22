import { describe, it, expect } from 'vitest';
import {
  MOBILE_MAX_BOT_PINS,
  canPinOnMobile,
  mergeVisibleOrder,
  moveId,
  pickVisibleBots,
  pinAfterMove,
  sortBots,
  splitMobileHome,
  togglePin,
} from './order';

const bots = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((b) => b.id);

const bot = (id: string, last: string | null = null, extra: { is_default?: boolean; name?: string } = {}) => ({
  id,
  name: extra.name ?? id,
  is_default: extra.is_default ?? false,
  last_activity_at: last,
});

describe('sortBots', () => {
  it('puts pinned bots first in pin order, then the rest by newest activity', () => {
    const list = [
      bot('old', '2026-10-01T00:00:00Z'),
      bot('new', '2026-10-14T00:00:00Z'),
      bot('pin2', '2026-10-13T00:00:00Z'),
      bot('pin1'),
      bot('never'),
    ];
    expect(ids(sortBots(list, ['pin1', 'pin2']))).toEqual(['pin1', 'pin2', 'new', 'old', 'never']);
  });

  it('breaks ties among never-used bots by name', () => {
    const list = [bot('b', null, { name: 'Zed' }), bot('c', null, { name: 'Amy' })];
    expect(ids(sortBots(list, []))).toEqual(['c', 'b']);
  });

  it('always puts Brain Bot first, ahead of pins and newer activity', () => {
    const list = [
      bot('pin1', '2026-10-14T00:00:00Z'),
      bot('new', '2026-10-15T00:00:00Z'),
      bot('brain', null, { is_default: true, name: 'Brain Bot' }),
    ];
    expect(ids(sortBots(list, ['pin1']))).toEqual(['brain', 'pin1', 'new']);
  });

  it('ignores pinned ids that match no bot', () => {
    expect(ids(sortBots([bot('a'), bot('b', '2026-10-14T00:00:00Z')], ['gone']))).toEqual(['b', 'a']);
  });
});

describe('pinAfterMove', () => {
  it('pins an unpinned bot dropped among the pins at its place', () => {
    // pins [A, B]; E dropped between A and B.
    expect(pinAfterMove(['A', 'B'], ['A', 'E', 'B', 'C', 'D'], 'E')).toEqual(['A', 'E', 'B']);
  });

  it('pins an unpinned bot dropped below the pins at the end of the pins', () => {
    expect(pinAfterMove(['A'], ['A', 'C', 'E', 'D'], 'E')).toEqual(['A', 'E']);
  });

  it('moves a pinned bot among the pins, never below them', () => {
    expect(pinAfterMove(['A', 'B'], ['B', 'C', 'D', 'A'], 'A')).toEqual(['B', 'A']);
    expect(pinAfterMove(['A', 'B'], ['B', 'A', 'C'], 'B')).toEqual(['B', 'A']);
  });
});

describe('togglePin', () => {
  it('pins at the end, and unpins', () => {
    expect(togglePin(['A'], 'B')).toEqual(['A', 'B']);
    expect(togglePin(['A', 'B'], 'A')).toEqual(['B']);
  });
});

describe('pickVisibleBots', () => {
  it('returns every bot when they all fit', () => {
    expect(ids(pickVisibleBots(bots('a', 'b'), 'b', 5))).toEqual(['a', 'b']);
  });

  it('cuts the list at the capacity', () => {
    expect(ids(pickVisibleBots(bots('a', 'b', 'c', 'd'), 'a', 2))).toEqual(['a', 'b']);
  });

  it('gives the last slot to an active bot that falls past the cut', () => {
    expect(ids(pickVisibleBots(bots('a', 'b', 'c', 'd'), 'd', 3))).toEqual(['a', 'b', 'd']);
  });

  it('always shows at least one bot', () => {
    expect(ids(pickVisibleBots(bots('a', 'b'), 'b', 0))).toEqual(['b']);
  });
});

describe('mergeVisibleOrder', () => {
  it('puts the rearranged visible bots first, then the hidden ones in their old order', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c', 'd', 'e'], ['b', 'a', 'e'])).toEqual(['b', 'a', 'e', 'c', 'd']);
  });
});

describe('moveId', () => {
  it('moves an id up or down', () => {
    expect(moveId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('clamps the target and ignores an out-of-range source', () => {
    expect(moveId(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(moveId(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('splitMobileHome', () => {
  const pin = (id: string, pinned: boolean, is_default = false) => ({ id, pinned, is_default });

  it('leaves room for Profile, Timeline and Brain Bot: three of six slots go to pinned bots', () => {
    expect(MOBILE_MAX_BOT_PINS).toBe(3);
  });

  it('lifts pinned bots into the pinned block and keeps the rest in order', () => {
    const { pinned, rest } = splitMobileHome([pin('a', true), pin('b', false), pin('c', true), pin('d', false)]);
    expect(ids(pinned)).toEqual(['a', 'c']);
    expect(ids(rest)).toEqual(['b', 'd']);
  });

  it('sets Brain Bot apart from the pins and the list, pinned or not', () => {
    const { primary, pinned, rest } = splitMobileHome([pin('brain', false, true), pin('a', true), pin('b', false)]);
    expect(primary?.id).toBe('brain');
    expect(ids(pinned)).toEqual(['a']);
    expect(ids(rest)).toEqual(['b']);
  });

  it('has no primary when the list has no default bot', () => {
    expect(splitMobileHome([pin('a', true)]).primary).toBeNull();
  });

  it('drops pins past the block into the list, as desktop pins have no cap', () => {
    const list = ['p1', 'p2', 'p3', 'p4'].map((id) => pin(id, true));
    const { pinned, rest } = splitMobileHome([...list, pin('x', false)]);
    expect(ids(pinned)).toEqual(['p1', 'p2', 'p3']);
    expect(ids(rest)).toEqual(['p4', 'x']);
  });
});

describe('canPinOnMobile', () => {
  const b = (pinned: boolean, is_default = false) => ({ pinned, is_default });

  it('allows a pin while fewer than three bots are pinned', () => {
    expect(canPinOnMobile([b(true), b(true), b(false)])).toBe(true);
  });

  it('refuses a fourth bot pin', () => {
    expect(canPinOnMobile([b(true), b(true), b(true)])).toBe(false);
  });

  it('does not count Brain Bot against the pins', () => {
    expect(canPinOnMobile([b(true, true), b(true), b(true)])).toBe(true);
  });
});
