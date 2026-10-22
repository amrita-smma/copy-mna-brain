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
  type Context,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { sortBots } from "@/lib/bots/order";
import { findBotMentions } from "@/lib/bots/mentions";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, buildWorkspaceHeaders } from "@/lib/api/client";
import { mergeHistoryTail } from "@/lib/chat/historyMerge";
import { sentNow } from "@/lib/chat/messageTime";
import { getPageContext } from "@/lib/chat/pageContextStore";
import { listBots, markBotRead, markBotUnread, openBotThread, savePinnedBots, stopChatTurn } from "@/lib/api/bots";
import { useEventStream } from "@/hooks/useEventStream";
import type { BotLiveEvent, BotPhase, BotPresence } from "@/lib/bots/presenceTypes";
import { mergeKeptUnread } from '@/lib/bots/keptUnread';
import type { BotDto } from "@/lib/bots/types";
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
 * open animation (~18 frames at 60Hz) plus the mount of the transcript's
 * composer when a bot's thread opens.
 */
const FOCUS_COMPOSER_MAX_FRAMES = 30;

/**
 * The bots' live state — who is thinking, a reply landing — is pushed over
 * this stream (`GET /api/bots/events`, backed by
 * Redis); nothing here polls. The snapshot it opens with is the bot list, so
 * it also replaces the periodic list refresh.
 */
const BOT_EVENTS_URL = '/api/bots/events';
/** How often, and how many times, a replaced turn is checked for having stopped. */
const TURN_STOP_POLL_MS = 500;
const TURN_STOP_POLL_ATTEMPTS = 30;

/**
 * Turns per older page, loaded as the user scrolls up. Opening a bot loads
 * only its last few turns (the server's default page).
 */
const EARLIER_PAGE_TURNS = 10;

const isLive = (status: string) => status === "streaming" || status === "submitted";

/** `bots` with exactly `pinnedIds` pinned, in the server's list order. */
function applyPins(bots: readonly BotDto[], pinnedIds: readonly string[]): BotDto[] {
  const pinned = new Set(pinnedIds);
  return sortBots(
    bots.map((b) => (b.pinned === pinned.has(b.id) ? b : { ...b, pinned: pinned.has(b.id) })),
    pinnedIds,
  );
}

/** A message's text, for spotting @mentions. */
function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
}

/** localStorage key remembering the bot the user last chatted with. */
const ACTIVE_BOT_STORAGE_KEY = 'copilot.activeBotId';

function readStoredBotId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_BOT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeBotId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_BOT_STORAGE_KEY, id);
  } catch {
    // Private mode or blocked storage: the default bot is picked next load.
  }
}

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
      error?: string | { type?: string; message?: string };
    };
    // The chat route's own errors are `{ error: "<message>" }`.
    if (typeof payload?.error === 'string') {
      return { title: "Couldn't send your message", description: payload.error };
    }
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
            'The request was rejected. Please try again.',
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

