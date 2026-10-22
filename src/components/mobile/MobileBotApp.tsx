'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AICopilotPane } from '@/components/layout/AICopilotPane';
import { useChatActions } from '@/components/chat/ChatProvider';
import { MobileBotHome } from './MobileBotHome';

/** The query param that marks a bot's chat as open on the mobile landing. */
export const MOBILE_BOT_QUERY_PARAM = 'bot';

/** Read `?bot=` from a location search string (testable without `window`). */
export function botIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(MOBILE_BOT_QUERY_PARAM);
}

function botInUrl(): string | null {
  return botIdFromSearch(window.location.search);
}

/**
 * The mobile landing. It has two screens: the bot home, and one bot's chat
 * full-screen. The open chat lives in the URL (`?bot=<id>`), so the system back
 * gesture and the browser's back button return to the home. Opening a chat
 * pushes a history entry, and the header's back button pops it. A chat reached
 * straight from a link has no home entry to pop, so its back button replaces
 * the URL instead.
 */
export function MobileBotApp() {
  const { selectBot, focusComposer, setActiveBotThreadOnScreen } = useChatActions();
  const [chatOpen, setChatOpen] = useState(false);
  // Whether the open chat's history entry is ours to pop.
  const pushedRef = useRef(false);

  const syncFromUrl = useCallback(() => {
    const id = botInUrl();
    const open = id !== null;
    if (open) selectBot(id);
    else pushedRef.current = false;
    setChatOpen(open);
    return open;
  }, [selectBot]);

  useLayoutEffect(() => {
    setActiveBotThreadOnScreen(chatOpen);
  }, [chatOpen, setActiveBotThreadOnScreen]);

  // A reload or deep link with `?bot=` lands in that chat.
  useEffect(() => {
    if (syncFromUrl()) focusComposer();
    const onPop = () => {
      if (syncFromUrl()) focusComposer();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // Mount only: later chats are opened by `openBot`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openBot = useCallback(
    (id: string) => {
      selectBot(id);
      const url = new URL(window.location.href);
      url.searchParams.set(MOBILE_BOT_QUERY_PARAM, id);
      window.history.pushState(null, '', url);
      pushedRef.current = true;
      setChatOpen(true);
      focusComposer();
    },
    [selectBot, focusComposer],
  );

  const back = useCallback(() => {
    if (pushedRef.current) {
      // popstate closes the chat.
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(MOBILE_BOT_QUERY_PARAM);
    window.history.replaceState(null, '', url);
    setChatOpen(false);
  }, []);

  if (!chatOpen) return <MobileBotHome onOpenBot={openBot} />;
  return (
    <AICopilotPane isExpanded onToggleExpand={() => {}} hideExpandToggle onBack={back} className="border-l-0" />
  );
}
