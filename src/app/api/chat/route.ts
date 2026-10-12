import { after, NextRequest, NextResponse } from 'next/server';
import {
  AIMessage,
  extractFirstTurn,
  extractLastTurn,
  asEffortChoice,
  asManualEffort,
  EFFORT_TIERS,
  type EffortChoice,
} from '@/lib/agents/analysis';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import { getActiveWorkspaceId, workspaceSlugFromClaims } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { isCacheableResponse } from '@/lib/services/copilotChatsService';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';
import { auth } from '@/auth';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { toBaseMessages } from '@ai-sdk/langchain';
import { createUIMessageStream, createUIMessageStreamResponse, UIMessage } from 'ai';
import {
  ChatAttachmentForbiddenError,
  type ChatAttachmentRef,
} from '@/lib/services/chatAttachmentService';
import { chatCacheEnabled, copilotMemoryEnabled, sourceOfFundsEnabled } from '@/lib/flags';
import { flushLangfuse } from '@/lib/langfuse';
import { generateChatTitle } from '@/lib/chat/title';
import { sanitizePageContext } from '@/lib/chat/pageContext';
import { stripComposerMarkup } from '@/lib/chat/composerMarkup';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { CHAT_MESSAGE_SENT, chatMessageSentProperties } from '@/lib/posthog-chat';
import { resolveChatAgentGraph } from '@/lib/chat/chatAgent';
import { formatInsightChatContext } from '@/lib/insights/chatOutline';
import {
  isTooLargeInsightTemplateBlock,
  readInsightTemplatePart,
} from '@/lib/insights/templateAttachment';
import {
  formatInsightSelectionBlock,
  INSIGHT_SELECTION_KWARG,
  readInsightSelectionPart,
  withInsightSelection,
} from '@/lib/insights/selectionAttachment';
import {
  CHAT_ATTACHMENTS_KWARG,
  latestUserAttachments,
  previousTurnTimedOut,
  wholeDocumentToolsToWithhold,
  timeoutFollowUpContext,
} from '@/lib/chat/largeDocumentTurn';
import {
  OPEN_INSIGHT_EFFORT_FLOOR,
  routeEffort,
  shouldRoute,
  resolveTurnEffort,
} from '@/lib/chat/effortRouter';
import {
  isGraphRecursionError,
  RECURSION_LIMIT_ERROR_MESSAGE,
  toThinkingMessageStream,
} from '@/lib/chat/thinkingStream';
import {
  buildBudgetNotice,
  summarizeAbandonedTurn,
  withBudgetWrapUp,
} from '@/lib/chat/turnBudget';

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
    // 'auto' (or anything unrecognised) means the client is deferring to the
    // server. An explicit tier pins the thread; see resolveEffort below.
    // Narrowed with asManualEffort, not asEffortChoice: a client must not be
    // able to pin a thread to the Auto-only `deep` tier by posting the string.
    const requestedEffort = asManualEffort(body.effort);

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const {
      chatService,
      copilotChatsService,
      chatAttachmentService,
      insightTemplateService,
      insightService,
      workspaceService,
      userMemoryService,
    } = createContainer(db, workspaceId);

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

    // The insight open on screen (MB-550): a compact outline of its current
    // version rides on this turn's system context, so a question can be asked
    // in the insight's own terms. Started now so the read overlaps the setup
    // below. Best-effort — a failure only means this turn goes without it.
    const openInsightId = pageContext?.insightId;
    const insightContextPromise: Promise<string | null> = openInsightId
      ? (async () => {
          const context = await insightService.getChatContext(workspaceId, openInsightId);
          return context ? formatInsightChatContext(context) : null;
        })().catch((err: unknown) => {
          console.error('[chat] failed to build the open insight context:', err);
          return null;
        })
      : Promise.resolve(null);

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

    const contextData = await chatService.buildContext();
    // Auth-sensitive values (the user's email) and per-user bytes (the user's
    // name) are NOT in `contextData`; they travel via `configurable` so tools
    // can read them as parameters rather than parsing them out of LLM-facing
    // instructions, keeping the cached system prompt prefix identical across users.
    const userEmail = session.user.email ?? null;
    const userName = session.user.name ?? null;

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

    // An insight template attached in the composer rides on the message as a
    // `data-insight-template` part. Read it before the parts are narrowed to
    // text; it is expanded into the human turn below.
    const insightTemplate = readInsightTemplatePart(
      (lastUserUI as { parts?: unknown }).parts,
    );
    // Elements picked with the insight selection tool ride the same way, as a
    // `data-insight-selection` part; the text part is only the user's words.
    const insightSelection = readInsightSelectionPart(
      (lastUserUI as { parts?: unknown }).parts,
    );

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
    // The turn as plain text, selection addresses included, for the readers that
    // never see the content blocks: effort routing and the question recorded
    // against research tool calls.
    const turnText = withInsightSelection(firstUserText, insightSelection);

    // What the CoPilot remembers about this user (mem0, see src/lib/memory).
    // Two switches: the deployment kill-switch, and the user's own
    // `copilot_memory_enabled`. The service reads the second itself (and
    // memoizes it), so the recall below is safe even before `memoryEnabled`
    // resolves — it is awaited only to decide whether to schedule the
    // write-back.
    //
    // Started here so the recall — an embedding plus one indexed query —
    // overlaps the attachment upload and the flag/workspace reads below rather
    // than adding its latency on top of them. Best-effort by construction:
    // `recallForTurn` resolves to null on any failure or past its deadline,
    // and the turn runs without memory.
    const memory = userMemoryService(userId);
    const memoryAllowed = await copilotMemoryEnabled();
    const memoryContextPromise: Promise<string | null> = memoryAllowed
      ? memory.recallForTurn(turnText).catch((err: unknown) => {
          console.error('[chat] memory recall failed:', err);
          return null;
        })
      : Promise.resolve(null);

    // Auto tiering. Kicked off HERE and awaited just before the graph is built,
    // so the routing call overlaps the attachment upload and the workspace/flag
    // lookups below instead of adding its latency on top of them.
    //
    // `shouldRoute` keeps this to one call per thread: a thread that has already
    // been routed reuses its stored tier unless the turn brings a new
    // attachment, which is the one cheap signal that the work just got heavier.
    // An attached insight template counts: it is a whole document to author.
    const storedEffort = asEffortChoice(chat.effort_tier);
    const hasAttachments = attachments.length > 0 || insightTemplate !== null;
    const routedEffortPromise: Promise<EffortChoice | null> =
      requestedEffort === null && shouldRoute(storedEffort, hasAttachments)
        ? routeEffort(
            {
              // Despite the name, this holds THIS turn's text (it is derived
              // from `normalizedLast`), which is what we want to route on.
              message: turnText,
              hasAttachments,
              pageSummary: pageContext?.path ?? null,
            },
            process.env.ANTHROPIC_API_KEY ?? '',
          )
        : Promise.resolve(null);

    // When the turn carries attachments or an insight template, build the human
    // message ourselves: files become Files-API `file` / image / extracted-text
    // blocks, and the template becomes an `<insight_template>` text block placed
    // before the user's words. `toBaseMessages` only preserves text.
    // `uploadedFileIds` is what we clean up when the turn finishes, is stopped,
    // or the connection drops.
    //
    // A template or HTML file too large for chat arrives as an outline plus a
    // hard instruction to hand it to the Workforce (`largeHtml: 'outline'`);
    // `carriesTooLargeDocument` also withholds the whole-document tools below.
    // The turn's attachment refs are recorded on the message's
    // additional_kwargs (never sent to the model), so a handoff on a later
    // turn can still carry the file.
    let messages: BaseMessage[];
    let uploadedFileIds: string[] = [];
    let carriesTooLargeDocument = false;
    if (attachments.length > 0 || insightTemplate || insightSelection) {
      try {
        const templateBlocks = insightTemplate
          ? [await insightTemplateService.prepareForMessage(insightTemplate)]
          : [];
        const { blocks, fileIds, outlinedHtml } = await chatAttachmentService.prepareForMessage(
          attachments,
          { largeHtml: 'outline' },
        );
        uploadedFileIds = fileIds;
        carriesTooLargeDocument =
          outlinedHtml.length > 0 ||
          templateBlocks.some((block) => isTooLargeInsightTemplateBlock(block.text));
        const fallbackText = attachments.length > 0
          ? 'Please review the attached file(s).'
          : insightTemplate
            ? 'Create an insight from the attached template.'
            : 'Tell me about the selected part of the insight.';
        // Recorded on the message, never sent to the model: the attachment
        // refs for a later handoff, and the selection so a reloaded chat can
        // re-render its chip.
        const additionalKwargs = {
          ...(attachments.length > 0
            ? { [CHAT_ATTACHMENTS_KWARG]: chatAttachmentService.ownedRefs(attachments) }
            : {}),
          ...(insightSelection ? { [INSIGHT_SELECTION_KWARG]: insightSelection } : {}),
        };
        messages = [
          new HumanMessage({
            content: [
              ...templateBlocks,
              ...(insightSelection
                ? [{ type: 'text' as const, text: formatInsightSelectionBlock(insightSelection) }]
                : []),
              { type: 'text', text: firstUserText || fallbackText },
              ...blocks,
            ],
            ...(Object.keys(additionalKwargs).length > 0
              ? { additional_kwargs: additionalKwargs }
              : {}),
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
    // 'investment' — funds & investing). A general thread runs on the matching
    // agent graph for the requested effort tier; defaults to 'mna' when unset.
    // A thread pinned to a sector agent ignores the flavor (see below).
    const copilotAgent = await workspaceService.getCopilotAgent(workspaceId);
    // Source-of-funds tracking is a per-workspace setting; when off, the agent
    // is built without the `query_fund_sources` tool (see getAgentGraph).
    const sofEnabled = await sourceOfFundsEnabled();
    const routed = await routedEffortPromise;
    // A turn made on an open insight is likely an edit, which rewrites the
    // whole document in one call — too long for `low` (see the floor's doc).
    const effort = resolveTurnEffort({
      requested: requestedEffort,
      stored: storedEffort,
      routed,
      floor: openInsightId ? OPEN_INSIGHT_EFFORT_FLOOR : null,
    });
    if (effort !== storedEffort) {
      await copilotChatsService.setEffortTier(chat.id, effort);
    }

    // Which agent this thread runs on (MB-549). Resolved from the insight the
    // chat was opened on and pinned on the thread's first turn; later turns
    // reuse the pin wherever the user is. Pinned before the response starts, so
    // the client's chat-list refresh on X-Chat-Id already sees it.
    const {
      graph: agent,
      agentKey,
      notice: agentNotice,
    } = await resolveChatAgentGraph(
      { chat, pageContext, effort, flavour: copilotAgent, sof: sofEnabled },
      { workspaceId, copilotChatsService, insightService },
    );
    const insightContext = await insightContextPromise;
    const memoryContext = await memoryContextPromise;
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
      // Stamped so this event answers a `workspace_slug` filter the same way
      // the client-side chat events do — those get the slug from the `/w/<slug>`
      // URL, this one from the session's membership claims (no DB call).
      workspaceSlug: workspaceSlugFromClaims(session.user.workspaces, workspaceId),
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

    // The thread's persisted history, read once for an existing thread: the
    // zero-work check, the earlier attachments and the file-reference rewrite
    // below all use this one read.
    const priorMessages = requestedChatId ? await agent.getMessages(chat.id) : [];

    // The previous turn hit its budget (it ended on a wrap-up), so "continue"
    // must not retry the same huge call: this turn is told to hand a document
    // off, and — like a turn carrying a document too large for chat — does not
    // get the whole-document tools.
    const previousTimeout = previousTurnTimedOut(priorMessages);
    const withheldTools = wholeDocumentToolsToWithhold({
      previousTurnTimedOut: previousTimeout !== null,
      carriesTooLargeDocument,
    });

    // A handoff carries this turn's attachments, or the thread's most recent
    // earlier ones, re-validated against this workspace.
    const priorAttachments =
      attachments.length > 0
        ? []
        : latestUserAttachments(priorMessages, (raw) => chatAttachmentService.ownedRefs(raw));

    // The one-turn "no sector agent on this insight" notice, the open
    // insight's outline and the zero-work follow-up ride on the per-invoke
    // system context, after the workspace context. System context is rebuilt
    // every turn and never written into the thread's messages, so the outline
    // always describes the insight open now, not the one open when the thread
    // started.
    // `memoryContext` sits after the workspace context and before anything
    // about the page: it is background on the person asking, not on the thing
    // being asked about.
    const additionalSystemContext =
      [
        contextData,
        memoryContext,
        agentNotice,
        insightContext,
        timeoutFollowUpContext(previousTimeout),
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;

    // Prior turns' persisted `file` blocks reference Anthropic uploads we
    // already deleted, so replaying the thread would 404. Repoint them at this
    // turn's fresh uploads (or neutralize them when nothing is attached) before
    // the agent runs. Only existing threads have history to fix.
    //
    // Also close orphaned tool_calls left when a prior run aborted mid-tool
    // (e.g. user switched chats during PPTX generation) — without a matching
    // ToolMessage Anthropic rejects the next turn.
    if (requestedChatId) {
      await agent.rewriteFileReferences(chat.id, uploadedFileIds, priorMessages);
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
    // A template- or selection-backed first turn is not cached: its text alone
    // doesn't say what was attached, so a later plain question could match it.
    // A turn that carried the no-sector-agent notice isn't cached either: its
    // answer opens with that statement, which is wrong anywhere else. Nor is a
    // turn made on an open insight (MB-550): its answer reads that insight.
    if (
      !requestedChatId &&
      !insightTemplate &&
      !insightSelection &&
      !agentNotice &&
      !openInsightId &&
      (await chatCacheEnabled())
    ) {
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

    // Record what this turn established, AFTER the response has streamed —
    // mem0's extraction is an LLM call plus embeddings, which has no business
    // on the user's critical path. Reads the persisted turn rather than the
    // request body so it sees the answer that was actually given (including a
    // budget wrap-up), and never runs for an aborted turn that persisted
    // nothing. Gated on the same flag as recall, so memory is all-or-nothing.
    //
    // Deliberately NOT a job row: it is a one-shot, best-effort side effect
    // with nothing to retry and no status anyone waits on. A failure is logged
    // and the turn stands.
    if (memoryAllowed) {
      after(async () => {
        try {
          const finalMessages = await agent.getMessages(chat.id);
          const { userText, assistantText } = extractLastTurn(finalMessages);
          if (!assistantText.trim()) return;
          await withBackgroundDb(async (bgDb) => {
            const { userMemoryService: bgMemoryService } = createContainer(bgDb, workspaceId);
            await bgMemoryService(userId).rememberTurn({
              userId,
              chatId: chat.id,
              userText,
              assistantText,
            });
          });
        } catch (err) {
          console.error('[chat] failed to record the turn to memory:', err);
        }
      });
    }

    const shouldGenerateTitle = !chat.title;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let titlePromise: Promise<string | null> | null = null;
    if (shouldGenerateTitle && apiKey) {
      let titlePromptText = stripComposerMarkup(firstUserText);
      if (!titlePromptText) titlePromptText = "Attached file(s)";
      // "make it blue" alone titles nothing; name the insight it was asked of.
      if (insightSelection) {
        titlePromptText = `About the insight "${insightSelection.insightName}": ${titlePromptText}`;
      }
      
      titlePromise = generateAndSaveTitle({
        chatId: chat.id,
        firstUserMessage: titlePromptText,
        apiKey,
      });
      after(() => titlePromise);
    }

    // X-Chat-Agent lets the CoPilot header show the thread's agent as soon as
    // the turn starts, without waiting for the chat list to refresh.
    const headers = { 'X-Chat-Id': chat.id, 'X-Chat-Agent': agentKey };

    // Per-tier turn budget.
    const budgetMs = EFFORT_TIERS[effort].turnBudgetMs;
    const budgetSignal = AbortSignal.timeout(budgetMs);
    const turnSignal = AbortSignal.any([req.signal, budgetSignal]);
    /** The budget fired and the user did not press stop. */
    const isBudgetAbort = () => budgetSignal.aborted && !req.signal.aborted;

    if (!returnIntermediateSteps) {
      const eventStream = await agent.streamEvents(
        { messages, additionalSystemContext, withheldTools },
        {
          version: 'v2',
          recursionLimit: 50,
          configurable: {
            thread_id: chat.id,
            userEmail,
            userName,
            agentRole: 'chat',
            pageContext,
            originalUserQuestion: turnText,
            attachments,
            // Read by propose_workforce_handoff when this turn has none.
            priorAttachments,
            // The thread's pinned agent, for stamping insight versions. From
            // the chat row, never a tool argument the model could choose.
            agent_key: agentKey,
          },
          // Propagate client disconnects (the UI's stop()/aborted fetch) and
          // the tier's turn budget down into LangGraph so the underlying
          // Anthropic request is cancelled and the graph stops executing — not
          // just the SSE stream to the client.
          signal: turnSignal,
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
          // A budget abort is handled by withBudgetWrapUp below and never
          // reaches here; if it somehow does, say so rather than going silent.
          if (isBudgetAbort()) {
            console.error(
              `[chat] turn budget of ${budgetMs}ms elapsed on tier "${effort}" (chat ${chat.id})`,
            );
            return buildBudgetNotice({ budgetMs });
          }
          if (req.signal.aborted || (error as Error)?.name === 'AbortError') {
            return '';
          }
          if (isGraphRecursionError(error)) {
            return RECURSION_LIMIT_ERROR_MESSAGE;
          }
          console.error(error);
          return 'Internal server error';
        },
        execute: async ({ writer }) => {
          writer.merge(
            withBudgetWrapUp(toThinkingMessageStream(eventStream, writer), {
              isBudgetAbort,
              // Stage two: the graph is stopped, but the tool rounds it did
              // finish are in the checkpoint. Spend the headroom under
              // maxDuration turning them into an answer, and persist it so the
              // thread does not reload ending on a tool result.
              wrapUp: async () => {
                console.error(
                  `[chat] turn budget of ${budgetMs}ms elapsed on tier "${effort}" (chat ${chat.id}) — wrapping up`,
                );
                const persisted = await agent.getMessages(chat.id).catch(() => []);
                const text = await summarizeAbandonedTurn({
                  messages: persisted,
                  budgetMs,
                  apiKey,
                });
                try {
                  await agent.seedMessages(chat.id, [new AIMessage(text)]);
                } catch (err) {
                  console.error('[chat] failed to persist wrap-up message:', err);
                }
                return text;
              },
            }),
          );
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
          { messages, additionalSystemContext, withheldTools },
          {
            recursionLimit: 50,
            configurable: {
              thread_id: chat.id,
              userEmail,
              userName,
              agentRole: 'chat',
              pageContext,
              originalUserQuestion: turnText,
              attachments,
              priorAttachments,
              agent_key: agentKey,
            },
            signal: turnSignal,
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
      } catch (invokeErr) {
        // Debug path: no stream to wrap up into, so report the budget plainly
        // instead of surfacing a bare AbortError as a 500.
        if (isBudgetAbort()) {
          return NextResponse.json(
            { error: buildBudgetNotice({ budgetMs }) },
            { status: 504, headers },
          );
        }
        if (isGraphRecursionError(invokeErr)) {
          return NextResponse.json(
            { error: RECURSION_LIMIT_ERROR_MESSAGE },
            { status: 400, headers },
          );
        }
        throw invokeErr;
      } finally {
        // Non-streaming path fully resolves here, so a finally reliably tears
        // down the per-turn Anthropic uploads on success, error, or abort.
        await cleanupAttachments();
        await flushLangfuse();
      }
    }
  } catch (e: unknown) {
    if (isGraphRecursionError(e)) {
      return NextResponse.json(
        { error: RECURSION_LIMIT_ERROR_MESSAGE },
        { status: 400 },
      );
    }
    const err = e as { message?: string; status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
