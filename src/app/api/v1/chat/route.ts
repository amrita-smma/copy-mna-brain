import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import {
  getAgentGraph,
  AIMessage,
  extractMessageText,
} from '@/lib/agents/analysis';
import type { BaseMessage } from '@langchain/core/messages';
import {
  ChatRequestError,
  prepareConversationRun,
} from '@/lib/server/apiChatSupport';

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
    const { apiKeyService, apiChatConversationService } = createContainer(db);

    const body = await req.json().catch(() => undefined);
    const { conversationId, messages } = await prepareConversationRun(req, body, {
      apiKeyService,
      apiChatConversationService,
    });

    const agent = await getAgentGraph();
    if (!agent) {
      return NextResponse.json(
        { error: 'Chat agent unavailable' },
        { status: 503 },
      );
    }

    const result = await agent.invoke(
      { messages },
      { recursionLimit: 50, configurable: { thread_id: conversationId } },
    );

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
