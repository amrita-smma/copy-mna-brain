/**
 * Bot ordering for every bot list (the Copilot strip, the sidebar, the Bots
 * page). Brain Bot (the default bot) always comes first; then pinned bots, in
 * the user's order; the rest follow by newest activity, then by name — the same order
 * `BotRepository.listVisible` returns, so an optimistic re-sort on the client
 * agrees with the next server read. Client safe: pure functions.
 */

export interface SortableBot {
  id: string;
  name: string;
  is_default: boolean;
  last_activity_at: string | null;
}

/** `bots` in list order: Brain Bot, then `pinnedIds` in that order, then newest activity first. */
export function sortBots<T extends SortableBot>(bots: readonly T[], pinnedIds: readonly string[]): T[] {
  const rank = new Map(pinnedIds.map((id, i) => [id, i]));
  const activity = (b: T) => (b.last_activity_at ? Date.parse(b.last_activity_at) : -Infinity);
  return [...bots].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    const byActivity = activity(b) - activity(a);
    if (byActivity !== 0 && !Number.isNaN(byActivity)) return byActivity;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The pin list after `movedId` was dropped somewhere in `newOrder` (a drag or
 * a keyboard move): the moved bot becomes pinned, placed among the other
 * pinned bots by how many of them now sit before it. A pinned bot cannot sink
 * below unpinned ones — those follow activity — so moving one down past them
 * leaves it last among the pins.
 */
export function pinAfterMove(
  pinnedIds: readonly string[],
  newOrder: readonly string[],
  movedId: string,
): string[] {
  const others = pinnedIds.filter((id) => id !== movedId);
  const otherSet = new Set(others);
  const at = newOrder.indexOf(movedId);
  if (at < 0) return [...others, movedId];
  const before = newOrder.slice(0, at).filter((id) => otherSet.has(id)).length;
  return [...others.slice(0, before), movedId, ...others.slice(before)];
}

/** Pin `id` at the end of the pins, or unpin it. */
export function togglePin(pinnedIds: readonly string[], id: string): string[] {
  return pinnedIds.includes(id) ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id];
}

/**
 * The bots that fit in a list with room for `capacity` items, in order. The
 * active bot always shows: if it falls past the cut it takes the last slot.
 */
export function pickVisibleBots<T extends { id: string }>(
  bots: readonly T[],
  activeId: string | null | undefined,
  capacity: number,
): T[] {
  const n = Math.max(1, Math.floor(capacity));
  if (bots.length <= n) return [...bots];
  const head = bots.slice(0, n);
  if (!activeId || head.some((b) => b.id === activeId)) return head;
  const active = bots.find((b) => b.id === activeId);
  return active ? [...head.slice(0, n - 1), active] : head;
}

/**
 * The full order after a visible subset was rearranged: the visible bots in
 * their new order, then every hidden bot in its old order.
 */
export function mergeVisibleOrder(allIds: readonly string[], visibleIds: readonly string[]): string[] {
  const shown = new Set(visibleIds);
  return [...visibleIds, ...allIds.filter((id) => !shown.has(id))];
}

/** `ids` with the item at `from` moved to `to` (both clamped). */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * The mobile home has `MOBILE_PIN_SLOTS` pins: two rows of three tiles.
 * Timeline, Your tasks and Brain Bot (the first three tiles) always take
 * `MOBILE_FIXED_PINS` of them; the user's pinned bots fill the rest
 * (`MOBILE_MAX_BOT_PINS`). Profile is the top-bar button, not a tile.
 */
export const MOBILE_PIN_SLOTS = 6;
export const MOBILE_FIXED_PINS = 3;
export const MOBILE_MAX_BOT_PINS = MOBILE_PIN_SLOTS - MOBILE_FIXED_PINS;

/**
 * Split `bots` (already in list order) for the mobile home: Brain Bot (always
 * pinned, never in `pinned`), the first pinned bots that fit the pinned block,
 * and everything else in order. Pins are shared with desktop, which has no
 * cap, so a pin past the block falls into the list.
 */
export function splitMobileHome<T extends { pinned: boolean; is_default: boolean }>(
  bots: readonly T[],
): { primary: T | null; pinned: T[]; rest: T[] } {
  let primary: T | null = null;
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const bot of bots) {
    if (bot.is_default && !primary) primary = bot;
    else if (bot.pinned && pinned.length < MOBILE_MAX_BOT_PINS) pinned.push(bot);
    else rest.push(bot);
  }
  return { primary, pinned, rest };
}

/** Whether the mobile pinned block has room for another bot. */
export function canPinOnMobile(bots: readonly { pinned: boolean; is_default: boolean }[]): boolean {
  return bots.filter((b) => b.pinned && !b.is_default).length < MOBILE_MAX_BOT_PINS;
}
