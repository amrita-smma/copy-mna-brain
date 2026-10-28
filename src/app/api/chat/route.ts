import { after, NextRequest, NextResponse } from 'next/server';
import {
  AIMessage,
  EFFORT_TIERS,
  type EffortChoice,
  type InvokeConfig,
  type InvokeOptions,
} from '@/lib/agents/analysis';
import { lastHumanMessageId } from '@/lib/agents/analysis/messages';
import type { AgentGraph } from '@/lib/agents/analysis/runtime';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId, workspaceSlugFromClaims } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';
import type { Session } from 'next-auth';
import { BaseMessage } from '@langchain/core/messages';
import { recallQueryFor } from '@/lib/memory/recallQuery';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { ChatAttachmentForbiddenError } from '@/lib/services/chatAttachmentService';
import { copilotMemoryEnabled, sourceOfFundsEnabled } from '@/lib/flags';
import { BotNotFoundError } from '@/lib/services/botService';
import { buildBotTurnOverride } from '@/lib/bots/threadMiddleware';
import { mayMentionBot } from '@/lib/bots/mentions';
import { TurnTimer } from '@/lib/chat/turnTimer';
import { hasTextContent } from '@/lib/chat/thinkingStream';
import {
  PresenceCallbackHandler,
  startTurnPresence,
  watchStop,
  type StopWatch,
  type TurnPresence,
} from '@/lib/bots/presence';
import { isCopilotAgentType } from '@/lib/agents/analysis/flavors/keys';
import { flushLangfuse, recordTurnTiming } from '@/lib/langfuse';
import { runWithLangfuseUser, runWithLangfuseWorkspace } from '@/lib/langfuseUser';
import { TRACE_NAMES } from '@/lib/langfuseTraceNames';
import { stripComposerMarkup } from '@/lib/chat/composerMarkup';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { CHAT_MESSAGE_SENT, chatMessageSentProperties } from '@/lib/posthog-chat';
import { resolveChatAgentGraph } from '@/lib/chat/chatAgent';
import { formatInsightChatContext } from '@/lib/insights/chatOutline';
import {
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
import { readTurnRequest, type TurnRequest } from '@/lib/chat/turnRequest';
import { buildTurnMessage, type TurnMessage } from '@/lib/chat/turnMessage';
import { finishTurn } from '@/lib/chat/finishTurn';

/** Allow long Anthropic pptx-skill runs inside send_email (up to ~10 min). */
export const maxDuration = 600;

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
    // The workspace slug rides the same way, read from the session's own
    // claims (no DB call); `getActiveWorkspaceId` is request-memoized, so the
    // handler's own call below reuses this resolution.
    const userId = session.user.id;
    const workspaceSlug = workspaceSlugFromClaims(
      session.user.workspaces,
      await getActiveWorkspaceId(),
    );
    return await runWithLangfuseUser(userId, () =>
      runWithLangfuseWorkspace(workspaceSlug, () =>
        handleChatTurn(req, session, userId, workspaceSlug),
      ),
    );
  } catch (e: unknown) {
    return chatErrorResponse(e);
  }
}

/**
 * One chat turn, start to finish. Reads top to bottom as the turn's stages:
 *
 * 1. the request, and the reads that only need it, started at once;
 * 2. the bot's thread, and its lock;
 * 3. the human message (attachments uploaded);
 * 4. the tier and the graph;
 * 5. the thread's history and the question row;
 * 6. the `after()` hook that stores the turn and releases the lock;
 * 7. what the agent is given, and the run itself (`streamTurnResponse`, or
 *    `invokeTurnResponse` on the debug path).
 *
 * The time before the first token is measured stage by stage (`TurnTimer`)
 * and filed on the turn's Langfuse trace once the first text streams.
 */
