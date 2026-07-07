import { after, NextRequest, NextResponse } from 'next/server';
import { getAgentGraph, AIMessage, extractFirstTurn } from '@/lib/agents/analysis';
import { ChatAnthropic } from '@langchain/anthropic';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { isCacheableResponse } from '@/lib/services/copilotChatsService';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';
import { auth } from '@/auth';
import { BaseMessage } from '@langchain/core/messages';
import { toUIMessageStream, toBaseMessages } from '@ai-sdk/langchain';
import { createUIMessageStream, createUIMessageStreamResponse, UIMessage } from 'ai';

const convertLangChainMessageToVercelMessage = (message: BaseMessage) => {
  if (message._getType() === 'human') {
    return { content: message.content, role: 'user' };
  } else if (message._getType() === 'ai') {
    return {
      content: message.content,
      role: 'assistant',
      tool_calls: (message as AIMessage).tool_calls,
    };
  } else {
    return { content: message.content, role: message._getType() };
  }
};

async function generateAndSaveTitle(opts: {
  chatId: string;
  firstUserMessage: string;
  apiKey: string;
}): Promise<string | null> {
  try {
    const llm = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: opts.apiKey,
      temperature: 0,
      maxTokens: 60,
    });
    const res = await llm.invoke([
      {
        role: 'system',
        content:
          'Produce a concise 2-5 word title for the following user message. ' +
          'Return only the title, no quotes, no trailing punctuation.',
      },
      { role: 'user', content: opts.firstUserMessage },
    ]);
    const title = String(res.content).trim().slice(0, 80);
    if (!title) return null;

    const db = createDb();
    const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());
    await copilotChatsService.setTitle(opts.chatId, title);
    return title;
  } catch (err) {
    console.error('[chat] title generation failed:', err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const returnIntermediateSteps = body.show_intermediate_steps;
    const requestedChatId: string | undefined = body.chat_id;

    const db = createDb();
    const { chatService, copilotChatsService } = createContainer(db, await getActiveWorkspaceId());

    let chat;
    if (requestedChatId) {
      try {
        chat = await copilotChatsService.assertOwnedBy(requestedChatId, userId);
      } catch (err) {
        if (err instanceof CopilotChatNotFoundError) {
          return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
        }
        if (err instanceof CopilotChatForbiddenError) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        throw err;
      }
    } else {
      chat = await copilotChatsService.create(userId);
    }

    const contextData = await chatService.buildContext({
      user: { name: session.user.name ?? null },
    });
    // Auth-sensitive values (the user's email) are NOT in `contextData`; they
    // travel via `configurable` so tools can read them as parameters rather
    // than parsing them out of LLM-facing instructions.
    const userEmail = session.user.email ?? null;

    // The client posts the full UI message history; with a checkpointer we
    // only feed the latest user turn — prior state is rehydrated by the
    // saver via thread_id.
    const filteredMessages = (body.messages ?? []).filter(
      (m: { role: string }) => m.role === 'user' || m.role === 'assistant',
    );
    const lastUserUI = [...filteredMessages]
      .reverse()
      .find((m: { role: string }) => m.role === 'user');
    if (!lastUserUI) {
      return NextResponse.json({ error: 'No user message in request' }, { status: 400 });
    }

    const normalizedLast: UIMessage = ((): UIMessage => {
      const m = lastUserUI as { role: string; parts?: { type: string }[]; content?: unknown };
      if (m.parts && Array.isArray(m.parts)) {
        return { ...m, parts: m.parts.filter((p) => p.type === 'text') } as UIMessage;
      }
      return {
        ...m,
        parts: m.content
          ? [
              {
                type: 'text',
                text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              },
            ]
          : [],
      } as UIMessage;
    })();

    const messages: BaseMessage[] = await toBaseMessages([normalizedLast]);

    const agent = await getAgentGraph();
    if (!agent) {
      return NextResponse.json(
        {
          error:
            'Agent not available. Check server logs — likely a missing ANTHROPIC_API_KEY, ' +
            'misconfigured DB env (DB_HOST/DB_PORT/DB_NAME/DB_USER + DB_PASSWORD or RDS_IAM_DB_AUTH), ' +
            'or a checkpointer setup failure.',
        },
        { status: 500 },
      );
    }

    await copilotChatsService.touchLastActive(chat.id);

    // First message of the chat → start title generation in parallel with the
    // agent stream so the title is ready sooner. `after()` keeps the runtime
    // alive until the promise resolves. Intentionally NOT going through the
    // jobs table: title generation is a one-shot side effect with no need
    // for status tracking, retry, or visibility.
    const firstUserText = (normalizedLast.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && 'text' in p)
      .map((p) => p.text)
      .join('\n');

    // First turn of a brand-new chat → cache it AFTER the run finishes, never at
    // the start. Once the response stream closes we read the persisted turn-1
    // and only record the cache key when the assistant produced a complete,
    // substantial answer (`isCacheableResponse`). This keeps partial/aborted/
    // errored runs out of the cache. Gated on `!requestedChatId` so we never
    // touch a resumed thread.
    if (!requestedChatId) {
      after(async () => {
        try {
          const finalMessages = await agent.getMessages(chat.id);
          const { assistantText } = extractFirstTurn(finalMessages);
          if (isCacheableResponse(assistantText)) {
            await copilotChatsService.recordFirstMessage(chat.id, firstUserText);
          }
        } catch (err) {
          console.error('[chat] failed to record cache entry:', err);
        }
      });
    }

    const shouldGenerateTitle = !chat.title;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let titlePromise: Promise<string | null> | null = null;
    if (shouldGenerateTitle && apiKey) {
      titlePromise = generateAndSaveTitle({
        chatId: chat.id,
        firstUserMessage: firstUserText,
        apiKey,
      });
      after(() => titlePromise);
    }

    const headers = { 'X-Chat-Id': chat.id };

    if (!returnIntermediateSteps) {
      const eventStream = await agent.streamEvents(
        { messages, additionalSystemContext: contextData || undefined },
        {
          version: 'v2',
          recursionLimit: 50,
          configurable: { thread_id: chat.id, userEmail },
          // Propagate client disconnects (the UI's stop()/aborted fetch) down
          // into LangGraph so the underlying Anthropic request is cancelled and
          // the graph stops executing — not just the SSE stream to the client.
          signal: req.signal,
        },
      );

      // Wrap the langchain stream so we can also push a transient data part
      // carrying the freshly-generated chat title the moment Haiku resolves —
      // the client picks it up via useChat's onData and updates the sidebar
      // without waiting for the agent stream to finish or polling the DB.
      const stream = createUIMessageStream({
        // The client aborting mid-stream surfaces here as an AbortError once
        // the signal propagates through LangGraph. That's expected teardown,
        // not a real failure — swallow it so it doesn't reach the (already
        // gone) client or pollute logs.
        onError: (error) => {
          if (req.signal.aborted || (error as Error)?.name === 'AbortError') {
            return '';
          }
          console.error(error);
          return 'Internal server error';
        },
        execute: async ({ writer }) => {
          writer.merge(toUIMessageStream(eventStream));
          if (titlePromise) {
            // Cap so a slow Haiku call can't hold the response open.
            const title = await Promise.race([
              titlePromise,
              new Promise<null>((r) => setTimeout(() => r(null), 15000)),
            ]);
            if (title) {
              writer.write({
                type: 'data-chat-title',
                data: { chatId: chat.id, title },
                transient: true,
              });
            }
          }
        },
      });

      return createUIMessageStreamResponse({ stream, headers });
    } else {
      const result = await agent.invoke(
        { messages, additionalSystemContext: contextData || undefined },
        {
          recursionLimit: 50,
          configurable: { thread_id: chat.id, userEmail },
          signal: req.signal,
        },
      );

      const validMessages = result.messages.map((m: BaseMessage | string) => {
        if (typeof m === 'string') {
          return new AIMessage(m);
        }
        return m as BaseMessage;
      });

      return NextResponse.json(
        { messages: validMessages.map(convertLangChainMessageToVercelMessage) },
        { status: 200, headers },
      );
    }
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
