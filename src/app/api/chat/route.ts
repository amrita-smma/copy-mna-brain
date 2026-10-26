import { after, NextRequest, NextResponse } from 'next/server';
import {
  AIMessage,
  extractLastTurn,
  asManualEffort,
  EFFORT_TIERS,
  type EffortChoice,
} from '@/lib/agents/analysis';
import { lastHumanMessageId } from '@/lib/agents/analysis/messages';
import type { ThreadSnapshot } from '@/lib/agents/analysis/runtime';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import { getActiveWorkspaceId, workspaceSlugFromClaims } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';
import type { Session } from 'next-auth';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { toBaseMessages } from '@ai-sdk/langchain';
import { recallQueryFor } from '@/lib/memory/recallQuery';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse, UIMessage } from 'ai';
import {
  ChatAttachmentForbiddenError,
  type ChatAttachmentRef,
} from '@/lib/services/chatAttachmentService';
import { copilotMemoryEnabled, sourceOfFundsEnabled } from '@/lib/flags';
import { BotNotFoundError } from '@/lib/services/botService';
import { buildBotTurnOverride } from '@/lib/bots/threadMiddleware';
import { mayMentionBot } from '@/lib/bots/mentions';
import { TurnTimer } from '@/lib/chat/turnTimer';
import { hasTextContent } from '@/lib/chat/thinkingStream';
import {
  PresenceCallbackHandler,
  publishReply,
  startTurnPresence,
  watchStop,
  type StopWatch,
  type TurnPresence,
} from '@/lib/bots/presence';
import { turnToolNames } from '@/lib/bots/runBotTurn';
import { isCopilotAgentType } from '@/lib/agents/analysis/flavors/keys';
import { flushLangfuse, recordTurnTiming } from '@/lib/langfuse';
import { runWithLangfuseUser } from '@/lib/langfuseUser';
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
  fallbackEffort,
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

/**
 * Pass the agent's events through, marking the turn timer when the model
 * starts, when its first chunk arrives and when the first visible text
 * arrives — the three points "the copilot is slow" is actually about. The
 * timeline is logged at the first text (or at the end of the turn, whichever
 * comes first; `TurnTimer.log` runs once).
 */
async function* markFirstTokens<T>(
  events: AsyncIterable<T>,
  timer: TurnTimer,
  onFirstText: () => void,
): AsyncGenerator<T, void, unknown> {
  let sawText = false;
  for await (const event of events) {
    const e = event as { event?: string; data?: { chunk?: unknown } };
    if (e?.event === 'on_chat_model_start') {
      timer.mark('model_started');
    } else if (e?.event === 'on_chat_model_stream') {
      timer.mark('first_token');
      if (!sawText && hasTextContent(e.data?.chunk)) {
        sawText = true;
        timer.mark('first_text');
        onFirstText();
      }
    }
    yield event;
  }
}

/**
 * The route's uniform error shape. Shared by `POST` and `handleChatTurn` so
 * that splitting the handler in two did not leave `auth()` outside a `try` —
 * a rejected session decrypt has to render as JSON here, not as a bare 500.
 */
