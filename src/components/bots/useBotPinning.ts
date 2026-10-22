"use client";

import { useCallback } from 'react';
import { useChatActions, useChatThread } from '@/components/chat/ChatProvider';
import { pinAfterMove, togglePin } from '@/lib/bots/order';

/**
 * Pinning, as every bot list offers it: moving a bot (drag or keyboard) pins
 * it where it was dropped among the pinned bots; the pin toggle pins it last
 * or unpins it. Unpinned bots follow newest activity, so they are never
 * placed by hand. Brain Bot always leads and is never pinned or moved.
 */
export function useBotPinning() {
  const { bots } = useChatThread();
  const { setPinnedBots } = useChatActions();
  const pinnedIds = bots.filter((b) => b.pinned && !b.is_default).map((b) => b.id);
  const key = pinnedIds.join(',');
  const primaryId = bots.find((b) => b.is_default)?.id;

  const save = useCallback(
    (next: string[]) => {
      if (next.join(',') !== key) setPinnedBots(next);
    },
    [key, setPinnedBots],
  );

  /** `movedId` was dropped so the list reads `newOrder` (every bot id). */
  const moveBot = useCallback(
    (newOrder: string[], movedId: string) => {
      if (movedId === primaryId) return;
      const order = newOrder.filter((id) => id !== primaryId);
      save(pinAfterMove(key ? key.split(',') : [], order, movedId));
    },
    [key, save, primaryId],
  );

  const togglePinned = useCallback(
    (id: string) => {
      if (id !== primaryId) save(togglePin(key ? key.split(',') : [], id));
    },
    [key, save, primaryId],
  );

  return { moveBot, togglePinned };
}
