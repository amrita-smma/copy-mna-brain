import type { BotDto } from '@/lib/bots/types';

/**
 * While a hand-set unread is in flight (or the server list is briefly stale),
 * keep the dot on screen. Drop ids from `kept` once the server agrees.
 */
export function mergeKeptUnread(list: readonly BotDto[], kept: Set<string>): BotDto[] {
  return list.map((b) => {
    if (!kept.has(b.id)) return b;
    if (b.unread) kept.delete(b.id);
    return { ...b, unread: true };
  });
}