interface ChatContextValue extends ReturnType<typeof useChat> {
  /** The active bot's permanent thread, or null while it is being opened. */
  chatId: string | null;
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
  /** Send what the user typed (plus composer attachments) to the active bot. */
  sendText: (text: string, insightTemplate?: InsightTemplateAttachment) => void;
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
  /** Copilot bots (RFC 02): the user's visible bots, `[]` until loaded. */
  bots: BotDto[];
  activeBot: BotDto | null;
  /** Switch to a bot and open its permanent thread. */
  selectBot: (id: string) => void;
  /** Reload the bot list (after the Bots page creates or edits one). */
  refreshBots: () => Promise<void>;
  /**
   * Pin exactly these bots, in this order, and save. Pinned bots lead every
   * list; the rest follow by newest activity.
   */
  setPinnedBots: (ids: string[]) => void;
  /** Mark a bot's thread read or unread (the mobile swipe). */
  setBotUnread: (id: string, unread: boolean) => void;
  /**
   * Mobile bot home: false while the picker is on screen so a poll does not
   * auto-read the last opened bot. Desktop leaves this true (default).
   */
  setActiveBotThreadOnScreen: (onScreen: boolean) => void;
  hasEarlierMessages: boolean;
  isLoadingEarlier: boolean;
  loadEarlierMessages: () => Promise<boolean>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/* ──────────────────────────────────────────────────────────────────────────
 * Narrow contexts
 *
 * `ChatContextValue` spreads `useChat()`, so it carries `messages` and gets a
 * new object identity on EVERY streamed chunk. Anything subscribed to it
 * re-renders dozens of times a second while the copilot answers — which used
 * to include Dashboard, Pipeline, SmartFiles, MasterData, CompanyDetailDialog
 * and AppShell, all of which only ever wanted one stable callback.
 *
 * So the value is also published through four narrow contexts, split by how
 * often each slice actually changes:
 *
 *   useChatActions()  — callbacks only. Never changes after mount.
 *   useChatThread()   — the active bot, its thread and the bot list. Changes
 *                       on bot switches and list refreshes.
 *   useChatComposer() — composer state (attachments, effort, draft). Changes
 *                       on user input.
 *   useChatStatus()   — just `status`. Changes on turn boundaries.
 *
 * Use the narrowest one that covers what you need. `useChatContext()` is for
 * components that genuinely render the transcript (`messages`) — reach for it
 * only there, because it is the one that re-renders per token.
 * ────────────────────────────────────────────────────────────────────────── */

type ChatHandle = ReturnType<typeof useChat>;

/** `message` with a `createdAt` stamp in its metadata, keeping any it already carries. */
function stampSent<M extends { metadata?: unknown } | undefined>(message: M): M {
  if (!message) return message;
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  return { ...message, metadata: { ...sentNow(), ...metadata } };
}

/**
 * Callbacks with no reactive dependencies, so this object is referentially
 * stable for the life of the provider. Subscribing to it costs nothing during
 * streaming.
 */
export interface ChatActions {
  analyzeWithAI: (text: string, options?: AnalyzeOptions) => void;
  prefillComposer: (text: string) => void;
  sendText: (text: string, insightTemplate?: InsightTemplateAttachment) => void;
  focusComposer: () => void;
  addFiles: (files: File[]) => void;
  removeAttachment: (localId: string) => void;
  setEffortChoice: (m: ChatEffortChoice) => void;
  setInsightTemplate: (tpl: { id: string; name: string } | null) => void;
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  /** Stable wrapper around the AI SDK's `sendMessage`. */
  sendMessage: ChatHandle['sendMessage'];
  /** Stable wrapper around the AI SDK's `stop`. */
  stop: ChatHandle['stop'];
  selectBot: (id: string) => void;
  refreshBots: () => Promise<void>;
  setPinnedBots: (ids: string[]) => void;
  setBotUnread: (id: string, unread: boolean) => void;
  setActiveBotThreadOnScreen: (onScreen: boolean) => void;
  /** Prepend the previous page of the thread's history. Resolves false on no-op or error. */
  loadEarlierMessages: () => Promise<boolean>;
}

/** The active bot, its thread, and the bot list. */
export interface ChatThreadState {
  chatId: string | null;
  isLoadingMessages: boolean;
  /** Whether older history exists before the oldest message on screen. */
  hasEarlierMessages: boolean;
  isLoadingEarlier: boolean;
  messagesChatId: string | null | undefined;
  /** Visible bots, `[]` until loaded. `busy` is the bot's live state (Redis), not the DB lock. */
  bots: BotDto[];
  activeBot: BotDto | null;
  /** What each live bot is doing, by id; absent when idle (a bot waiting on another bot shows nothing). */
  livePhase: Record<string, BotPhase>;
}

/** Everything the composer owns, plus the optimistic attachment map. */
export interface ChatComposerState {
  attachments: ChatAttachment[];
  effortChoice: ChatEffortChoice;
  insightTemplate: { id: string; name: string } | null;
  composerDraft: { text: string; nonce: number } | null;
  optimisticAttachments: Record<string, ChatAttachment[]>;
}

export interface ChatStatusState {
  status: ChatHandle['status'];
}

const ChatActionsContext = createContext<ChatActions | null>(null);
const ChatThreadContext = createContext<ChatThreadState | null>(null);
const ChatComposerContext = createContext<ChatComposerState | null>(null);
const ChatStatusContext = createContext<ChatStatusState | null>(null);

function useNarrowChatContext<T>(ctx: Context<T | null>, hook: string): T {
  const value = useContext(ctx);
  if (!value) throw new Error(`${hook} must be used within ChatProvider`);
  return value;
}

/** Stable copilot callbacks. Safe to use from any component, at any depth. */
export function useChatActions(): ChatActions {
  return useNarrowChatContext(ChatActionsContext, 'useChatActions');
}

/** The active bot and its thread. Re-renders on bot switches, not on tokens. */
export function useChatThread(): ChatThreadState {
  return useNarrowChatContext(ChatThreadContext, 'useChatThread');
}

/** Composer state. Re-renders on user input, not on tokens. */
export function useChatComposer(): ChatComposerState {
  return useNarrowChatContext(ChatComposerContext, 'useChatComposer');
}

/** Just the turn status. Re-renders on turn boundaries, not on tokens. */
export function useChatStatus(): ChatStatusState {
  return useNarrowChatContext(ChatStatusContext, 'useChatStatus');
}

interface ServerUIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: { type: 'text'; text: string }[];
}

/** One page of a thread's stored history (`GET /api/copilot/chats/:id/messages`). */
interface HistoryPage {
  messages: ServerUIMessage[];
  /** Cursor for the page before this one; null at the start of the thread. */
  nextCursor: number | null;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();

