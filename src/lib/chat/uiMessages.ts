/**
 * The Copilot's checkpoint messages (LangChain `BaseMessage[]`) as the UI
 * messages the chat renders. Shared by the messages endpoint, the history
 * writer (`ChatHistoryService`) and the one-time import of a thread's
 * checkpoint history, so a stored turn renders exactly like a live one.
 */
import type { BaseMessage } from '@langchain/core/messages';
import { SUMMARIZATION_SOURCE, SUMMARY_MARKER_TEXT } from '@/lib/bots/summary';
import type { ResponseFeedbackValue } from '@/lib/chat/responseFeedback';
import {
  INSIGHT_TEMPLATE_PART_TYPE,
  parseInsightTemplateBlock,
  type InsightTemplateAttachment,
} from '@/lib/insights/templateAttachment';
import {
  INSIGHT_SELECTION_PART_TYPE,
  isInsightSelectionBlock,
  readInsightSelectionKwarg,
  type InsightSelectionAttachment,
} from '@/lib/insights/selectionAttachment';

/**
 * `additional_kwargs` key marking a human message that reached this bot
 * through an @mention in another bot's chat. Never sent to the model.
 */
export const FROM_BOT_KWARG = 'from_bot';

/**
 * Where a mention came from. `bot` (the default, and all history from before
 * @mentions): the named bot wrote it in a reply. `user_mention`: the user
 * typed it in their chat with the named bot.
 */
/**
 * How another bot's words reached this thread: `bot` — it @mentioned this bot
 * in its reply; `user_mention` — the user @mentioned this bot in its chat;
 * `bot_reply` — it answered work this bot handed it.
 */
export type FromBotKind = 'bot' | 'user_mention' | 'bot_reply';

export interface FromBot {
  id: string;
  name: string;
  kind?: FromBotKind;
  /**
   * On a `bot_reply` that carries several bots' answers at once (the fan-in
   * of one hand-off to many bots): every answering bot after the first, so
   * the transcript credits them all, not just `name`.
   */
  others?: { id: string; name: string }[];
}

export function readFromBot(kwargs: Record<string, unknown> | undefined): FromBot | null {
  const raw = kwargs?.[FROM_BOT_KWARG] as Partial<FromBot> | undefined;
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  // Only the kinds the UI labels differently survive; anything else is a
  // plain message from that bot.
  if (raw.kind === 'user_mention') return { id: raw.id, name: raw.name, kind: raw.kind };
  if (raw.kind === 'bot_reply') {
    const others = Array.isArray(raw.others)
      ? raw.others.filter(
          (o): o is { id: string; name: string } => !!o && typeof o.id === 'string' && typeof o.name === 'string',
        )
      : [];
    return {
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      ...(others.length > 0 ? { others: others.map((o) => ({ id: o.id, name: o.name })) } : {}),
    };
  }
  return { id: raw.id, name: raw.name };
}

/**
 * `additional_kwargs` key marking a human message a bot routine sent on the
 * user's behalf. Never sent to the model.
 */
export const FROM_ROUTINE_KWARG = 'from_routine';

export interface FromRoutine {
  id: string;
  title: string;
}

export function readFromRoutine(kwargs: Record<string, unknown> | undefined): FromRoutine | null {
  const raw = kwargs?.[FROM_ROUTINE_KWARG] as Partial<FromRoutine> | undefined;
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return { id: raw.id, title: raw.title };
}

type TextPart = { type: 'text'; text: string };
type ToolPart = {
  type: 'dynamic-tool';
  toolCallId: string;
  toolName: string;
  state: 'input-available' | 'output-available';
  input: unknown;
  output?: { kwargs: { content: string } };
};
type TemplatePart = { type: typeof INSIGHT_TEMPLATE_PART_TYPE; data: InsightTemplateAttachment };
type SelectionPart = { type: typeof INSIGHT_SELECTION_PART_TYPE; data: InsightSelectionAttachment };
export type UIPart = TextPart | ToolPart | TemplatePart | SelectionPart;

export interface UIMessageOut {
  id: string;
  role: 'user' | 'assistant';
  parts: UIPart[];
  experimental_attachments?: { url: string; contentType?: string }[];
  /**
   * `fromBot` / `fromRoutine`: set on a user message another bot or a routine
   * sent. `createdAt`: when the message was stored (ISO), set on every message
   * read from history; a live turn writes its own as a `message-metadata`
   * chunk (`/api/chat`), and the composer stamps the message it sends.
   */
  metadata?: UIMessageMetadata;
}

/** The metadata a chat message carries beside its parts (client safe). */
export interface UIMessageMetadata {
  fromBot?: FromBot;
  fromRoutine?: FromRoutine;
  /** When the message was written, ISO 8601. Shown as the bubble's timestamp. */
  createdAt?: string;
  /**
   * On a reply: the id of the question row (copilot_messages) that started
   * its turn — what feedback on the reply is keyed on. Sent by the live
   * stream and by history pages; absent when the question was never stored.
   */
  questionId?: string;
  /** On a reply read from history: the user's feedback on it, if any. */
  feedback?: ResponseFeedbackValue;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // LangChain Anthropic content blocks: [{type:'text', text:'…'}, {type:'tool_use', …}, …]
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const txt = (block as { text?: string }).text ?? '';
        // Hide backend file extractions, expanded insight templates and insight
        // selections from the UI
        if (txt.startsWith('Attached file "') && txt.includes('":\n\n')) {
          return '';
        }
        if (parseInsightTemplateBlock(txt) || isInsightSelectionBlock(txt)) {
          return '';
        }
        return txt;
      }
      return '';
    })
    .join('');
}

