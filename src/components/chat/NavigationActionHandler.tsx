'use client';

import { useEffect, useRef } from 'react';
import { useChatContext } from './ChatProvider';
import {
  parseNavigatePayloads,
  resolveNavigationAction,
  type NavigatePagePayload,
} from '@/lib/navigation/navigateAction';

/** Reads the text a tool part carries, whichever shape the SDK gave it. */
function toolOutputText(part: unknown): string {
  const output = (part as { output?: unknown }).output;
  if (typeof output === 'string') return output;
  const content = (output as { kwargs?: { content?: unknown } })?.kwargs?.content;
  return typeof content === 'string' ? content : '';
}

/** Every navigate_page payload present in the transcript, in order. */
function collectNavigations(messages: { parts?: unknown[] }[]): NavigatePagePayload[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => parseNavigatePayloads(toolOutputText(part))),
  );
}

/**
 * Performs the navigation the copilot asked for with `navigate_page`.
 *
 * The rule itself lives in `resolveNavigationAction` (pure, and tested there);
 * this component only feeds it and acts on the answer.
 *
 * The one subtlety worth stating here is why it keys off `messagesChatId` and
 * not `chatId`. Those change in separate commits: selecting a chat sets `chatId`
 * immediately while `messages` still holds the *previous* conversation, and the
 * history only lands later. Keying off `chatId` meant the baseline was taken
 * against the wrong transcript, and the real history — arriving afterwards under
 * an unchanged `chatId` — looked live and navigated. `messagesChatId` is stamped
 * in the same batch as `setMessages`, so "are these messages new to me?" has a
 * single, race-free answer.
 */
export function NavigationActionHandler({
  onNavigate,
}: {
  /** Called with the workspace-relative path the agent chose. */
  onNavigate: (path: string) => void;
}) {
  const { messages, messagesChatId, status } = useChatContext();
  const handledRef = useRef<Set<string>>(new Set());
  // `undefined` is also ChatProvider's "load in flight" value, so seed with a
  // sentinel that can never equal it — otherwise a mid-load first render would
  // count as having already seen this chat.
  const seenChatRef = useRef<string | null | undefined | symbol>(Symbol('unseen'));
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    // A load is in flight: `messages` is a placeholder, not this chat's
    // history. Absorbing it would baseline the wrong transcript.
    if (messagesChatId === undefined) return;

    const isFirstViewOfChat = seenChatRef.current !== messagesChatId;
    seenChatRef.current = messagesChatId;

    const { absorb, navigateTo } = resolveNavigationAction({
      navigations: collectNavigations(messages as { parts?: unknown[] }[]),
      handled: handledRef.current,
      isFirstViewOfChat,
      isLiveTurn: status === 'submitted' || status === 'streaming',
    });

    for (const navId of absorb) handledRef.current.add(navId);
    if (navigateTo) onNavigateRef.current(navigateTo.path);
  }, [messages, messagesChatId, status]);

  return null;
}
