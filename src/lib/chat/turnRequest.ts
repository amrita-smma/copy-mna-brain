/**
 * A chat turn as the client posted it (`POST /api/chat`), read once and with
 * no I/O before anything is looked up.
 *
 * Everything the route needs from the request body is read here, so the
 * reads that depend only on the body — the memory recall, the effort
 * routing, the open insight's outline, the workspace context — can all be
 * in flight while the thread is opened, instead of starting after it.
 *
 * Pure: no I/O, nothing thrown. A body with no user message reads as null.
 */
import type { UIMessage } from 'ai';
import type { ChatAttachmentRef } from '@/lib/services/chatAttachmentService';
import { asManualEffort, type ManualEffortChoice } from '@/lib/chat/effortTiers';
import { sanitizePageContext, type PageContext } from '@/lib/chat/pageContext';
import {
  readInsightTemplatePart,
  type InsightTemplateAttachment,
} from '@/lib/insights/templateAttachment';
import {
  readInsightSelectionPart,
  withInsightSelection,
  type InsightSelectionAttachment,
} from '@/lib/insights/selectionAttachment';

export interface TurnRequest {
  /** Debug: answer with the agent's final messages as JSON instead of a stream. */
  returnIntermediateSteps: boolean;
  /**
   * Every turn runs on a Copilot bot (RFC 02): one permanent thread per user
   * per bot. No `bot_id` means the workspace default bot.
   */
  requestedBotId: string | undefined;
  /**
   * An explicit tier pins the turn; null ('auto', or anything unrecognised)
   * defers to the server. Narrowed with `asManualEffort`, not
   * `asEffortChoice`: a client must not be able to pin a thread to the
   * Auto-only `deep` tier by posting the string.
   */
  requestedEffort: ManualEffortChoice | null;
  /**
   * Composer attachments the client is carrying for this turn. Each is an S3
   * key under the workspace's `chat-attachments/` prefix plus display
   * metadata; the file itself persists in S3 across turns and is uploaded to
   * Anthropic per-request (and deleted again once the turn settles).
   */
  attachments: ChatAttachmentRef[];
  /**
   * What the user is looking at in the center console. Browser-supplied, so
   * it is normalized (unknown tab dropped, path shape enforced, detail
   * clamped) before it can reach a prompt. Travels via `configurable`, like
   * `userEmail` — the model reads it through `read_page_context`, never as
   * an argument it could fabricate.
   */
  pageContext: PageContext | null;
  /**
   * The latest user message, narrowed to its text parts. The client posts the
   * full UI message history; with a checkpointer only the latest user turn is
   * fed to the agent — prior state is rehydrated by the saver via thread_id.
   */
  lastUserMessage: UIMessage;
  /**
   * An insight template attached in the composer rides on the message as a
   * `data-insight-template` part; it is expanded into the human turn. Counts
   * as an attachment: it is a whole document to author.
   */
  insightTemplate: InsightTemplateAttachment | null;
  /**
   * Elements picked with the insight selection tool ride the same way, as a
   * `data-insight-selection` part; the text part is only the user's words.
   */
  insightSelection: InsightSelectionAttachment | null;
  /** The user's words: the text parts of the latest user message, joined. */
  userText: string;
  /**
   * The turn as plain text, selection addresses included, for the readers
   * that never see the content blocks: effort routing and the question
   * recorded against research tool calls.
   */
  turnText: string;
  /**
   * The previous user turn, read the same way as `turnText`: a short
   * follow-up searches memory with it behind (`recallQueryFor`). The client
   * sends the visible conversation, so that turn is right here.
   */
  previousUserText: string | null;
  /** The turn carries a file or an insight template to author. */
  hasAttachments: boolean;
}

interface UIMessageLike {
  role: string;
  parts?: unknown;
  content?: unknown;
}

function isMessageLike(value: unknown): value is UIMessageLike {
  return Boolean(value) && typeof value === 'object' && typeof (value as UIMessageLike).role === 'string';
}

/** The text of a message's text parts, joined; '' when it has none. */
function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (p): p is { type: 'text'; text: string } =>
        Boolean(p) && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
}

/**
 * The latest user message with only its text parts kept (the attachment
 * parts are read separately), or, for the legacy `content` shape, one text
 * part built from the content.
 */
function textOnlyMessage(message: UIMessageLike): UIMessage {
  if (Array.isArray(message.parts)) {
    return {
      ...message,
      parts: (message.parts as { type: string }[]).filter((p) => p.type === 'text'),
    } as UIMessage;
  }
  return {
    ...message,
    parts: message.content
      ? [
          {
            type: 'text',
            text:
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
          },
        ]
      : [],
  } as UIMessage;
}

/** Read a turn from the request body; null when it carries no user message. */
export function readTurnRequest(body: unknown): TurnRequest | null {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).filter(
    (m): m is UIMessageLike => isMessageLike(m) && (m.role === 'user' || m.role === 'assistant'),
  );
  const userMessages = messages.filter((m) => m.role === 'user');
  const last = userMessages[userMessages.length - 1];
  if (!last) return null;

  const insightTemplate = readInsightTemplatePart(last.parts);
  const insightSelection = readInsightSelectionPart(last.parts);
  const lastUserMessage = textOnlyMessage(last);
  const userText = textOfParts(lastUserMessage.parts);

  const previous = userMessages[userMessages.length - 2];
  let previousUserText: string | null = null;
  if (previous) {
    if (Array.isArray(previous.parts)) {
      previousUserText = withInsightSelection(
        textOfParts(previous.parts),
        readInsightSelectionPart(previous.parts),
      );
    } else if (typeof previous.content === 'string') {
      previousUserText = previous.content;
    }
  }

  const attachments: ChatAttachmentRef[] = Array.isArray(raw.attachments)
    ? (raw.attachments as ChatAttachmentRef[])
    : [];

  return {
    returnIntermediateSteps: Boolean(raw.show_intermediate_steps),
    requestedBotId:
      typeof raw.bot_id === 'string' && raw.bot_id ? raw.bot_id : undefined,
    requestedEffort: asManualEffort(raw.effort),
    attachments,
    pageContext: sanitizePageContext(raw.page_context),
    lastUserMessage,
    insightTemplate,
    insightSelection,
    userText,
    turnText: withInsightSelection(userText, insightSelection),
    previousUserText,
    hasAttachments: attachments.length > 0 || insightTemplate !== null,
  };
}
