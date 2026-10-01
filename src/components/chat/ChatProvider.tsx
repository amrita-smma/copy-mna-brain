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
import { getPageContext, useOpenInsightAgent } from "@/lib/chat/pageContextStore";
import { describeChatAgent, toChatAgentKey } from "@/lib/chat/chatAgentKey";
import posthog from "posthog-js";
import { CHAT_ATTACHMENT_UPLOADED, chatAttachmentProperties } from "@/lib/posthog-chat";
import {
  insightTemplatePart,
  type InsightTemplateAttachment,
} from "@/lib/insights/templateAttachment";
import {
  insightSelectionPart,
  type InsightSelectionAttachment,
} from "@/lib/insights/selectionAttachment";
import type { ManualEffortChoice } from "@/lib/agents/analysis";

/** Structured context `analyzeWithAI` sends as message parts, not as text. */
export interface AnalyzeOptions {
  insightSelection?: InsightSelectionAttachment;
}

// Manual tiers only. The Auto-only `deep` tier is decided and stored server
// side; the client never names it, so it must not be representable here.
export type ChatEffortChoice = 'auto' | ManualEffortChoice;
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

/**
 * How many animation frames `focusComposer` will wait for the composer to
 * appear before giving up. Generous enough to cover the copilot pane's 300ms
 * open animation (~18 frames at 60Hz) plus the remount that swaps the docked
 * composer for the empty state's hero one.
 */
const FOCUS_COMPOSER_MAX_FRAMES = 30;

/** Max size for a single chat attachment. Supports documents, images, and text. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/json',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function isAllowedFileType(file: File): boolean {
  if (file.type && file.type.startsWith('text/')) return true;
  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) return true;
  
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.pdf')) return true;
  if (lowerName.endsWith('.docx')) return true;
  if (lowerName.endsWith('.pptx')) return true;
  if (lowerName.endsWith('.xlsx')) return true;
  if (lowerName.endsWith('.json')) return true;
  if (lowerName.endsWith('.csv')) return true;
  if (lowerName.endsWith('.png')) return true;
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return true;
  if (lowerName.endsWith('.gif')) return true;
  if (lowerName.endsWith('.webp')) return true;
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) return true;
  
  return false;
}

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
  effort_tier: string | null;
  /**
   * The agent the thread is pinned to (MB-549): a sector agent key or
   * 'general'; null until the thread's first turn resolves it.
   */
  agent_key: string | null;
}

/**
 * Chats fetched per page. Kept in step with `CHAT_HISTORY_PAGE_SIZE` on the
 * server — the client sends it explicitly so the two can't silently disagree
 * about how far an offset advances.
 */
const CHAT_PAGE_SIZE = 20;

/** Mirrors `CHAT_HISTORY_MAX_PAGE_SIZE`; the server clamps to it regardless. */
const CHAT_MAX_PAGE_SIZE = 100;

