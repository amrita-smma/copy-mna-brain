'use client';

import { useEffect, useRef } from 'react';
import { useChatActions, useChatMessages, useChatStatus, useChatThread } from './ChatProvider';
import {
  collectNavigations,
  resolveNavigationAction,
  type NavigationSource,
  type NavigatePagePayload,
} from '@/lib/navigation/navigateAction';

/**
 * Performs the navigation the copilot asked for with `navigate_page`.
 *
 * The rule itself lives in `resolveNavigationAction` (pure, and tested there);
 * this component only feeds it and acts on the answer.
 *
 * It hears a marker two ways. The transcript, on every streamed batch, so
 * the console moves the moment the tool answers rather than when the turn
 * ends; and the finished message of each turn (`onTurnFinished`), because
 * the transcript is throttled while `status` is not: the turn can read as
 * over before its last batch lands, and that batch would then be absorbed
 * as history. The finished message is read first, whole, so a marker in it
 * is acted on before the batch arrives, and `handled` keeps the two from
 * navigating twice.
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
  const { messages } = useChatMessages();
  const { messagesChatId } = useChatThread();
  const { status } = useChatStatus();
  const { onTurnFinished } = useChatActions();
  const handledRef = useRef<Set<string>>(new Set());
  // Each message's markers, found once per message object: the stream hands
  // out a new object only for the message it is writing.
  const navCacheRef = useRef(new WeakMap<NavigationSource, NavigatePagePayload[]>());
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
      navigations: collectNavigations(messages as NavigationSource[], navCacheRef.current),
      handled: handledRef.current,
      isFirstViewOfChat,
      isLiveTurn: status === 'submitted' || status === 'streaming',
    });

    for (const navId of absorb) handledRef.current.add(navId);
    if (navigateTo) onNavigateRef.current(navigateTo.path);
  }, [messages, messagesChatId, status]);

  // The turn this tab streamed just ended: whatever it asked for is live,
  // whether or not the transcript has caught up.
  useEffect(
    () =>
      onTurnFinished((message) => {
        const { absorb, navigateTo } = resolveNavigationAction({
          navigations: collectNavigations([message as NavigationSource]),
          handled: handledRef.current,
          isFirstViewOfChat: false,
          isLiveTurn: true,
        });
        for (const navId of absorb) handledRef.current.add(navId);
        if (navigateTo) onNavigateRef.current(navigateTo.path);
      }),
    [onTurnFinished],
  );

  return null;
}
