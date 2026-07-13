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
  type RefObject,
} from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, buildWorkspaceHeaders } from "@/lib/api/client";
import type { ModelChoice } from "@/lib/agents/analysis";

export type ChatModelChoice = 'auto' | ModelChoice;
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

/** Max size for a single chat attachment. Any file type is accepted. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB

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

/**
 * A file the user has dropped/attached to the composer. It is uploaded to S3
 * as soon as it's added; `key` is populated once the presigned upload resolves.
 * `status: 'ready'` attachments are sent (as `{ key, fileName, contentType }`)
 * with every chat turn so the file can be referenced across the conversation.
 */
export interface ChatAttachment {
  localId: string;
  key: string | null;
  fileName: string;
  contentType: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
}

/**
 * A cached prior chat whose first message matches what the user is about to
 * send in a brand-new chat. Rendered inline as a dotted-bordered preview (see
 * CachedChatPreview) offering "continue from chat" or "start fresh".
 */
export interface CachedChatHit {
  chatId: string;
  createdAt: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
  /** The message the user typed, replayed verbatim on "start fresh". */
  pendingText: string;
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
  /**
   * Send the first message of a chat with a cache pre-check. For a brand-new
   * chat it looks up a prior chat that started with the same question and, on
   * a hit, surfaces an inline cached preview instead of sending. Falls back to
   * a normal send for existing chats or on lookup failure.
   */
  sendWithCacheCheck: (text: string) => void;
  /** The active cached-chat hit to preview inline, or null. */
  cacheHit: CachedChatHit | null;
  /** Fork the cached turn-1 into a new owned chat and focus the input. */
  continueFromCached: () => void;
  /** Discard the cached preview and run the agent on the original message. */
  startFreshFromCached: () => void;
  /** Ref the active chat input registers so we can focus it programmatically. */
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  /** Files attached to the composer for the current chat (persist across turns). */
  attachments: ChatAttachment[];
  /** Upload files to S3 and attach them to the composer. */
  addFiles: (files: File[]) => void;
  /** Remove an attachment (deletes its S3 object) by its local id. */
  removeAttachment: (localId: string) => void;
  /** Which model the chat will use. 'auto' defers to the server default (Sonnet). */
  modelChoice: ChatModelChoice;
  setModelChoice: (m: ChatModelChoice) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

interface ServerUIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: { type: 'text'; text: string }[];
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();

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
  // A cached chat that started with the same first message as the one the user
  // is about to send in a brand-new chat. Non-null while the inline cached
  // preview is shown (offering "continue from chat" or "start fresh").
  const [cacheHit, setCacheHit] = useState<CachedChatHit | null>(null);
  // The active chat input registers itself here so "continue from chat" can
  // return focus to the chat bar.
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Indirection so the transport closure (memoized once) can always call the
  // latest refreshChats without re-creating the transport.
  const refreshChatsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Composer attachments. Held in a ref too so the (memoized-once) transport
  // body can read the latest set on every send without re-creating the
  // transport. Only 'ready' ones (finished uploading to S3) are sent.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  attachmentsRef.current = attachments;