async function handleChatTurn(
  req: NextRequest,
  session: Session,
  userId: string,
  workspaceSlug: string | null,
) {
  // Live state for the bot icons in every open tab (`@/lib/bots/presence`):
  // set once the lock is ours, cleared after it is released. The turn id
  // lets the sending tab tell its own turn's events from a background one.
  const turnId = randomUUID();
  const timer = new TurnTimer(`turn ${turnId.slice(0, 8)}`);
  timer.mark('auth');
  // Live state for the bot icons (`startTurnPresence`), from the lock to its
  // release; and the way back out of the lock on a path that ends — by a
  // return or a throw — between the claim and the `after()` hook that
  // normally releases it. Null once that hook owns the release.
  let presence: TurnPresence | undefined;
  let abandonTurn: (() => Promise<void>) | null = null;
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
    // ---- 1. The request. Pure CPU over the body, first, so the reads that
    // only depend on it can all be in flight while the thread is opened.
    const body = await req.json();
    timer.mark('body');
    const request = readTurnRequest(body);
    if (!request) {
      return NextResponse.json({ error: 'No user message in request' }, { status: 400 });
    }
    const { attachments, pageContext, userText, turnText, hasAttachments, requestedEffort } = request;

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

    // The insight open on screen (MB-550): a compact outline of its current
    // version rides on this turn's system context, so a question can be asked
    // in the insight's own terms. Best-effort — a failure only means this turn
    // goes without it.
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
    // memoizes it), so the recall is safe even before `memoryAllowed`
    // resolves — it is awaited only to decide whether to schedule the
    // write-back. The recall — an embedding plus one indexed query — is
    // best-effort by construction: `recallForTurn` resolves to null on any
    // failure or past its deadline (`RECALL_TIMEOUT_MS`), and the turn runs
    // without memory.
    const memory = userMemoryService(userId);
    const memoryAllowed = await copilotMemoryEnabled();
    const memoryContextPromise: Promise<string | null> = memoryAllowed
      ? memory
          .recallForTurn(recallQueryFor(turnText, request.previousUserText))
          .catch((err: unknown) => {
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
    // tier would leave every later turn on the most expensive one.
    const storedEffort = null;
    const routedEffortPromise: Promise<EffortChoice | null> =
      requestedEffort === null && shouldRoute(storedEffort, hasAttachments)
        ? routeEffort(
            {
              message: turnText,
              hasAttachments,
              pageSummary: pageContext?.path ?? null,
            },
            process.env.ANTHROPIC_API_KEY ?? '',
          )
        : Promise.resolve(null);

    // Workspace-wide reads that do not depend on which bot answers: the
    // thesis + criteria context and the source-of-funds flag (when off, the
    // agent is built without the `query_fund_sources` tool).
    const contextDataPromise = chatService.buildContext();
    const sofEnabledPromise = sourceOfFundsEnabled();

    // The bots this turn can @mention: the list is the heaviest of the
    // per-turn reads, so it is started here and read behind the thread open
    // rather than after it; the note is built once the bot is known.
    const mentionContextFor = botService.prepareMentionContext(userId);

    // ---- 2. The thread, and its lock.
    let opened;
    try {
      opened = request.requestedBotId
        ? await botService.openThread(userId, request.requestedBotId)
        : await botService.openDefaultThread(userId);
    } catch (err) {
      if (err instanceof BotNotFoundError) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      throw err;
    }
    const { bot, chat } = opened;
    timer.mark('thread_open');

    // One turn at a time per thread: a bot answering an @mention or a routine
    // (a background job) writes this same checkpoint thread. Claimed in the
    // same round trip as the reads below — only the thread's id is needed —
    // and before everything that writes to the thread: the history read's
    // repairs, the question row, the run itself. Released by the `after()`
    // hook registered further down once the turn is stored, or by
    // `abandonTurn` on a path that ends before that hook exists.
    const claimPromise = copilotChatsService.claimTurn(chat.id, maxDuration);
    claimPromise.catch(() => undefined);
    abandonTurn = async () => {
      // Only a granted claim is given back; one that failed or threw held nothing.
      if (await claimPromise.catch(() => false)) {
        await copilotChatsService.releaseTurn(chat.id).catch(() => undefined);
      }
      await presence?.done();
    };

    // The reads that need the bot, all at once: the other bots this one can
    // hand work to with an @mention, the notes the user asked this bot to
    // keep (explicit requests, so not behind the mem0 switch; best-effort
    // like the recall), and the flavor the bot runs on ('mna' — M&A — or
    // 'investment' — funds & investing, …; falling back to the workspace's).
    const [contextData, mentionContext, botMemoryContext, copilotAgent, claimed] = await Promise.all([
      contextDataPromise,
      mentionContextFor(bot.id).catch((err: unknown) => {
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
      claimPromise,
    ]);
    timer.mark('context');
    if (!claimed) {
      abandonTurn = null;
      return NextResponse.json(
        { error: `${bot.name} is working on a background task. Try again in a moment.` },
        { status: 409 },
      );
    }
    timer.mark('turn_claimed');
    presence = startTurnPresence({ workspaceId, userId, chatId: chat.id, botId: bot.id, turnId });

    // ---- 3. The human message: the files uploaded, the template expanded.
    let turnMessage: TurnMessage;
    try {
      turnMessage = await buildTurnMessage(request, { chatAttachmentService, insightTemplateService });
    } catch (err) {
      if (err instanceof ChatAttachmentForbiddenError) {
        await abandonTurn();
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      throw err;
    }
    const { messages, uploadedFileIds, carriesTooLargeDocument } = turnMessage;
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

    // ---- 4. The tier and the graph.
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
      await abandonTurn();
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

    // ---- 5. The thread's history, and the question row.

    // The user's @mentions ping now, not after the reply: an @mention is the
    // user involving that bot, so it goes out on every message that names
    // one, whatever happens to this turn. Each mentioned bot answers in its own
    // chat with the user. Best-effort: a failure is logged, the turn runs.
    // Only for a message that can name a bot (`mayMentionBot`: an `@` starting
    // a word, not the one in an email address), and alongside the history
    // read rather than before it.
    const userPingedPromise: Promise<string[]> = mayMentionBot(userText)
      ? botService
          .dispatchMentions(userId, { bot: { id: bot.id, name: bot.name }, userText })
          .catch((err: unknown) => {
            console.error('[chat] failed to hand on @mentions:', err);
            return [];
          })
      : Promise.resolve([]);

    // The thread's persisted history, read once: the zero-work check, the
    // earlier attachments, the file-reference rewrite and the orphaned-call
    // repair below all use this one read.
    const [snapshot, userPinged] = await Promise.all([agent.getThreadSnapshot(chat.id), userPingedPromise]);
    const priorMessages = snapshot.messages;
    timer.mark('history_read');
    const priorLastHumanId = lastHumanMessageId(priorMessages);

    // The question goes into the history now, under the lock, so a tab
    // reloaded mid-turn shows it beneath the live bubble; the reply follows
    // in the `after()` below. The row's id is chosen here rather than read
    // back from the insert, so the write is NOT awaited: the run, its trace
    // and the reply's feedback key all use the id while the insert is still
    // in flight, alongside the repairs and the stream start. The hook waits
    // for it. A failed write (logged) means the turn stores both rows at the
    // end, the question under this same id, so nothing handed out dangles.
    const question = messages[0];
    const questionId = question ? randomUUID() : null;
    // The trace runs under the question's id from here on (see `traceRunId`).
    if (questionId) traceRunId = questionId;
    // What produced the reply, for feedback on it (MB-693). The same model
    // the agent's trace metadata names.
    const questionTurn = { model: EFFORT_TIERS[effort].model, effortTier: effort };
    const questionStored: Promise<boolean> =
      question && questionId
        ? chatHistoryService
            .persistQuestion({
              chat,
              message: question,
              prior: priorMessages,
              turn: questionTurn,
              id: questionId,
            })
            .then((id) => {
              timer.mark('question_stored');
              return id !== null;
            })
            .catch((err: unknown) => {
              console.error('[chat] failed to store the question in history:', err);
              return false;
            })
        : Promise.resolve(false);

    // ---- 6. After the response has finished (`finishTurn`): store the turn,
    // release the lock, then record what the turn established. Registered
    // here, right after the claim, so the lock is released on every path,
    // including an error further down.
    //
    // The turn runs to the end even when the browser disconnects (the user
    // navigated away): the stream is drained on the server, and the work
    // queued with `after()` waits for `turnFinished`. Only the turn budget or
    // an explicit Stop (`POST /api/copilot/chats/[id]/stop`, polled by
    // `watchStop`) ends it early. Resolved now for the paths that never stream.
    let turnFinished: Promise<void> = Promise.resolve();
    let stopWatch: StopWatch | undefined;
    after(async () => {
      await turnFinished;
      stopWatch?.dispose();
      // A turn that produced no visible text (stopped, budget, error) still
      // files what it has; before the Langfuse drain.
      recordTimeline();
      // The question's insert was started under the lock and not awaited;
      // whether it landed decides what is stored and what is taken back.
      const questionWritten = await questionStored;
      await finishTurn({
        agent,
        workspaceId,
        userId,
        bot: { id: bot.id, name: bot.name },
        chat,
        turnId,
        question: questionId ? { id: questionId, turn: questionTurn, written: questionWritten } : null,
        priorLastHumanId,
        userPinged,
        memoryAllowed,
        presence,
      });
    });
    // From here the hook above releases the lock on every path.
    abandonTurn = null;

    captureChatMessageSent({
      session,
      workspaceId,
      userId,
      request,
      chatId: chat.id,
      isNewChat: priorMessages.length === 0,
      effort,
      copilotAgent,
    });

    // ---- 7. What the agent is given, and the run.

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

    // Per-tier turn budget. Not the request's signal: a dropped connection is
    // not a Stop. Stop is the Redis flag `POST /api/copilot/chats/[id]/stop`
    // sets, polled here.
    const budgetMs = EFFORT_TIERS[effort].turnBudgetMs;
    const budgetSignal = AbortSignal.timeout(budgetMs);
    stopWatch = watchStop(chat.id);
    const stopSignal = stopWatch.signal;

    const run: TurnRun = {
      agent,
      input: { messages, additionalSystemContext, withheldTools, override },
      config: {
        // The root run's id is the Langfuse trace id: the question row's id
        // when it was stored, so feedback on the reply can score the trace,
        // and the id the turn timeline is filed under either way.
        runId: traceRunId,
        runName: TRACE_NAMES.copilotChat,
        recursionLimit: 50,
        configurable: {
          thread_id: chat.id,
          // Read by tools that act for the user (history search, bot tools,
          // crm_banker_insights, read_contact_emails), never from a model
          // argument. Auth-sensitive values (the user's email) and per-user
          // bytes (the user's name) travel here rather than in the system
          // context, keeping the cached prompt prefix identical across users.
          userId,
          botId: bot.id,
          userEmail: session.user.email ?? null,
          userName: session.user.name ?? null,
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
        signal: AbortSignal.any([stopSignal, budgetSignal]),
        // The presence detector rides on the agent run.
        callbacks: [new PresenceCallbackHandler((phase) => presence?.setPhase(phase))],
      },
      // X-Chat-Agent lets the CoPilot header show the thread's agent as soon
      // as the turn starts, without waiting for the chat list to refresh.
      headers: { 'X-Chat-Id': chat.id, 'X-Chat-Agent': agentKey, 'X-Turn-Id': turnId },
      chatId: chat.id,
      effort,
      budgetMs,
      isBudgetAbort: () => budgetSignal.aborted && !stopSignal.aborted,
      stopSignal,
      stopWatch,
      cleanupAttachments,
      recordTimeline,
    };

    if (request.returnIntermediateSteps) {
      return await invokeTurnResponse(run);
    }
    const streamed = await streamTurnResponse(run, { timer, questionId, userId, workspaceSlug });
    turnFinished = streamed.turnFinished;
    return streamed.response;
  } catch (e: unknown) {
    // A throw between the claim and the hook that releases it: give the
    // thread back, or the next message 409s until the lock's TTL runs out.
    await abandonTurn?.();
    return chatErrorResponse(e);
  }
}

/** The turn, built and ready to run: what the two response paths share. */
interface TurnRun {
  agent: AgentGraph;
  input: InvokeOptions;
  config: InvokeConfig;
  headers: Record<string, string>;
  chatId: string;
  effort: EffortChoice;
  budgetMs: number;
  /** The budget fired and the user did not press stop. */
  isBudgetAbort: () => boolean;
  stopSignal: AbortSignal;
  stopWatch: StopWatch;
  /** Best-effort, idempotent teardown of the per-turn Anthropic uploads. */
  cleanupAttachments: () => Promise<void>;
  /** Log the setup timeline and file it on the trace; runs once. */
  recordTimeline: () => void;
}

/**
 * The normal path: the agent's events streamed to the browser as a UI
 * message stream. The response is returned as soon as the agent's event
 * stream opens; `turnFinished` resolves once the stream has been read to the
 * end on the server, whether or not the browser is still there.
 */
async function streamTurnResponse(
  run: TurnRun,
  {
    timer,
    questionId,
    userId,
    workspaceSlug,
  }: { timer: TurnTimer; questionId: string | null; userId: string; workspaceSlug: string | null },
): Promise<{ response: Response; turnFinished: Promise<void> }> {
  const { agent, chatId, effort, budgetMs, isBudgetAbort, stopSignal, stopWatch } = run;
  let eventStream;
  try {
    eventStream = await agent.streamEvents(run.input, { version: 'v2', ...run.config });
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
          `[chat] turn budget of ${budgetMs}ms elapsed on tier "${effort}" (chat ${chatId})`,
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
      runWithLangfuseUser(userId, () => runWithLangfuseWorkspace(workspaceSlug, async () => {
        // The reply's timestamp, the same field history pages carry, so
        // the bubble shows it while streaming and after a reload alike.
        // `questionId` keys the reply's feedback (MB-693) — the same id a
        // history page sends once the turn is stored.
        writer.write({
          type: 'message-metadata',
          messageMetadata: {
            createdAt: new Date().toISOString(),
            ...(questionId ? { questionId } : {}),
          },
        });
        timer.mark('stream_opened');
        writer.merge(
          withBudgetWrapUp(
            toThinkingMessageStream(markFirstTokens(eventStream, timer, run.recordTimeline), writer),
            {
              isBudgetAbort,
              // Stage two: the graph is stopped, but the tool rounds it did
              // finish are in the checkpoint. Spend the headroom under
              // maxDuration turning them into an answer, and persist it so the
              // thread does not reload ending on a tool result.
              wrapUp: async () => {
                console.error(
                  `[chat] turn budget of ${budgetMs}ms elapsed on tier "${effort}" (chat ${chatId}) — wrapping up`,
                );
                const persisted = await agent.getMessages(chatId).catch(() => []);
                const text = await summarizeAbandonedTurn({
                  messages: persisted,
                  budgetMs,
                  apiKey: process.env.ANTHROPIC_API_KEY,
                });
                try {
                  await agent.seedMessages(chatId, [new AIMessage(text)]);
                } catch (err) {
                  console.error('[chat] failed to persist wrap-up message:', err);
                }
                return text;
              },
            },
          ),
        );
      })),
  });

  // Set by `consumeSseStream` below, synchronously, as the response is built.
  let turnFinished: Promise<void> = Promise.resolve();
  // Delete the per-turn Anthropic uploads once the turn has finished.
  after(async () => {
    await turnFinished;
    await run.cleanupAttachments();
  });
  // LangChain callbacks are non-blocking; flush after the turn so Copilot
  // traces aren't dropped when the request ends.
  after(async () => {
    await turnFinished;
    await flushLangfuse();
  });

  const response = createUIMessageStreamResponse({
    stream,
    headers: run.headers,
    // A copy of the stream read to the end on the server, so the agent
    // keeps running after the browser disconnects (the client's copy is
    // cancelled; a tee keeps pulling while either copy reads).
    consumeSseStream: ({ stream: serverCopy }) => {
      turnFinished = serverCopy
        .pipeTo(new WritableStream())
        .catch(() => undefined)
        .finally(() => stopWatch.dispose());
    },
  });
  return { response, turnFinished };
}

/**
 * The debug path (`show_intermediate_steps`): the agent run to completion
 * and its final messages answered as JSON. Everything is torn down here, in
 * one `finally`, since nothing outlives the response.
 */
async function invokeTurnResponse(run: TurnRun): Promise<NextResponse> {
  const { agent, headers, budgetMs, isBudgetAbort, stopWatch } = run;
  try {
    const result = await agent.invoke(run.input, run.config);
    const validMessages = result.messages.map((m: BaseMessage | string) =>
      typeof m === 'string' ? new AIMessage(m) : (m as BaseMessage),
    );
    return NextResponse.json(
      { messages: validMessages.map(convertLangChainMessageToVercelMessage) },
      { status: 200, headers },
    );
  } catch (invokeErr) {
    // No stream to wrap up into, so report the budget plainly instead of
    // surfacing a bare AbortError as a 500.
    if (isBudgetAbort()) {
      return NextResponse.json({ error: buildBudgetNotice({ budgetMs }) }, { status: 504, headers });
    }
    if (isGraphRecursionError(invokeErr)) {
      return NextResponse.json({ error: RECURSION_LIMIT_ERROR_MESSAGE }, { status: 400, headers });
    }
    throw invokeErr;
  } finally {
    stopWatch.dispose();
    await run.cleanupAttachments();
    run.recordTimeline();
    await flushLangfuse();
  }
}

/**
 * `chat_message_sent` — one event per user turn, captured on the server
 * rather than in the composer for the reason given on `captureUserEvent`: a
 * server capture is the only kind an ad blocker cannot drop, and this is the
 * headline engagement metric. Emitted after the turn is fully validated
 * (auth, chat ownership, attachment access, agent availability) so the count
 * means "a turn actually ran", not "a request arrived".
 */
function captureChatMessageSent(input: {
  session: Session;
  workspaceId: string;
  userId: string;
  request: TurnRequest;
  chatId: string;
  isNewChat: boolean;
  effort: EffortChoice;
  copilotAgent: string;
}) {
  const { session, workspaceId, userId, request, chatId, isNewChat, effort, copilotAgent } = input;
  captureWorkspaceEvent({
    workspaceId,
    // Stamped so this event answers a `workspace_slug` filter the same way
    // the client-side chat events do — those get the slug from the `/w/<slug>`
    // URL, this one from the session's membership claims (no DB call).
    workspaceSlug: workspaceSlugFromClaims(session.user.workspaces, workspaceId),
    distinctId: userId,
    event: CHAT_MESSAGE_SENT,
    properties: chatMessageSentProperties({
      chatId,
      isNewChat,
      effort,
      attachmentCount: request.attachments.length,
      // The user's own words, not the `📎 Attached: …` lines the composer
      // appends — otherwise an attachment-only turn records a non-zero
      // length and a long filename inflates a short prompt.
      messageLength: stripComposerMarkup(request.userText).length,
      copilotAgent,
      hasPageContext: Boolean(request.pageContext),
      pageContextTab: request.pageContext?.tabSlug ?? null,
    }),
  });
}

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
