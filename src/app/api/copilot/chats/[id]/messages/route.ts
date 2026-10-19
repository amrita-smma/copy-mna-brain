import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';
import { getChatAgentGraph } from '@/lib/chat/chatAgent';
import { toChatAgentKey } from '@/lib/chat/chatAgentKey';
import type { BaseMessage } from '@langchain/core/messages';
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
type UIPart = TextPart | ToolPart | TemplatePart | SelectionPart;

interface UIMessageOut {
  id: string;
  role: 'user' | 'assistant';
  parts: UIPart[];
  experimental_attachments?: { url: string; contentType?: string }[];
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
function toUIMessages(messages: BaseMessage[]): UIMessageOut[] {
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

      const text = extractText(m.content);
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
        experimental_attachments: experimental_attachments.length > 0 ? experimental_attachments : undefined
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: chatId } = await params;

  const db = createDb();
  const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());

  let chat;
  try {
    chat = await copilotChatsService.assertOwnedBy(chatId, session.user.id);
  } catch (err) {
    if (err instanceof CopilotChatNotFoundError) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }
    if (err instanceof CopilotChatForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw err;
  }

  // Read through the thread's own agent (MB-549). Every graph shares one
  // checkpointer, so this never pins or resolves anything — an unresolved
  // thread just reads through the general graph.
  const agent = await getChatAgentGraph(toChatAgentKey(chat.agent_key));
  if (!agent) {
    return NextResponse.json({ messages: [] });
  }

  const baseMessages = await agent.getMessages(chatId);
  return NextResponse.json({ messages: toUIMessages(baseMessages) });
}
