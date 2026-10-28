import { after, NextRequest, NextResponse } from 'next/server';
import { flushLangfuse } from '@/lib/langfuse';
import { runWithLangfuseUser } from '@/lib/langfuseUser';
import { runWithLangfuseWorkspaceId } from '@/lib/langfuseWorkspace';
import { TRACE_NAMES } from '@/lib/langfuseTraceNames';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  ChatRequestError,
  langfuseUserForApiKey,
  prepareConversationRun,
  eventStreamToSse,
} from '@/lib/server/apiChatSupport';
import { resolveChatAgentGraph } from '@/lib/chat/chatAgent';

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

    // The SSE reader is built inside the scope, not just `streamEvents`.
    // `eventStreamToSse` drains the event stream from inside the
    // ReadableStream's `start`, so building it here is what puts the drain —
    // and the tool calls it drives — on an async chain that inherits the
    // store. Merely creating the iterator in scope is not enough: a `for await`
    // run from outside reads an empty store, which would leave a trace a tool
    // hand-builds mid-drain (the pptx skill) unattributed.
    const sse = await runWithLangfuseUser(
      langfuseUserForApiKey(principal),
      () => runWithLangfuseWorkspaceId(db, workspaceId, async () => {
        const eventStream = await agent.streamEvents(
          { messages },
          {
            version: 'v2',
            runName: TRACE_NAMES.apiChat,
            recursionLimit: 50,
            configurable: { thread_id: conversationId, originalUserQuestion, agent_key: agentKey },
          },
        );
        return eventStreamToSse(eventStream, conversationId);
      }),
    );

    // Not a `finally`: streamEvents returns the iterator immediately and the
    // trace events are emitted while the SSE body drains, so the drain has to
    // outlive the handler. Same shape as the Copilot chat route.
    after(() => flushLangfuse());

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