  // The active bot's permanent thread. `null` while it is being opened; the
  // server resolves the thread from `bot_id` either way and reports it back
  // via X-Chat-Id.
  const [chatId, setChatIdState] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  // A thread id learned mid-stream from the X-Chat-Id response header, so the
  // load effect can skip its history fetch (and the destructive setMessages([])
  // that would wipe the in-flight stream). Reset on consume.
  const justMintedChatIdRef = useRef<string | null>(null);

  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  // Paging back through a long permanent thread: the cursor for the page before
  // the oldest one loaded, or null when the start of the thread is on screen.
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const historyCursorRef = useRef<number | null>(null);
  historyCursorRef.current = historyCursor;
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
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
  const messagesChatIdRef = useRef<string | null | undefined>(null);
  messagesChatIdRef.current = messagesChatId;
  // The active chat input registers itself here so "continue from chat" can
  // return focus to the chat bar.
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Copilot bots (RFC 02). The active bot id is also held in a ref so the
  // memoized-once transport sends the current one.
  const [bots, setBots] = useState<BotDto[]>([]);
  // For the build-once useChat callbacks (spotting a turn's @mentions).
  const botsRef = useRef<BotDto[]>([]);
  botsRef.current = bots;
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const activeBotIdRef = useRef<string | null>(null);
  activeBotIdRef.current = activeBotId;
  // Latest bot whose thread is being opened; a slower earlier open is dropped.
  const activeBotRequestRef = useRef<string | null>(null);
  // The transport and useChat callbacks are built once; they reach the latest
  // refreshBots through this.
  const refreshBotsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Live state from the events stream, by bot id. `ownTurnId` is the turn this
  // tab is streaming itself (from the chat route's X-Turn-Id): its presence
  // is shown by the live avatar, not as a background cloud, and its reply
  // needs no reload. Cleared when the user leaves the thread mid-reply, at
  // which point the turn is, to this tab, a background one.
  const [presence, setPresence] = useState<Record<string, BotPresence>>({});
  const [ownTurnId, setOwnTurnId] = useState<string | null>(null);
  const ownTurnIdRef = useRef<string | null>(null);
  ownTurnIdRef.current = ownTurnId;
  // A turn keeps running on the server when the user leaves its chat mid-
  // reply. Its question, by thread, so coming back shows it under the
  // thinking bubble. The server stores the question when the turn starts, so
  // the reload normally already has it; this covers the moment before that
  // row exists, and a store that failed.
  const leftTurnsRef = useRef(new Map<string, UIMessage>());
  // The thread on screen, so leaving it can tell which one was live.
  const shownChatIdRef = useRef<string | null>(null);
  // The user's latest pinned bots, and which pin change the server has caught
  // up with. A list read while a save was in flight (or that started before the
  // latest change) is re-pinned locally, so the strip never snaps back.
  const botOrderRef = useRef<{ ids: string[]; seq: number; settledSeq: number }>({
    ids: [],
    seq: 0,
    settledSeq: 0,
  });
  // The phase each bot shows: its running turn (not this tab's own). `busy`
  // on the bots the consumers see is this, not the DB lock, so a refresh
  // mid-turn and a crashed turn both read right. A bot waiting on another
  // bot's answer is not running a turn and shows nothing.
  const livePhase = useMemo<Record<string, BotPhase>>(() => {
    const out: Record<string, BotPhase> = {};
    for (const [botId, p] of Object.entries(presence)) if (p.turnId !== ownTurnId) out[botId] = p.phase;
    return out;
  }, [presence, ownTurnId]);
  const liveBots = useMemo(
    () => bots.map((b) => (b.busy === Boolean(livePhase[b.id]) ? b : { ...b, busy: Boolean(livePhase[b.id]) })),
    [bots, livePhase],
  );
  const activeBot = useMemo(
    () => liveBots.find((b) => b.id === activeBotId) ?? null,
    [liveBots, activeBotId],
  );

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
  const optimisticAttachmentsRef = useRef<Record<string, ChatAttachment[]>>({});
  optimisticAttachmentsRef.current = optimisticAttachments;

