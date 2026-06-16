"use client";

import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const CHAT_API = "/api/chat";

function parseChatError(err: Error): { title: string; description: string } {
  // The AI SDK forwards Anthropic API errors as a JSON-stringified payload in
  // err.message (e.g. {"error":{"type":"overloaded_error",...}}). Translate
  // the known types into user-friendly copy; fall back to the raw message.
  try {
    const payload = JSON.parse(err.message) as {
      error?: { type?: string; message?: string };
    };
    switch (payload?.error?.type) {
      case 'overloaded_error':
        return {
          title: 'Claude is overloaded right now',
          description:
            "Anthropic's servers are busy. Please wait a moment and send your message again.",
        };
      case 'rate_limit_error':
        return {
          title: 'Rate limit reached',
          description: 'Too many requests in a short window. Please wait a few seconds and try again.',
        };
      case 'timeout_error':
        return {
          title: 'Request timed out',
          description: 'The model took too long to respond. Please try again.',
        };
      case 'api_error':
        return {
          title: 'Claude API error',
          description:
            payload.error?.message ||
            "Something went wrong on Anthropic's side. Please try again in a moment.",
        };
      case 'authentication_error':
      case 'permission_error':
        return {
          title: 'Authentication issue',
          description: 'There was a problem authenticating with the model provider. Please contact support.',
        };
      case 'invalid_request_error':
        return {
          title: 'Invalid request',
          description:
            payload.error?.message ||
            'The request was rejected. Please try again or start a new chat.',
        };
    }
  } catch {
    // Not a JSON payload — fall through to the generic message.
  }
  return {
    title: 'Error while processing your request',
    description: err.message,
  };
}

export interface CopilotChatSummary {
  id: string;
  title: string | null;
  last_active_at: string;
  created_at: string;
}

interface ChatContextValue extends ReturnType<typeof useChat> {
  chatId: string | null;
  setChatId: (id: string | null) => void;
  newChat: () => void;
  chats: CopilotChatSummary[];
  refreshChats: () => Promise<void>;
  isLoadingMessages: boolean;
  /**
   * Entry point for every "Analyze using AI" trigger. Sends the prompt to the
   * copilot immediately when idle; when a response is already streaming it
   * opens a confirmation dialog offering to stop the current response and
   * replace it with this analysis.
   */
  analyzeWithAI: (text: string) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

interface ServerUIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: { type: 'text'; text: string }[];
}

