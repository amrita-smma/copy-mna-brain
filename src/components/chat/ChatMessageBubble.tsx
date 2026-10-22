import { type UIMessage } from "@ai-sdk/react";
import { formatMessageTime, messageCreatedAt } from '@/lib/chat/messageTime';
import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Wrench, Loader2, FileText, Sparkles, FileSearch, Brain, AlertTriangle, CalendarClock } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import FilePreview from "@/components/Files/FilePreview";
import { toast } from "sonner";
import {
  WorkforceHandoffCard,
  type WorkforceHandoffPayload,
} from "./WorkforceHandoffCard";
import {
  BulkDropCompaniesCard,
  type BulkDropApprovalPayload,
} from "./BulkDropCompaniesCard";
import {
  BulkPromoteCompaniesCard,
  type BulkPromoteApprovalPayload,
} from "./BulkPromoteCompaniesCard";
import {
  InsightEditApprovalCard,
} from "./InsightEditApprovalCard";
import {
  InsightCreateApprovalCard,
} from "./InsightCreateApprovalCard";
import { InsightRefreshApprovalCard } from "./InsightRefreshApprovalCard";
import {
  ReportPlanCard,
} from "./ReportPlanCard";
import { BotChangeApprovalCard } from "./BotChangeApprovalCard";
import { BotRoutineApprovalCard } from "./BotRoutineApprovalCard";
import { OptionCard } from "./OptionCard";
import { OPTION_CARD_MARKER, isOptionCardPayload, type OptionCardPayload } from "@/lib/chat/optionCards";
import { STALE_SOURCE_MONTHS, isStaleSource, readPublishedDate } from "@/lib/chat/citations";
import { BotMessageCard } from "./BotMessageCard";
import {
  BOT_CHANGE_APPROVAL_MARKER,
  BOT_MESSAGE_MARKER,
  isBotChangeApprovalPayload,
  isBotMessagePayload,
  isBotRoutineApprovalPayload,
  BOT_ROUTINE_APPROVAL_MARKER,
  type BotRoutineApprovalPayload,
  type BotChangeApprovalPayload,
  type BotMessagePayload,
} from "@/lib/bots/approval";
import { AttachedInsightTemplateCard } from "./AttachedInsightTemplateCard";
import { readInsightTemplatePart } from "@/lib/insights/templateAttachment";
import { AttachedInsightSelectionCard } from "./AttachedInsightSelectionCard";
import { readInsightSelectionPart } from "@/lib/insights/selectionAttachment";
import type {
  InsightCreateApprovalPayload,
  InsightEditApprovalPayload,
  InsightRefreshApprovalPayload,
} from "@/lib/insights/types";
import type { ReportPlanApprovalPayload } from "@/lib/reports/plan";
import { useChatActions, useChatComposer, useChatThread } from "./ChatProvider";
import { MentionPings } from "./MentionPings";
import type { FromBot, FromRoutine } from "@/lib/chat/uiMessages";
import { CompanyChip } from "./CompanyChip";
import { ChipOverflow } from "./ChipOverflow";
import { stripNavigateMarkers } from "@/lib/navigation/navigateAction";
import { BotAvatar } from "@/components/bots/BotAvatar";
import { ThinkingBubble } from "@/components/bots/ThoughtCloud";
import type { AvatarState } from "@/lib/bots/avatarState";
import type { BotAvatarConfig } from "@/lib/bots/types";
import {
  parseCompanyMentions,
  selectMentionedCompanies,
  stripCompanyMentionMarkers,
  type CompanyMention,
} from "@/lib/navigation/companyMentions";
import {
  INSIGHT_CREATE_APPROVAL_MARKER,
  INSIGHT_EDIT_APPROVAL_MARKER,
  INSIGHT_REFRESH_APPROVAL_MARKER,
  REPORT_PLAN_APPROVAL_MARKER,
  extractApprovalPayload,
  resolveApprovalPayload,
  stripApprovalMarkers,
} from "@/lib/insights/approvalMarker";


const WORKFORCE_HANDOFF_MARKER = "WORKFORCE_HANDOFF_JSON";
const WORKFORCE_HANDOFF_TOOL_NAME = "propose_workforce_handoff";
const BULK_DROP_APPROVAL_MARKER = "BULK_DROP_APPROVAL_JSON";
const BULK_DROP_APPROVAL_TOOL_NAME = "propose_bulk_drop_companies";
const BULK_PROMOTE_APPROVAL_MARKER = "BULK_PROMOTE_APPROVAL_JSON";
const BULK_PROMOTE_APPROVAL_TOOL_NAME = "propose_bulk_promote_companies";
// Marker the chat UI (ChatMessageBubble) scans for to detect an insight edit
// approval card in this tool's output and render the card. Keep in sync with
// propose_insight_edit.ts.
const INSIGHT_EDIT_TOOL_NAME = "propose_insight_edit";
// Same contract for a brand-new insight. Keep in sync with
// propose_insight_create.ts.
const INSIGHT_CREATE_TOOL_NAME = "propose_insight_create";
const REPORT_PLAN_TOOL_NAME = "propose_report_plan";
// The "Refresh this insight now" card (MB-552). Keep in sync with
// propose_insight_refresh.ts. Carries no document, so — like the report plan —
// its payload is used as-is rather than joined with the tool call's html.
const INSIGHT_REFRESH_TOOL_NAME = "propose_insight_refresh";
// Bot tools (RFC 02). Their payloads carry no document either. Keep in sync
// with propose_create_bot.ts, update_bot.ts and message_bot.ts.
const PROPOSE_CREATE_BOT_TOOL_NAME = "propose_create_bot";
const UPDATE_BOT_TOOL_NAME = "update_bot";
// The name update_bot had before it also kept the user's notes; stored
// history still carries its cards.
const LEGACY_PROPOSE_UPDATE_BOT_TOOL_NAME = "propose_update_bot";
const MESSAGE_BOT_TOOL_NAME = "message_bot";
const PROPOSE_CREATE_ROUTINE_TOOL_NAME = "propose_create_routine";
// Option cards (offer_options): clickable choices; see src/lib/chat/optionCards.ts.
const OFFER_OPTIONS_TOOL_NAME = "offer_options";
const PAYLOAD_ONLY_APPROVAL_TOOLS = new Set([
  REPORT_PLAN_TOOL_NAME,
  INSIGHT_REFRESH_TOOL_NAME,
  PROPOSE_CREATE_BOT_TOOL_NAME,
  UPDATE_BOT_TOOL_NAME,
  LEGACY_PROPOSE_UPDATE_BOT_TOOL_NAME,
  MESSAGE_BOT_TOOL_NAME,
  PROPOSE_CREATE_ROUTINE_TOOL_NAME,
  OFFER_OPTIONS_TOOL_NAME,
]);

