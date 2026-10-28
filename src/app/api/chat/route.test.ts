import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, after } from 'next/server';

const {
  authMock,
  createContainerMock,
  resolveChatAgentGraphMock,
  invokeMock,
  touchLastActiveMock,
  getCopilotAgentMock,
  buildContextMock,
  copilotMemoryEnabledMock,
  extractLastTurnMock,
  recallForTurnMock,
  rememberTurnMock,
  userMemoryServiceMock,
  botMemoryPromptContextMock,
  cardPromptContextMock,
  withBackgroundDbMock,
  openThreadMock,
  openDefaultThreadMock,
  mentionContextMock,
  prepareMentionContextMock,
  dispatchMentionsMock,
  recordTaskMock,
  routeEffortMock,
  recordTurnTimingMock,
  shouldRouteMock,
  buildBotTurnOverrideMock,
  summarizeThreadAheadMock,
  readThreadSnapshotMock,
  beginCheckpointStatsMock,
  recordTurnWritesMock,
} = vi.hoisted(() => ({
  summarizeThreadAheadMock: vi.fn(),
  readThreadSnapshotMock: vi.fn(),
  beginCheckpointStatsMock: vi.fn(),
  recordTurnWritesMock: vi.fn(),
  openThreadMock: vi.fn(),
  openDefaultThreadMock: vi.fn(),
  mentionContextMock: vi.fn(),
  prepareMentionContextMock: vi.fn(),
  dispatchMentionsMock: vi.fn(),
  recordTaskMock: vi.fn(),
  routeEffortMock: vi.fn(),
  recordTurnTimingMock: vi.fn(),
  shouldRouteMock: vi.fn(),
  buildBotTurnOverrideMock: vi.fn(),
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  resolveChatAgentGraphMock: vi.fn(),
  invokeMock: vi.fn(),
  touchLastActiveMock: vi.fn(),
  getCopilotAgentMock: vi.fn(),
  buildContextMock: vi.fn(),
  copilotMemoryEnabledMock: vi.fn(),
  extractLastTurnMock: vi.fn(),
  recallForTurnMock: vi.fn(),
  rememberTurnMock: vi.fn(),
  userMemoryServiceMock: vi.fn(),
  botMemoryPromptContextMock: vi.fn(),
  cardPromptContextMock: vi.fn(),
  // Runs the callback against the same container double the request used, so a
  // background write can be asserted the way a foreground one is.
  withBackgroundDbMock: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
  withBackgroundDb: withBackgroundDbMock,
}));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
  workspaceSlugFromClaims: vi.fn(() => 'ws-slug'),
}));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/services/chatAttachmentService', () => ({
  ChatAttachmentForbiddenError: class extends Error {},
}));
vi.mock('@/lib/agents/analysis', () => ({
  AIMessage: class AIMessage {
    constructor(public content: unknown) {}
    _getType() {
      return 'ai';
    }
  },
  extractLastTurn: extractLastTurnMock,
  readThreadSnapshot: readThreadSnapshotMock,
  beginCheckpointStats: beginCheckpointStatsMock,
  asManualEffort: (v: unknown) => (v === 'low' || v === 'medium' || v === 'high' ? v : null),
  EFFORT_TIERS: {
    low: { turnBudgetMs: 30_000, model: 'claude-haiku-5-5' },
    medium: { turnBudgetMs: 60_000, model: 'claude-sonnet-5-5' },
  },
}));
vi.mock('@ai-sdk/langchain', () => ({ toBaseMessages: vi.fn(async () => []) }));
vi.mock('@/lib/flags', () => ({
  copilotMemoryEnabled: copilotMemoryEnabledMock,
  sourceOfFundsEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/bots/threadMiddleware', () => ({ buildBotTurnOverride: buildBotTurnOverrideMock }));
vi.mock('@/lib/bots/summarizeAhead', () => ({ summarizeThreadAhead: summarizeThreadAheadMock }));
// Partial: only the network-touching drain is stubbed. `runWithLangfuseUser`
// stays real so the attribution assertion below exercises the actual store.
vi.mock('@/lib/langfuse', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  flushLangfuse: vi.fn(),
  recordTurnTiming: recordTurnTimingMock,
  recordTurnWrites: recordTurnWritesMock,
}));
// The real tier resolution (escalate-only, the open-insight floor); only the
// routing call is stubbed.
vi.mock('@/lib/chat/effortRouter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  routeEffort: routeEffortMock,
  shouldRoute: shouldRouteMock,
}));
// Partial: the real `hasTextContent` stays, since the route's first-token tap
// reads it; only the stream conversion is stubbed.
vi.mock('@/lib/chat/thinkingStream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGraphRecursionError: () => false,
  RECURSION_LIMIT_ERROR_MESSAGE: 'recursion',
  toThinkingMessageStream: vi.fn(),
}));
// The real zero-work notice helpers; only the stream wrap-up is stubbed.
vi.mock('@/lib/chat/turnBudget', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeAbandonedTurn: vi.fn(),
  withBudgetWrapUp: vi.fn(),
}));
vi.mock('@/lib/chat/chatAgent', () => ({ resolveChatAgentGraph: resolveChatAgentGraphMock }));
// The live-state layer (Redis): stubbed so a turn's presence, Stop watch and
// reply push can be asserted without a Redis.
const presence = vi.hoisted(() => {
  const handle = { setPhase: vi.fn(), done: vi.fn(async () => undefined) };
  const stop = { controller: new AbortController(), dispose: vi.fn() };
  return {
    handle,
    stop,
    startTurnPresence: vi.fn(() => handle),
    watchStop: vi.fn(() => ({ signal: stop.controller.signal, dispose: stop.dispose })),
    publishReply: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/bots/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startTurnPresence: presence.startTurnPresence,
  watchStop: presence.watchStop,
  publishReply: presence.publishReply,
}));

import { POST } from './route';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { buildBudgetNotice, withBudgetWrapUp } from '@/lib/chat/turnBudget';
import { toThinkingMessageStream } from '@/lib/chat/thinkingStream';
import {
  CHAT_ATTACHMENTS_KWARG,
  WHOLE_DOCUMENT_TOOL_NAMES,
  TIMED_OUT_FOLLOW_UP_CONTEXT,
  ZERO_WORK_FOLLOW_UP_CONTEXT,
} from '@/lib/chat/largeDocumentTurn';
import {
  INSIGHT_SELECTION_KWARG,
  formatInsightSelectionBlock,
} from '@/lib/insights/selectionAttachment';
import { getLangfuseUserId } from '@/lib/langfuseUser';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const INSIGHT_ID = '99999999-8888-4777-8666-555555555555';

function chatRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      show_intermediate_steps: true,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'How is this developer doing?' }] }],
      ...body,
    }),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('POST /api/chat', () => {
  const claimTurnMock = vi.fn();
  const releaseTurnMock = vi.fn();
  const persistTurnMock = vi.fn();
  const persistQuestionMock = vi.fn();
  const discardQuestionMock = vi.fn();
  const copilotChatsService = {
    touchLastActive: touchLastActiveMock,
    claimTurn: claimTurnMock,
    releaseTurn: releaseTurnMock,
  };
  // The workspace default bot and the user's thread with it: where a turn that
  // names no bot runs.
  const defaultBot = {
    id: 'dddddddd-2222-4333-8444-555555555555',
    name: 'Copilot',
    base_flavor: 'investment',
    persona_md: '',
    skills: [],
  };
  const getChatContextMock = vi.fn();
  const insightService = { findBoundAgent: vi.fn(), getChatContext: getChatContextMock };
  const getMessagesMock = vi.fn();
  const streamEventsMock = vi.fn();
  const graph = {
    invoke: invokeMock,
    streamEvents: streamEventsMock,
    getMessages: getMessagesMock,
    // The route's one pre-turn read of the thread; the `after()` hook reads
    // again through `getMessages`, so both go through the same mock and a
    // test sequences them with `mockResolvedValueOnce` as before.
    getThreadSnapshot: vi.fn(async (id: string) => ({ messages: await getMessagesMock(id), hasInterrupt: false })),
    rewriteFileReferences: vi.fn(),
    repairCorruptServerToolCalls: vi.fn(),
    repairOrphanedToolCalls: vi.fn(),
  };
  const ownedRefsMock = vi.fn();
  const attachmentPrepareMock = vi.fn();
  const templatePrepareMock = vi.fn();

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A' } });
    openDefaultThreadMock.mockReset().mockResolvedValue({
      bot: defaultBot,
      chat: { id: CHAT_ID, title: 'Copilot', effort_tier: null, agent_key: 'general', bot_id: defaultBot.id },
    });
    routeEffortMock.mockReset();
    recordTurnTimingMock.mockReset();
    recordTurnWritesMock.mockReset();
    beginCheckpointStatsMock.mockReset().mockReturnValue({
      end: () => ({ checkpoints: 2, writeBatches: 1, totalMs: 40, maxMs: 25, lastCheckpointMessages: 5 }),
    });
    claimTurnMock.mockReset().mockResolvedValue(true);
    streamEventsMock.mockReset().mockResolvedValue({});
    releaseTurnMock.mockReset().mockResolvedValue(undefined);
    persistTurnMock.mockReset().mockResolvedValue(undefined);
    persistQuestionMock.mockReset().mockResolvedValue('q-row');
    discardQuestionMock.mockReset().mockResolvedValue(undefined);
    shouldRouteMock.mockReset().mockReturnValue(false);
    touchLastActiveMock.mockReset();
    getCopilotAgentMock.mockReset().mockResolvedValue('investment');
    buildContextMock.mockReset().mockResolvedValue('WORKSPACE CONTEXT');
    copilotMemoryEnabledMock.mockReset().mockResolvedValue(false);
    recallForTurnMock.mockReset().mockResolvedValue(null);
    rememberTurnMock.mockReset().mockResolvedValue(0);
    extractLastTurnMock.mockReset().mockReturnValue({ userText: '', assistantText: '' });
    userMemoryServiceMock
      .mockReset()
      .mockReturnValue({ recallForTurn: recallForTurnMock, rememberTurn: rememberTurnMock });
    botMemoryPromptContextMock.mockReset().mockResolvedValue(null);
    cardPromptContextMock.mockReset().mockResolvedValue(null);
    withBackgroundDbMock.mockClear();
    vi.mocked(after).mockClear();
    presence.handle.setPhase.mockClear();
    presence.handle.done.mockClear();
    presence.stop.controller = new AbortController();
    presence.stop.dispose.mockClear();
    presence.startTurnPresence.mockClear();
    presence.watchStop.mockClear();
    presence.publishReply.mockClear();
    invokeMock.mockReset().mockResolvedValue({ messages: [] });
    resolveChatAgentGraphMock.mockReset();
    getChatContextMock.mockReset().mockResolvedValue(null);
    getMessagesMock.mockReset().mockResolvedValue([]);
    // The route's pre-turn read goes through the tier-independent reader, not
    // the tier's graph; in tests it answers from the same history double.
    readThreadSnapshotMock.mockReset().mockImplementation((id: string) => graph.getThreadSnapshot(id));
    graph.getThreadSnapshot.mockClear();
    graph.rewriteFileReferences.mockReset();
    graph.repairCorruptServerToolCalls.mockReset();
    graph.repairOrphanedToolCalls.mockReset();
    ownedRefsMock.mockReset().mockImplementation((refs: unknown) =>
      (refs as Array<{ key: string }>).filter((r) => r.key.startsWith('chat-attachments/ws-1/')),
    );
    attachmentPrepareMock.mockReset().mockResolvedValue({ blocks: [], fileIds: [], outlinedHtml: [] });
    templatePrepareMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      chatService: { buildContext: buildContextMock },
      copilotChatsService,
      chatAttachmentService: {
        ownedRefs: ownedRefsMock,
        prepareForMessage: attachmentPrepareMock,
        deleteFromAnthropic: vi.fn(),
      },
      insightTemplateService: { prepareForMessage: templatePrepareMock },
      insightService,
      workspaceService: { getCopilotAgent: getCopilotAgentMock },
      userMemoryService: userMemoryServiceMock,
      botMemoryService: { promptContext: botMemoryPromptContextMock },
      copilotChatCardService: { promptContext: cardPromptContextMock },
      botService: {
        openThread: openThreadMock,
        openDefaultThread: openDefaultThreadMock,
        prepareMentionContext: prepareMentionContextMock,
        dispatchMentions: dispatchMentionsMock,
      },
      chatHistoryService: {
        persistTurn: persistTurnMock,
        persistQuestion: persistQuestionMock,
        discardQuestion: discardQuestionMock,
      },
      botTaskLogService: { record: recordTaskMock },
    });
    openThreadMock.mockReset();
    // The route starts the bot-list read before the thread open and names the
    // bot afterwards; the reader it gets back is `mentionContextMock`.
    mentionContextMock.mockReset().mockResolvedValue('');
    prepareMentionContextMock.mockReset().mockReturnValue(mentionContextMock);
    dispatchMentionsMock.mockReset().mockResolvedValue([]);
    recordTaskMock.mockReset().mockResolvedValue(undefined);
    buildBotTurnOverrideMock.mockReset().mockReturnValue({ systemPrompt: 'BOT', toolList: [] });
    summarizeThreadAheadMock.mockReset().mockResolvedValue('nothing_to_do');
  });

  const resolve = (over: { agentKey?: string; notice?: string | null; firstTurn?: boolean } = {}) =>
    resolveChatAgentGraphMock.mockResolvedValue({
      graph,
      agentKey: 'general',
      notice: null,
      firstTurn: false,
      ...over,
    });
  const systemContext = () => invokeMock.mock.calls[0][0].additionalSystemContext;

  it('runs the turn on the graph the resolver picked for this thread and page', async () => {
    resolve({ agentKey: 'bangun', firstTurn: true });

    const res = await POST(
      chatRequest({
        page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
      }),
    );

    expect(res.status).toBe(200);
    expect(resolveChatAgentGraphMock).toHaveBeenCalledWith(
      {
        chat: expect.objectContaining({ id: CHAT_ID }),
        pageContext: expect.objectContaining({ insightId: INSIGHT_ID }),
        // Unrouted (the router mock answers nothing) on an open insight: the
        // short-turn fallback is `low`, raised to the insight floor.
        effort: 'medium',
        flavour: 'investment',
        sof: true,
      },
      { workspaceId: 'ws-1', copilotChatsService, insightService },
    );
    expect(res.headers.get('X-Chat-Agent')).toBe('bangun');
  });

  it('runs the turn under the signed-in user so its Langfuse traces are attributed', async () => {
    // Not asserted on the invoke config: the id reaches Langfuse through the
    // ambient store that `withLangfuseCallbacks` reads inside the agent
    // runtime, which is mocked out here.
    let userDuringTurn: string | undefined;
    resolve();
    invokeMock.mockImplementation(async () => {
      userDuringTurn = getLangfuseUserId();
      return { messages: [] };
    });

    await POST(chatRequest({}));

    expect(userDuringTurn).toBe('u1');
    expect(getLangfuseUserId()).toBeUndefined();
  });

  it('leaves an unauthenticated request unattributed and unanswered', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(chatRequest({}));

    expect(res.status).toBe(401);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('renders a failed session read as the route\'s own JSON error, not a bare throw', async () => {
    // auth() sits outside handleChatTurn so the user can be resolved before the
    // turn runs; POST keeps its own try/catch so that move did not take the
    // session decrypt out from under the route's error shape.
    authMock.mockRejectedValue(Object.assign(new Error('JWEDecryptionFailed'), { status: 401 }));

    const res = await POST(chatRequest({}));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'JWEDecryptionFailed' });
  });

  it("passes the thread's agent to tools via configurable.agent_key", async () => {
    resolve({ agentKey: 'dikti' });

    await POST(chatRequest({}));

    const [inputs, config] = invokeMock.mock.calls[0];
    expect(config.configurable.agent_key).toBe('dikti');
    expect(inputs.additionalSystemContext).toBe('WORKSPACE CONTEXT');
  });

  it('appends the no-sector-agent notice to the system context on the turn that carries it', async () => {
    resolve({ notice: 'NO AGENT NOTICE', firstTurn: true });

    await POST(chatRequest({}));

    expect(systemContext()).toBe('WORKSPACE CONTEXT\n\nNO AGENT NOTICE');
  });

  it('returns 500 when the resolved agent graph is unavailable', async () => {
    resolveChatAgentGraphMock.mockResolvedValue({ graph: null, agentKey: 'general', notice: null, firstTurn: false });

    const res = await POST(chatRequest({}));

    expect(res.status).toBe(500);
    expect(invokeMock).not.toHaveBeenCalled();
    // The lock was already held: given back, since the hook that would release it never registered.
    expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
    expect(presence.handle.done).toHaveBeenCalledTimes(1);
  });

  describe("the thread's history read", () => {
    it('starts once the lock is held, through the tier-independent reader, while the router is still out', async () => {
      resolve();
      shouldRouteMock.mockReturnValue(true);
      let answerRouter!: (tier: string) => void;
      routeEffortMock.mockImplementation(
        () =>
          new Promise<string>((r) => {
            answerRouter = r;
          }),
      );
      const prior = [new HumanMessage({ id: 'h-1', content: 'earlier' })];
      const snapshot = { messages: prior, hasInterrupt: false, checkpointId: 'cp-1' };
      readThreadSnapshotMock.mockResolvedValue(snapshot);
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);

      const pending = POST(chatRequest({}));
      await vi.waitFor(() => expect(readThreadSnapshotMock).toHaveBeenCalledWith(CHAT_ID));
      // The tier is unknown while the router is out, so no graph has been
      // resolved yet — the read did not wait for one.
      expect(resolveChatAgentGraphMock).not.toHaveBeenCalled();
      expect(claimTurnMock).toHaveBeenCalledWith(CHAT_ID, expect.any(Number));

      answerRouter('low');
      const res = await pending;

      expect(res.status).toBe(200);
      // That one read is the history the turn ran on; the tier's graph is
      // never asked for it again.
      expect(graph.getThreadSnapshot).not.toHaveBeenCalled();
      expect(graph.repairOrphanedToolCalls).toHaveBeenCalledWith(CHAT_ID, snapshot);
      expect(persistQuestionMock.mock.calls[0][0].prior).toBe(prior);
    });

    it('is not started for a turn that does not get the lock', async () => {
      resolve();
      claimTurnMock.mockResolvedValue(false);

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(409);
      expect(readThreadSnapshotMock).not.toHaveBeenCalled();
    });

    it('fails the turn, giving the lock back, when the read fails', async () => {
      resolve();
      readThreadSnapshotMock.mockRejectedValue(new Error('checkpoint unavailable'));

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(500);
      expect(invokeMock).not.toHaveBeenCalled();
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
    });
  });

  describe('the open insight as context (MB-550)', () => {
    const insightPage = { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID };
    const context = {
      insightId: INSIGHT_ID,
      name: 'Java universities',
      versionNo: 3,
      publishedAt: '2026-09-24T00:00:00Z',
      outline: 'Insight "Java universities" · version 3\n[section: cohort]\n| Uni A | 1,200 |',
      truncated: false,
    };

    it('appends the outline to the system context, and never to the persisted messages', async () => {
      getChatContextMock.mockResolvedValue(context);
      resolve({ agentKey: 'bangun' });

      await POST(chatRequest({ page_context: insightPage }));

      expect(getChatContextMock).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
      const [inputs] = invokeMock.mock.calls[0];
      expect(inputs.additionalSystemContext).toMatch(/^WORKSPACE CONTEXT\n\n## The insight open on screen\n/);
      expect(inputs.additionalSystemContext).toContain(`<insight_outline>\n${context.outline}\n</insight_outline>`);
      expect(JSON.stringify(inputs.messages)).not.toContain('Uni A');
    });

    it('places the outline after the no-sector-agent notice', async () => {
      getChatContextMock.mockResolvedValue(context);
      resolve({ notice: 'NO AGENT NOTICE', firstTurn: true });

      await POST(chatRequest({ page_context: insightPage }));

      expect(systemContext()).toMatch(/^WORKSPACE CONTEXT\n\nNO AGENT NOTICE\n\n## The insight open on screen\n/);
    });

    it('reads no outline when no insight is open', async () => {
      resolve();

      await POST(chatRequest({ page_context: { tabSlug: null, path: '/pipeline' } }));

      expect(getChatContextMock).not.toHaveBeenCalled();
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
    });

    it('runs the turn without an outline when the insight is gone or the read fails', async () => {
      resolve();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      getChatContextMock.mockResolvedValueOnce(null);
      await POST(chatRequest({ page_context: insightPage }));
      getChatContextMock.mockRejectedValueOnce(new Error('db down'));
      const res = await POST(chatRequest({ page_context: insightPage }));

      expect(res.status).toBe(200);
      expect(invokeMock.mock.calls[0][0].additionalSystemContext).toBe('WORKSPACE CONTEXT');
      expect(invokeMock.mock.calls[1][0].additionalSystemContext).toBe('WORKSPACE CONTEXT');
      consoleError.mockRestore();
    });

  });

  describe('large documents and the zero-work timeout', () => {
    const HTML_REF = { key: 'chat-attachments/ws-1/brief.html', fileName: 'brief.html', contentType: 'text/html' };
    const config = () => invokeMock.mock.calls[0][1];
    const inputs = () => invokeMock.mock.calls[0][0];

    it('reads the thread once, and passes that read to the file-reference rewrite', async () => {
      const history = [new HumanMessage('earlier')];
      getMessagesMock.mockResolvedValue(history);
      resolve();

      await POST(chatRequest({}));

      expect(getMessagesMock).toHaveBeenCalledTimes(1);
      expect(getMessagesMock).toHaveBeenCalledWith(CHAT_ID);
      expect(graph.rewriteFileReferences).toHaveBeenCalledWith(CHAT_ID, [], history);
      expect(graph.repairCorruptServerToolCalls).toHaveBeenCalledWith(CHAT_ID, history);
    });

    it('repairs nothing on a thread with no history yet', async () => {
      resolve();

      await POST(chatRequest({}));

      expect(getMessagesMock).toHaveBeenCalledTimes(1);
      expect(graph.rewriteFileReferences).not.toHaveBeenCalled();
      expect(graph.repairOrphanedToolCalls).not.toHaveBeenCalled();
    });

    it('after a zero-work timeout, tells this turn to hand off and withholds the whole-document tools', async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage('build an insight from my template'),
        new AIMessage(buildBudgetNotice({ budgetMs: 180_000 })),
      ]);
      resolve();

      await POST(chatRequest({}));

      expect(inputs().additionalSystemContext).toBe(`WORKSPACE CONTEXT\n\n${ZERO_WORK_FOLLOW_UP_CONTEXT}`);
      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
    });

    it('after a timeout that did complete tools, steers a document request to a handoff and withholds the whole-document tools', async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage('remove this sidebar'),
        new AIMessage(buildBudgetNotice({ budgetMs: 90_000, toolNames: ['get_insight'] })),
      ]);
      resolve();

      await POST(chatRequest({}));

      expect(inputs().additionalSystemContext).toBe(`WORKSPACE CONTEXT\n\n${TIMED_OUT_FOLLOW_UP_CONTEXT}`);
      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
    });

    it('adds nothing after an ordinary answer', async () => {
      getMessagesMock.mockResolvedValue([new HumanMessage('rank them'), new AIMessage('Here is the ranking.')]);
      resolve();

      await POST(chatRequest({}));

      expect(inputs().additionalSystemContext).toBe('WORKSPACE CONTEXT');
      expect(inputs().withheldTools).toEqual([]);
    });

    it("gives the handoff the thread's most recent attachments when this turn has none", async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage({ content: 'here is the file', additional_kwargs: { [CHAT_ATTACHMENTS_KWARG]: [HTML_REF] } }),
        new AIMessage('ok'),
      ]);
      resolve();

      await POST(chatRequest({}));

      expect(ownedRefsMock).toHaveBeenCalledWith([HTML_REF]);
      expect(config().configurable.priorAttachments).toEqual([HTML_REF]);
      expect(config().configurable.attachments).toEqual([]);
    });

    it("drops an earlier ref from another workspace", async () => {
      const foreign = { ...HTML_REF, key: 'chat-attachments/ws-2/brief.html' };
      getMessagesMock.mockResolvedValue([
        new HumanMessage({ content: 'x', additional_kwargs: { [CHAT_ATTACHMENTS_KWARG]: [foreign] } }),
      ]);
      resolve();

      await POST(chatRequest({}));

      expect(config().configurable.priorAttachments).toEqual([]);
    });

    it('records the attachment refs on the human message and outlines a large HTML file', async () => {
      attachmentPrepareMock.mockResolvedValue({
        blocks: [{ type: 'text', text: 'Attached file "brief.html":\n\nOUTLINE' }],
        fileIds: [],
        outlinedHtml: ['brief.html'],
      });
      resolve();

      await POST(chatRequest({ attachments: [HTML_REF] }));

      expect(attachmentPrepareMock).toHaveBeenCalledWith([HTML_REF], { largeHtml: 'outline' });
      const [human] = inputs().messages;
      expect(human.additional_kwargs).toEqual({ [CHAT_ATTACHMENTS_KWARG]: [HTML_REF] });
      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
      // This turn's own attachments go to the handoff; no fallback is read.
      expect(config().configurable.attachments).toEqual([HTML_REF]);
      expect(config().configurable.priorAttachments).toEqual([]);
    });

    it('withholds the whole-document tools on a turn carrying a template too large for chat', async () => {
      const TEMPLATE_ID = '00000000-0000-0000-0000-00000000e001';
      templatePrepareMock.mockResolvedValue({
        type: 'text',
        text: `<insight_template id="${TEMPLATE_ID}" name="Huge" status="too-large-for-chat">\nOUTLINE\n</insight_template>`,
      });
      resolve();

      await POST(
        chatRequest({
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'text', text: 'build it' },
                { type: 'data-insight-template', data: { id: TEMPLATE_ID, name: 'Huge' } },
              ],
            },
          ],
        }),
      );

      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
      // No attachments on this turn, so nothing is recorded on the message.
      expect(inputs().messages[0].additional_kwargs).toEqual({});
    });

    it('keeps every tool for a template chat can build', async () => {
      const TEMPLATE_ID = '00000000-0000-0000-0000-00000000e001';
      templatePrepareMock.mockResolvedValue({
        type: 'text',
        text: `<insight_template id="${TEMPLATE_ID}" name="Small">\n<template_html>x</template_html>\n</insight_template>`,
      });
      resolve();

      await POST(
        chatRequest({
          messages: [
            {
              role: 'user',
              parts: [{ type: 'data-insight-template', data: { id: TEMPLATE_ID, name: 'Small' } }],
            },
          ],
        }),
      );

      expect(inputs().withheldTools).toEqual([]);
    });
  });

  describe('an insight selection (MB-583)', () => {
    const SELECTION = {
      insightId: INSIGHT_ID,
      insightName: 'Weekly Weather Forecast',
      sections: [{ path: [0, 0], tags: ['div', 'h1'], content: 'Weekly Weather Forecast' }],
    };
    const selectionRequest = () =>
      chatRequest({
        page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'HERE YOU GO' },
              { type: 'data-insight-selection', data: SELECTION },
            ],
          },
        ],
      });

    it('puts the selection block before the user words, and records it on the message', async () => {
      resolve();

      await POST(selectionRequest());

      const [human] = invokeMock.mock.calls[0][0].messages;
      expect(human.content).toEqual([
        { type: 'text', text: formatInsightSelectionBlock(SELECTION) },
        { type: 'text', text: 'HERE YOU GO' },
      ]);
      expect(human.additional_kwargs).toEqual({ [INSIGHT_SELECTION_KWARG]: SELECTION });
    });

    it('records the question with the selection addresses but never the document content', async () => {
      resolve();

      await POST(selectionRequest());

      const question = invokeMock.mock.calls[0][1].configurable.originalUserQuestion;
      expect(question).toBe(
        `${formatInsightSelectionBlock(SELECTION, { includeContent: false })}\n\nHERE YOU GO`,
      );
      expect(question).not.toContain('document_content');
    });

    it('leaves a turn without a selection on the plain text path', async () => {
      resolve();

      await POST(chatRequest({}));

      expect(attachmentPrepareMock).not.toHaveBeenCalled();
      expect(invokeMock.mock.calls[0][1].configurable.originalUserQuestion).toBe(
        'How is this developer doing?',
      );
    });
  });

  describe('the CoPilot\u2019s memory (mem0)', () => {
    /** Run every callback the route handed to `after()`. */
    const runAfterCallbacks = async () => {
      for (const [fn] of vi.mocked(after).mock.calls) {
        await (fn as () => unknown)();
      }
    };

    it('does nothing at all when the memory flag is off', async () => {
      resolve();

      await POST(chatRequest({}));
      await runAfterCallbacks();

      expect(recallForTurnMock).not.toHaveBeenCalled();
      expect(rememberTurnMock).not.toHaveBeenCalled();
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
    });

    it('recalls on this turn\u2019s text and puts the memories right after the workspace context', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      recallForTurnMock.mockResolvedValue('## What you remember about this user\n\n- Covers coal');
      resolve();

      await POST(chatRequest({}));

      expect(userMemoryServiceMock).toHaveBeenCalledWith('u1');
      expect(recallForTurnMock).toHaveBeenCalledWith('How is this developer doing?');
      expect(systemContext()).toBe(
        'WORKSPACE CONTEXT\n\n## What you remember about this user\n\n- Covers coal',
      );
    });

    it('adds the notes the user asked this bot to keep after the mem0 memories, whatever the memory flag says', async () => {
      // Explicit notes are not behind the mem0 switch: the user asked for each by name.
      copilotMemoryEnabledMock.mockResolvedValue(false);
      botMemoryPromptContextMock.mockResolvedValue('## What this user asked you to remember\n\n- Answer in Bahasa');
      resolve();

      await POST(chatRequest({}));

      expect(botMemoryPromptContextMock).toHaveBeenCalledWith('u1', expect.any(String));
      expect(systemContext()).toBe('WORKSPACE CONTEXT\n\n## What this user asked you to remember\n\n- Answer in Bahasa');
    });

    it('runs the turn without the notes when their lookup fails', async () => {
      botMemoryPromptContextMock.mockRejectedValue(new Error('db down'));
      resolve();

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(200);
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
    });

    it("tells the turn the user's decisions on the chat's cards, after the bot's notes", async () => {
      botMemoryPromptContextMock.mockResolvedValue('BOT NOTES');
      cardPromptContextMock.mockResolvedValue('CARD DECISIONS');
      resolve();

      await POST(chatRequest({}));

      expect(cardPromptContextMock).toHaveBeenCalledWith(expect.any(String));
      expect(systemContext()).toBe('WORKSPACE CONTEXT\n\nBOT NOTES\n\nCARD DECISIONS');
    });

    it('runs the turn without the card decisions when their lookup fails', async () => {
      cardPromptContextMock.mockRejectedValue(new Error('db down'));
      resolve();

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(200);
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
    });

    it('places the memories before the open insight\u2019s outline', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      recallForTurnMock.mockResolvedValue('MEMORY BLOCK');
      getChatContextMock.mockResolvedValue({
        insightId: INSIGHT_ID,
        name: 'Java universities',
        versionNo: 1,
        publishedAt: '2026-09-24T00:00:00Z',
        outline: 'outline',
        truncated: false,
      });
      resolve({ agentKey: 'bangun' });

      await POST(
        chatRequest({
          page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
        }),
      );

      expect(systemContext()).toMatch(
        /^WORKSPACE CONTEXT\n\nMEMORY BLOCK\n\n## The insight open on screen\n/,
      );
    });

    it('runs the turn without memory when recall fails', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      recallForTurnMock.mockRejectedValue(new Error('bedrock down'));
      resolve();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(200);
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
      spy.mockRestore();
    });

    it('records the finished turn after the response, from the persisted messages', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      extractLastTurnMock.mockReturnValue({ userText: 'q', assistantText: 'the answer' });
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue([new HumanMessage({ id: 'h', content: 'q' })]);
      resolve();

      await POST(chatRequest({}));
      expect(rememberTurnMock).not.toHaveBeenCalled();

      await runAfterCallbacks();

      expect(getMessagesMock).toHaveBeenCalledWith(CHAT_ID);
      expect(withBackgroundDbMock).toHaveBeenCalled();
      expect(rememberTurnMock).toHaveBeenCalledWith({
        userId: 'u1',
        chatId: CHAT_ID,
        userText: 'q',
        assistantText: 'the answer',
      });
    });

    it('records nothing when the turn persisted no answer', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      extractLastTurnMock.mockReturnValue({ userText: 'q', assistantText: '   ' });
      resolve();

      await POST(chatRequest({}));
      await runAfterCallbacks();

      expect(rememberTurnMock).not.toHaveBeenCalled();
    });

    it('does not fail the turn when the write-back throws', async () => {
      copilotMemoryEnabledMock.mockResolvedValue(true);
      extractLastTurnMock.mockReturnValue({ userText: 'q', assistantText: 'a' });
      rememberTurnMock.mockRejectedValue(new Error('anthropic 529'));
      resolve();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(chatRequest({}));
      await expect(runAfterCallbacks()).resolves.not.toThrow();

      expect(res.status).toBe(200);
      spy.mockRestore();
    });
  });

  describe('the turn lock and chat history', () => {
    const runAfter = async () => {
      for (const call of vi.mocked(after).mock.calls) {
        const task = call[0];
        await (typeof task === 'function' ? task() : task);
      }
    };

    it('409s while a background turn (a mention or a routine) holds this thread, and runs nothing', async () => {
      claimTurnMock.mockResolvedValue(false);
      resolve();

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('Copilot is working on a background task');
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('holds the lock for the turn and releases it once the response is done', async () => {
      resolve();

      await POST(chatRequest({}));
      expect(claimTurnMock).toHaveBeenCalledWith(CHAT_ID, 600);
      expect(releaseTurnMock).not.toHaveBeenCalled();

      await runAfter();
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
    });

    it('stores the finished turn in the chat history as read', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      const finalMessages = [new HumanMessage({ id: 'h-new', content: 'q' })];
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue(finalMessages);
      resolve();

      await POST(chatRequest({}));
      await runAfter();

      expect(persistTurnMock).toHaveBeenCalledWith({
        chat: expect.objectContaining({ id: CHAT_ID }),
        finalMessages,
        interactive: true,
        questionStored: true,
        // What the up-front write stamped, for the case it had failed.
        question: {
          id: persistQuestionMock.mock.calls[0][0].id,
          turn: { model: 'claude-haiku-5-5', effortTier: 'low' },
        },
      });
    });

    it('stores the question as soon as the turn is claimed, before the agent runs', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      getMessagesMock.mockResolvedValue([]);
      resolve();

      await POST(chatRequest({}));

      expect(persistQuestionMock).toHaveBeenCalledTimes(1);
      const [call] = persistQuestionMock.mock.calls;
      expect(call[0]).toMatchObject({ chat: expect.objectContaining({ id: CHAT_ID }), prior: [] });
      expect(call[0].message).toBeInstanceOf(HumanMessage);
      expect(persistQuestionMock.mock.invocationCallOrder[0]).toBeGreaterThan(claimTurnMock.mock.invocationCallOrder[0]);
      const agentRan = streamEventsMock.mock.invocationCallOrder[0] ?? invokeMock.mock.invocationCallOrder[0];
      expect(persistQuestionMock.mock.invocationCallOrder[0]).toBeLessThan(agentRan);
    });

    it("records the turn's model and tier on the question, and runs the turn under the question's id", async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      getMessagesMock.mockResolvedValue([]);
      resolve();

      const res = await POST(chatRequest({ show_intermediate_steps: false }));

      // A short, attachment-free turn with no router answer falls back to `low`.
      const [call] = persistQuestionMock.mock.calls[0];
      expect(call.turn).toEqual({ model: 'claude-haiku-5-5', effortTier: 'low' });
      // The route picks the row's id itself, so the run never waits for the insert.
      expect(call.id).toMatch(UUID);
      // The root runId is the Langfuse trace id that feedback scores.
      expect(streamEventsMock.mock.calls[0][1].runId).toBe(call.id);
      // The reply learns its question id, which keys its feedback.
      expect(await res.text()).toContain(`"questionId":"${call.id}"`);
    });

    it("runs a non-streamed turn under the question's id too", async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      getMessagesMock.mockResolvedValue([]);
      resolve();

      await POST(chatRequest({}));

      expect(invokeMock.mock.calls[0][1].runId).toBe(persistQuestionMock.mock.calls[0][0].id);
    });

    it("keeps the question's id for the run and the reply when its insert fails, and stores the question under it at the end", async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      persistQuestionMock.mockRejectedValue(new Error('db hiccup'));
      const finalMessages = [new HumanMessage({ id: 'h-new', content: 'q' }), new AIMessage('a')];
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue(finalMessages);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resolve();

      const res = await POST(chatRequest({ show_intermediate_steps: false }));
      const body = await res.text();
      await runAfter();

      // The id went out before the insert came back, so nothing dangles: the
      // run, the reply and the question stored at the end all carry it.
      const id = persistQuestionMock.mock.calls[0][0].id as string;
      expect(id).toMatch(UUID);
      expect(streamEventsMock.mock.calls[0][1].runId).toBe(id);
      expect(body).toContain(`"questionId":"${id}"`);
      expect(persistTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          questionStored: false,
          question: { id, turn: { model: 'claude-haiku-5-5', effortTier: 'low' } },
        }),
      );
      spy.mockRestore();
    });

    it('does not wait for the question insert before running the agent, and counts it once it lands', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      let land!: (id: string) => void;
      persistQuestionMock.mockReturnValue(new Promise<string>((resolveInsert) => { land = resolveInsert; }));
      const finalMessages = [new HumanMessage({ id: 'h-new', content: 'q' }), new AIMessage('a')];
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue(finalMessages);
      resolve();

      await POST(chatRequest({}));
      // The agent ran while the insert was still in flight.
      expect(invokeMock).toHaveBeenCalledTimes(1);

      land(persistQuestionMock.mock.calls[0][0].id);
      await runAfter();
      expect(persistTurnMock).toHaveBeenCalledWith(expect.objectContaining({ questionStored: true }));
    });

    it('claims the turn with the context reads, before the router has answered', async () => {
      shouldRouteMock.mockReturnValue(true);
      let claimsWhenRouted = -1;
      routeEffortMock.mockImplementation(
        () =>
          new Promise((resolveRoute) =>
            setTimeout(() => {
              claimsWhenRouted = claimTurnMock.mock.calls.length;
              resolveRoute('medium');
            }, 5),
          ),
      );
      resolve();

      await POST(chatRequest({}));

      expect(claimsWhenRouted).toBe(1);
      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('medium');
    });

    it('gives the thread back when the attachments are refused after the claim', async () => {
      const { ChatAttachmentForbiddenError } = await import('@/lib/services/chatAttachmentService');
      attachmentPrepareMock.mockRejectedValue(new ChatAttachmentForbiddenError());
      resolve();

      const res = await POST(chatRequest({ attachments: [{ key: 'chat-attachments/ws-1/a.pdf', name: 'a.pdf' }] }));

      expect(res.status).toBe(403);
      expect(claimTurnMock).toHaveBeenCalledTimes(1);
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
      expect(presence.handle.done).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('gives the thread back when a step after the claim throws', async () => {
      resolveChatAgentGraphMock.mockRejectedValue(new Error('registry down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(500);
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
      expect(presence.handle.done).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('releases nothing when the claim itself failed', async () => {
      claimTurnMock.mockRejectedValue(new Error('db down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resolve();

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(500);
      expect(releaseTurnMock).not.toHaveBeenCalled();
      expect(presence.startTurnPresence).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('still answers when the question cannot be stored up front, and stores the whole turn at the end', async () => {
      persistQuestionMock.mockRejectedValue(new Error('db hiccup'));
      const finalMessages = [new HumanMessage({ id: 'h-new', content: 'q' })];
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue(finalMessages);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resolve();

      const res = await POST(chatRequest({}));
      await runAfter();

      expect(res.status).toBe(200);
      expect(persistTurnMock.mock.calls[0][0].questionStored).toBe(false);
      spy.mockRestore();
    });

    it('summarizes the thread ahead of need after the turn, off the lock, from the read it already made', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      const finalMessages = [new HumanMessage({ id: 'h-new', content: 'q' }), new AIMessage('a')];
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue(finalMessages);
      resolve();

      await POST(chatRequest({}));
      await runAfter();

      expect(summarizeThreadAheadMock).toHaveBeenCalledTimes(1);
      const [call] = summarizeThreadAheadMock.mock.calls[0];
      expect(call).toMatchObject({ agent: graph, chatId: CHAT_ID, known: { messages: finalMessages } });
      expect(summarizeThreadAheadMock.mock.invocationCallOrder[0]).toBeGreaterThan(releaseTurnMock.mock.invocationCallOrder[0]);
      // Its lock is the thread's own, through the background connection.
      await call.claimTurn(CHAT_ID, 60);
      await call.releaseTurn(CHAT_ID);
      expect(claimTurnMock).toHaveBeenLastCalledWith(CHAT_ID, 60);
      expect(releaseTurnMock).toHaveBeenCalledTimes(2);
    });

    it('does not summarize a turn that never reached the thread, and survives a summarizer failure', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      getMessagesMock.mockResolvedValue([new HumanMessage({ id: 'h-old', content: 'old' })]);
      resolve();
      await POST(chatRequest({}));
      await runAfter();
      expect(summarizeThreadAheadMock).not.toHaveBeenCalled();

      vi.mocked(after).mockClear();
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      getMessagesMock.mockReset().mockResolvedValueOnce([]).mockResolvedValue([new HumanMessage({ id: 'h-new', content: 'q' }), new AIMessage('a')]);
      summarizeThreadAheadMock.mockRejectedValue(new Error('summarizer down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await POST(chatRequest({}));
      await expect(runAfter()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith('[chat] failed to summarize the thread ahead of need:', expect.any(Error));
      spy.mockRestore();
    });

    const mentionRequest = (text: string) =>
      chatRequest({ messages: [{ role: 'user', parts: [{ type: 'text', text }] }] });

    it("pings the user's @mentions as soon as the message arrives", async () => {
      dispatchMentionsMock.mockResolvedValue(['scout']);
      resolve();

      await POST(mentionRequest('@Scout look at this'));

      expect(dispatchMentionsMock).toHaveBeenCalledTimes(1);
      expect(dispatchMentionsMock).toHaveBeenCalledWith('u1', {
        bot: { id: defaultBot.id, name: defaultBot.name },
        userText: '@Scout look at this',
      });
    });

    it("pings the user's @mentions even when the turn never reaches the thread", async () => {
      // The turn fails before the agent runs: nothing new in the thread.
      getMessagesMock.mockResolvedValue([]);
      resolve();

      await POST(mentionRequest('@Scout look'));
      await runAfter();

      expect(dispatchMentionsMock).toHaveBeenCalledTimes(1);
      expect(dispatchMentionsMock).toHaveBeenCalledWith('u1', expect.objectContaining({ userText: '@Scout look' }));
    });

    it('does not ping when the message names no bot', async () => {
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue([new HumanMessage({ id: 'h-new', content: 'q' })]);
      extractLastTurnMock.mockReturnValue({ userText: 'q', assistantText: 'a' });
      resolve();

      await POST(chatRequest({}));
      expect(dispatchMentionsMock).not.toHaveBeenCalled();
    });

    it("hands the reply's @mentions on after the turn, skipping bots the user already pinged", async () => {
      dispatchMentionsMock.mockResolvedValue(['scout']);
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue([new HumanMessage({ id: 'h-new', content: 'q' })]);
      extractLastTurnMock.mockReturnValue({ userText: '@Scout look', assistantText: 'Asked @Atlas.' });
      resolve();

      await POST(mentionRequest('@Scout look'));
      expect(dispatchMentionsMock).toHaveBeenCalledTimes(1);
      await runAfter();

      expect(dispatchMentionsMock).toHaveBeenLastCalledWith('u1', {
        bot: { id: defaultBot.id, name: defaultBot.name },
        replyText: 'Asked @Atlas.',
        alreadyPinged: ['scout'],
        // The asker's thread and turn: the group the requests behind these mentions share.
        chatId: CHAT_ID,
        turnId: expect.any(String),
      });
    });

    it("queues the finished turn for the bot's task log", async () => {
      getMessagesMock.mockResolvedValueOnce([]).mockResolvedValue([new HumanMessage({ id: 'h-new', content: 'q' })]);
      extractLastTurnMock.mockReturnValue({ userText: 'Find targets', assistantText: 'Found three.' });
      resolve();

      await POST(chatRequest({}));
      await runAfter();

      expect(recordTaskMock).toHaveBeenCalledWith({
        botId: defaultBot.id,
        userId: 'u1',
        chatId: CHAT_ID,
        source: 'chat',
        routine: null,
        question: 'Find targets',
        answer: 'Found three.',
        toolNames: [],
      });
    });

    it('tells the bot which other bots it can @mention', async () => {
      mentionContextMock.mockResolvedValue('<other_bots>');
      resolve();

      await POST(chatRequest({}));

      // The list read starts before the thread is opened; the note names the bot afterwards.
      expect(prepareMentionContextMock).toHaveBeenCalledWith('u1');
      expect(prepareMentionContextMock.mock.invocationCallOrder[0]).toBeLessThan(
        openDefaultThreadMock.mock.invocationCallOrder[0],
      );
      expect(mentionContextMock).toHaveBeenCalledWith(defaultBot.id);
      expect(systemContext()).toBe('WORKSPACE CONTEXT\n\n<other_bots>');
    });

    it('stores nothing when the turn never reached the thread, takes its question back out, and still releases the lock', async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      const unchanged = [new HumanMessage({ id: 'h-old', content: 'old' })];
      getMessagesMock.mockResolvedValue(unchanged);
      resolve();

      await POST(chatRequest({}));
      await runAfter();

      expect(persistTurnMock).not.toHaveBeenCalled();
      expect(discardQuestionMock).toHaveBeenCalledWith(persistQuestionMock.mock.calls[0][0].id);
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
    });

    it('releases the lock and clears live presence when reading the history fails', async () => {
      getMessagesMock.mockRejectedValue(new Error('checkpointer down'));
      resolve();

      const res = await POST(chatRequest({}));

      expect(res.status).toBe(500);
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
      expect(presence.handle.done).toHaveBeenCalledTimes(1);
    });

    it('gives the tools the chatting user and the bot, from the session', async () => {
      resolve();

      await POST(chatRequest({}));

      expect(invokeMock.mock.calls[0][1].configurable).toMatchObject({
        userId: 'u1',
        botId: defaultBot.id,
      });
    });
  });

  describe('the turn timeline on the Langfuse trace', () => {
    it("files the setup stages on the turn's trace, which runs under the question's id", async () => {
      const { toBaseMessages } = await import('@ai-sdk/langchain');
      vi.mocked(toBaseMessages).mockResolvedValueOnce([new HumanMessage('q')]);
      resolve();

      await POST(chatRequest({}));

      const runId = invokeMock.mock.calls[0][1].runId as string;
      expect(runId).toBe(persistQuestionMock.mock.calls[0][0].id);
      expect(recordTurnTimingMock).toHaveBeenCalledTimes(1);
      const [timing] = recordTurnTimingMock.mock.calls[0];
      expect(timing.traceId).toBe(runId);
      expect(Object.keys(timing.stages)).toEqual(
        expect.arrayContaining(['thread_open', 'context', 'router', 'graph_resolved', 'turn_claimed', 'history_read', 'repairs']),
      );
      // The debug path streams nothing, so there is no first token to report.
      expect(timing.firstTokenMs).toBeNull();
      expect(timing.firstTextMs).toBeNull();
    });

    it('records a streamed turn once, with its first-token timings, before the Langfuse drain', async () => {
      resolve();
      streamEventsMock.mockResolvedValue(
        (async function* () {
          yield { event: 'on_chat_model_start' };
          yield { event: 'on_chat_model_stream', data: { chunk: { content: [{ type: 'thinking', thinking: 'hm' }] } } };
          yield { event: 'on_chat_model_stream', data: { chunk: { content: 'Hello' } } };
        })(),
      );
      // Drain the (tapped) agent events the way the real converter does, then
      // emit one text chunk; the wrap-up passes the stream through.
      vi.mocked(toThinkingMessageStream).mockImplementationOnce(
        (events) =>
          new ReadableStream({
            async start(controller) {
              for await (const _ of events as AsyncIterable<unknown>) {
                void _;
              }
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'Hello' });
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.close();
            },
          }) as never,
      );
      vi.mocked(withBudgetWrapUp).mockImplementationOnce((stream) => stream as never);
      const res = await POST(
        new NextRequest('http://localhost/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'How is this developer doing?' }] }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      // No question row on this path, so the turn runs under a fresh trace id.
      expect(streamEventsMock.mock.calls[0][1].runId).toMatch(UUID);
      // Drain the body so the tap sees the model events, then run the hooks.
      await res.body!.pipeTo(new WritableStream());
      for (const [fn] of vi.mocked(after).mock.calls) {
        await (fn as () => unknown)();
      }

      expect(recordTurnTimingMock).toHaveBeenCalledTimes(1);
      const [timing] = recordTurnTimingMock.mock.calls[0];
      expect(timing.traceId).toBe(streamEventsMock.mock.calls[0][1].runId);
      expect(timing.stages).toMatchObject({ model_started: expect.any(Number), first_token: expect.any(Number), first_text: expect.any(Number) });
      expect(timing.firstTokenMs).toEqual(expect.any(Number));
      expect(timing.firstTextMs).toEqual(expect.any(Number));
      expect(timing.firstTextMs).toBeGreaterThanOrEqual(timing.firstTokenMs);
    });
  });

  describe('bot threads (RFC 02)', () => {
    const BOT_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
    const BOT_CHAT_ID = 'cccccccc-2222-4333-8444-555555555555';
    const bot = {
      id: BOT_ID,
      name: 'Scout',
      base_flavor: 'vc',
      persona_md: 'Be brief.',
      skills: ['crm'],
    };
    const botThread = (over: Record<string, unknown> = {}) =>
      openThreadMock.mockResolvedValue({
        bot,
        chat: { id: BOT_CHAT_ID, title: 'Scout', effort_tier: 'high', agent_key: 'general', bot_id: BOT_ID, ...over },
      });

    it("runs on the bot's permanent thread and flavor, ignoring a posted chat_id", async () => {
      botThread();
      resolve();

      const res = await POST(chatRequest({ bot_id: BOT_ID, chat_id: CHAT_ID }));

      expect(res.status).toBe(200);
      expect(openThreadMock).toHaveBeenCalledWith('u1', BOT_ID);
      expect(openDefaultThreadMock).not.toHaveBeenCalled();
      expect(resolveChatAgentGraphMock.mock.calls[0][0]).toMatchObject({
        chat: expect.objectContaining({ id: BOT_CHAT_ID }),
        flavour: 'vc',
      });
      expect(res.headers.get('X-Chat-Id')).toBe(BOT_CHAT_ID);
    });

    it("hands the bot's prompt, tools and middleware to the agent for this turn", async () => {
      botThread();
      resolve();

      await POST(chatRequest({ bot_id: BOT_ID }));

      expect(buildBotTurnOverrideMock).toHaveBeenCalledWith(graph, bot);
      expect(invokeMock.mock.calls[0][0].override).toEqual({ systemPrompt: 'BOT', toolList: [] });
    });

    it('picks the effort tier per turn and never stores it on the thread', async () => {
      // The thread row says 'high'; a permanent thread must not stay pinned there.
      // Unrouted, short and with nothing attached, the turn runs at `low`.
      botThread({ effort_tier: 'high' });
      resolve();

      await POST(chatRequest({ bot_id: BOT_ID }));

      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('low');
    });

    it('falls back to medium for a long unrouted turn or one with attachments', async () => {
      resolve();

      await POST(chatRequest({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(300) }] }] }));

      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('medium');
    });

    it('runs on the workspace default bot when the turn names none', async () => {
      resolve();

      const res = await POST(chatRequest({}));

      expect(openDefaultThreadMock).toHaveBeenCalledWith('u1');
      expect(openThreadMock).not.toHaveBeenCalled();
      expect(buildBotTurnOverrideMock).toHaveBeenCalledWith(graph, defaultBot);
      expect(res.headers.get('X-Chat-Id')).toBe(CHAT_ID);
    });

    it("asks shouldRoute with the turn's text, so a very short turn skips the router and runs at low", async () => {
      // The real `shouldRoute` for this test: the stub is what the other tests use.
      const { shouldRoute: realShouldRoute } =
        await vi.importActual<typeof import('@/lib/chat/effortRouter')>('@/lib/chat/effortRouter');
      shouldRouteMock.mockImplementation(realShouldRoute);
      resolve();

      await POST(
        chatRequest({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'thanks, continue' }] }] }),
      );

      expect(shouldRouteMock).toHaveBeenCalledWith(null, false, 'thanks, continue');
      expect(routeEffortMock).not.toHaveBeenCalled();
      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('low');
    });

    it('still raises a very short unrouted turn on an open insight to the floor', async () => {
      const { shouldRoute: realShouldRoute } =
        await vi.importActual<typeof import('@/lib/chat/effortRouter')>('@/lib/chat/effortRouter');
      shouldRouteMock.mockImplementation(realShouldRoute);
      resolve();

      await POST(
        chatRequest({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'remove this sidebar' }] }],
          page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
        }),
      );

      expect(routeEffortMock).not.toHaveBeenCalled();
      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('medium');
    });

    it('files how the tier was decided on the trace: skipped, requested, routed or unanswered', async () => {
      resolve();
      const routingOf = (call: number) => recordTurnTimingMock.mock.calls[call][0].routing;

      // The stub says "do not route": the fallback placed the turn.
      await POST(chatRequest({}));
      expect(routingOf(0)).toEqual({
        decision: 'skipped',
        routed: null,
        effort: 'low',
        turnChars: 'How is this developer doing?'.length,
        floor: false,
      });

      await POST(chatRequest({ effort: 'medium' }));
      expect(routingOf(1)).toMatchObject({ decision: 'requested', routed: null, effort: 'medium' });

      shouldRouteMock.mockReturnValue(true);
      routeEffortMock.mockResolvedValue('medium');
      await POST(chatRequest({}));
      expect(routingOf(2)).toMatchObject({ decision: 'routed', routed: 'medium', effort: 'medium' });

      routeEffortMock.mockResolvedValue(null);
      await POST(chatRequest({ page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID } }));
      expect(routingOf(3)).toMatchObject({ decision: 'unanswered', routed: null, effort: 'medium', floor: true });
    });

    it("files the run's checkpoint writes on the trace once the turn has finished", async () => {
      resolve();
      getMessagesMock.mockResolvedValue([new HumanMessage({ id: 'h-1', content: 'earlier' })]);

      await POST(chatRequest({}));
      expect(beginCheckpointStatsMock).toHaveBeenCalledWith(CHAT_ID);
      expect(recordTurnWritesMock).not.toHaveBeenCalled();
      for (const [fn] of vi.mocked(after).mock.calls) {
        await (fn as () => unknown)();
      }

      const runId = invokeMock.mock.calls[0][1].runId as string;
      expect(recordTurnWritesMock).toHaveBeenCalledTimes(1);
      expect(recordTurnWritesMock).toHaveBeenCalledWith({
        traceId: runId,
        checkpoints: 2,
        writeBatches: 1,
        totalMs: 40,
        maxMs: 25,
        lastCheckpointMessages: 5,
        messagesAtStart: 1,
        // The timeline rides again on the turn's last trace update.
        timeline: {
          stages: expect.objectContaining({ history_read: expect.any(Number) }),
          routing: expect.objectContaining({ decision: 'skipped' }),
        },
      });
    });

    it('routes the effort tier per turn, raised to the open-insight floor', async () => {
      shouldRouteMock.mockReturnValue(true);
      routeEffortMock.mockResolvedValue('low');
      resolve();

      await POST(chatRequest({ page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID } }));
      await POST(chatRequest({}));
      await POST(chatRequest({ effort: 'low', page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID } }));

      expect(resolveChatAgentGraphMock.mock.calls.map((c) => c[0].effort)).toEqual(['medium', 'low', 'low']);
    });

    it('reads the persisted history even on the first message after a reload', async () => {
      botThread();
      getMessagesMock.mockResolvedValue([new HumanMessage('earlier')]);
      resolve();

      await POST(chatRequest({ bot_id: BOT_ID }));

      expect(getMessagesMock).toHaveBeenCalledWith(BOT_CHAT_ID);
      // The repair reuses the one read rather than reading the checkpoint again.
      expect(graph.repairOrphanedToolCalls).toHaveBeenCalledWith(BOT_CHAT_ID, {
        messages: [new HumanMessage('earlier')],
        hasInterrupt: false,
      });
    });

    it('404s when the bot is not visible to the user', async () => {
      const { BotNotFoundError } = await import('@/lib/services/botService');
      openThreadMock.mockRejectedValue(new BotNotFoundError());

      const res = await POST(chatRequest({ bot_id: BOT_ID }));

      expect(res.status).toBe(404);
      expect(invokeMock).not.toHaveBeenCalled();
    });

  });

  // A turn outlives its browser connection: navigating away must not cut the
  // reply off. Only the turn budget or an explicit Stop ends it early.
  describe('a streamed turn after the browser disconnects', () => {
    const runAfterCallbacks = async () => {
      for (const [fn] of vi.mocked(after).mock.calls) {
        await (fn as () => unknown)();
      }
    };
    const streamRequest = (signal?: AbortSignal) =>
      new NextRequest('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'How is this developer doing?' }] }],
        }),
        signal,
      });
    /** The agent's UI stream: `count` text chunks, recording how many were read. */
    const agentStream = (count: number) => {
      const read = { chunks: 0, done: false };
      let i = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (i === 0) controller.enqueue({ type: 'text-start', id: 't' });
          if (i < count) {
            controller.enqueue({ type: 'text-delta', id: 't', delta: `chunk ${i}` });
            i++;
            read.chunks = i;
            return;
          }
          controller.enqueue({ type: 'text-end', id: 't' });
          read.done = true;
          controller.close();
        },
      });
      return { stream, read };
    };
    const turnSignal = () => streamEventsMock.mock.calls[0][1].signal as AbortSignal;

    it('does not abort the agent when the request is aborted', async () => {
      resolve();
      vi.mocked(withBudgetWrapUp).mockReturnValue(agentStream(1).stream as never);
      const client = new AbortController();

      await POST(streamRequest(client.signal));
      client.abort();

      expect(turnSignal().aborted).toBe(false);
    });

    it('reads the agent to the end on the server after the client cancels its copy', async () => {
      resolve();
      const { stream, read } = agentStream(50);
      vi.mocked(withBudgetWrapUp).mockReturnValue(stream as never);

      const res = await POST(streamRequest());
      await res.body!.cancel();
      // The work queued with after() waits for the turn to finish.
      await runAfterCallbacks();

      expect(read).toEqual({ chunks: 50, done: true });
      expect(releaseTurnMock).toHaveBeenCalledWith(CHAT_ID);
    });

    it('aborts the agent when the Stop watch fires, never the request signal', async () => {
      resolve();
      // Still running: the agent has not produced its next chunk yet.
      vi.mocked(withBudgetWrapUp).mockReturnValue(new ReadableStream({ pull: () => new Promise(() => {}) }) as never);

      await POST(streamRequest());

      expect(presence.watchStop).toHaveBeenCalledWith(CHAT_ID);
      expect(turnSignal().aborted).toBe(false);
      presence.stop.controller.abort();
      expect(turnSignal().aborted).toBe(true);
    });

    it('shows the bot as live from the lock to after its release, and pushes the stored reply', async () => {
      resolve();
      const { stream } = agentStream(1);
      vi.mocked(withBudgetWrapUp).mockReturnValue(stream as never);
      getMessagesMock
        .mockResolvedValueOnce([])
        .mockResolvedValue([new HumanMessage({ content: 'q', id: 'h1' }), new AIMessage('a')]);

      const res = await POST(streamRequest());
      const turnId = res.headers.get('X-Turn-Id');
      expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
      expect(presence.startTurnPresence).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        userId: 'u1',
        chatId: CHAT_ID,
        botId: defaultBot.id,
        turnId,
      });
      // The presence detector rides on the agent run.
      expect(streamEventsMock.mock.calls[0][1].callbacks).toHaveLength(1);

      await res.body!.cancel();
      await runAfterCallbacks();

      expect(presence.publishReply).toHaveBeenCalledWith('ws-1', 'u1', { chatId: CHAT_ID, botId: defaultBot.id, turnId });
      expect(presence.handle.done).toHaveBeenCalledTimes(1);
      expect(presence.handle.done.mock.invocationCallOrder[0]).toBeGreaterThan(releaseTurnMock.mock.invocationCallOrder[0]);
      expect(presence.stop.dispose).toHaveBeenCalled();
    });

    it('never goes live for a turn that lost the lock', async () => {
      resolve();
      claimTurnMock.mockResolvedValue(false);

      const res = await POST(streamRequest());

      expect(res.status).toBe(409);
      expect(presence.startTurnPresence).not.toHaveBeenCalled();
    });
  });
});