interface ChatListResponse {
  chats: CopilotChatSummary[];
  hasMore?: boolean;
  nextOffset?: number | null;
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
  previewUrl?: string;
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
  activeChatEffortTier: string | null;
  /**
   * The agent the active thread is pinned to, or null when there is no thread
   * yet or its pin isn't known on the client.
   */
  activeChatAgentKey: string | null;
  refreshChats: () => Promise<void>;
  /**
   * Append the next page of chat history. The sidebar calls this when the
   * user clicks "See More". No-op while a load is in flight or once every
   * chat has been fetched.
   */
  loadMoreChats: () => Promise<void>;
  /** Whether the server reported another page after the ones already loaded. */
  hasMoreChats: boolean;
  /** True while `loadMoreChats` is fetching, so the list can show a spinner. */
  isLoadingMoreChats: boolean;
  isLoadingMessages: boolean;
  /**
   * Which chat the current `messages` array belongs to; `undefined` while a
   * history load is in flight. Consumers that must distinguish "this chat's
   * persisted history" from "something that just streamed in" have to key off
   * this rather than `chatId`, which changes a commit earlier.
   */
  messagesChatId: string | null | undefined;
  /**
   * Entry point for every "Analyze using AI" trigger. Sends the prompt to the
   * copilot immediately when idle; when a response is already streaming it
   * opens a confirmation dialog offering to stop the current response and
   * replace it with this analysis.
   *
   * `insightSelection` attaches the elements picked in an open insight: the
   * bubble shows them as a chip and `text` stays the user's own words.
   */
  analyzeWithAI: (text: string, options?: AnalyzeOptions) => void;
  /**
   * Put text in the composer ready to edit, without sending it. Unlike
   * `analyzeWithAI` (which sends immediately), this hands the user a
   * half-written sentence to finish and submit themselves.
   */
  prefillComposer: (text: string) => void;
  /** The pending prefill, consumed by the composer. */
  composerDraft: { text: string; nonce: number } | null;
  /**
   * Send the first message of a chat with a cache pre-check. For a brand-new
   * chat it looks up a prior chat that started with the same question and, on
   * a hit, surfaces an inline cached preview instead of sending. Falls back to
   * a normal send for existing chats or on lookup failure.
   */
  sendWithCacheCheck: (text: string, insightTemplate?: InsightTemplateAttachment) => void;
  /** The active cached-chat hit to preview inline, or null. */
  cacheHit: CachedChatHit | null;
  /** Fork the cached turn-1 into a new owned chat and focus the input. */
  continueFromCached: () => void;
  /** Discard the cached preview and run the agent on the original message. */
  startFreshFromCached: () => void;
  /** Ref the active chat input registers so we can focus it programmatically. */
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Put the caret in the composer, ready to type. Tolerates the composer not
   * being mounted yet (see the implementation), so callers can fire it in the
   * same tick as the state change that reveals it.
   */
  focusComposer: () => void;
  /** Files attached to the composer for the current chat (persist across turns). */
  attachments: ChatAttachment[];
  /** Upload files to S3 and attach them to the composer. */
  addFiles: (files: File[]) => void;
  /** Remove an attachment (deletes its S3 object) by its local id. */
  removeAttachment: (localId: string) => void;
  /** Which effort tier the chat will use. 'auto' lets the server route the thread. */
  effortChoice: ChatEffortChoice;
  setEffortChoice: (m: ChatEffortChoice) => void;
  /** Holds attachments for optimistically rendered user messages before server reload. */
  optimisticAttachments: Record<string, ChatAttachment[]>;
  /** The insight template selected via the `/insight-template` chip, if any. */
  insightTemplate: { id: string; name: string } | null;
  /** Select (or clear, with `null`) the insight-template chip. */
  setInsightTemplate: (tpl: { id: string; name: string } | null) => void;
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
  // The tier the thread is actually running at, for consumers that need to
  // inherit it (e.g. the workforce handoff card). `chats` is the paged sidebar
  // list; a chat outside the loaded page yields null and the consumer falls back.
  const activeChatEffortTier = useMemo(
    () => chats.find((c) => c.id === chatId)?.effort_tier ?? null,
    [chats, chatId],
  );
  // Agents the server reported via X-Chat-Agent this session, by chat id. The
  // header can name the thread's agent the moment a turn starts, before the
  // chat list refresh lands (or when the chat sits outside the loaded page).
  const [reportedAgentKeys, setReportedAgentKeys] = useState<Record<string, string>>({});
  const activeChatAgentKey = useMemo(
    () =>
      (chatId
        ? reportedAgentKeys[chatId] ?? chats.find((c) => c.id === chatId)?.agent_key
        : null) ?? null,
    [chats, chatId, reportedAgentKeys],
  );
  const activeChatAgentKeyRef = useRef<string | null>(null);
  activeChatAgentKeyRef.current = activeChatAgentKey;
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
  // The paging callbacks read the current list length to compute the next
  // offset. Going through a ref keeps them stable across renders, so the
  // sidebar's IntersectionObserver isn't torn down and rebuilt on every append.
  const chatsRef = useRef<CopilotChatSummary[]>([]);
  chatsRef.current = chats;
  const loadingMoreRef = useRef(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  // Which chat the CURRENT `messages` array belongs to — `undefined` while a
  // load is in flight, meaning "don't trust `messages` yet".
  //
  // This exists because `chatId` and `messages` change in separate commits:
  // selecting a chat sets `chatId` immediately while `messages` still holds the
  // previous conversation, and the history only lands an effect (or a network
  // round-trip) later. Any consumer that needs to know "are these messages the
  // ones this chat arrived with, or something that just streamed in?" cannot
  // answer it from `chatId` alone. Always updated in the same batch as
  // `setMessages`, so it is never out of step with the array it describes.
  const [messagesChatId, setMessagesChatId] = useState<string | null | undefined>(null);
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
  
  // Captures attachments synchronously when the user hits send, holding them
  // for the few milliseconds it takes Vercel AI SDK to build and dispatch
  // the asynchronous network request.
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);

