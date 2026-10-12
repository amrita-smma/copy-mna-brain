import { NextRequest, NextResponse } from 'next/server';
import { flushLangfuse } from '@/lib/langfuse';
import { runWithLangfuseUser } from '@/lib/langfuseUser';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  AIMessage,
  extractMessageText,
} from '@/lib/agents/analysis';
import type { BaseMessage } from '@langchain/core/messages';
import {
  ChatRequestError,
  langfuseUserForApiKey,
  prepareConversationRun,
} from '@/lib/server/apiChatSupport';
import { resolveChatAgentGraph } from '@/lib/chat/chatAgent';

/**
 * External chat API — non-streaming. Authenticated by API key (Bearer token,
 * `chat:write` scope). Returns the assistant's full reply as JSON.
 *
 *   POST /api/v1/chat
 *   Authorization: Bearer mna_...
 *   { "conversation_id"?: string, "messages": [{ "role": "user", "content": "..." }] }
 */
export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { apiKeyService, apiChatConversationService, copilotChatsService, insightService } =
      createContainer(db, workspaceId);

    const body = await req.json().catch(() => undefined);
    const { principal, conversationId, messages, originalUserQuestion } =
      await prepareConversationRun(req, body, {
        apiKeyService,
        apiChatConversationService,
      });

    // External API conversations are not CoPilot threads and carry no page,
    // so they resolve to the general CoPilot with today's defaults. Going
    // through the resolver keeps every chat entrypoint on one rule (MB-549).
    const { graph: agent, agentKey } = await resolveChatAgentGraph(
      { chat: null, pageContext: null },
      { workspaceId, copilotChatsService, insightService },
    );
    if (!agent) {
      return NextResponse.json(
        { error: 'Chat agent unavailable' },
        { status: 503 },
      );
    }

    let result;
    try {
      // Filed under the calling API key rather than a person — see
      // langfuseUserForApiKey.
      result = await runWithLangfuseUser(langfuseUserForApiKey(principal), () =>
        agent.invoke(
          { messages },
          {
            recursionLimit: 50,
            configurable: { thread_id: conversationId, originalUserQuestion, agent_key: agentKey },
          },
        ),
      );
    } finally {
      // The external chat API runs the same agent as Copilot and so emits the
      // same traces; without this drain they are the only agent turns lost.
      await flushLangfuse();
    }

    const lastAi = [...result.messages]
      .reverse()
      .find((m): m is AIMessage => m instanceof AIMessage) as
      | AIMessage
      | undefined;

    return NextResponse.json(
      {
        data: {
          conversation_id: conversationId,
          message: {
            role: 'assistant',
            content: extractMessageText(lastAi as BaseMessage | undefined),
            tool_calls: lastAi?.tool_calls ?? [],
          },
        },
      },
      { status: 200, headers: { 'X-Conversation-Id': conversationId } },
    );
  } catch (err) {
    if (err instanceof ChatRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
