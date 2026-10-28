'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DISPATCH_CLAIM_MS,
  claimDispatch,
  dequeueMessage,
  enqueueMessage,
  queueStorageKey,
  readQueue,
  removeQueuedMessage,
  writeQueue,
  type QueuedMessage,
} from '@/lib/chat/messageQueue';
import type { InsightTemplateAttachment } from '@/lib/insights/templateAttachment';

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The bot's queue of messages typed while it was responding, persisted in
 * localStorage and kept in sync with other tabs. `canSend` says the bot is
 * free; the hook then sends the oldest message through `send`, one per turn.
 */
export function useMessageQueue({
  botId,
  canSend,
  send,
}: {
  botId: string | null | undefined;
  canSend: boolean;
  send: (message: QueuedMessage) => void;
}) {
  const key = queueStorageKey(botId);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [tabId] = useState(() => crypto.randomUUID());
  // Bumped to retry a send another tab held the claim on.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setQueue(readQueue(browserStorage(), key));
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setQueue(readQueue(browserStorage(), key));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  // Every write starts from storage, not state, so a message another tab
  // queued or sent in the meantime is not overwritten.
  const update = useCallback(
    (change: (current: QueuedMessage[]) => QueuedMessage[]) => {
      const storage = browserStorage();
      const next = change(storage ? readQueue(storage, key) : queue);
      writeQueue(storage, key, next);
      setQueue(next);
      return next;
    },
    [key, queue],
  );

  const enqueue = useCallback(
    (text: string, insightTemplate?: InsightTemplateAttachment) => {
      update((current) =>
        enqueueMessage(current, {
          id: crypto.randomUUID(),
          text,
          ...(insightTemplate ? { insightTemplate } : {}),
          queuedAt: Date.now(),
        }),
      );
    },
    [update],
  );

  const remove = useCallback((id: string) => update((current) => removeQueuedMessage(current, id)), [update]);

  // One send per free moment: the flag drops when `canSend` changes, i.e.
  // once the sent message has made the bot busy (or the send settled).
  const sendingRef = useRef(false);
  useEffect(() => {
    sendingRef.current = false;
  }, [canSend]);

  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!canSend || sendingRef.current || queue.length === 0) return;
    const storage = browserStorage();
    if (!claimDispatch(storage, key, tabId, Date.now())) {
      const timer = window.setTimeout(() => setRetryTick((t) => t + 1), DISPATCH_CLAIM_MS);
      return () => window.clearTimeout(timer);
    }
    const taken = dequeueMessage(storage ? readQueue(storage, key) : queue);
    if (!taken) {
      setQueue([]);
      return;
    }
    sendingRef.current = true;
    writeQueue(storage, key, taken.rest);
    setQueue(taken.rest);
    sendRef.current(taken.next);
  }, [canSend, queue, key, tabId, retryTick]);

  return { queue, enqueue, remove };
}

/** The messages waiting to be sent, each deletable until it goes out. */
export function QueuedMessageList({
  queue,
  onRemove,
  paused = false,
  className,
}: {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  /** The last reply failed, so the queue holds until the user sends again. */
  paused?: boolean;
  className?: string;
}) {
  if (queue.length === 0) return null;
  return (
    <div className={cn('rounded-xl border bg-card p-1.5', className)} data-testid="chat-queued-messages">
      <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
        <Clock className="h-3 w-3" />
        {paused
          ? 'Queued — paused after the last reply failed'
          : `Queued — sends when the bot is free`}
      </div>
      <ul className="space-y-1">
        {queue.map((m) => (
          <li
            key={m.id}
            className="flex items-start gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-sm"
            data-testid="chat-queued-message"
          >
            <div className="min-w-0 flex-1">
              {m.insightTemplate && (
                <div className="truncate text-[11px] text-muted-foreground">{m.insightTemplate.name}</div>
              )}
              <p className="line-clamp-2 whitespace-pre-wrap break-words">{m.text}</p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(m.id)}
              aria-label="Delete queued message"
              title="Delete queued message"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              data-testid="chat-queued-message-delete"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