  const [effortChoice, setEffortChoice] = useState<ChatEffortChoice>('auto');
  const effortChoiceRef = useRef<ChatEffortChoice>('auto');
  effortChoiceRef.current = effortChoice;

  // The template selected via the composer's `/insight-template` popup. Kept
  // as its own slot (not folded into `composerDraft`) because `composerDraft`
  // is deliberately never cleared by its consumer effect — a template value
  // piggybacked on it would silently re-apply itself to a later, unrelated
  // message after any composer remount (pane collapse/expand, route change).
  const [insightTemplate, setInsightTemplate] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Holds attachments associated with message IDs to render them optimistically
  // in the chat bubble before the server reloads the history.
  const [optimisticAttachments, setOptimisticAttachments] = useState<Record<string, ChatAttachment[]>>({});

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: CHAT_API,
        body: () => {
          const ready = pendingAttachmentsRef.current.map((a) => ({
            key: a.key!,
            fileName: a.fileName,
            contentType: a.contentType,
          }));
          // Consume them so they aren't sent again on the next turn.
          pendingAttachmentsRef.current = [];
          
          const mc = effortChoiceRef.current;
          // What the user has on screen right now, so `read_page_context` can
          // resolve "this deal" / "summarize this page". Read from the module
          // store rather than React state: `PageContextProvider` lives inside
          // the workspace layout, below this provider, so context can't reach
          // up here.
          const pageContext = getPageContext();
          return {
            ...(chatIdRef.current ? { chat_id: chatIdRef.current } : {}),
            ...(ready.length ? { attachments: ready } : {}),
            ...(mc !== 'auto' ? { effort: mc } : {}),
            ...(pageContext ? { page_context: pageContext } : {}),
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
          const agentKey = res.headers.get('X-Chat-Agent');
          if (newId && agentKey) {
            setReportedAgentKeys((prev) =>
              prev[newId] === agentKey ? prev : { ...prev, [newId]: agentKey },
            );
          }
          if (newId && newId !== chatIdRef.current) {
            chatIdRef.current = newId;
            justMintedChatIdRef.current = newId;
            setChatIdState(newId);
            // The in-flight messages now belong to the newly minted chat. Move
            // the stamp with the id — the load effect skips its fetch for a
            // just-minted chat, so nothing else will set it, and leaving it on
            // the old value would make the rest of this live turn read as
            // another chat's history.
            setMessagesChatId(newId);
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

  /**
   * Refetch the chat list from the top.
   *
   * Called whenever the list can have changed (a chat was created, renamed, or
   * touched). It re-reads as many chats as are currently on screen rather than
   * just the first page, so a user who has scrolled through several pages does
   * not watch the list collapse back to thirty entries when a title lands.
   */
  const refreshChats = useCallback(async () => {
    const loaded = Math.max(chatsRef.current.length, CHAT_PAGE_SIZE);
    try {
      const data = await apiRequest<ChatListResponse>(
        `/api/copilot/chats?limit=${Math.min(loaded, CHAT_MAX_PAGE_SIZE)}`,
      );
      setChats(data.chats ?? []);
      setHasMoreChats(Boolean(data.hasMore));
    } catch (err) {
      console.error('[chat] failed to load chat list:', err);
    }
  }, []);
  refreshChatsRef.current = refreshChats;

  /**
   * Append the next page. Guarded by a ref rather than the `isLoadingMoreChats`
   * state because a fast double-click on "See More" can fire before React
   * commits the state update, which would fire two requests for the same
   * offset and duplicate rows.
   */
  const loadMoreChats = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreChats) return;
    loadingMoreRef.current = true;
    setIsLoadingMoreChats(true);
    try {
      const data = await apiRequest<ChatListResponse>(
        `/api/copilot/chats?limit=${CHAT_PAGE_SIZE}&offset=${chatsRef.current.length}`,
      );
      // Dedupe on id: a chat touched between page loads shifts toward the top
      // of the ordering, so the same row can appear in two consecutive pages.
      setChats((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...(data.chats ?? []).filter((c) => !seen.has(c.id))];
      });
      setHasMoreChats(Boolean(data.hasMore));
    } catch (err) {
      console.error('[chat] failed to load more chats:', err);
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMoreChats(false);
    }
  }, [hasMoreChats]);

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
    if (authLoading || !user) return;

    // Any chat switch (including back to "new chat") drops a pending cached
    // preview — it only ever applies to the brand-new chat it was raised for.
    setCacheHit(null);
    if (!chatId) {
      chatStateRef.current.stop();
      setMessages([]);
      setMessagesChatId(null);
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
    // `undefined`, not `chatId`: these empty messages are not this chat's
    // history, they are a placeholder until the fetch below lands.
    setMessagesChatId(undefined);
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
      // Stamp the loaded history in the same batch as the messages it
      // describes, so consumers can tell "this chat's history" from "something
      // that just streamed in" without racing the two state updates.
      setMessagesChatId(chatId);
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
  }, [chatId, setMessages, refreshChats, authLoading, user]);

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
        if (!isAllowedFileType(file)) {
          toast.error('Unsupported file type', {
            description: `${file.name} is not a supported document or image format.`,
          });
          continue;
        }
        const localId = crypto.randomUUID();
        const contentType = file.type || 'application/octet-stream';
        const previewUrl = contentType.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setAttachments((prev) => [
          ...prev,
          {
            localId,
            key: null,
            fileName: file.name,
            contentType,
            size: file.size,
            status: 'uploading',
            previewUrl,
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
            // `chat_attachment_uploaded` — one event per file, emitted only
            // once the object is actually in S3. Captured here rather than in
            // `POST /api/chat` because a file can be attached and then removed
            // before the turn is sent, and "how many documents do people bring
            // to the copilot" is the question the dashboard asks.
            //
            // In its own try: posthog-js does not swallow a throw from
            // `before_send`, and this sits after the PUT already succeeded.
            // Letting it reach the outer catch would mark a file that is
            // sitting in S3 as failed and block the user from sending it.
            try {
              posthog.capture(
                CHAT_ATTACHMENT_UPLOADED,
                chatAttachmentProperties({
                  fileName: file.name,
                  contentType,
                  sizeBytes: file.size,
                  surface: 'copilot',
                }),
              );
            } catch (err) {
              console.error('[chat] attachment telemetry failed:', err);
            }
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
        if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [deleteAttachmentObject],
  );

  // Clears the composer UI state (e.g. after sending a message) without
  // deleting the underlying S3 objects, which the server still needs to read.
  const resetComposerAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  // An attached insight template or insight selection is a structured part of
  // the message itself — the bubble renders it as a card and the server expands
  // it into the model's turn — never words added to what the user typed.
  const sendWithAttachments = useCallback((
    text: string,
    insightTemplate?: InsightTemplateAttachment,
    insightSelection?: InsightSelectionAttachment,
  ) => {
    const readyAttachments = attachmentsRef.current.filter((a) => a.status === 'ready' && a.key);
    let payloadText = text;
    
    if (readyAttachments.length > 0) {
      const attachmentStr = readyAttachments.map(a => `\n📎 Attached: ${a.fileName}`).join("");
      payloadText = text ? `${text}\n${attachmentStr}` : attachmentStr.trim();
    }
    
    const messageId = crypto.randomUUID();
    
    if (readyAttachments.length > 0) {
      // Inject a hidden tracking ID so UserMessageBubble can find the optimistic attachments
      // even if Vercel AI SDK rewrites the actual message.id.
      payloadText = `${payloadText}\n<!-- attach_id: ${messageId} -->`.trim();
      setOptimisticAttachments(prev => ({ ...prev, [messageId]: readyAttachments }));
      pendingAttachmentsRef.current = readyAttachments;
    }
    
    chatStateRef.current.sendMessage({
      id: messageId,
      parts: [
        { type: 'text', text: payloadText },
        ...(insightTemplate ? [insightTemplatePart(insightTemplate)] : []),
        ...(insightSelection ? [insightSelectionPart(insightSelection)] : []),
      ],
    });
    resetComposerAttachments();
  }, [resetComposerAttachments]);

  // Drop every attachment and delete its S3 object. Called when starting a
  // brand-new chat so the composer starts clean.
  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) {
        if (a.key) deleteAttachmentObject(a.key);
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, [deleteAttachmentObject]);

  // Put the caret in the composer with the cursor at the end of whatever is
  // already there.
  //
  // Callers fire this in the same tick as the state change that reveals the
  // composer (opening a new chat, landing on the chat route), at which point the
  // textarea may not be mounted yet — the empty state and the transcript render
  // separate composers, and the copilot pane animates open. So retry across a
  // bounded number of frames until one lands. Bails if the user has meanwhile
  // put their cursor in some other text field, so this never steals focus from
  // a control they deliberately clicked.
  const focusComposer = useCallback(() => {
    if (typeof window === 'undefined') return;
    let framesLeft = FOCUS_COMPOSER_MAX_FRAMES;
    const attempt = () => {
      const active = document.activeElement as HTMLElement | null;
      const el = chatInputRef.current;
      if (
        active &&
        active !== el &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }
      // A disabled textarea (mid-send, mid-enhance) can't take focus; keep
      // waiting rather than burning the attempt on a no-op.
      if (el && !el.disabled) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
        return;
      }
      if (framesLeft-- > 0) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }, []);

  const newChat = useCallback(() => {
    setChatId(null);
    setMessages([]);
    // Same batch as the empty transcript so NavigationActionHandler does not
    // see "chat B's stamp, no messages" for a frame.
    setMessagesChatId(null);
    // Starting a new chat discards any pending cached-chat preview.
    setCacheHit(null);
    clearAttachments();
    // A fresh chat shouldn't carry over a stale template selection.
    setInsightTemplate(null);
    // Pressing "New Chat" is always a prelude to typing one, so hand the caret
    // over. Emptying the transcript swaps the docked composer for the empty
    // state's hero one, so the focus has to survive that remount — which
    // `focusComposer` handles.
    focusComposer();
  }, [setChatId, setMessages, clearAttachments, focusComposer]);

  // Entry point for sending the FIRST message of a chat. For a brand-new chat
  // (no chatId yet) it first asks the server whether the same question was
  // already answered; on a hit it opens the warning dialog instead of sending.
  // Any other case (existing chat, empty text, or lookup failure) sends
  // immediately so caching never blocks the normal flow.
  const sendWithCacheCheck = useCallback(async (text: string, insightTemplate?: InsightTemplateAttachment) => {
    const trimmed = text.trim();
    // A template-backed ask is never served from the cache: the cached chat's
    // text alone can't say whether the same template was attached.
    if (chatIdRef.current || !trimmed || insightTemplate) {
      sendWithAttachments(text, insightTemplate);
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
        // The page decides which agent a new chat would run on, and a cached
        // answer is only offered from that same agent (MB-549).
        body: JSON.stringify({ message: trimmed, page_context: getPageContext() }),
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
    sendWithAttachments(text);
  }, [sendWithAttachments]);

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
    sendWithAttachments(hit.pendingText);
  }, [cacheHit, sendWithAttachments]);

  // Switching insights switches the agent (MB-549, US-10 AC4). When the user
  // opens an insight whose bound agent differs from the one the current thread
  // is pinned to, the panel starts a new thread for it; the old thread is
  // untouched and stays resumable from history on its own agent. Keyed on the
  // open insight and its binding only — never on the active chat — so resuming
  // an old thread from history while an insight is open does not bounce the
  // user out of it. An empty thread needs nothing: its first turn resolves the
  // agent on the server. A thread whose pin the client doesn't know, or one
  // that is mid-response, is left alone.
  const openInsight = useOpenInsightAgent();
  const openInsightId = openInsight?.insightId ?? null;
  const openInsightAgentKey = openInsight?.agentKey ?? null;
  useEffect(() => {
    if (!openInsightId || !chatIdRef.current) return;
    const current = chatStateRef.current;
    if (current.messages.length === 0) return;
    if (current.status === 'streaming' || current.status === 'submitted') return;
    const pinned = activeChatAgentKeyRef.current;
    if (!pinned) return;
    const target = toChatAgentKey(openInsightAgentKey);
    if (toChatAgentKey(pinned) === target) return;

    // Not `newChat()`: that also deletes the composer's uploaded files and
    // grabs focus, neither of which a page navigation should do.
    chatIdRef.current = null;
    setChatIdState(null);
    setMessages([]);
    setMessagesChatId(null);
    setCacheHit(null);
    toast.info(`New chat with ${describeChatAgent(target).label}`, {
      description: 'This insight uses a different agent. Your previous chat is in history.',
    });
  }, [openInsightId, openInsightAgentKey, setMessages]);

  // A prompt that's queued behind a still-streaming response. Non-null while
  // the "stop & replace" confirmation dialog is open.
  const [pendingAnalysis, setPendingAnalysis] = useState<
    { text: string; options?: AnalyzeOptions } | null
  >(null);

  // The pending composer prefill, consumed by ChatInputContainer. Nonce increments on
  // every prefill so identical prompts (e.g. clicking "New insight" twice) still
  // re-trigger the consumer effect.
  const [composerDraft, setComposerDraft] = useState<{ text: string; nonce: number } | null>(null);

  const prefillComposer = useCallback((text: string) => {
    setComposerDraft((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const analyzeWithAI = useCallback(
    (text: string, options?: AnalyzeOptions) => {
      const status = chatStateRef.current.status;
      const busy = status === "streaming" || status === "submitted";
      if (busy) {
        setPendingAnalysis({ text, options });
      } else if (options?.insightSelection) {
        // Never served from the cache: the text alone ("make it blue") can't
        // say what was selected, so it would match an unrelated chat.
        sendWithAttachments(text, undefined, options.insightSelection);
      } else {
        void sendWithCacheCheck(text);
      }
    },
    [sendWithCacheCheck, sendWithAttachments],
  );

  const confirmPendingAnalysis = useCallback(async () => {
    const pending = pendingAnalysis;
    setPendingAnalysis(null);
    if (pending == null) return;
    const { text, options } = pending;

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

    const insightSelection = options?.insightSelection;
    chatStateRef.current.sendMessage(
      insightSelection
        ? { parts: [{ type: "text", text }, insightSelectionPart(insightSelection)] }
        : { text },
    );
  }, [pendingAnalysis]);

  const value = useMemo<ChatContextValue>(
    () => ({
      ...chat,
      chatId,
      setChatId,
      newChat,
      chats,
      activeChatEffortTier,
      activeChatAgentKey,
      refreshChats,
      loadMoreChats,
      hasMoreChats,
      isLoadingMoreChats,
      isLoadingMessages,
      messagesChatId,
      analyzeWithAI,
      prefillComposer,
      composerDraft,
      sendWithCacheCheck,
      cacheHit,
      continueFromCached,
      startFreshFromCached,
      chatInputRef,
      focusComposer,
      attachments,
      addFiles,
      removeAttachment,
      effortChoice,
      setEffortChoice,
      optimisticAttachments,
      insightTemplate,
      setInsightTemplate,
    }),
    [
      chat,
      chatId,
      setChatId,
      newChat,
      chats,
      activeChatEffortTier,
      activeChatAgentKey,
      refreshChats,
      loadMoreChats,
      hasMoreChats,
      isLoadingMoreChats,
      isLoadingMessages,
      messagesChatId,
      analyzeWithAI,
      prefillComposer,
      composerDraft,
      sendWithCacheCheck,
      cacheHit,
      continueFromCached,
      startFreshFromCached,
      focusComposer,
      attachments,
      addFiles,
      removeAttachment,
      effortChoice,
      optimisticAttachments,
      insightTemplate,
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