// Delimiters: legacy thinking is between THINKING_START and THINKING_END; response is after THINKING_END.
const THINKING_START_DELIMITER = "<!-- THINKING_START -->";
const THINKING_END_DELIMITER = "<!-- THINKING_END -->";
const WARNING_START_DELIMITER = "<!-- WARNING_START -->";
const WARNING_END_DELIMITER = "<!-- WARNING_END -->";

// Hoisted out of the render path: `new RegExp(...)` compiles a fresh pattern
// every call, and these used to be rebuilt once per tool part per render.
const CITATIONS_JSON_RE = /<!-- CITATIONS_JSON:(.*?) -->/;
const FILES_JSON_RE = /<!-- FILES_JSON:(.*?) -->/;
const WORKFORCE_HANDOFF_RE = new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, "s");
const BULK_DROP_APPROVAL_RE = new RegExp(`<!--\\s*${BULK_DROP_APPROVAL_MARKER}:(.*?)-->`, "s");
const BULK_PROMOTE_APPROVAL_RE = new RegExp(`<!--\\s*${BULK_PROMOTE_APPROVAL_MARKER}:(.*?)-->`, "s");

// Global variants, for stripping every occurrence out of a tool trace.
const CITATIONS_JSON_STRIP_RE = /\n*<!-- CITATIONS_JSON:.*? -->/g;
const FILES_JSON_STRIP_RE = /\n*<!-- FILES_JSON:.*? -->/g;
const WORKFORCE_HANDOFF_STRIP_RE = new RegExp(`\\n*<!--\\s*${WORKFORCE_HANDOFF_MARKER}:.*?-->`, "gs");
const BULK_DROP_APPROVAL_STRIP_RE = new RegExp(`\\n*<!--\\s*${BULK_DROP_APPROVAL_MARKER}:.*?-->`, "gs");
const BULK_PROMOTE_APPROVAL_STRIP_RE = new RegExp(`\\n*<!--\\s*${BULK_PROMOTE_APPROVAL_MARKER}:.*?-->`, "gs");

/** Stable empty array so a part-less message doesn't bust the parse memo. */
const EMPTY_PARTS: UIMessage["parts"] = [];

/** A file surfaced by `query_files`, as the tool serialises it. */
interface MeetingNoteRef {
  id: string;
  file_name: string;
  file_link: string;
  file_date: string | null;
  tags: string[];
  structured_notes: string | null;
  matched_companies: any[];
}

/** The text a tool part carries, whatever shape the SDK wrapped it in. */
function toolOutputText(part: unknown): string {
  const output = (part as any).output;
  if (output?.kwargs?.content) return output.kwargs.content as string;
  if (typeof output === "string") return output;
  return "";
}

interface ChatMessageBubbleProps {
  message: UIMessage;
  aiEmoji?: string;
  sources?: any[];
  className?: string;
  /** True only when this is the last message and the chat is actively streaming it. */
  isActive?: boolean;
  /** The active bot's look (RFC 02); when set, a tiny avatar sits beside assistant turns. */
  botAvatar?: BotAvatarConfig;
  /** The active bot's name, for the "Deal Scout is thinking…" bubble. */
  botName?: string;
  avatarState?: AvatarState;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 text-muted-foreground py-2">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="text-sm">Thinking</span>
      <span className="flex gap-0.5">
        <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
        <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
      </span>
    </div>
  );
}

/** Shown while send_email is building a PPTX — generation commonly takes several minutes. */
function PptxGeneratingNotice() {
  return (
    <div
      role="status"
      data-testid="pptx-generating-notice"
      className="flex items-start gap-3 w-full rounded-xl border border-border bg-muted/40 px-4 py-3 text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 flex-shrink-0 mt-0.5 animate-spin" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <span className="font-medium text-foreground">Generating PowerPoint… </span>
        This can take several minutes. Keep this chat open — switching chats
        cancels generation. The deck will be emailed when ready.
      </div>
    </div>
  );
}

function isRunningPptxSendEmail(part: {
  type?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  args?: unknown;
}): boolean {
  if (part.toolName !== "send_email") return false;
  if (part.state === "output-available") return false;
  const input = (part.input ?? part.args) as { presentation?: unknown } | undefined;
  return Boolean(input && typeof input === "object" && input.presentation);
}

/**
 * Where the reply will land, before its first token: the bot's avatar with a
 * thought cloud. `label` overrides the state's own wording (a background
 * reply to another bot).
 */