export function ChatProvider({ children }: { children: ReactNode }) {
  // Active chat. `null` means "the next message will mint a new chat row on
  // the server"; the server's response header (X-Chat-Id) tells us which.
  const [chatId, setChatIdState] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  // Tracks chat IDs we minted mid-stream via the X-Chat-Id response header,
  // so the chat-load effect can skip its history fetch (and the destructive
  // setMessages([]) that would wipe the in-flight stream). Reset on consume.
  const justMintedChatIdRef = useRef<string | null>(null);

  const [chats, setChats] = useState<CopilotChatSummary[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  // Indirection so the transport closure (memoized once) can always call the
  // latest refreshChats without re-creating the transport.
  const refreshChatsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: CHAT_API,
        body: () => (chatIdRef.current ? { chat_id: chatIdRef.current } : {}),
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await fetch(input, init);
          // Capture the chat_id minted server-side on the first message of a
          // brand-new chat. Set it before the stream finishes so the next
          // user message in the same session sticks to the same thread.
          const newId = res.headers.get('X-Chat-Id');
          if (newId && newId !== chatIdRef.current) {
            chatIdRef.current = newId;
            justMintedChatIdRef.current = newId;
            setChatIdState(newId);
            // Surface the new chat in the sidebar immediately. The row exists
            // in the DB by the time headers arrive; the title will be pushed
            // via the stream's `data-chat-title` part the moment Haiku
            // resolves (see onData below).
            void refreshChatsRef.current();
          }
          return res;
        },
      }),
    [],
  );

  const chat = useChat({
    transport,
    onError: (e: Error) => {
      console.error(e);
      const { title, description } = parseChatError(e);
      toast.error(title, { description, duration: 8000 });
    },
    onData: (part) => {
      // The server pushes the generated chat title via a transient
      // `data-chat-title` part the moment Haiku resolves — update the matching
      // chat row in the sidebar immediately, no polling, no waiting for the
      // agent stream to finish.
      if (part.type === 'data-chat-title') {
        const payload = part.data as { chatId?: string; title?: string };
        if (!payload?.chatId || !payload.title) return;
        setChats((prev) =>
          prev.map((c) =>
            c.id === payload.chatId ? { ...c, title: payload.title ?? c.title } : c,
          ),
        );
      }
    },
    onFinish: () => {
      // Catch-all refresh in case the data-chat-title part was missed (e.g.
      // Haiku timed out server-side and the title landed via the `after()`
      // hook instead).
      void refreshChats();
    },
  });

  const { setMessages } = chat;
  // Keep a ref to the latest chat handle so effects can call stop()/read
  // status without needing chat in their deps (which changes every render).
  const chatStateRef = useRef(chat);
  chatStateRef.current = chat;

  const refreshChats = useCallback(async () => {
    try {
      const res = await fetch('/api/copilot/chats');
      if (!res.ok) return;
      const data = (await res.json()) as { chats: CopilotChatSummary[] };
      setChats(data.chats ?? []);
    } catch (err) {
      console.error('[chat] failed to load chat list:', err);
    }
  }, []);
  refreshChatsRef.current = refreshChats;

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  // When chatId changes (user clicked a chat in the sidebar), load that
  // chat's history from the server. Skip when we just minted this ID
  // mid-stream from the server's X-Chat-Id header — in that case the stream
  // belongs to THIS chat, so we don't want to abort or wipe it.
  //
  // On any other transition we abort the in-flight stream (chat.stop()) so
  // the new chat's input is usable immediately. The server-side LangGraph
  // run may halt too — we tolerate that; the checkpointer persists state at
  // each step boundary. If the resumed chat's last persisted message is from
  // the user (no assistant reply yet), we poll briefly so a late-arriving
  // assistant reply (whether from a still-running agent or another client)
  // shows up automatically.
  useEffect(() => {
    if (!chatId) {
      chatStateRef.current.stop();
      setMessages([]);
      setIsLoadingMessages(false);
      // Pick up any title that landed via the server's `after()` hook between
      // the user aborting and now — the data-chat-title SSE chunk would have
      // been dropped on abort.
      void refreshChats();
      return;
    }
    if (justMintedChatIdRef.current === chatId) {
      justMintedChatIdRef.current = null;
      return;
    }
    chatStateRef.current.stop();
    void refreshChats();

    setMessages([]);
    setIsLoadingMessages(true);

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const fetchMessages = async (): Promise<UIMessage[] | null> => {
      try {
        const res = await fetch(`/api/copilot/chats/${chatId}/messages`);
        if (!res.ok) return null;
        const data = (await res.json()) as { messages: ServerUIMessage[] };
        return (data.messages ?? []) as unknown as UIMessage[];
      } catch (err) {
        console.error('[chat] failed to load chat messages:', err);
        return null;
      }
    };

    const lastIsUser = (msgs: UIMessage[]): boolean =>
      msgs.length > 0 && msgs[msgs.length - 1].role === 'user';

    (async () => {
      const initial = await fetchMessages();
      if (cancelled) return;
      if (initial) setMessages(initial);
      setIsLoadingMessages(false);

      // The chat is "in-flight" from the user's perspective if the last
      // persisted message is theirs — i.e. the assistant reply hasn't
      // checkpointed yet. Poll every 2s up to ~30s for an update.
      if (!initial || !lastIsUser(initial)) return;

      let attempts = 0;
      const tick = async () => {
        if (cancelled) return;
        // Don't stomp on useChat's local state if the user has started a new
        // send in this chat in the meantime.
        if (chatStateRef.current.status !== 'ready') return;
        attempts++;
        const fresh = await fetchMessages();
        if (cancelled) return;
        if (fresh) {
          setMessages(fresh);
          if (!lastIsUser(fresh)) return; // assistant reply landed
        }
        if (attempts < 15) {
          pollTimer = setTimeout(tick, 2000);
        }
      };
      pollTimer = setTimeout(tick, 2000);
    })();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [chatId, setMessages, refreshChats]);

  const setChatId = useCallback(
    (id: string | null) => {
      chatIdRef.current = id;
      setChatIdState(id);
    },
    [],
  );

  const newChat = useCallback(() => {
    setChatId(null);
    setMessages([]);
  }, [setChatId, setMessages]);

  // A prompt that's queued behind a still-streaming response. Non-null while
  // the "stop & replace" confirmation dialog is open.
  const [pendingAnalysis, setPendingAnalysis] = useState<string | null>(null);

  const analyzeWithAI = useCallback((text: string) => {
    const status = chatStateRef.current.status;
    const busy = status === "streaming" || status === "submitted";
    if (busy) {
      setPendingAnalysis(text);
    } else {
      chatStateRef.current.sendMessage({ text });
    }
  }, []);

  const confirmPendingAnalysis = useCallback(async () => {
    const text = pendingAnalysis;
    setPendingAnalysis(null);
    if (text == null) return;

    // Fully stop the in-flight run BEFORE starting the new turn. stop() aborts
    // the fetch (which propagates to the server via req.signal), but we also
    // wait for useChat's status to actually settle out of streaming/submitted —
    // otherwise the new send races the dying run and both stream into the same
    // thread concurrently (the cascade of duplicate thinking/tool blocks).
    try {
      await chatStateRef.current.stop();
    } catch {
      // stop() can reject if there's nothing in flight — safe to ignore.
    }

    const settled = await new Promise<boolean>((resolve) => {
      let attempts = 0;
      const check = () => {
        const status = chatStateRef.current.status;
        if (status !== "streaming" && status !== "submitted") {
          resolve(true);
          return;
        }
        if (attempts++ >= 50) {
          resolve(false); // ~5s cap; bail rather than hang forever
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    if (!settled) {
      toast.error("Couldn't stop the current response", {
        description: "Please try again in a moment.",
      });
      return;
    }

    chatStateRef.current.sendMessage({ text });
  }, [pendingAnalysis]);

  const value = useMemo<ChatContextValue>(
    () => ({
      ...chat,
      chatId,
      setChatId,
      newChat,
      chats,
      refreshChats,
      isLoadingMessages,
      analyzeWithAI,
    }),
    [
      chat,
      chatId,
      setChatId,
      newChat,
      chats,
      refreshChats,
      isLoadingMessages,
      analyzeWithAI,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {children}
      <AlertDialog
        open={pendingAnalysis !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAnalysis(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the current response?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI is still responding. Starting this analysis will stop the
              current response and replace it with the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPendingAnalysis}>
              Stop &amp; analyze
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ChatContext.Provider>
  );
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within ChatProvider");
  }
  return ctx;
}