  /**
   * Drop every optimistic entry and revoke the object URLs it was holding.
   *
   * Each image attached to a sent message parks a `URL.createObjectURL` blob
   * in this map, and the browser keeps the whole File alive until it is
   * revoked. Nothing used to clear it, so every image sent in a session stayed
   * resident for the lifetime of the tab. The map only ever describes the
   * thread on screen, so leaving it (and the thread) is the moment to let go.
   */
  const clearOptimisticAttachments = useCallback(() => {
    const current = optimisticAttachmentsRef.current;
    if (Object.keys(current).length === 0) return;
    for (const list of Object.values(current)) {
      for (const a of list) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    }
    optimisticAttachmentsRef.current = {};
    setOptimisticAttachments({});
  }, []);

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
            // Every turn runs on the bot's permanent thread (server-resolved).
            ...(activeBotIdRef.current ? { bot_id: activeBotIdRef.current } : {}),
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
          const turnId = res.headers.get('X-Turn-Id');
          if (turnId) setOwnTurnId(turnId);
          // The bot's thread, which a send made before the thread finished
          // opening learns only from this header.
          const newId = res.headers.get('X-Chat-Id');
          if (newId && newId !== chatIdRef.current) {
            chatIdRef.current = newId;
            justMintedChatIdRef.current = newId;
            setChatIdState(newId);
            // The in-flight messages now belong to this thread. Move the stamp
            // with the id — the load effect skips its fetch for it, so nothing
            // else will set it.
            setMessagesChatId(newId);
          }
          return res;
        },
      }),
    [],
  );

  const chat = useChat({
    transport,
    // NOTE: `experimental_throttle` would coalesce stream chunks into far
    // fewer commits, but it is unsafe here as the code stands. The AI SDK
    // throttles only the messages subscription — `status` stays unthrottled —
    // so at the end of a turn `status` can flip to `ready` while `messages` is
    // still up to one throttle window behind. `NavigationActionHandler` gates
    // on `status`, and `resolveNavigationAction` *absorbs* a pending
    // `navigate_page` when the turn is not live, so a nav marker landing in
    // that last batch would be silently swallowed. Make navigation robust to a
    // lagging transcript before turning this on.
    onError: (e: Error) => {
      console.error(e);
      const { title, description } = parseChatError(e);
      toast.error(title, { description, duration: 8000 });
    },
    // The turn's own bot moved to the top of the list (newest activity) and
    // may have created or changed a bot: one re-read. Everything else — the
    // bots it @mentioned starting, their replies — arrives on the stream.
    onFinish: () => {
      void refreshBotsRef.current();
    },
  });

  const { setMessages } = chat;
  // Keep a ref to the latest chat handle so effects can call stop()/read
  // status without needing chat in their deps (which changes every render).
  const chatStateRef = useRef(chat);
  chatStateRef.current = chat;

  // Stable wrappers so `useChatActions()` consumers never re-subscribe. The
  // AI SDK rebuilds its handle every render; going through the ref means the
  // identity of these two never changes while the call still lands on the
  // current handle.
  // Every send through the wrapper is stamped with when it was sent (the
  // bubble's timestamp), unless the caller stamped it already.
  const sendMessage = useCallback<ChatHandle['sendMessage']>(
    (message, options) => chatStateRef.current.sendMessage(stampSent(message), options),
    [],
  );
  // Stop: the server turn outlives the request, so it is told to stop
  // explicitly; aborting the fetch alone only detaches this tab from it.
  const stopStream = useCallback<ChatHandle['stop']>((...args) => {
    const id = chatIdRef.current;
    if (id && isLive(chatStateRef.current.status)) {
      void stopChatTurn(id).catch((err: unknown) => console.error('[chat] failed to stop the turn:', err));
    }
    return chatStateRef.current.stop(...args);
  }, []);

  // When chatId changes (the user picked a bot), load that thread's history
  // from the server. Skip when we just learned this ID mid-stream from the
  // server's X-Chat-Id header — in that case the stream belongs to THIS
  // thread, so we don't want to abort or wipe it.
  //
    // On any other transition we abort this tab's stream (chat.stop()) so the
    // new bot's input is usable immediately; the server turn keeps running.
    // If the resumed chat's last persisted message is from the user (no
    // assistant reply yet), we poll briefly so a reply landing on the server
    // shows up automatically.
  useEffect(() => {
    if (authLoading || !user) return;

    // Leaving a thread mid-reply only detaches from its stream: the turn runs
    // on. Keep its question to show on return, and re-read the bots so its
    // thinking bubble shows.
    const leftId = shownChatIdRef.current;
    shownChatIdRef.current = chatId;
    if (leftId && leftId !== chatId && isLive(chatStateRef.current.status)) {
      const question = [...chatStateRef.current.messages].reverse().find((m) => m.role === 'user');
      if (question) leftTurnsRef.current.set(leftId, question);
      // Its presence now shows as a cloud, and its reply is merged into the
      // thread when the stream announces it.
      setOwnTurnId(null);
    }

    if (!chatId) {
      chatStateRef.current.stop();
      clearOptimisticAttachments();
      setMessages([]);
      setMessagesChatId(null);
      setHistoryCursor(null);
      setIsLoadingMessages(false);
      return;
    }
    if (justMintedChatIdRef.current === chatId) {
      justMintedChatIdRef.current = null;
      return;
    }
    chatStateRef.current.stop();
    clearOptimisticAttachments();

    setMessages([]);
    setHistoryCursor(null);
    // `undefined`, not `chatId`: these empty messages are not this chat's
    // history, they are a placeholder until the fetch below lands.
    setMessagesChatId(undefined);
    setIsLoadingMessages(true);

    let cancelled = false;

    const fetchMessages = async (): Promise<UIMessage[] | null> => {
      try {
        const data = await apiRequest<HistoryPage>(`/api/copilot/chats/${chatId}/messages`);
        if (!cancelled) setHistoryCursor(data.nextCursor ?? null);
        return (data.messages ?? []) as unknown as UIMessage[];
      } catch (err) {
        console.error('[chat] failed to load chat messages:', err);
        return null;
      }
    };

    (async () => {
      const initial = await fetchMessages();
      if (cancelled) return;
      // A turn left running: its question is stored only with the reply, so
      // show the kept one until the stored turn includes it.
      const left = leftTurnsRef.current.get(chatId);
      if (left && initial) {
        const lastUser = [...initial].reverse().find((m) => m.role === 'user');
        if (lastUser && messageText(lastUser) === messageText(left)) leftTurnsRef.current.delete(chatId);
      }
      const kept = leftTurnsRef.current.get(chatId);
      if (initial) setMessages(kept ? [...initial, kept] : initial);
      // Stamp the loaded history in the same batch as the messages it
      // describes, so consumers can tell "this chat's history" from "something
      // that just streamed in" without racing the two state updates.
      setMessagesChatId(chatId);
      setIsLoadingMessages(false);

      // A reply still running lands through the events stream (`reply`),
      // which lays the thread's latest page over this one (`mergeLatestHistory`);
      // nothing to poll for.
    })();

    return () => {
      cancelled = true;
    };
  }, [chatId, setMessages, authLoading, user, clearOptimisticAttachments]);

  const setChatId = useCallback(
    (id: string | null) => {
      chatIdRef.current = id;
      setChatIdState(id);
    },
    [],
  );

  /**
   * Prepend the page of history before the oldest message on screen. No-op at
   * the start of the thread or while a load is in flight; a response that
   * lands after the user switched bots is dropped.
   */
  const loadEarlierMessages = useCallback(async (): Promise<boolean> => {
    const id = chatIdRef.current;
    const before = historyCursorRef.current;
    if (!id || before === null || loadingEarlierRef.current) return false;
    loadingEarlierRef.current = true;
    setIsLoadingEarlier(true);
    try {
      const data = await apiRequest<HistoryPage>(
        `/api/copilot/chats/${id}/messages?before=${before}&turns=${EARLIER_PAGE_TURNS}`,
      );
      if (chatIdRef.current !== id) return false;
      const earlier = (data.messages ?? []) as unknown as UIMessage[];
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...earlier.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHistoryCursor(data.nextCursor ?? null);
      return true;
    } catch (err) {
      console.error('[chat] failed to load earlier messages:', err);
      toast.error("Couldn't load earlier messages");
      return false;
    } finally {
      loadingEarlierRef.current = false;
      setIsLoadingEarlier(false);
    }
  }, [setMessages]);

  /**
   * Lay the thread's latest page over the messages on screen: what is new is
   * appended, what is already shown keeps its object (and so its bubble), so
   * a message from another bot arrives without the transcript being rebuilt.
   * Skipped while the thread's history is still loading (that load reads the
   * same page) and dropped if the user switched bots or started a turn
   * meanwhile (the page would overwrite the stream). True when the page was
   * laid over the thread — only then is the thread marked seen.
   */
  const mergeLatestHistory = useCallback(async (): Promise<boolean> => {
    const id = chatIdRef.current;
    if (!id || messagesChatIdRef.current !== id) return false;
    try {
      const data = await apiRequest<HistoryPage>(`/api/copilot/chats/${id}/messages`);
      if (chatIdRef.current !== id || messagesChatIdRef.current !== id) return false;
      if (isLive(chatStateRef.current.status)) return false;
      const tail = (data.messages ?? []) as unknown as UIMessage[];
      // An empty thread takes the page's cursor too; otherwise the cursor for
      // the pages already loaded stands.
      const wasEmpty = chatStateRef.current.messages.length === 0;
      setMessages((prev) => mergeHistoryTail(prev, tail));
      if (wasEmpty) setHistoryCursor(data.nextCursor ?? null);
      return true;
    } catch (err) {
      console.error('[chat] failed to read the latest messages:', err);
      return false;
    }
  }, [setMessages]);

  // Bots the user marked unread by hand. The poll below clears the dot of the
  // active bot (its thread is on screen), but on the mobile home the active
  // bot is just the last one opened, so a hand-set dot must survive until the
  // user opens that bot again.
  const keptUnreadRef = useRef<Set<string>>(new Set());
  /** False on the mobile bot picker; true while that bot's chat is visible. */
  const activeBotThreadOnScreenRef = useRef(true);

  const setActiveBotThreadOnScreen = useCallback((onScreen: boolean) => {
    activeBotThreadOnScreenRef.current = onScreen;
  }, []);

  /** Clear a bot's unread dot: at once on screen, and on the server. */
  const markBotSeen = useCallback((id: string) => {
    setBots((prev) =>
      prev.some((b) => b.id === id && b.unread)
        ? prev.map((b) => (b.id === id ? { ...b, unread: false } : b))
        : prev,
    );
    void markBotRead(id).catch((err) => console.error('[chat] failed to mark the bot read:', err));
  }, []);

  /** Set a bot's unread dot by hand: at once on screen, then on the server. */
  const setBotUnread = useCallback(
    (id: string, unread: boolean) => {
      if (!unread) {
        keptUnreadRef.current.delete(id);
        markBotSeen(id);
        return;
      }
      keptUnreadRef.current.add(id);
      setBots((prev) => prev.map((b) => (b.id === id ? { ...b, unread: true } : b)));
      void markBotUnread(id).catch((err) => {
        console.error('[chat] failed to mark the bot unread:', err);
        keptUnreadRef.current.delete(id);
        setBots((prev) => prev.map((b) => (b.id === id ? { ...b, unread: false } : b)));
      });
    },
    [markBotSeen],
  );

  /**
   * Switch to a bot and open its permanent thread. The thread id comes back
   * from the server (created on first open); setting it runs the history load
   * effect above. A slower earlier open never overrides a newer pick.
   */
  const selectBot = useCallback(
    (id: string) => {
      const switching = activeBotIdRef.current !== id;
      // Opening the bot is reading it: a hand-set unread dot no longer holds.
      keptUnreadRef.current.delete(id);
      activeBotIdRef.current = id;
      setActiveBotId(id);
      storeBotId(id);
      activeBotRequestRef.current = id;
      // Leave the previous bot's thread immediately: waiting for the new
      // thread id would leave the old transcript visible under the new bot.
      // Going through `null` (whose load-effect branch stops the stream and
      // clears the transcript) also guarantees the effect re-runs when the id
      // arrives, even if it equals the thread we were on before a quick
      // A → B → A switch.
      if (switching) setChatId(null);
      void (async () => {
        try {
          const { chatId: threadId } = await openBotThread(id);
          if (activeBotRequestRef.current !== id) return;
          setChatId(threadId);
          // Opening the thread loads all of it: nothing in it is unread now.
          markBotSeen(id);
        } catch (err) {
          if (activeBotRequestRef.current !== id) return;
          console.error('[chat] failed to open bot thread:', err);
          toast.error("Couldn't open this bot's chat");
        }
      })();
    },
    [setChatId, markBotSeen],
  );

  /**
   * Load the visible bots. On first load, opens the remembered bot, or the
   * workspace default (the server creates it if the workspace has none).
   */
  /**
   * Take a freshly read bot list (a fetch, or the events stream's snapshot)
   * as the current one, and open the thread a background reply landed in.
   * `pinSeqAtStart` is the pin change the read started under, so a list
   * read while a pin save was in flight is re-pinned locally.
   */
  const applyBotList = useCallback((read: BotDto[], pinSeqAtStart: number, settledAtStart: boolean) => {
    const list = mergeKeptUnread(read, keptUnreadRef.current);
    const stale = !settledAtStart || botOrderRef.current.seq !== pinSeqAtStart;
    setBots(stale ? applyPins(list, botOrderRef.current.ids) : list);
    if (list.length === 0) {
      activeBotIdRef.current = null;
      setActiveBotId(null);
      return;
    }
    const current = activeBotIdRef.current;
    const active = current ? list.find((b) => b.id === current) : undefined;
    if (active) {
      // A background reply landed in the thread on screen (another bot
      // messaged this one, or a turn the user left and came back to): lay it
      // over the thread and clear the dot (once it is on screen: a merge that
      // could not apply leaves the dot for the next read). Not while a turn
      // is live — the page would overwrite it.
      if (
        activeBotThreadOnScreenRef.current &&
        !isLive(chatStateRef.current.status) &&
        active.unread &&
        !keptUnreadRef.current.has(active.id)
      ) {
        if (chatIdRef.current) leftTurnsRef.current.delete(chatIdRef.current);
        void mergeLatestHistory().then((merged) => {
          if (merged) markBotSeen(active.id);
        });
      }
      return;
    }
    const stored = readStoredBotId();
    const pick =
      list.find((b) => b.id === stored) ?? list.find((b) => b.is_default) ?? list[0];
    selectBot(pick.id);
  }, [selectBot, markBotSeen, mergeLatestHistory]);

  /** Re-read the visible bots (after a save, on a `bots-changed` event, on return to the tab). */
  const refreshBots = useCallback(async () => {
    const order = botOrderRef.current;
    const seqAtStart = order.seq;
    const settledAtStart = order.settledSeq === order.seq;
    let list: BotDto[];
    try {
      list = await listBots();
    } catch (err) {
      console.error('[chat] failed to load bots:', err);
      return;
    }
    applyBotList(list, seqAtStart, settledAtStart);
  }, [applyBotList]);
  refreshBotsRef.current = refreshBots;

  /** Re-pin and re-sort at once on screen, then save; a failed save reloads the server's order. */
  const setPinnedBots = useCallback((ids: string[]) => {
    const order = botOrderRef.current;
    const seq = order.seq + 1;
    botOrderRef.current = { ...order, ids, seq };
    setBots((prev) => applyPins(prev, ids));
    const settle = () => {
      if (botOrderRef.current.seq === seq) botOrderRef.current.settledSeq = seq;
    };
    void savePinnedBots(ids).then(settle, (err) => {
      console.error('[chat] failed to save the pinned bots:', err);
      toast.error("Couldn't save the pinned bots");
      settle();
      if (botOrderRef.current.seq === seq) void refreshBotsRef.current();
    });
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    void refreshBots();
  }, [authLoading, user, refreshBots]);

  // The live state, pushed. The snapshot on (re)connect is authoritative —
  // it is the bot list plus every live key — so a reconnect heals whatever an
  // outage missed; the events in between are the fast path.
  const onLiveEvent = useCallback(
    (event: BotLiveEvent) => {
      switch (event.type) {
        case 'snapshot': {
          const order = botOrderRef.current;
          applyBotList(event.bots, order.seq, order.settledSeq === order.seq);
          setPresence(Object.fromEntries(event.presence.map((p) => [p.botId, p])));
          return;
        }
        case 'presence':
          setPresence((prev) => {
            if (event.phase === null) {
              if (!(event.botId in prev)) return prev;
              const { [event.botId]: _gone, ...rest } = prev;
              return rest;
            }
            return {
              ...prev,
              [event.botId]: {
                chatId: event.chatId,
                botId: event.botId,
                userId: user?.id ?? '',
                phase: event.phase,
                since: prev[event.botId]?.since ?? new Date().toISOString(),
                turnId: event.turnId,
              },
            };
          });
          return;
        case 'reply': {
          // This tab streamed its own turn's reply; only another turn's is
          // news. For the thread on screen the thread's latest page is laid
          // over it right here — only the new messages are added, nothing
          // already shown is rebuilt — so another bot's message appears
          // without a refresh or a blip, and without depending on the list's
          // unread flag; not while a turn streams (the page would overwrite
          // it). Any other thread gets its dot from the list read.
          if (event.turnId === ownTurnIdRef.current) return;
          leftTurnsRef.current.delete(event.chatId);
          const chatStatus = chatStateRef.current.status;
          if (
            event.chatId === chatIdRef.current &&
            activeBotThreadOnScreenRef.current &&
            (chatStatus === 'ready' || chatStatus === 'error')
          ) {
            // Marked seen only once the message is on screen; a merge that
            // could not apply (the history still loading, a turn started
            // meanwhile) leaves it to the list read, which shows the dot or
            // merges once the thread is ready.
            void mergeLatestHistory().then((merged) => {
              if (merged) markBotSeen(event.botId);
              else void refreshBotsRef.current();
            });
            return;
          }
          void refreshBotsRef.current();
          return;
        }
        case 'bots-changed':
          void refreshBotsRef.current();
          return;
      }
    },
    [applyBotList, markBotSeen, mergeLatestHistory, user?.id],
  );
  useEventStream<BotLiveEvent>(!authLoading && user ? BOT_EVENTS_URL : null, onLiveEvent);

  // Mobile Safari suspends EventSource in the background: one re-read on
  // return covers what the stream missed, until it reconnects with a snapshot.
  useEffect(() => {
    if (authLoading || !user) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshBots();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [authLoading, user, refreshBots]);

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
      metadata: sentNow(),
    });
    resetComposerAttachments();
  }, [resetComposerAttachments]);

  const sendText = useCallback(
    (text: string, insightTemplate?: InsightTemplateAttachment) => {
      sendWithAttachments(text, insightTemplate);
    },
    [sendWithAttachments],
  );

  // Put the caret in the composer with the cursor at the end of whatever is
  // already there.
  //
  // Callers fire this in the same tick as the state change that reveals the
  // composer (switching bots, landing on the chat route), at which point the
  // textarea may not be mounted yet — the transcript mounts its composer with
  // the thread, and the copilot pane animates open. So retry across a
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
      } else {
        sendWithAttachments(text, undefined, options?.insightSelection);
      }
    },
    [sendWithAttachments],
  );

  const confirmPendingAnalysis = useCallback(async () => {
    const pending = pendingAnalysis;
    setPendingAnalysis(null);
    if (pending == null) return;
    const { text, options } = pending;

    // Fully stop the in-flight run BEFORE starting the new turn. stopStream()
    // tells the server turn to stop and aborts the fetch; we then wait for
    // useChat's status to settle out of streaming/submitted and for the server
    // turn to let go of the thread — otherwise the new send races the dying
    // run (the cascade of duplicate thinking/tool blocks) or is refused.
    const stoppingId = chatIdRef.current;
    const wasLive = isLive(chatStateRef.current.status);
    try {
      await stopStream();
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

    // The server turn holds the thread until it has stored what it did; a
    // Stop on a running turn reports `stopped: true` until then.
    const released =
      !wasLive || !stoppingId
        ? true
        : await (async () => {
            for (let i = 0; i < TURN_STOP_POLL_ATTEMPTS; i++) {
              await new Promise((r) => setTimeout(r, TURN_STOP_POLL_MS));
              try {
                if (!(await stopChatTurn(stoppingId)).stopped) return true;
              } catch {
                return true; // let the send report whatever is wrong
              }
            }
            return false;
          })();

    if (!settled || !released) {
      toast.error("Couldn't stop the current response", {
        description: "Please try again in a moment.",
      });
      return;
    }

    const insightSelection = options?.insightSelection;
    chatStateRef.current.sendMessage(
      insightSelection
        ? { parts: [{ type: "text", text }, insightSelectionPart(insightSelection)], metadata: sentNow() }
        : { text, metadata: sentNow() },
    );
  }, [pendingAnalysis, stopStream]);

  // Release every outstanding preview blob if the provider ever unmounts
  // (sign-out, hard route change). Written as an explicit cleanup body rather
  // than returning the callback directly, which reads too easily as "call this
  // on mount".
  useEffect(() => {
    return () => {
      clearOptimisticAttachments();
    };
  }, [clearOptimisticAttachments]);

  /* ── Narrow context values ───────────────────────────────────────────────
   * Each of these is deliberately split out of `value` below so that the
   * common case — a view that wants `analyzeWithAI` and nothing else — does
   * not re-render on every streamed token. See the contexts' doc comment.
   * ──────────────────────────────────────────────────────────────────────── */

  // Every entry is stable, so this object is created once and never again.
  const actions = useMemo<ChatActions>(
    () => ({
      analyzeWithAI,
      prefillComposer,
      sendText,
      focusComposer,
      addFiles,
      removeAttachment,
      setEffortChoice,
      setInsightTemplate,
      chatInputRef,
      sendMessage,
      stop: stopStream,
      selectBot,
      refreshBots,
      setPinnedBots,
      setBotUnread,
      setActiveBotThreadOnScreen,
      loadEarlierMessages,
    }),
    [
      selectBot,
      refreshBots,
      setPinnedBots,
      setBotUnread,
      setActiveBotThreadOnScreen,
      loadEarlierMessages,
      analyzeWithAI,
      prefillComposer,
      sendText,
      focusComposer,
      addFiles,
      removeAttachment,
      sendMessage,
      stopStream,
    ],
  );

  const thread = useMemo<ChatThreadState>(
    () => ({
      chatId,
      isLoadingMessages,
      hasEarlierMessages: historyCursor !== null,
      isLoadingEarlier,
      messagesChatId,
      bots: liveBots,
      activeBot,
      livePhase,
    }),
    [liveBots, activeBot, livePhase, chatId, isLoadingMessages, historyCursor, isLoadingEarlier, messagesChatId],
  );

  const composer = useMemo<ChatComposerState>(
    () => ({
      attachments,
      effortChoice,
      insightTemplate,
      composerDraft,
      optimisticAttachments,
    }),
    [attachments, effortChoice, insightTemplate, composerDraft, optimisticAttachments],
  );

  const statusValue = useMemo<ChatStatusState>(() => ({ status: chat.status }), [chat.status]);

  const value = useMemo<ChatContextValue>(
    () => ({
      ...chat,
      stop: stopStream,
      chatId,
      isLoadingMessages,
      messagesChatId,
      analyzeWithAI,
      prefillComposer,
      composerDraft,
      sendText,
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
      bots: liveBots,
      activeBot,
      selectBot,
      refreshBots,
      setPinnedBots,
      setBotUnread,
      setActiveBotThreadOnScreen,
      hasEarlierMessages: historyCursor !== null,
      isLoadingEarlier,
      loadEarlierMessages,
    }),
    [
      liveBots,
      activeBot,
      selectBot,
      refreshBots,
      setPinnedBots,
      setBotUnread,
      setActiveBotThreadOnScreen,
      historyCursor,
      isLoadingEarlier,
      loadEarlierMessages,
      chat,
      stopStream,
      chatId,
      isLoadingMessages,
      messagesChatId,
      analyzeWithAI,
      prefillComposer,
      composerDraft,
      sendText,
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
    <ChatActionsContext.Provider value={actions}>
    <ChatThreadContext.Provider value={thread}>
    <ChatComposerContext.Provider value={composer}>
    <ChatStatusContext.Provider value={statusValue}>
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
    </ChatStatusContext.Provider>
    </ChatComposerContext.Provider>
    </ChatThreadContext.Provider>
    </ChatActionsContext.Provider>
  );
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within ChatProvider");
  }
  return ctx;
}
