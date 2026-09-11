import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { getAgentGraph } from '@/lib/agents/analysis';
import {
  ChatRequestError,
  prepareConversationRun,
  eventStreamToSse,
} from '@/lib/server/apiChatSupport';

/**
 * External chat API — streaming. Authenticated by API key (Bearer token,
 * `chat:write` scope). Streams the assistant reply as Server-Sent Events using
 * a stable contract (`delta`, `tool_call`, `done`, `error`) that does not
 * depend on AI SDK internals.
 *
 *   POST /api/v1/chat/stream
 *   Authorization: Bearer mna_...
 *   { "conversation_id"?: string, "messages": [{ "role": "user", "content": "..." }] }
 */
export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { apiKeyService, apiChatConversationService } = createContainer(db, await getActiveWorkspaceId());

    const body = await req.json().catch(() => undefined);
    const { conversationId, messages, originalUserQuestion } = await prepareConversationRun(
      req,
      body,
      { apiKeyService, apiChatConversationService },
    );

    const agent = await getAgentGraph();
    if (!agent) {
      return NextResponse.json(
        { error: 'Chat agent unavailable' },
        { status: 503 },
      );
    }

    const eventStream = await agent.streamEvents(
      { messages },
      {
        version: 'v2',
        recursionLimit: 50,
        configurable: { thread_id: conversationId, originalUserQuestion },
      },
    );

    const sse = eventStreamToSse(eventStream, conversationId);

    return new Response(sse, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Conversation-Id': conversationId,
      },
    });
  } catch (err) {
    if (err instanceof ChatRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