export function LoadingBubble({
  botAvatar,
  botName,
  state = 'thinking',
  label,
}: {
  botAvatar?: BotAvatarConfig;
  botName?: string;
  state?: AvatarState;
  label?: string;
} = {}) {
  if (!botAvatar) {
    return (
      <div className="flex mb-3">
        <div className="flex-1 min-w-0 flex flex-col items-start px-5">
          <ThinkingIndicator />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-3">
      <ThinkingBubble avatar={botAvatar} name={botName} state={state} label={label} />
    </div>
  );
}

/**
 * How much of a tool's raw output the trace shows before offering "show full
 * output". A single `query_companies` call can return tens of kilobytes; the
 * trace is a debugging aid, not content, so it is capped by default.
 */
const TOOL_TRACE_PREVIEW_CHARS = 1200;

/**
 * One tool's input/output inside the expandable tool chain.
 *
 * Rendered as preformatted text rather than through `MarkdownRenderer`: a tool
 * trace is raw output, not prose, so a full remark/rehype parse per tool was
 * both the wrong presentation and the single most expensive thing the copilot
 * did — a ten-tool turn meant ten markdown parses, re-run on every render of
 * the bubble. Memoized so expanding the chain costs one pass per tool.
 */
const ToolTrace = memo(function ToolTrace({ part }: { part: unknown }) {
  const [showFull, setShowFull] = useState(false);
  const toolName = (part as any).toolName || "Tool";
  const state = (part as any).state as string | undefined;

  const { text, truncated } = useMemo(() => {
    const output = (part as any).output;
    let content: string;
    if (output?.kwargs?.content) {
      content = output.kwargs.content;
    } else if (typeof output === "string") {
      content = output;
    } else if (output) {
      content = JSON.stringify(output, null, 2);
    } else {
      content = "";
    }

    // Strip the hidden metadata the UI consumes elsewhere (citations, files,
    // approval payloads, navigation and company-mention manifests).
    content = content
      .replace(CITATIONS_JSON_STRIP_RE, "")
      .replace(FILES_JSON_STRIP_RE, "")
      .replace(WORKFORCE_HANDOFF_STRIP_RE, "")
      .replace(BULK_DROP_APPROVAL_STRIP_RE, "")
      .replace(BULK_PROMOTE_APPROVAL_STRIP_RE, "");
    content = stripApprovalMarkers(content);
    content = stripNavigateMarkers(content);
    content = stripCompanyMentionMarkers(content);

    // Measure the trimmed text, which is what actually gets sliced — stripping
    // a large hidden JSON manifest can drop a long raw output under the cap,
    // and measuring before the strip would offer "show full output" with
    // nothing further to show.
    const trimmed = content.trim();
    return { text: trimmed, truncated: trimmed.length > TOOL_TRACE_PREVIEW_CHARS };
  }, [part]);

  const visible = showFull || !truncated ? text : text.slice(0, TOOL_TRACE_PREVIEW_CHARS);

  return (
    <div className="border-b border-border/50 pb-2 last:border-0 last:pb-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-foreground">{toolName}</span>
        {state && (
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded",
              state === "output-available"
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : state === "running"
                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {state === "output-available" ? "completed" : state}
          </span>
        )}
      </div>
      {visible && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {visible}
        </pre>
      )}
      {truncated && (
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          className="mt-1 text-[11px] font-medium text-primary hover:underline"
        >
          {showFull
            ? "Show less"
            : `Show full output (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
});

function ChatMessageBubbleImpl(props: ChatMessageBubbleProps) {
  // Hookless dispatcher. User and assistant bubbles call a different number of
  // hooks, so they MUST be distinct component types. If a single component
  // served both roles via an early `return` (as this did previously), a fiber
  // whose message flips role across renders — which happens when the message
  // list is swapped during the post-login re-render / streaming — would change
  // its own hook count and throw "Rendered more hooks than during the previous
  // render". Branching on component type makes React remount the correct
  // subcomponent instead, keeping each one's hook count constant.
  if (props.message.role === "user") {
    return <UserMessageBubble message={props.message} />;
  }
  return <AssistantMessageBubble {...props} />;
}

/** The sending bot's avatar on a bot-to-bot message; a generic tile if it is gone. */
/** When the message was written, under the bubble — bottom right of the user's, bottom left of a bot's; nothing when unknown. */
function MessageTime({ message, className }: { message: { metadata?: unknown }; className?: string }) {
  const date = messageCreatedAt(message);
  if (!date) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      data-testid="message-time"
      className={cn('text-[10px] tabular-nums leading-none text-muted-foreground', className)}
    >
      {formatMessageTime(date)}
    </time>
  );
}

function FromBotAvatar({ botId }: { botId: string }) {
  const { bots } = useChatThread();
  const sender = bots.find((b) => b.id === botId);
  return <BotAvatar avatar={sender?.avatar} size="xs" trackCursor={false} />;
}

function UserMessageBubble({ message }: { message: UIMessage }) {
  const parts = message?.parts || [];
  let textContent = parts
    .filter((part) => part.type === "text")
    .map((part) => (part as any).text)
    .join("");

  const fileAttachments: string[] = [];
  
  // Extract the injected attachment markers from the UI text
  textContent = textContent.replace(/\n*📎 Attached: (.*)$/gm, (match, fileName) => {
    if (fileName) fileAttachments.push(fileName.trim());
    return '';
  });
  
  // Extract the hidden tracking ID for optimistic lookups
  let trackingId: string | null = null;
  textContent = textContent.replace(/\n*<!-- attach_id: (.*?) -->/g, (match, id) => {
    trackingId = id;
    return '';
  }).trim();

  // Narrow context: the optimistic map only changes when a message with
  // attachments is sent, so this bubble does not re-render while a reply
  // streams in.
  const { optimisticAttachments } = useChatComposer();
  
  // Combine optimistic attachments (active session) with server-loaded attachments (history)
  const activeAttachments = optimisticAttachments?.[trackingId || message.id] || [];
  const historyImageAttachments = (message as any).experimental_attachments || [];
  
  const hasImages = activeAttachments.some(a => a.previewUrl) || historyImageAttachments.length > 0;
  // Deduplicate file names just in case active and history overlap (which they shouldn't since active clears on reload)
  const uniqueFilePills = Array.from(new Set([
    ...fileAttachments,
    ...activeAttachments.filter(a => !a.previewUrl).map(a => a.fileName)
  ])).filter(fileName => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return !['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '');
  });
  
  const attachedTemplate = readInsightTemplatePart(parts);
  const attachedSelection = readInsightSelectionPart(parts);

  const hasAttachments =
    hasImages ||
    uniqueFilePills.length > 0 ||
    attachedTemplate !== null ||
    attachedSelection !== null;

  // How the message reached this bot when the user did not type it here: an
  // @mention from another bot's reply, the user's own @mention in another
  // bot's chat, or a routine.
  const metadata = (message as { metadata?: { fromBot?: FromBot; fromRoutine?: FromRoutine } }).metadata;
  const userMention = metadata?.fromBot?.kind === 'user_mention' ? metadata.fromBot : undefined;
  const fromBot = metadata?.fromBot && !userMention ? metadata.fromBot : undefined;
  const fromRoutine = metadata?.fromRoutine;

  // Another bot's words (its reply back, or its hand-off to this bot) are a
  // bot's message, so they read like one: the sender's avatar on the left,
  // flat text on the page, no user bubble.
  if (fromBot) {
    return (
      <div className="flex mb-3 min-w-0 gap-2" data-testid="bot-relay-message">
        <div className="mt-1 shrink-0">
          <FromBotAvatar botId={fromBot.id} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col items-start gap-1 px-0 md:px-2">
          <span className="text-[11px] font-medium text-muted-foreground" data-testid="from-bot-label">
            {fromBot.kind === 'bot_reply' ? `Reply from ${fromBot.name}` : `${fromBot.name} mentioned this bot`}
          </span>
          {textContent && (
            <div className="w-full min-w-0 overflow-auto break-words text-sm">
              <MarkdownRenderer content={textContent} linkSurface="copilot" />
            </div>
          )}
          {textContent.includes('@') && <MentionPings text={textContent} fromUser />}
          <MessageTime message={message} className="self-start" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex mb-3 flex-row-reverse min-w-0">
      {/* The column hugs its text — a short message is a short bubble on the
          right — and caps at the same width a long one always had. */}
      <div className="min-w-0 max-w-full md:max-w-[80%] flex flex-col items-end gap-1.5">
        {userMention && (
          <span className="text-xs font-medium text-muted-foreground" data-testid="from-bot-label">
            You mentioned this bot in your chat with {userMention.name}
          </span>
        )}
        {fromRoutine && (
          <span
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground"
            data-testid="from-routine-label"
          >
            <CalendarClock className="h-3 w-3" />
            Routine · {fromRoutine.title}
          </span>
        )}
        {hasAttachments && (
          <div className="flex flex-wrap justify-end gap-2 mb-1">
            {attachedTemplate && <AttachedInsightTemplateCard template={attachedTemplate} />}
            {attachedSelection && <AttachedInsightSelectionCard selection={attachedSelection} />}

            {/* Document Pills */}
            {uniqueFilePills.map((fileName, i) => (
              <div 
                key={`file-${i}`} 
                className="flex items-center gap-2 px-3 py-2 h-10 rounded-lg border bg-muted/60 text-sm text-foreground shadow-sm"
                // TODO: Implement redownload file to local system when clicked
              >
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="truncate max-w-[150px] font-medium">{fileName}</span>
              </div>
            ))}
            
            {/* Image Thumbnails */}
            {activeAttachments.map((a) => (
              a.previewUrl && (
                <div 
                  key={a.localId} 
                  className="h-24 w-24 sm:h-32 sm:w-32 rounded-lg border shadow-sm overflow-hidden bg-muted"
                  // TODO: Implement redownload file to local system when clicked
                >
                  <img src={a.previewUrl} alt={a.fileName} className="h-full w-full object-cover" />
                </div>
              )
            ))}
            {historyImageAttachments.map((a, i) => (
              a.url && (
                <div 
                  key={`hist-${i}`} 
                  className="h-24 w-24 sm:h-32 sm:w-32 rounded-lg border shadow-sm overflow-hidden bg-muted"
                  // TODO: Implement redownload file to local system when clicked
                >
                  <img src={a.url} alt="Attached image" className="h-full w-full object-cover" />
                </div>
              )
            ))}
          </div>
        )}
        
        {textContent && (
          <div className="rounded-2xl px-4 py-2.5 max-w-full min-w-0 overflow-auto break-words bg-primary text-primary-foreground text-sm">
            <MarkdownRenderer
              content={textContent}
              linkSurface="copilot"
              className="prose-invert [&_*]:text-primary-foreground"
            />
          </div>
        )}
        {textContent.includes('@') && <MentionPings text={textContent} fromUser className="justify-end" />}
        <MessageTime message={message} />
      </div>
    </div>
  );
}

/**
 * Everything `AssistantMessageBubble` scrapes out of one assistant turn.
 *
 * Deliberately a pure function of `parts` so the bubble can wrap it in a
 * single `useMemo`. It walks the full text character by character looking for
 * delimiters and runs a JSON.parse per approval marker per tool — cheap once,
 * ruinous when a 40-message thread re-runs it on every streamed token (which
 * is what happened before the chat context was split).
 */
export interface ParsedAssistantTurn {
  toolParts: unknown[];
  hasTextContent: boolean;
  hasReasoningContent: boolean;
  isStreamingComplete: boolean;
  hasRunningTools: boolean;
  isPptxRunning: boolean;
  thinkingText: string;
  responseText: string;
  warnings: string[];
  allCitations: { title: string; url: string; published?: string }[];
  allMeetingNotes: MeetingNoteRef[];
  mentionedCompanies: CompanyMention[];
  workforceHandoff: WorkforceHandoffPayload | null;
  bulkDropApproval: BulkDropApprovalPayload | null;
  bulkPromoteApproval: BulkPromoteApprovalPayload | null;
  insightEditApproval: InsightEditApprovalPayload | null;
  insightCreateApproval: InsightCreateApprovalPayload | null;
  reportPlanApproval: ReportPlanApprovalPayload | null;
  insightRefreshApproval: InsightRefreshApprovalPayload | null;
  botChangeApprovals: BotChangeApprovalPayload[];
  botRoutineApprovals: BotRoutineApprovalPayload[];
  optionCards: OptionCardPayload[];
  botMessages: BotMessagePayload[];
}

export function parseAssistantTurn(parts: UIMessage["parts"]): ParsedAssistantTurn {
  const hasTextContent = parts.some(
    (part) => part.type === "text" && (part as any).text?.trim()
  );

  const hasReasoningContent = parts.some(
    (part) => part.type === "reasoning" && Boolean((part as any).text?.trim() || (part as any).reasoning?.trim())
  );

  // A streaming part carries `state: "streaming"` until the SDK marks it
  // "done". A part loaded from stored history carries no state at all — it is
  // finished by definition — so only an explicit "streaming" counts as open.
  // (Keying on `=== "done"` hid everything gated on this, such as the
  // "Pinged" footer, after a refresh or a bot change.)
  const isStreamingComplete = parts.length > 0 &&
    parts.filter((part) => part.type === "text" || part.type === "reasoning").every((part) => (part as any).state !== "streaming");

  const hasRunningTools = parts.some(
    (part) => (part.type === "dynamic-tool" || part.type === "tool-invocation") &&
      (part as any).state !== "output-available"
  );

  const toolParts = parts.filter(
    (part) => part.type === "dynamic-tool" || part.type === "tool-invocation"
  );
  const textParts = parts.filter((part) => part.type === "text");
  const reasoningParts = parts.filter((part) => part.type === "reasoning");

  const isPptxRunning = toolParts.some((part) => isRunningPptxSendEmail(part as never));

  const fullText = textParts.map((part) => (part as any).text || "").join("");

  let thinkingText = "";
  let responseText = "";

  // 1. Primary: genuine reasoning parts from AI SDK
  const genuineThinkingText = reasoningParts
    .map((part) => (part as any).text || (part as any).reasoning || "")
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (genuineThinkingText) {
    thinkingText = genuineThinkingText;
    responseText = fullText;
  } else {
    // 2. Fallback: parse delimiters for historical messages that still contain them
    const hasEitherDelimiter = fullText.includes(THINKING_START_DELIMITER) || fullText.includes(THINKING_END_DELIMITER);

    if (!hasEitherDelimiter) {
      responseText = fullText;
    } else {
      // Collect all thinking blocks (text between each THINKING_START and THINKING_END pair)
      const thinkingParts: string[] = [];
      let remaining = fullText;

      while (remaining.length > 0) {
        const startIdx = remaining.indexOf(THINKING_START_DELIMITER);
        const endIdx = remaining.indexOf(THINKING_END_DELIMITER);

        if (startIdx === -1 && endIdx === -1) {
          // No more delimiters — rest is response text
          responseText += remaining;
          break;
        }

        if (startIdx !== -1 && (endIdx === -1 || startIdx < endIdx)) {
          // Found a THINKING_START — text before it is response
          responseText += remaining.substring(0, startIdx);
          remaining = remaining.substring(startIdx + THINKING_START_DELIMITER.length);

          // Look for matching THINKING_END
          const matchingEnd = remaining.indexOf(THINKING_END_DELIMITER);
          if (matchingEnd !== -1) {
            thinkingParts.push(remaining.substring(0, matchingEnd).trim());
            remaining = remaining.substring(matchingEnd + THINKING_END_DELIMITER.length);
          } else {
            // No closing delimiter yet (still streaming) — rest is thinking
            thinkingParts.push(remaining.trim());
            remaining = "";
          }
        } else {
          // THINKING_END without a preceding START — skip past it
          responseText += remaining.substring(0, endIdx);
          remaining = remaining.substring(endIdx + THINKING_END_DELIMITER.length);
        }
      }

      thinkingText = thinkingParts.filter(Boolean).join("\n\n---\n\n");
    }
  }

  // Second pass: pull warning blocks out of responseText. The agent wraps an
  // EBITDA concern (or any other risk surfaced from a tool preview) between
  // <!-- WARNING_START --> and <!-- WARNING_END -->; we render those as a
  // yellow banner above the chat bubble and strip them from the prose.
  const warnings: string[] = [];
  if (
    responseText.includes(WARNING_START_DELIMITER) ||
    responseText.includes(WARNING_END_DELIMITER)
  ) {
    let cleaned = "";
    let remaining = responseText;
    while (remaining.length > 0) {
      const startIdx = remaining.indexOf(WARNING_START_DELIMITER);
      if (startIdx === -1) {
        // Drop any orphan END token but keep surrounding text.
        cleaned += remaining.split(WARNING_END_DELIMITER).join("");
        break;
      }
      cleaned += remaining.substring(0, startIdx);
      remaining = remaining.substring(startIdx + WARNING_START_DELIMITER.length);
      const endIdx = remaining.indexOf(WARNING_END_DELIMITER);
      if (endIdx === -1) {
        // Mid-stream: closing delimiter hasn't arrived. Treat the remainder
        // as an in-progress warning so it shows immediately as a banner.
        const partial = remaining.trim();
        if (partial) warnings.push(partial);
        remaining = "";
      } else {
        const body = remaining.substring(0, endIdx).trim();
        if (body) warnings.push(body);
        remaining = remaining.substring(endIdx + WARNING_END_DELIMITER.length);
      }
    }
    responseText = cleaned;
  }

  // Extract citations from web_search / valyu_search tool results
  const allCitations: { title: string; url: string; published?: string }[] = [];
  // Extract files from query_files tool results - matches MeetingNote type
  const allMeetingNotes: MeetingNoteRef[] = [];
  let workforceHandoff: WorkforceHandoffPayload | null = null;
  let bulkDropApproval: BulkDropApprovalPayload | null = null;
  let bulkPromoteApproval: BulkPromoteApprovalPayload | null = null;
  let insightEditApproval: InsightEditApprovalPayload | null = null;
  let insightCreateApproval: InsightCreateApprovalPayload | null = null;
  let reportPlanApproval: ReportPlanApprovalPayload | null = null;
  let insightRefreshApproval: InsightRefreshApprovalPayload | null = null;
  // Several bot changes or messages can come out of one turn; each gets a card.
  const botChangeApprovals: BotChangeApprovalPayload[] = [];
  const botRoutineApprovals: BotRoutineApprovalPayload[] = [];
  const optionCards: OptionCardPayload[] = [];
  const botMessages: BotMessagePayload[] = [];

  const approvalSpecs = [
    {
      tool: INSIGHT_CREATE_TOOL_NAME,
      marker: INSIGHT_CREATE_APPROVAL_MARKER,
      isValid: (p: any): p is InsightCreateApprovalPayload => Boolean(p?.name && p?.html),
      assign: (p: any) => { insightCreateApproval = p; },
      has: () => Boolean(insightCreateApproval),
    },
    {
      tool: INSIGHT_EDIT_TOOL_NAME,
      marker: INSIGHT_EDIT_APPROVAL_MARKER,
      isValid: (p: any): p is InsightEditApprovalPayload => Boolean(p?.insight_id && p?.html),
      assign: (p: any) => { insightEditApproval = p; },
      has: () => Boolean(insightEditApproval),
    },
    {
      tool: REPORT_PLAN_TOOL_NAME,
      marker: REPORT_PLAN_APPROVAL_MARKER,
      isValid: (p: any): p is ReportPlanApprovalPayload => Boolean(p?.methodology),
      assign: (p: any) => { reportPlanApproval = p; },
      has: () => Boolean(reportPlanApproval),
    },
    {
      tool: INSIGHT_REFRESH_TOOL_NAME,
      marker: INSIGHT_REFRESH_APPROVAL_MARKER,
      isValid: (p: any): p is InsightRefreshApprovalPayload =>
        Boolean(p?.insight_id && typeof p?.reason === "string"),
      assign: (p: any) => { insightRefreshApproval = p; },
      has: () => Boolean(insightRefreshApproval),
    },
  ];

  // Every company any tool in this turn resolved, as id↔name pairs. Narrowed
  // below to just the ones the answer actually names.
  const companyMentions: CompanyMention[] = [];

  for (const part of toolParts) {
    const toolName = (part as any).toolName || "";
    const content = toolOutputText(part);

    if (toolName === "web_search" || toolName === "valyu_search") {
      const citationMatch = content.match(CITATIONS_JSON_RE);
      if (citationMatch) {
        try {
          const citations = JSON.parse(citationMatch[1]);
          for (const cite of citations) {
            if (!allCitations.some(c => c.url === cite.url)) {
              allCitations.push(cite);
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    if (toolName === WORKFORCE_HANDOFF_TOOL_NAME && !workforceHandoff) {
      const handoffMatch = content.match(WORKFORCE_HANDOFF_RE);
      if (handoffMatch) {
        try {
          const parsed = JSON.parse(handoffMatch[1].trim()) as WorkforceHandoffPayload;
          if (parsed && parsed.title && parsed.instruction) {
            workforceHandoff = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (toolName === BULK_DROP_APPROVAL_TOOL_NAME && !bulkDropApproval) {
      const bulkDropMatch = content.match(BULK_DROP_APPROVAL_RE);
      if (bulkDropMatch) {
        try {
          const parsed = JSON.parse(bulkDropMatch[1].trim()) as BulkDropApprovalPayload;
          if (parsed && parsed.title && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
            bulkDropApproval = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (toolName === BULK_PROMOTE_APPROVAL_TOOL_NAME && !bulkPromoteApproval) {
      const bulkPromoteMatch = content.match(BULK_PROMOTE_APPROVAL_RE);
      if (bulkPromoteMatch) {
        try {
          const parsed = JSON.parse(bulkPromoteMatch[1].trim()) as BulkPromoteApprovalPayload;
          if (
            parsed &&
            parsed.title &&
            parsed.target_stage &&
            Array.isArray(parsed.candidates) &&
            parsed.candidates.length > 0
          ) {
            bulkPromoteApproval = parsed;
          }
        } catch {
          // Ignore parse errors — fall through to plain text rendering.
        }
      }
    }

    if (
      toolName === PROPOSE_CREATE_BOT_TOOL_NAME ||
      toolName === UPDATE_BOT_TOOL_NAME ||
      toolName === LEGACY_PROPOSE_UPDATE_BOT_TOOL_NAME
    ) {
      const parsed = extractApprovalPayload(content, BOT_CHANGE_APPROVAL_MARKER);
      if (isBotChangeApprovalPayload(parsed)) botChangeApprovals.push(parsed);
    }
    if (toolName === PROPOSE_CREATE_ROUTINE_TOOL_NAME) {
      const parsed = extractApprovalPayload(content, BOT_ROUTINE_APPROVAL_MARKER);
      if (isBotRoutineApprovalPayload(parsed)) botRoutineApprovals.push(parsed);
    }
    if (toolName === OFFER_OPTIONS_TOOL_NAME) {
      const parsed = extractApprovalPayload(content, OPTION_CARD_MARKER);
      if (isOptionCardPayload(parsed)) optionCards.push(parsed);
    }
    if (toolName === MESSAGE_BOT_TOOL_NAME) {
      const parsed = extractApprovalPayload(content, BOT_MESSAGE_MARKER);
      if (isBotMessagePayload(parsed)) botMessages.push(parsed);
    }

    for (const spec of approvalSpecs) {
      if (toolName === spec.tool && !spec.has()) {
        const parsed = extractApprovalPayload(content, spec.marker);
        if (parsed) {
          const candidate =
            PAYLOAD_ONLY_APPROVAL_TOOLS.has(spec.tool)
              ? parsed
              : resolveApprovalPayload(
                  parsed as any,
                  (part as any).input ?? (part as any).args,
                );
          if (candidate && spec.isValid(candidate)) {
            spec.assign(candidate);
          }
        }
      }
    }

    companyMentions.push(...parseCompanyMentions(content));

    if (toolName === "query_files") {
      const notesMatch = content.match(FILES_JSON_RE);
      if (notesMatch) {
        try {
          const notes = JSON.parse(notesMatch[1]);
          for (const note of notes) {
            if (!allMeetingNotes.some(n => n.id === note.id)) {
              allMeetingNotes.push(note);
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }

  for (const spec of approvalSpecs) {
    if (responseText.includes(spec.marker)) {
      if (!spec.has()) {
        const parsed = extractApprovalPayload(responseText, spec.marker);
        if (parsed) {
          const candidate =
            PAYLOAD_ONLY_APPROVAL_TOOLS.has(spec.tool)
              ? parsed
              : resolveApprovalPayload(parsed as any, undefined);
          if (candidate && spec.isValid(candidate)) {
            spec.assign(candidate);
          }
        }
      }
      responseText = stripApprovalMarkers(responseText);
    }
  }

  return {
    toolParts,
    hasTextContent,
    hasReasoningContent,
    isStreamingComplete,
    hasRunningTools,
    isPptxRunning,
    thinkingText,
    responseText,
    warnings,
    allCitations,
    allMeetingNotes,
    // A single query can return fifty rows; chipping all of them would bury
    // the answer. Keep only the companies the assistant actually named.
    mentionedCompanies: selectMentionedCompanies(companyMentions, responseText),
    workforceHandoff,
    bulkDropApproval,
    bulkPromoteApproval,
    insightEditApproval,
    insightCreateApproval,
    reportPlanApproval,
    insightRefreshApproval,
    botChangeApprovals,
    botRoutineApprovals,
    optionCards,
    botMessages,
  };
}

function AssistantMessageBubble(props: ChatMessageBubbleProps) {
  const parts = props.message?.parts || EMPTY_PARTS;

  // One pass over the turn, cached on the parts array. The AI SDK hands back a
  // new `parts` only when the message actually changed, so a bubble that is
  // not the streaming one re-uses this result for the life of the thread.
  const parsed = useMemo(() => parseAssistantTurn(parts), [parts]);
  const {
    toolParts,
    hasTextContent,
    hasReasoningContent,
    isStreamingComplete,
    hasRunningTools,
    isPptxRunning,
    thinkingText,
    responseText,
    warnings,
    allCitations,
    allMeetingNotes,
    mentionedCompanies,
    workforceHandoff,
    bulkDropApproval,
    bulkPromoteApproval,
    insightEditApproval,
    insightCreateApproval,
    reportPlanApproval,
    insightRefreshApproval,
    botChangeApprovals,
    botRoutineApprovals,
    optionCards,
    botMessages,
  } = parsed;

  const hasThinkingContent = thinkingText.trim().length > 0;
  const hasResponseContent = responseText.trim().length > 0;

  // Show the thinking bubble while no answer text exists yet, or while tools
  // are running. Reasoning that is streaming in counts as "still thinking":
  // it lives behind the collapsed details toggle, so the bubble is the only
  // live sign. Gated on isActive so that pressing Stop clears it at once —
  // without that gate, hasRunningTools stays true on an aborted tool call.
  const showThinking =
    (!hasResponseContent || hasRunningTools) &&
    !isStreamingComplete &&
    (props.isActive ?? false);

  // Deterministic ETA notice while send_email builds a presentation (do not rely on the model).
  const isGeneratingPptx = (props.isActive ?? false) && isPptxRunning;

  // Auto-collapse tool results when response text starts streaming
  // The turn's thinking and tool traces: collapsed by default, behind one
  // small toggle under the avatar, so the transcript is the answers.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Sending a follow-up (e.g. "Just answer here"). From the actions context,
  // which never changes identity: subscribing to the full chat context here
  // would re-render every bubble in the thread on every token and defeat the
  // `memo` below. The workforce card reads the thread's effort tier itself,
  // for the same reason — `useChatThread` carries the sidebar list, which is
  // replaced several times a turn.
  const { sendMessage } = useChatActions();
  const handleJustAnswerHere = () => {
    sendMessage({
      text: "Just answer here — please proceed inline without sending this to the Workforce.",
    });
  };

  // State for files preview modal
  const [previewNote, setPreviewNote] = useState<MeetingNoteRef | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Fetch signed URL when opening preview
  const handleOpenPreview = async (note: typeof previewNote) => {
    if (!note) return;
    setPreviewNote(note);
    setLoadingPreview(true);
    try {
      // Use the meeting-notes API to get a signed URL
      const res = await fetch(`/api/smart-files/${note.id}/download-url`);
      if (res.ok) {
        const data = await res.json();
        setPreviewUrl(data.url);
      } else {
        // Fallback: try to use file_link directly if it's a full URL
        if (note.file_link.startsWith('http')) {
          setPreviewUrl(note.file_link);
        } else {
          toast.error("Failed to load file preview");
        }
      }
    } catch (e) {
      console.error("Failed to fetch preview URL:", e);
      toast.error("Failed to load file preview");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewNote(null);
    setPreviewUrl(null);
  };

  const hasDetails = toolParts.length > 0 || hasThinkingContent;

  // For assistant messages, render parts with switch statement
  return (
    <div className="flex mb-3 min-w-0 gap-2">
      {(props.botAvatar || hasDetails) && (
        <div className="mt-1 flex shrink-0 flex-col items-center gap-1">
          {props.botAvatar && (
            <BotAvatar avatar={props.botAvatar} state={props.avatarState ?? 'idle'} size="xs" />
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
              aria-label={detailsOpen ? 'Hide thinking and tools' : 'Show thinking and tools'}
              title={detailsOpen ? 'Hide thinking and tools' : `Thinking${toolParts.length > 0 ? ` · ${toolParts.length} tool${toolParts.length > 1 ? 's' : ''}` : ''}`}
              data-testid="chat-details-toggle"
              className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      )}
      {/* Message Content — flat, full-width with symmetric horizontal padding */}
      <div className="flex-1 min-w-0 flex flex-col items-start gap-1.5 px-0 md:px-2">
        {/* Thinking and tool traces, behind the toggle under the avatar. */}
        {hasDetails && detailsOpen && (
          <div className="w-full rounded-lg border border-dashed bg-muted p-3 text-muted-foreground" data-testid="chat-details">
            {hasThinkingContent && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                  <Brain className="h-3 w-3" /> Thinking
                </div>
                <MarkdownRenderer
                  content={thinkingText}
                  linkSurface="copilot"
                  className="prose-sm text-xs [&_*]:text-muted-foreground"
                />
              </div>
            )}
            {toolParts.length > 0 && (
              <div className={hasThinkingContent ? 'mt-3' : undefined}>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                  <Wrench className="h-3 w-3" /> {toolParts.length} tool{toolParts.length > 1 ? 's' : ''} used
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border bg-card p-2">
                  {toolParts.map((part, index) => (
                    <ToolTrace key={`tool-${index}`} part={part} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* PPTX generation can take several minutes — prefer this over the generic spinner. */}
        {isGeneratingPptx ? (
          <PptxGeneratingNotice />
        ) : (
          showThinking &&
          (props.botAvatar ? (
            // The avatar is already beside this bubble; the cloud floats next to it.
            <ThinkingBubble
              showAvatar={false}
              name={props.botName}
              state={props.avatarState === 'working' ? 'working' : 'thinking'}
            />
          ) : (
            <ThinkingIndicator />
          ))
        )}

        {/* Warning banner(s) — agent surfaces concerns (e.g. weak EBITDA on an
            L0→L1 promotion preview) between WARNING_START/WARNING_END. */}
        {warnings.length > 0 && (
          <div className="w-full flex flex-col gap-2">
            {warnings.map((w, i) => (
              <div
                key={`warning-${i}`}
                role="alert"
                className="flex items-start gap-3 w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
              >
                <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 text-sm leading-relaxed">
                  <span className="font-semibold">Warning! </span>
                  <MarkdownRenderer
                    content={w}
                    linkSurface="copilot"
                    className="inline prose-sm [&_p]:inline [&_p]:m-0 [&_*]:text-amber-900 dark:[&_*]:text-amber-200"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Response Text - Final answer. Rendered as plain full-width text
            with no card/bubble, flat against the background. */}
        {hasResponseContent && (
          <div className="w-full min-w-0 overflow-auto break-words text-sm">
            <MarkdownRenderer content={responseText} linkSurface="copilot" evidenceMarkers citationPills />
          </div>
        )}

        {/* Workforce handoff card */}
        {workforceHandoff && (
          <WorkforceHandoffCard
            payload={workforceHandoff}
            onJustAnswerHere={handleJustAnswerHere}
          />
        )}

        {/* Bulk drop approval card */}
        {bulkDropApproval && (
          <BulkDropCompaniesCard payload={bulkDropApproval} />
        )}

        {/* Bulk promote approval card */}
        {bulkPromoteApproval && (
          <BulkPromoteCompaniesCard payload={bulkPromoteApproval} />
        )}

        {/* Insight edit approval card */}
        {insightEditApproval && (
          <InsightEditApprovalCard payload={insightEditApproval} />
        )}

        {/* New insight approval card */}
        {insightCreateApproval && (
          <InsightCreateApprovalCard payload={insightCreateApproval} />
        )}

        {/* Report plan approval card */}
        {reportPlanApproval && (
          <ReportPlanCard payload={reportPlanApproval} />
        )}

        {/* Insight refresh offer (MB-552) */}
        {insightRefreshApproval && (
          <InsightRefreshApprovalCard payload={insightRefreshApproval} />
        )}

        {/* Bot tools (RFC 02): proposed bot changes, and messages sent to other bots */}
        {botChangeApprovals.map((p) => (
          <BotChangeApprovalCard key={p.approval_id} payload={p} />
        ))}
        {botRoutineApprovals.map((p) => (
          <BotRoutineApprovalCard key={p.approval_id} payload={p} />
        ))}
        {/* Clickable choices (offer_options); the pick is the user's next message. */}
        {optionCards.map((p) => (
          <OptionCard key={p.card_id} payload={p} />
        ))}
        {botMessages.map((p, i) => (
          <BotMessageCard key={`${p.bot_id}-${i}`} payload={p} />
        ))}
        {isStreamingComplete && responseText.includes('@') && <MentionPings text={responseText} />}

        {/* One "Open <company>" chip per company the answer actually names,
            in the order it named them. Only companies a tool resolved to an id
            can appear here — see `companyMentions` for why the ids travel in a
            hidden manifest rather than being parsed out of the prose. */}
        {mentionedCompanies.length > 0 && (
          <ChipOverflow className="w-full">
            {mentionedCompanies.map((company) => (
              <CompanyChip key={company.id} company={company} prefix="Open" />
            ))}
          </ChipOverflow>
        )}

        {/* Sources */}
        {props.sources && props.sources.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            <p className="font-semibold mb-1">Sources:</p>
            <ChipOverflow className="gap-2">
              {props.sources.map((source, i) => (
                <div key={i} className="bg-muted px-2 py-1 rounded border">
                  {source.title || source.name || "Source"}
                </div>
              ))}
            </ChipOverflow>
          </div>
        )}

        {/* Web Search Citations - Below chat bubble */}
        {allCitations.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">📚 Sources</p>
            <ChipOverflow>
              {allCitations.slice(0, 6).map((cite, i) => {
                const published = readPublishedDate(cite.published);
                const stale = published ? isStaleSource(published.date) : false;
                return (
                <a
                  key={i}
                  href={cite.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={stale ? `Dated source: published over ${STALE_SOURCE_MONTHS} months ago` : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 transition-colors border border-blue-100 dark:border-blue-800",
                    stale && "border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900",
                  )}
                >
                  {cite.title.length > 35 ? cite.title.substring(0, 35) + "..." : cite.title}
                  {published && (
                    <span className="tabular-nums opacity-80">
                      · {published.label}
                      {stale ? " · dated" : ""}
                    </span>
                  )}
                  <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
                );
              })}
            </ChipOverflow>
          </div>
        )}

        {/* Files - Below chat bubble */}
        {allMeetingNotes.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">📄 Files</p>
            <ChipOverflow>
              {allMeetingNotes.slice(0, 6).map((note, i) => (
                <button
                  key={i}
                  onClick={() => handleOpenPreview(note)}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50 transition-colors border border-amber-100 dark:border-amber-800 cursor-pointer"
                >
                  <FileText className="h-3 w-3 flex-shrink-0" />
                  {note.file_name?.length > 30 ? note.file_name.substring(0, 30) + "..." : note.file_name}
                </button>
              ))}
            </ChipOverflow>
          </div>
        )}
        <MessageTime message={props.message} className="self-start" />
      </div>

      {/* Files Preview Dialog */}
      <Dialog open={!!previewNote} onOpenChange={(open) => !open && handleClosePreview()}>
        <DialogContent className="flex flex-col w-screen h-screen max-w-none sm:rounded-none border-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              <span className="truncate">{previewNote?.file_name}</span>
              {previewNote?.file_date && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {previewNote.file_date}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* Side-by-side layout */}
          <div className="grid md:grid-cols-2 gap-6 mt-4 flex-1 min-h-0 overflow-hidden">
            {/* Left: File Preview */}
            <div className="flex flex-col gap-2 min-h-0">
              {loadingPreview ? (
                <>
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileSearch className="h-4 w-4" />
                    File Preview
                  </h3>
                  <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted/30 rounded-md border">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                </>
              ) : previewUrl ? (
                <div className="flex-1 min-h-0">
                  <FilePreview
                    title={
                      <>
                        <FileSearch className="h-4 w-4" />
                        File Preview
                      </>
                    }
                    url={previewUrl}
                    fileName={previewNote?.file_name || ""}
                    fileKey={
                      previewNote?.file_link && !previewNote.file_link.startsWith("http")
                        ? previewNote.file_link
                        : undefined
                    }
                  />
                </div>
              ) : (
                <>
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileSearch className="h-4 w-4" />
                    File Preview
                  </h3>
                  <div className="flex flex-1 min-h-0 w-full items-center justify-center bg-muted/30 rounded-md border text-muted-foreground">
                    Preview not available
                  </div>
                </>
              )}
            </div>

            {/* Right: AI Structured Notes */}
            <div className="flex flex-col gap-2 min-h-0">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                AI Structured Notes
              </h3>
              <ScrollArea className="flex-1 min-h-0 w-full rounded-md border p-4 bg-muted/30">
                {previewNote?.structured_notes ? (
                  <div className="space-y-4 text-sm">
                    {(() => {
                      try {
                        const structured = JSON.parse(previewNote.structured_notes);
                        return (
                          <>
                            {/* Tags */}
                            {previewNote?.tags && previewNote.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pb-2">
                                {previewNote.tags.map((tag, i) => (
                                  <Badge key={i} variant="secondary" className="text-xs">
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            )}

                            {/* Summary */}
                            {structured.summary && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Summary</h4>
                                <p>{structured.summary}</p>
                              </div>
                            )}

                            {/* Key Points */}
                            {structured.key_points && structured.key_points.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Key Points</h4>
                                <ul className="list-disc pl-4 space-y-1">
                                  {structured.key_points.map((point: string, i: number) => (
                                    <li key={i}>{point}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Action Items */}
                            {structured.action_items && structured.action_items.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Action Items</h4>
                                <ul className="list-disc pl-4 space-y-1">
                                  {structured.action_items.map((item: string, i: number) => (
                                    <li key={i}>{item}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Matched Companies */}
                            {previewNote?.matched_companies && previewNote.matched_companies.length > 0 && (
                              <div>
                                <h4 className="font-medium text-primary mb-1">Companies Mentioned</h4>
                                <div className="flex flex-wrap gap-1.5">
                                  {previewNote.matched_companies.map((company, i) => (
                                    <CompanyChip key={i} company={company} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        );
                      } catch (e) {
                        return <pre className="text-xs whitespace-pre-wrap">{previewNote.structured_notes}</pre>;
                      }
                    })()}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic p-4">
                    Processing not complete or structure extraction failed.
                  </p>
                )}
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Memoize so typing in the input doesn't re-render every bubble in the
// history. Streaming messages still re-render because the AI SDK produces a
// new message object on each chunk (changes the prop reference).
export const ChatMessageBubble = memo(ChatMessageBubbleImpl);