  const [modelChoice, setModelChoice] = useState<ChatModelChoice>('auto');
  const modelChoiceRef = useRef<ChatModelChoice>('auto');
  modelChoiceRef.current = modelChoice;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: CHAT_API,
        body: () => {
          const ready = attachmentsRef.current
            .filter((a) => a.status === 'ready' && a.key)
            .map((a) => ({ key: a.key!, fileName: a.fileName, contentType: a.contentType }));
          const mc = modelChoiceRef.current;
          return {
            ...(chatIdRef.current ? { chat_id: chatIdRef.current } : {}),
            ...(ready.length ? { attachments: ready } : {}),
            ...(mc !== 'auto' ? { model: mc } : {}),
          };
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await fetch(input, {
            ...init,
            headers: buildWorkspaceHeaders(input, init?.headers),
          });
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
      const data = await apiRequest<{ chats: CopilotChatSummary[] }>(
        '/api/copilot/chats',
      );
      setChats(data.chats ?? []);
    } catch (err) {
      console.error('[chat] failed to load chat list:', err);
    }
  }, []);
  refreshChatsRef.current = refreshChats;

  useEffect(() => {
    // ChatProvider is mounted at the app root (providers.tsx), so this runs
    // on every page including /login and the brief window before the
    // session resolves — skip until we actually have a logged-in user to
    // avoid a guaranteed 401 on every unauthenticated page load.
    if (authLoading || !user) return;
    void refreshChats();
  }, [authLoading, user, refreshChats]);

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
    // Any chat switch (including back to "new chat") drops a pending cached
    // preview — it only ever applies to the brand-new chat it was raised for.
    setCacheHit(null);
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
        const data = await apiRequest<{ messages: ServerUIMessage[] }>(
          `/api/copilot/chats/${chatId}/messages`,
        );
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

  // Best-effort S3 delete of a single attachment key (fire-and-forget).
  const deleteAttachmentObject = useCallback((key: string) => {
    void apiRequest('/api/chat/attachments', {
      method: 'DELETE',
      body: JSON.stringify({ key }),
    }).catch((err) => console.error('[chat] attachment delete failed:', err));
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.error('File too large', {
            description: `${file.name} exceeds the 100 MB limit.`,
          });
          continue;
        }
        const localId = crypto.randomUUID();
        const contentType = file.type || 'application/octet-stream';
        setAttachments((prev) => [
          ...prev,
          {
            localId,
            key: null,
            fileName: file.name,
            contentType,
            size: file.size,
            status: 'uploading',
          },
        ]);
        void (async () => {
          try {
            const { uploadUrl, key } = await apiRequest<{ uploadUrl: string; key: string }>(
              `/api/chat/attachments/upload-url?fileName=${encodeURIComponent(
                file.name,
              )}&contentType=${encodeURIComponent(contentType)}`,
            );
            // Direct-to-S3 PUT against the presigned URL — no workspace headers
            // (buildWorkspaceHeaders already omits them for cross-origin URLs).
            const put = await fetch(uploadUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': contentType },
            });
            if (!put.ok) throw new Error(`S3 upload failed (${put.status})`);
            setAttachments((prev) =>
              prev.map((a) => (a.localId === localId ? { ...a, key, status: 'ready' } : a)),
            );
          } catch (err) {
            console.error('[chat] attachment upload failed:', err);
            toast.error('Failed to upload attachment', { description: file.name });
            setAttachments((prev) =>
              prev.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a)),
            );
          }
        })();
      }
    },
    [],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.localId === localId);
        if (target?.key) deleteAttachmentObject(target.key);
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [deleteAttachmentObject],
  );

  // Drop every attachment and delete its S3 object. Called when starting a
  // brand-new chat so the composer starts clean.
  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) if (a.key) deleteAttachmentObject(a.key);
      return [];
    });
  }, [deleteAttachmentObject]);

  const newChat = useCallback(() => {
    setChatId(null);
    setMessages([]);
    // Starting a new chat discards any pending cached-chat preview.
    setCacheHit(null);
    clearAttachments();
  }, [setChatId, setMessages, clearAttachments]);

  // Entry point for sending the FIRST message of a chat. For a brand-new chat
  // (no chatId yet) it first asks the server whether the same question was
  // already answered; on a hit it opens the warning dialog instead of sending.
  // Any other case (existing chat, empty text, or lookup failure) sends
  // immediately so caching never blocks the normal flow.
  const sendWithCacheCheck = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (chatIdRef.current || !trimmed) {
      chatStateRef.current.sendMessage({ text });
      return;
    }
    try {
      const data = await apiRequest<{
        hit?: boolean;
        chatId?: string;
        createdAt?: string;
        firstUserMessage?: string;
        firstAssistantMessage?: string;
      }>('/api/chat/cache-check', {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });
      if (data?.hit && data.chatId) {
        setCacheHit({
          chatId: data.chatId,
          createdAt: data.createdAt ?? '',
          firstUserMessage: data.firstUserMessage ?? '',
          firstAssistantMessage: data.firstAssistantMessage ?? '',
          pendingText: text,
        });
        return;
      }
    } catch (err) {
      console.error('[chat] cache-check failed:', err);
    }
    chatStateRef.current.sendMessage({ text });
  }, []);

  // "Continue from chat" — fork the cached turn-1 into a new chat owned by the
  // current user, switch to it (the chat-load effect renders the seeded
  // question + answer), and focus the chat bar so the user can keep typing.
  // Never opens the source thread directly.
  const continueFromCached = useCallback(async () => {
    const hit = cacheHit;
    setCacheHit(null);
    if (!hit) return;
    try {
      const data = await apiRequest<{ chatId?: string }>(
        '/api/copilot/chats/fork',
        {
          method: 'POST',
          body: JSON.stringify({ sourceChatId: hit.chatId }),
        },
      );
      if (!data?.chatId) throw new Error('fork returned no chatId');
      await refreshChats();
      setChatId(data.chatId);
      // Defer focus until after the chat-load effect has re-rendered the input.
      requestAnimationFrame(() => chatInputRef.current?.focus());
    } catch (err) {
      console.error('[chat] fork failed:', err);
      toast.error("Couldn't open the cached chat", {
        description: 'Please try again in a moment.',
      });
    }
  }, [cacheHit, refreshChats, setChatId]);

  // "Start fresh" — ignore the cache and send the original message as a new chat.
  const startFreshFromCached = useCallback(() => {
    const hit = cacheHit;
    setCacheHit(null);
    if (!hit) return;
    chatStateRef.current.sendMessage({ text: hit.pendingText });
  }, [cacheHit]);

  // A prompt that's queued behind a still-streaming response. Non-null while
  // the "stop & replace" confirmation dialog is open.
  const [pendingAnalysis, setPendingAnalysis] = useState<string | null>(null);

  const analyzeWithAI = useCallback(
    (text: string) => {
      const status = chatStateRef.current.status;
      const busy = status === "streaming" || status === "submitted";
      if (busy) {
        setPendingAnalysis(text);
      } else {
        void sendWithCacheCheck(text);
      }
    },
    [sendWithCacheCheck],
  );

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
      sendWithCacheCheck,
      cacheHit,
      continueFromCached,
      startFreshFromCached,
      chatInputRef,
      attachments,
      addFiles,
      removeAttachment,
      modelChoice,
      setModelChoice,
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
      sendWithCacheCheck,
      cacheHit,
      continueFromCached,
      startFreshFromCached,
      attachments,
      addFiles,
      removeAttachment,
      modelChoice,
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
