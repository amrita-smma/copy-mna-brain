import { after, NextRequest, NextResponse } from 'next/server';
import { getAgentGraph, AIMessage, extractFirstTurn, type EffortChoice } from '@/lib/agents/analysis';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { isCacheableResponse } from '@/lib/services/copilotChatsService';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';
import { auth } from '@/auth';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { toUIMessageStream, toBaseMessages } from '@ai-sdk/langchain';
import { createUIMessageStream, createUIMessageStreamResponse, UIMessage } from 'ai';
import {
  ChatAttachmentForbiddenError,
  type ChatAttachmentRef,
} from '@/lib/services/chatAttachmentService';
import { chatCacheEnabled, sourceOfFundsEnabled } from '@/lib/flags';
import { flushLangfuse } from '@/lib/langfuse';
import { generateChatTitle } from '@/lib/chat/title';
import { sanitizePageContext } from '@/lib/chat/pageContext';
import { stripComposerMarkup } from '@/lib/chat/composerMarkup';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { CHAT_MESSAGE_SENT, chatMessageSentProperties } from '@/lib/posthog-chat';

/** Allow long Anthropic pptx-skill runs inside send_email (up to ~10 min). */
export const maxDuration = 600;

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
    const title = await generateChatTitle(opts.firstUserMessage, opts.apiKey);
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
    const effort: EffortChoice =
      body.effort === 'high' ? 'high' : 'medium';

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { chatService, copilotChatsService, chatAttachmentService, workspaceService } =
      createContainer(db, workspaceId);

    // Composer attachments the client is carrying for this turn. Each is an S3
    // key under the workspace's `chat-attachments/` prefix plus display
    // metadata; the file itself persists in S3 across turns and is uploaded to
    // Anthropic per-request (and deleted again once the turn settles).
    const attachments: ChatAttachmentRef[] = Array.isArray(body.attachments)
      ? (body.attachments as ChatAttachmentRef[])
      : [];

    // What the user is looking at in the center console. Browser-supplied, so
    // it is normalized (unknown tab dropped, path shape enforced, detail
    // clamped) before it can reach a prompt. Travels via `configurable`, like
    // `userEmail` — the model reads it through `read_page_context`, never as an
    // argument it could fabricate.
    const pageContext = sanitizePageContext(body.page_context);

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

    const firstUserText = (normalizedLast.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && 'text' in p)
      .map((p) => p.text)
      .join('\n');

    // When the turn carries attachments, upload each to Anthropic's Files API
    // and build the human message ourselves with `file` content blocks —
    // `toBaseMessages` only preserves text. `uploadedFileIds` is what we clean
    // up when the turn finishes, is stopped, or the connection drops.
    let messages: BaseMessage[];
    let uploadedFileIds: string[] = [];
    if (attachments.length > 0) {
      try {
        const { blocks, fileIds } = await chatAttachmentService.prepareForMessage(attachments);
        uploadedFileIds = fileIds;
        messages = [
          new HumanMessage({
            content: [
              {
                type: 'text',
                text: firstUserText || 'Please review the attached file(s).',
              },
              ...blocks,
            ],
          }),
        ];
      } catch (err) {
        if (err instanceof ChatAttachmentForbiddenError) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        throw err;
      }
    } else {
      messages = await toBaseMessages([normalizedLast]);
    }

    // Best-effort, idempotent teardown of the per-turn Anthropic uploads. Wired
    // to both `after()` (normal completion of the streamed response) and the
    // request's abort signal (the UI's stop() or a dropped SSE connection).
    let attachmentsCleaned = false;
    const cleanupAttachments = async () => {
      if (attachmentsCleaned || uploadedFileIds.length === 0) return;
      attachmentsCleaned = true;
      await chatAttachmentService.deleteFromAnthropic(uploadedFileIds);
    };
    if (uploadedFileIds.length > 0) {
      req.signal.addEventListener('abort', () => {
        void cleanupAttachments();
      });
    }

    // The workspace picks its Copilot flavor ('mna' — M&A/acquisitions — or
    // 'investment' — funds & investing). Resolve it and select the matching
    // agent graph for the requested effort tier; defaults to 'mna' when unset.
    const copilotAgent = await workspaceService.getCopilotAgent(workspaceId);
    // Source-of-funds tracking is a per-workspace setting; when off, the agent
    // is built without the `query_fund_sources` tool (see getAgentGraph).
    const sofEnabled = await sourceOfFundsEnabled();
    const agent = await getAgentGraph(copilotAgent, effort, sofEnabled);
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

    // `chat_message_sent` — one event per user turn, captured here rather than
    // in the composer for the reason given on `captureUserEvent`: a server
    // capture is the only kind an ad blocker cannot drop, and this is the
    // headline engagement metric. Emitted after the turn is fully validated
    // (auth, chat ownership, attachment access, agent availability) so the
    // count means "a turn actually ran", not "a request arrived".
    captureWorkspaceEvent({
      workspaceId,
      distinctId: userId,
      event: CHAT_MESSAGE_SENT,
      properties: chatMessageSentProperties({
        chatId: chat.id,
        isNewChat: !requestedChatId,
        effort,
        attachmentCount: attachments.length,
        // The user's own words, not the `📎 Attached: …` lines the composer
        // appends — otherwise an attachment-only turn records a non-zero
        // length and a long filename inflates a short prompt.
        messageLength: stripComposerMarkup(firstUserText).length,
        copilotAgent,
        hasPageContext: Boolean(pageContext),
        pageContextTab: pageContext?.tabSlug ?? null,
      }),
    });

    // Prior turns' persisted `file` blocks reference Anthropic uploads we
    // already deleted, so replaying the thread would 404. Repoint them at this
    // turn's fresh uploads (or neutralize them when nothing is attached) before
    // the agent runs. Only existing threads have history to fix.
    //
    // Also close orphaned tool_calls left when a prior run aborted mid-tool
    // (e.g. user switched chats during PPTX generation) — without a matching
    // ToolMessage Anthropic rejects the next turn.
    if (requestedChatId) {
      await agent.rewriteFileReferences(chat.id, uploadedFileIds);
      await agent.repairOrphanedToolCalls(chat.id);
    }

    // Title generation runs in parallel with the agent stream (see below) so
    // the title is ready sooner. `after()` keeps the runtime alive until the
    // promise resolves. Intentionally NOT going through the jobs table: it's a
    // one-shot side effect with no need for status tracking, retry, or
    // visibility. `firstUserText` is computed above with the message.

    // First turn of a brand-new chat → cache it AFTER the run finishes, never at
    // the start. Once the response stream closes we read the persisted turn-1
    // and only record the cache key when the assistant produced a complete,
    // substantial answer (`isCacheableResponse`). This keeps partial/aborted/
    // errored runs out of the cache. Gated on `!requestedChatId` so we never
    // touch a resumed thread, and on the `chatCacheEnabled` flag so caching can
    // be turned off entirely.
    if (!requestedChatId && (await chatCacheEnabled())) {
      after(async () => {
        try {
          const finalMessages = await agent.getMessages(chat.id);
          const { assistantText } = extractFirstTurn(finalMessages);
          if (isCacheableResponse(assistantText)) {
            await withBackgroundDb(async (bgDb) => {
              const { copilotChatsService: bgChatsService } = createContainer(bgDb, workspaceId);
              await bgChatsService.recordFirstMessage(chat.id, firstUserText);
            });
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
      let titlePromptText = stripComposerMarkup(firstUserText);
      if (!titlePromptText) titlePromptText = "Attached file(s)";
      
      titlePromise = generateAndSaveTitle({
        chatId: chat.id,
        firstUserMessage: titlePromptText,
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
          configurable: {
            thread_id: chat.id,
            userEmail,
            agentRole: 'chat',
            pageContext,
            originalUserQuestion: firstUserText,
          },
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

      // Delete the per-turn Anthropic uploads once the streamed response has
      // fully drained (the abort listener covers the stopped/disconnected case).
      after(cleanupAttachments);
      // LangChain callbacks are non-blocking; flush after the turn so Copilot
      // traces aren't dropped when the request ends.
      after(() => flushLangfuse());

      return createUIMessageStreamResponse({ stream, headers });
    } else {
      try {
        const result = await agent.invoke(
          { messages, additionalSystemContext: contextData || undefined },
          {
            recursionLimit: 50,
            configurable: {
              thread_id: chat.id,
              userEmail,
              agentRole: 'chat',
              pageContext,
              originalUserQuestion: firstUserText,
            },
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
      } finally {
        // Non-streaming path fully resolves here, so a finally reliably tears
        // down the per-turn Anthropic uploads on success, error, or abort.
        await cleanupAttachments();
        await flushLangfuse();
      }
    }
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
