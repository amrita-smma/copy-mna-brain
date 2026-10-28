import type { InsightTemplateAttachment } from '@/lib/insights/templateAttachment';

/**
 * Messages the user typed while the bot was still responding. They wait in
 * the browser, oldest first, and the composer sends the head of the queue as
 * soon as the bot is free. Until one is sent it can still be deleted.
 *
 * Kept in localStorage, one list per bot, so a reload does not lose them.
 * Best-effort: private browsing / storage-disabled environments just keep the
 * queue in memory for the life of the composer.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  insightTemplate?: InsightTemplateAttachment;
  queuedAt: number;
}

const KEY_PREFIX = 'mna-brain:queuedMessages:';

/** The storage key for a bot's queue; `null` (no bot yet) shares one list. */
export function queueStorageKey(botId: string | null | undefined): string {
  return `${KEY_PREFIX}${botId ?? 'default'}`;
}

function asQueuedMessage(data: unknown): QueuedMessage | null {
  if (!data || typeof data !== 'object') return null;
  const { id, text, insightTemplate, queuedAt } = data as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof text !== 'string' || !text.trim()) return null;
  const message: QueuedMessage = {
    id,
    text,
    queuedAt: typeof queuedAt === 'number' ? queuedAt : 0,
  };
  if (insightTemplate && typeof insightTemplate === 'object') {
    const tpl = insightTemplate as Record<string, unknown>;
    if (typeof tpl.id === 'string' && typeof tpl.name === 'string') {
      message.insightTemplate = { id: tpl.id, name: tpl.name };
    }
  }
  return message;
}

/** Parse a stored queue, dropping anything malformed. */
export function parseQueue(raw: string | null): QueuedMessage[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(asQueuedMessage).filter((m): m is QueuedMessage => m !== null);
  } catch {
    return [];
  }
}

export function readQueue(storage: Pick<Storage, 'getItem'> | null, key: string): QueuedMessage[] {
  if (!storage) return [];
  try {
    return parseQueue(storage.getItem(key));
  } catch {
    return [];
  }
}

export function writeQueue(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  key: string,
  queue: QueuedMessage[],
): void {
  if (!storage) return;
  try {
    if (queue.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(queue));
  } catch {
    // Ignore — the queue just won't survive a reload.
  }
}

export function enqueueMessage(queue: QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  return [...queue, message];
}

export function removeQueuedMessage(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((m) => m.id !== id);
}

/** Split off the oldest message to send next; `null` when the queue is empty. */
export function dequeueMessage(
  queue: QueuedMessage[],
): { next: QueuedMessage; rest: QueuedMessage[] } | null {
  if (queue.length === 0) return null;
  const [next, ...rest] = queue;
  return { next, rest };
}

/**
 * How long a tab's claim to send from a queue blocks other tabs. Another tab
 * on the same bot sees the queue change (the `storage` event) before it hears
 * the bot went busy, so without a claim both tabs would send the next message.
 */
export const DISPATCH_CLAIM_MS = 5000;

/**
 * Claim the right to send the next queued message from this tab. False when
 * another tab claimed it within `DISPATCH_CLAIM_MS`. Without storage there is
 * no other tab to race, so the claim always succeeds.
 */
export function claimDispatch(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  key: string,
  tabId: string,
  now: number,
): boolean {
  if (!storage) return true;
  const lockKey = `${key}:claim`;
  try {
    const raw = storage.getItem(lockKey);
    if (raw) {
      const claim = JSON.parse(raw) as { tabId?: unknown; at?: unknown };
      if (claim.tabId !== tabId && typeof claim.at === 'number' && now - claim.at < DISPATCH_CLAIM_MS) {
        return false;
      }
    }
    storage.setItem(lockKey, JSON.stringify({ tabId, at: now }));
  } catch {
    // Unreadable claim or storage refused the write — this tab sends.
  }
  return true;
}
