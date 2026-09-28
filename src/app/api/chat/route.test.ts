import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  authMock,
  createContainerMock,
  resolveChatAgentGraphMock,
  invokeMock,
  assertOwnedByMock,
  createChatMock,
  setEffortTierMock,
  touchLastActiveMock,
  getCopilotAgentMock,
  buildContextMock,
  chatCacheEnabledMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  resolveChatAgentGraphMock: vi.fn(),
  invokeMock: vi.fn(),
  assertOwnedByMock: vi.fn(),
  createChatMock: vi.fn(),
  setEffortTierMock: vi.fn(),
  touchLastActiveMock: vi.fn(),
  getCopilotAgentMock: vi.fn(),
  buildContextMock: vi.fn(),
  chatCacheEnabledMock: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})), withBackgroundDb: vi.fn() }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
  workspaceSlugFromClaims: vi.fn(() => 'ws-slug'),
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
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
  extractFirstTurn: vi.fn(() => ({ userText: '', assistantText: '' })),
  asEffortChoice: (v: unknown) => (typeof v === 'string' ? v : null),
  asManualEffort: (v: unknown) => (v === 'low' || v === 'medium' || v === 'high' ? v : null),
  EFFORT_TIERS: { low: { turnBudgetMs: 30_000 }, medium: { turnBudgetMs: 60_000 } },
}));
vi.mock('@ai-sdk/langchain', () => ({ toBaseMessages: vi.fn(async () => []) }));
vi.mock('@/lib/flags', () => ({
  chatCacheEnabled: chatCacheEnabledMock,
  sourceOfFundsEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/langfuse', () => ({ flushLangfuse: vi.fn() }));
vi.mock('@/lib/chat/title', () => ({ generateChatTitle: vi.fn() }));
// The real tier resolution (escalate-only, the open-insight floor); only the
// routing call is stubbed.
vi.mock('@/lib/chat/effortRouter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  routeEffort: vi.fn(),
  shouldRoute: () => false,
}));
vi.mock('@/lib/chat/thinkingStream', () => ({
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

import { POST } from './route';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { buildBudgetNotice } from '@/lib/chat/turnBudget';
import {
  CHAT_ATTACHMENTS_KWARG,
  WHOLE_DOCUMENT_TOOL_NAMES,
  TIMED_OUT_FOLLOW_UP_CONTEXT,
  ZERO_WORK_FOLLOW_UP_CONTEXT,
} from '@/lib/chat/largeDocumentTurn';

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

describe('POST /api/chat', () => {
  const copilotChatsService = {
    assertOwnedBy: assertOwnedByMock,
    create: createChatMock,
    setEffortTier: setEffortTierMock,
    touchLastActive: touchLastActiveMock,
  };
  const getChatContextMock = vi.fn();
  const insightService = { findBoundAgent: vi.fn(), getChatContext: getChatContextMock };
  const getMessagesMock = vi.fn();
  const graph = {
    invoke: invokeMock,
    getMessages: getMessagesMock,
    rewriteFileReferences: vi.fn(),
    repairOrphanedToolCalls: vi.fn(),
  };
  const ownedRefsMock = vi.fn();
  const attachmentPrepareMock = vi.fn();
  const templatePrepareMock = vi.fn();

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A' } });
    assertOwnedByMock
      .mockReset()
      .mockResolvedValue({ id: CHAT_ID, title: 'T', effort_tier: 'medium', agent_key: null });
    createChatMock.mockReset();
    setEffortTierMock.mockReset();
    touchLastActiveMock.mockReset();
    getCopilotAgentMock.mockReset().mockResolvedValue('investment');
    buildContextMock.mockReset().mockResolvedValue('WORKSPACE CONTEXT');
    chatCacheEnabledMock.mockReset().mockResolvedValue(false);
    invokeMock.mockReset().mockResolvedValue({ messages: [] });
    resolveChatAgentGraphMock.mockReset();
    getChatContextMock.mockReset().mockResolvedValue(null);
    getMessagesMock.mockReset().mockResolvedValue([]);
    graph.rewriteFileReferences.mockReset();
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
    });
  });

  const resolve = (over: { agentKey?: string; notice?: string | null; firstTurn?: boolean } = {}) =>
    resolveChatAgentGraphMock.mockResolvedValue({
      graph,
      agentKey: 'general',
      notice: null,
      firstTurn: false,
      ...over,
    });
  /** A new thread (no chat_id) with the response cache flag on. */
  const newCachedThread = () => {
    createChatMock.mockResolvedValue({ id: CHAT_ID, title: 'T', effort_tier: null, agent_key: null });
    chatCacheEnabledMock.mockResolvedValue(true);
  };
  const systemContext = () => invokeMock.mock.calls[0][0].additionalSystemContext;

  it('runs the turn on the graph the resolver picked for this thread and page', async () => {
    resolve({ agentKey: 'bangun', firstTurn: true });

    const res = await POST(
      chatRequest({
        chat_id: CHAT_ID,
        page_context: { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID },
      }),
    );

    expect(res.status).toBe(200);
    expect(resolveChatAgentGraphMock).toHaveBeenCalledWith(
      {
        chat: expect.objectContaining({ id: CHAT_ID, agent_key: null }),
        pageContext: expect.objectContaining({ insightId: INSIGHT_ID }),
        effort: 'medium',
        flavour: 'investment',
        sof: true,
      },
      { workspaceId: 'ws-1', copilotChatsService, insightService },
    );
    expect(res.headers.get('X-Chat-Agent')).toBe('bangun');
  });

  describe('effort floor on an open insight', () => {
    const lowThread = () =>
      assertOwnedByMock.mockResolvedValue({ id: CHAT_ID, title: 'T', effort_tier: 'low', agent_key: null });
    const onInsight = { tabSlug: 'insight', path: '/insight', insightId: INSIGHT_ID };

    it('raises an Auto thread on low to medium when an insight is open, and stores it', async () => {
      lowThread();
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID, page_context: onInsight }));

      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('medium');
      expect(setEffortTierMock).toHaveBeenCalledWith(CHAT_ID, 'medium');
    });

    it('leaves an Auto thread on low when no insight is open', async () => {
      lowThread();
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('low');
      expect(setEffortTierMock).not.toHaveBeenCalled();
    });

    it('never overrides a tier the user picked by hand', async () => {
      lowThread();
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID, effort: 'low', page_context: onInsight }));

      expect(resolveChatAgentGraphMock.mock.calls[0][0].effort).toBe('low');
    });
  });

  it("passes the thread's agent to tools via configurable.agent_key", async () => {
    resolve({ agentKey: 'dikti' });

    await POST(chatRequest({ chat_id: CHAT_ID }));

    const [inputs, config] = invokeMock.mock.calls[0];
    expect(config.configurable.agent_key).toBe('dikti');
    expect(inputs.additionalSystemContext).toBe('WORKSPACE CONTEXT');
  });

  it('appends the no-sector-agent notice to the system context on the turn that carries it', async () => {
    resolve({ notice: 'NO AGENT NOTICE', firstTurn: true });

    await POST(chatRequest({ chat_id: CHAT_ID }));

    expect(systemContext()).toBe('WORKSPACE CONTEXT\n\nNO AGENT NOTICE');
  });

  it('returns 500 when the resolved agent graph is unavailable', async () => {
    resolveChatAgentGraphMock.mockResolvedValue({ graph: null, agentKey: 'general', notice: null, firstTurn: false });

    const res = await POST(chatRequest({ chat_id: CHAT_ID }));

    expect(res.status).toBe(500);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['caches an ordinary first turn', null, true],
    ['does not cache a first turn that carried the no-sector-agent notice', 'NO AGENT NOTICE', false],
  ])('%s', async (_label, notice, cached) => {
    newCachedThread();
    resolve({ agentKey: notice ? 'general' : 'bangun', notice, firstTurn: true });

    await POST(chatRequest({}));

    expect(chatCacheEnabledMock.mock.calls.length > 0).toBe(cached);
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

      await POST(chatRequest({ chat_id: CHAT_ID, page_context: insightPage }));

      expect(getChatContextMock).toHaveBeenCalledWith('ws-1', INSIGHT_ID);
      const [inputs] = invokeMock.mock.calls[0];
      expect(inputs.additionalSystemContext).toMatch(/^WORKSPACE CONTEXT\n\n## The insight open on screen\n/);
      expect(inputs.additionalSystemContext).toContain(`<insight_outline>\n${context.outline}\n</insight_outline>`);
      expect(JSON.stringify(inputs.messages)).not.toContain('Uni A');
    });

    it('places the outline after the no-sector-agent notice', async () => {
      getChatContextMock.mockResolvedValue(context);
      resolve({ notice: 'NO AGENT NOTICE', firstTurn: true });

      await POST(chatRequest({ chat_id: CHAT_ID, page_context: insightPage }));

      expect(systemContext()).toMatch(/^WORKSPACE CONTEXT\n\nNO AGENT NOTICE\n\n## The insight open on screen\n/);
    });

    it('reads no outline when no insight is open', async () => {
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID, page_context: { tabSlug: null, path: '/pipeline' } }));

      expect(getChatContextMock).not.toHaveBeenCalled();
      expect(systemContext()).toBe('WORKSPACE CONTEXT');
    });

    it('runs the turn without an outline when the insight is gone or the read fails', async () => {
      resolve();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      getChatContextMock.mockResolvedValueOnce(null);
      await POST(chatRequest({ chat_id: CHAT_ID, page_context: insightPage }));
      getChatContextMock.mockRejectedValueOnce(new Error('db down'));
      const res = await POST(chatRequest({ chat_id: CHAT_ID, page_context: insightPage }));

      expect(res.status).toBe(200);
      expect(invokeMock.mock.calls[0][0].additionalSystemContext).toBe('WORKSPACE CONTEXT');
      expect(invokeMock.mock.calls[1][0].additionalSystemContext).toBe('WORKSPACE CONTEXT');
      consoleError.mockRestore();
    });

    it('does not cache a first turn made on an insight', async () => {
      newCachedThread();
      getChatContextMock.mockResolvedValue(context);
      resolve({ agentKey: 'bangun', firstTurn: true });

      await POST(chatRequest({ page_context: insightPage }));

      expect(chatCacheEnabledMock).not.toHaveBeenCalled();
    });
  });

  describe('large documents and the zero-work timeout', () => {
    const HTML_REF = { key: 'chat-attachments/ws-1/brief.html', fileName: 'brief.html', contentType: 'text/html' };
    const config = () => invokeMock.mock.calls[0][1];
    const inputs = () => invokeMock.mock.calls[0][0];

    it('reads the thread once, and passes that read to the file-reference rewrite', async () => {
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(getMessagesMock).toHaveBeenCalledTimes(1);
      expect(getMessagesMock).toHaveBeenCalledWith(CHAT_ID);
      expect(graph.rewriteFileReferences).toHaveBeenCalledWith(CHAT_ID, [], []);
    });

    it('does not read history on a brand-new thread', async () => {
      createChatMock.mockResolvedValue({ id: CHAT_ID, title: 'T', effort_tier: null, agent_key: null });
      resolve();

      await POST(chatRequest({}));

      expect(getMessagesMock).not.toHaveBeenCalled();
    });

    it('after a zero-work timeout, tells this turn to hand off and withholds the whole-document tools', async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage('build an insight from my template'),
        new AIMessage(buildBudgetNotice({ budgetMs: 180_000 })),
      ]);
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(inputs().additionalSystemContext).toBe(`WORKSPACE CONTEXT\n\n${ZERO_WORK_FOLLOW_UP_CONTEXT}`);
      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
    });

    it('after a timeout that did complete tools, steers a document request to a handoff and withholds the whole-document tools', async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage('remove this sidebar'),
        new AIMessage(buildBudgetNotice({ budgetMs: 90_000, toolNames: ['get_insight'] })),
      ]);
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(inputs().additionalSystemContext).toBe(`WORKSPACE CONTEXT\n\n${TIMED_OUT_FOLLOW_UP_CONTEXT}`);
      expect(inputs().withheldTools).toEqual([...WHOLE_DOCUMENT_TOOL_NAMES]);
    });

    it('adds nothing after an ordinary answer', async () => {
      getMessagesMock.mockResolvedValue([new HumanMessage('rank them'), new AIMessage('Here is the ranking.')]);
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(inputs().additionalSystemContext).toBe('WORKSPACE CONTEXT');
      expect(inputs().withheldTools).toEqual([]);
    });

    it("gives the handoff the thread's most recent attachments when this turn has none", async () => {
      getMessagesMock.mockResolvedValue([
        new HumanMessage({ content: 'here is the file', additional_kwargs: { [CHAT_ATTACHMENTS_KWARG]: [HTML_REF] } }),
        new AIMessage('ok'),
      ]);
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID }));

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

      await POST(chatRequest({ chat_id: CHAT_ID }));

      expect(config().configurable.priorAttachments).toEqual([]);
    });

    it('records the attachment refs on the human message and outlines a large HTML file', async () => {
      attachmentPrepareMock.mockResolvedValue({
        blocks: [{ type: 'text', text: 'Attached file "brief.html":\n\nOUTLINE' }],
        fileIds: [],
        outlinedHtml: ['brief.html'],
      });
      resolve();

      await POST(chatRequest({ chat_id: CHAT_ID, attachments: [HTML_REF] }));

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
          chat_id: CHAT_ID,
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
          chat_id: CHAT_ID,
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
});