function chatErrorResponse(e: unknown) {
  if (isGraphRecursionError(e)) {
    return NextResponse.json(
      { error: RECURSION_LIMIT_ERROR_MESSAGE },
      { status: 400 },
    );
  }
  const err = e as { message?: string; status?: number };
  const status = err.status ?? 500;
  if (status >= 500) console.error('[chat] turn failed:', e);
  return NextResponse.json({ error: err.message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Every Langfuse trace this turn produces is filed under the signed-in
    // user: the agent run itself plus the side calls it makes (effort
    // routing, turn wrap-up), none of which take a user parameter. The
    // wrapper has to be out here, around the whole handler, because the
    // streaming branch builds its config deep inside it.
    const userId = session.user.id;
    return await runWithLangfuseUser(userId, () =>
      handleChatTurn(req, session, userId),
    );
  } catch (e: unknown) {
    return chatErrorResponse(e);
  }
}

async function handleChatTurn(req: NextRequest, session: Session, userId: string) {
  // Live state for the bot icons in every open tab (`@/lib/bots/presence`):
  // set once the lock is ours, cleared after it is released. The turn id
  // lets the sending tab tell its own turn's events from a background one.
  const turnId = randomUUID();
  // Where the time before the first token goes, stage by stage
  // (`src/lib/chat/turnTimer.ts`). Logged, and filed on the turn's Langfuse
  // trace, once the first text streams — or when the turn ends without any.
  const timer = new TurnTimer(`turn ${turnId.slice(0, 8)}`);
  timer.mark('auth');
  // The agent run's root run id, which the Langfuse LangChain handler uses as
  // the trace id. Once the question is stored it becomes the question row's id
  // (MB-693: feedback on the reply scores the trace by the id it already
  // holds); until then, or if storing fails, a fresh one. Either way the route
  // knows it before the run starts, which is what lets the timeline be filed
  // on the right trace after the run (`recordTurnTiming`).
  let traceRunId: string = randomUUID();
  let timelineRecorded = false;
  const recordTimeline = () => {
    if (timelineRecorded) return;
    timelineRecorded = true;
    timer.log();
    recordTurnTiming({
      traceId: traceRunId,
      stages: timer.stages(),
      firstTokenMs: timer.at('first_token'),
      firstTextMs: timer.at('first_text'),
    });
  };
  try {
    const body = await req.json();
    timer.mark('body');
    const returnIntermediateSteps = body.show_intermediate_steps;
    // Every turn runs on a Copilot bot (RFC 02): one permanent thread per user
    // per bot. No `bot_id` means the workspace default bot.
    const requestedBotId: string | undefined =
      typeof body.bot_id === 'string' && body.bot_id ? body.bot_id : undefined;
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
      botService,
      botMemoryService,
      chatHistoryService,
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

    // ---- Everything below until the thread open is CPU over the body. It
    // comes first so the reads that only depend on the body (recall, routing,
    // the open insight, the flags, the workspace context) can all be in
    // flight while the thread is opened, instead of starting after it.

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

    // What the CoPilot remembers about this user (mem0, see src/lib/memory).
    // Two switches: the deployment kill-switch, and the user's own
    // `copilot_memory_enabled`. The service reads the second itself (and
    // memoizes it), so the recall below is safe even before `memoryEnabled`
    // resolves — it is awaited only to decide whether to schedule the
    // write-back.
    //
    // Started here, before the thread is even opened, so the recall — an
    // embedding plus one indexed query — overlaps every read below rather
    // than adding its latency on top of them. Best-effort by construction:
    // `recallForTurn` resolves to null on any failure or past its deadline
    // (`RECALL_TIMEOUT_MS`), and the turn runs without memory.
    const memory = userMemoryService(userId);
    const memoryAllowed = await copilotMemoryEnabled();
    // A short follow-up searches with the previous user turn behind it
    // (`recallQueryFor`); the client sends the visible conversation, so that
    // turn is right here.
    const previousUserText = (() => {
      const users = filteredMessages.filter((m: { role: string }) => m.role === 'user');
      const previous = users[users.length - 2] as { parts?: { type: string; text?: string }[]; content?: unknown } | undefined;
      if (!previous) return null;
      if (Array.isArray(previous.parts)) {
        const text = previous.parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
        // The same reading as this turn's `turnText`: selection addresses included.
        return withInsightSelection(text, readInsightSelectionPart(previous.parts));
      }
      return typeof previous.content === 'string' ? previous.content : null;
    })();
    const memoryContextPromise: Promise<string | null> = memoryAllowed
      ? memory.recallForTurn(recallQueryFor(turnText, previousUserText)).catch((err: unknown) => {
          console.error('[chat] memory recall failed:', err);
          return null;
        })
      : Promise.resolve(null);

    // Auto tiering. Kicked off HERE, before the thread open, and awaited just
    // before the graph is built, so the routing call overlaps the thread open,
    // the context reads, the recall and any attachment upload instead of
    // adding its latency on top of them.
    //
    // A permanent bot thread picks its tier per turn: a stored, only-escalating
    // tier would leave every later turn on the most expensive one. An attached
    // insight template counts as an attachment: it is a whole document to author.
    const storedEffort = null;
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

    // Workspace-wide reads that do not depend on which bot answers: the
    // thesis + criteria context and the source-of-funds flag.
    const contextDataPromise = chatService.buildContext();
    // Source-of-funds tracking is a per-workspace setting; when off, the agent
    // is built without the `query_fund_sources` tool (see getAgentGraph).
    const sofEnabledPromise = sourceOfFundsEnabled();

    let opened;
    try {
      opened = requestedBotId
        ? await botService.openThread(userId, requestedBotId)
        : await botService.openDefaultThread(userId);
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      throw err;
    }
    const { bot, chat } = opened;
    timer.mark('thread_open');

    // The reads that need the bot, all at once: the other bots this one can
    // hand work to with an @mention, the notes the user asked this bot to
    // keep (explicit requests, so not behind the mem0 switch; best-effort
    // like the recall), and the flavor the bot runs on ('mna' — M&A — or
    // 'investment' — funds & investing, …; falling back to the workspace's).
    const [contextData, mentionContext, botMemoryContext, copilotAgent] = await Promise.all([
      contextDataPromise,
      botService.mentionContext(userId, bot.id).catch((err: unknown) => {
        console.error('[chat] failed to list the bots to mention:', err);
        return '';
      }),
      botMemoryService.promptContext(userId, bot.id).catch((err: unknown) => {
        console.error('[chat] bot memory lookup failed:', err);
        return null;
      }),
      isCopilotAgentType(bot.base_flavor)
        ? Promise.resolve(bot.base_flavor)
        : workspaceService.getCopilotAgent(workspaceId),
    ]);
    timer.mark('context');
    // Auth-sensitive values (the user's email) and per-user bytes (the user's
    // name) are NOT in `contextData`; they travel via `configurable` so tools
    // can read them as parameters rather than parsing them out of LLM-facing
    // instructions, keeping the cached system prompt prefix identical across users.
    const userEmail = session.user.email ?? null;
    const userName = session.user.name ?? null;

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
        // The template read and the file uploads are independent network
        // work; together, not one after the other.
        const [templateBlocks, prepared] = await Promise.all([
          insightTemplate
            ? insightTemplateService.prepareForMessage(insightTemplate).then((block) => [block])
            : Promise.resolve([]),
          chatAttachmentService.prepareForMessage(attachments, { largeHtml: 'outline' }),
        ]);
        const { blocks, fileIds, outlinedHtml } = prepared;
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
    timer.mark('attachments');

    // Best-effort, idempotent teardown of the per-turn Anthropic uploads, once
    // the turn has finished. Not on the request's abort: the turn outlives a
    // dropped connection and may still read them.
    let attachmentsCleaned = false;
    const cleanupAttachments = async () => {
      if (attachmentsCleaned || uploadedFileIds.length === 0) return;
      attachmentsCleaned = true;
      await chatAttachmentService.deleteFromAnthropic(uploadedFileIds);
    };

    // The turn runs to the end even when the browser disconnects (the user
    // navigated away): the stream is drained on the server, and the work
    // queued with `after()` waits for `turnFinished`. Only the turn budget or
    // an explicit Stop (`POST /api/copilot/chats/[id]/stop`, polled by
    // `stopPoll`) ends it early. Resolved now for the paths that never stream.
    let turnFinished: Promise<void> = Promise.resolve();
    let presence: TurnPresence | undefined;
    let stopWatch: StopWatch | undefined;

    const sofEnabled = await sofEnabledPromise;
    const routed = await routedEffortPromise;
    timer.mark('router');
    // A turn made on an open insight is likely an edit, which rewrites the
    // whole document in one call — too long for `low` (see the floor's doc).
    // A turn the router could not place runs at `low` when it is short and
    // carries nothing, `medium` otherwise (`fallbackEffort`).
    const effort = resolveTurnEffort({
      requested: requestedEffort,
      stored: storedEffort,
      routed,
      floor: openInsightId ? OPEN_INSIGHT_EFFORT_FLOOR : null,
      fallback: fallbackEffort({ message: turnText, hasAttachments }),
    });

    // Which agent this thread runs on. Bot threads are created pinned to the
    // general agent, so this resolves to the flavor graph with no lookup.
    const {
      graph: agent,
      agentKey,
      notice: agentNotice,
    } = await resolveChatAgentGraph(
      { chat, pageContext, effort, flavour: copilotAgent, sof: sofEnabled },
      { workspaceId, copilotChatsService, insightService },
    );
    timer.mark('graph_resolved');
    const insightContext = await insightContextPromise;
    const memoryContext = await memoryContextPromise;
    timer.mark('memory_recall');
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

    // A bookkeeping write nothing in this turn reads back; not worth a round
    // trip on the critical path.
    void Promise.resolve()
      .then(() => copilotChatsService.touchLastActive(chat.id))
      .catch((err: unknown) => {
        console.error('[chat] failed to touch the thread:', err);
      });

    // A bot turn runs on its flavor's cached graph with the bot's prompt,
    // skill tools and history summarization swapped in.
    const override = buildBotTurnOverride(agent, bot);

    // One turn at a time per thread: a bot answering an @mention or a routine
    // (a background job) writes this same checkpoint thread. Claimed before the
    // history read and the repairs below, which write to the thread too.
    // Released by the `after()` right below, once the turn is stored.
    if (!(await copilotChatsService.claimTurn(chat.id, maxDuration))) {
      return NextResponse.json(
        { error: `${bot.name} is working on a background task. Try again in a moment.` },
        { status: 409 },
      );
    }
    timer.mark('turn_claimed');
    presence = startTurnPresence({ workspaceId, userId, chatId: chat.id, botId: bot.id, turnId });

    // The user's @mentions ping now, not after the reply: an @mention is the
    // user involving that bot, so it goes out on every message that names
    // one, whatever happens to this turn. Each mentioned bot answers in its own
    // chat with the user. Best-effort: a failure is logged, the turn runs.
    // Only for a message that can name a bot (`mayMentionBot`: an `@` starting
    // a word, not the one in an email address), and alongside the history
    // read rather than before it.
    const userPingedPromise: Promise<string[]> = mayMentionBot(firstUserText)
      ? botService
          .dispatchMentions(userId, { bot: { id: bot.id, name: bot.name }, userText: firstUserText })
          .catch((err: unknown) => {
            console.error('[chat] failed to hand on @mentions:', err);
            return [];
          })
      : Promise.resolve([]);

    // The thread's persisted history, read once: the zero-work check, the
    // earlier attachments, the file-reference rewrite and the orphaned-call
    // repair below all use this one read.
    let snapshot: ThreadSnapshot;
    let userPinged: string[];
    try {
      [snapshot, userPinged] = await Promise.all([agent.getThreadSnapshot(chat.id), userPingedPromise]);
    } catch (err) {
      await copilotChatsService.releaseTurn(chat.id).catch(() => undefined);
      await presence?.done();
      throw err;
    }
    const priorMessages = snapshot.messages;
    timer.mark('history_read');
    const priorLastHumanId = lastHumanMessageId(priorMessages);

    // The question goes into the history now, under the lock, so a tab
    // reloaded mid-turn shows it beneath the live bubble; the reply follows
    // in the `after()` below. Best-effort: without it the turn stores both
    // at the end, as before.
    let questionRowId: string | null = null;
    const question = messages[0];
    if (question) {
      try {
        questionRowId = await chatHistoryService.persistQuestion({
          chat,
          message: question,
          prior: priorMessages,
          // What produced the reply, for feedback on it (MB-693). The same
          // model the agent's trace metadata names.
          turn: { model: EFFORT_TIERS[effort].model, effortTier: effort },
        });
        // The trace runs under the question's id from here on (see `traceRunId`).
        traceRunId = questionRowId ?? traceRunId;
      } catch (err) {
        console.error('[chat] failed to store the question in history:', err);
      }
    }
    timer.mark('question_stored');

    // After the response has finished — registered here, right after the
    // claim, so the lock is released on every path, including an error
    // further down: store the turn in the chat history
    // (copilot_messages — what the UI pages and the bots search), release
    // the lock, then record what the turn established. Everything reads the
    // persisted turn rather than the request body, so it sees the answer that
    // was actually given (including a budget wrap-up), and never runs for an
    // aborted turn that persisted nothing.
    //
    // The lock is released as soon as the thread is stored, NOT after the
    // whole hook: the @mention hand-off, the task-log entry and the memory
    // write-back (an LLM call) do not touch the thread, and holding the lock
    // through them made a quick follow-up message 409 for seconds.
    //
    // Memory (mem0) is gated on the same flag as recall, so it is all-or-
    // nothing. Deliberately NOT a job row: a one-shot, best-effort side effect
    // with nothing to retry; a failure is logged and the turn stands. The
    // history write queues its own embedding job.
    after(async () => {
      await turnFinished;
      stopWatch?.dispose();
      // A turn that produced no visible text (stopped, budget, error) still
      // files what it has; before the Langfuse drain below.
      recordTimeline();
      let finalMessages: BaseMessage[] | undefined;
      try {
        try {
          finalMessages = await agent.getMessages(chat.id);
        } catch (err) {
          console.error('[chat] failed to read the finished turn:', err);
          return;
        }
        // Nothing to store when this turn never reached the thread (it failed
        // before the agent ran): its last user message is still the old one,
        // and the question stored at the start comes back out.
        if (lastHumanMessageId(finalMessages) === priorLastHumanId) {
          finalMessages = undefined;
          if (questionRowId) {
            await withBackgroundDb(async (bgDb) =>
              createContainer(bgDb, workspaceId).chatHistoryService.discardQuestion(questionRowId!),
            ).catch((err: unknown) => {
              console.error('[chat] failed to discard the unanswered question:', err);
            });
          }
          return;
        }
        try {
          const stored = finalMessages;
          await withBackgroundDb(async (bgDb) => {
            const { chatHistoryService: bgHistory } = createContainer(bgDb, workspaceId);
            await bgHistory.persistTurn({
              chat,
              finalMessages: stored,
              interactive: true,
              questionStored: questionRowId !== null,
            });
          });
          // Stored: other tabs reload the thread (this one streamed it live).
          await publishReply(workspaceId, userId, { chatId: chat.id, botId: bot.id, turnId });
        } catch (err) {
          console.error('[chat] failed to store the turn in history:', err);
        }
      } finally {
        // A background connection: the request's pooled one may already be
        // gone once the response has been sent.
        await withBackgroundDb(async (bgDb) =>
          createContainer(bgDb, workspaceId).copilotChatsService.releaseTurn(chat.id),
        ).catch((err: unknown) => {
          console.error('[chat] failed to release the turn lock:', err);
        });
        // After the lock: a client must never see the bot idle while the
        // thread still refuses its next message.
        await presence?.done();
      }
      if (!finalMessages) return;

      // ---- Off the lock from here on: nothing below writes to the thread.

      // Hand the reply's @mentions on (the user's went out when the message
      // arrived; a bot they already pinged is not pinged again). Each answers
      // in the background in its own chat with the user.
      const { userText: turnUserText, assistantText: turnReplyText } = extractLastTurn(finalMessages);
      try {
        await withBackgroundDb(async (bgDb) => {
          const { botService: bgBots } = createContainer(bgDb, workspaceId);
          await bgBots.dispatchMentions(userId, {
            bot: { id: bot.id, name: bot.name },
            replyText: turnReplyText,
            alreadyPinged: userPinged,
            chatId: chat.id,
            turnId,
          });
        });
      } catch (err) {
        console.error('[chat] failed to hand on @mentions:', err);
      }
      // Queue the turn for the bot's task log (summarized in a job).
      try {
        await withBackgroundDb(async (bgDb) => {
          const { botTaskLogService: bgTasks } = createContainer(bgDb, workspaceId);
          await bgTasks.record({
            botId: bot.id,
            userId,
            chatId: chat.id,
            source: 'chat',
            routine: null,
            question: turnUserText,
            answer: turnReplyText,
            toolNames: turnToolNames(finalMessages),
          });
        });
      } catch (err) {
        console.error('[chat] failed to queue the task log entry:', err);
      }
      if (!memoryAllowed) return;
      try {
        if (!turnReplyText.trim()) return;
        await withBackgroundDb(async (bgDb) => {
          const { userMemoryService: bgMemoryService } = createContainer(bgDb, workspaceId);
          await bgMemoryService(userId).rememberTurn({
            userId,
            chatId: chat.id,
            userText: turnUserText,
            assistantText: turnReplyText,
          });
        });
      } catch (err) {
        console.error('[chat] failed to record the turn to memory:', err);
      }
    });


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
        isNewChat: priorMessages.length === 0,
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
        mentionContext,
        memoryContext,
        botMemoryContext,
        agentNotice,
        insightContext,
        timeoutFollowUpContext(previousTimeout),
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;

    // Prior turns' persisted `file` blocks reference Anthropic uploads we
    // already deleted, so replaying the thread would 404. Repoint them at this
    // turn's fresh uploads (or neutralize them when nothing is attached) before
    // the agent runs.
    //
    // Also close orphaned tool_calls left when a prior run aborted mid-tool
    // (e.g. user switched bots during PPTX generation) — without a matching
    // ToolMessage Anthropic rejects the next turn.
    if (priorMessages.length > 0) {
      await agent.rewriteFileReferences(chat.id, uploadedFileIds, priorMessages);
      await agent.repairCorruptServerToolCalls(chat.id, priorMessages);
      await agent.repairOrphanedToolCalls(chat.id, snapshot);
    }
    timer.mark('repairs');

    const apiKey = process.env.ANTHROPIC_API_KEY;

    // X-Chat-Agent lets the CoPilot header show the thread's agent as soon as
    // the turn starts, without waiting for the chat list to refresh.
    const headers = { 'X-Chat-Id': chat.id, 'X-Chat-Agent': agentKey, 'X-Turn-Id': turnId };

    // Per-tier turn budget.
    const budgetMs = EFFORT_TIERS[effort].turnBudgetMs;
    const budgetSignal = AbortSignal.timeout(budgetMs);
    // Not the request's signal: a dropped connection is not a Stop. Stop is
    // the Redis flag `POST /api/copilot/chats/[id]/stop` sets, polled here.
    stopWatch = watchStop(chat.id);
    const stopSignal = stopWatch.signal;
    const turnSignal = AbortSignal.any([stopSignal, budgetSignal]);
    /** The budget fired and the user did not press stop. */
    const isBudgetAbort = () => budgetSignal.aborted && !stopSignal.aborted;
    const callbacks = [new PresenceCallbackHandler((phase) => presence?.setPhase(phase))];

    if (!returnIntermediateSteps) {
      let eventStream;
      try {
        eventStream = await agent.streamEvents(
          { messages, additionalSystemContext, withheldTools, override },
          {
            version: 'v2',
            // The root run's id is the Langfuse trace id: the question row's
            // id when it was stored, so feedback on the reply can score the
            // trace, and the id the turn timeline is filed under either way
            // (see `traceRunId`).
            runId: traceRunId,
            recursionLimit: 50,
            configurable: {
              thread_id: chat.id,
              // Read by tools that act for the user (history search, bot tools,
              // crm_banker_insights, read_contact_emails), never from a model argument.
              userId,
              botId: bot.id,
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
            // Only the turn budget or an explicit Stop aborts the agent — not
            // the browser disconnecting from the SSE response.
            signal: turnSignal,
            callbacks,
          },
        );
      } catch (streamErr) {
        stopWatch.dispose();
        throw streamErr;
      }

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
          if (stopSignal.aborted || (error as Error)?.name === 'AbortError') {
            return '';
          }
          if (isGraphRecursionError(error)) {
            return RECURSION_LIMIT_ERROR_MESSAGE;
          }
          console.error(error);
          return 'Internal server error';
        },
        // Re-entered rather than inherited: this callback runs while the SSE
        // body drains, after the handler's own runWithLangfuseUser scope has
        // returned. The agent's own LangChain runs already carry the user in the
        // config built above, but a trace a tool hand-builds mid-drain (the pptx
        // skill) and the budget wrap-up's own LLM call both read the ambient
        // store, so it has to still be set here.
        execute: async ({ writer }) =>
          runWithLangfuseUser(userId, async () => {
            // The reply's timestamp, the same field history pages carry, so
            // the bubble shows it while streaming and after a reload alike.
            // `questionId` keys the reply's feedback (MB-693) — the same id a
            // history page sends once the turn is stored.
            writer.write({
              type: 'message-metadata',
              messageMetadata: {
                createdAt: new Date().toISOString(),
                ...(questionRowId ? { questionId: questionRowId } : {}),
              },
            });
            timer.mark('stream_opened');
            writer.merge(
              withBudgetWrapUp(toThinkingMessageStream(markFirstTokens(eventStream, timer, recordTimeline), writer), {
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
          }),
      });

      // Delete the per-turn Anthropic uploads once the turn has finished.
      after(async () => {
        await turnFinished;
        await cleanupAttachments();
      });
      // LangChain callbacks are non-blocking; flush after the turn so Copilot
      // traces aren't dropped when the request ends.
      after(async () => {
        await turnFinished;
        await flushLangfuse();
      });

      return createUIMessageStreamResponse({
        stream,
        headers,
        // A copy of the stream read to the end on the server, so the agent
        // keeps running after the browser disconnects (the client's copy is
        // cancelled; a tee keeps pulling while either copy reads).
        consumeSseStream: ({ stream: serverCopy }) => {
          turnFinished = serverCopy
            .pipeTo(new WritableStream())
            .catch(() => undefined)
            .finally(() => stopWatch?.dispose());
        },
      });
    } else {
      try {
        const result = await agent.invoke(
          { messages, additionalSystemContext, withheldTools, override },
          {
            // As on the streamed path: the trace id (see `traceRunId`).
            runId: traceRunId,
            recursionLimit: 50,
            configurable: {
              thread_id: chat.id,
              userId,
              botId: bot.id,
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
            callbacks,
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
        stopWatch.dispose();
        await cleanupAttachments();
        recordTimeline();
        await flushLangfuse();
      }
    }
  } catch (e: unknown) {
    return chatErrorResponse(e);
  }
}