/**
 * Reconstruct UIMessage[] from the checkpointer's BaseMessage[] in the same
 * shape the live stream produces, so reloaded chats render identically.
 *
 * Key invariants the UI relies on (see ChatMessageBubble.tsx):
 *   - One bubble per assistant turn. A turn covers ALL consecutive AI/Tool
 *     messages between two human messages. LangGraph stores a tool-using
 *     turn as separate BaseMessages (AI w/ tool_use → Tool result → AI w/
 *     final answer); the UI expects them merged into a single UIMessage with
 *     text + tool parts in its `parts` array.
 *   - Tool results are *back-attached* to the matching tool part via
 *     toolCallId, with the result string at `output.kwargs.content`.
 *   - Citations / files are embedded inside the tool output as HTML comments
 *     (e.g. `<!-- CITATIONS_JSON:[…] -->`) which the UI parses out, so we
 *     just need to preserve the output text verbatim.
 */
export function toUIMessages(messages: BaseMessage[]): UIMessageOut[] {
  const out: UIMessageOut[] = [];
  let currentAssistant: UIMessageOut | null = null;
  const toolPartByCallId = new Map<string, ToolPart>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const kind = m._getType();
    const id = (m as { id?: string }).id ?? `msg-${i}`;

    if (kind === 'human') {
      // User turn closes the current assistant turn.
      currentAssistant = null;
      toolPartByCallId.clear();

      // A permanent bot thread's history summary (LangChain's summarization
      // middleware) stands in for the turns it replaced. Show a marker, not
      // the summary text posing as something the user typed.
      if (m.additional_kwargs?.lc_source === SUMMARIZATION_SOURCE) {
        out.push({ id, role: 'assistant', parts: [{ type: 'text', text: SUMMARY_MARKER_TEXT }] });
        continue;
      }

      const text = extractText(m.content);
      const fromBot = readFromBot(m.additional_kwargs);
      const fromRoutine = readFromRoutine(m.additional_kwargs);
      const experimental_attachments: { url: string; contentType?: string }[] = [];
      const parts: UIPart[] = [];

      const selection = readInsightSelectionKwarg(m.additional_kwargs);
      if (selection) parts.push({ type: INSIGHT_SELECTION_PART_TYPE, data: selection });

      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const template = parseInsightTemplateBlock((block as { text?: string }).text ?? '');
            if (template) parts.push({ type: INSIGHT_TEMPLATE_PART_TYPE, data: template });
          }
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'image_url') {
            const imgUrl = (block as { image_url?: { url?: string } }).image_url?.url;
            if (imgUrl) {
              // Extract content type from data URI (data:image/png;base64,...)
              const contentType = imgUrl.split(';')[0]?.split(':')[1] || 'image/png';
              experimental_attachments.push({ url: imgUrl, contentType });
            }
          }
        }
      }

      if (text) parts.push({ type: 'text', text });
      if (parts.length === 0 && experimental_attachments.length === 0) continue;
      out.push({
        id,
        role: 'user',
        parts,
        experimental_attachments: experimental_attachments.length > 0 ? experimental_attachments : undefined,
        ...(fromBot || fromRoutine
          ? { metadata: { ...(fromBot ? { fromBot } : {}), ...(fromRoutine ? { fromRoutine } : {}) } }
          : {}),
      });
      continue;
    }

    if (kind === 'ai') {
      // Start or continue the current assistant turn.
      if (!currentAssistant) {
        currentAssistant = { id, role: 'assistant', parts: [] };
        out.push(currentAssistant);
      }

      const text = extractText(m.content);
      if (text) currentAssistant.parts.push({ type: 'text', text });

      const toolCalls = (m as { tool_calls?: Array<{ id?: string; name?: string; args?: unknown }> })
        .tool_calls;
      if (toolCalls?.length) {
        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j];
          const toolName = tc.name ?? 'tool';
          const toolCallId = tc.id ?? `${id}-tc-${j}`;
          const part: ToolPart = {
            type: 'dynamic-tool',
            toolCallId,
            toolName,
            state: 'input-available',
            input: tc.args,
          };
          currentAssistant.parts.push(part);
          toolPartByCallId.set(toolCallId, part);
        }
      }
      continue;
    }

    if (kind === 'tool') {
      // Back-attach the tool result onto the matching assistant tool part
      // in the current turn.
      const toolMsg = m as BaseMessage & { tool_call_id?: string };
      const toolCallId = toolMsg.tool_call_id;
      if (!toolCallId) continue;
      const part = toolPartByCallId.get(toolCallId);
      if (!part) continue;
      const content =
        typeof toolMsg.content === 'string' ? toolMsg.content : extractText(toolMsg.content);
      part.state = 'output-available';
      part.output = { kwargs: { content } };
    }
  }
  // Drop empty assistant turns (no text and no tools — shouldn't happen, but
  // be defensive).
  return out.filter((msg) => msg.parts.length > 0);
}

/**
 * The thread's latest turn — its last human message and everything after it —
 * as UI messages: the user message (when it rendered at all) and the merged
 * assistant reply. What the history writer stores after each turn.
 */
export function lastTurnUIMessages(messages: BaseMessage[]): UIMessageOut[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._getType() !== 'human') continue;
    if (m.additional_kwargs?.lc_source === SUMMARIZATION_SOURCE) continue;
    return toUIMessages(messages.slice(i));
  }
  return [];
}
