import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

vi.mock('./threadMiddleware', () => ({
  buildBotTurnOverride: vi.fn(() => ({ systemPrompt: 'BOT', toolList: [] })),
}));

import {
  BACKGROUND_WITHHELD_TOOLS,
  BotThreadBusyError,
  TURN_LOCK_POLL_MS,
  TURN_LOCK_WAIT_MS,
  originContext,
  runBotTurn,
  turnToolNames,
  type BotTurnDeps,
  type BotTurnInput,
} from './runBotTurn';
import { PresenceCallbackHandler } from './presence';
import { FROM_BOT_KWARG, FROM_ROUTINE_KWARG } from '@/lib/chat/uiMessages';

const bot = { id: 'scout', name: 'Deal Scout', base_flavor: 'mna' } as never;
const chat = { id: 'chat-1', user_id: 'u1', bot_id: 'scout' } as never;
const input: BotTurnInput = {
  workspaceId: 'ws-1',
  bot,
  chat,
  user: { id: 'u1', email: 'a@b.c', name: 'A' },
  origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
  text: 'Find me three fintech targets.',
  turnId: 'turn-1',
};

const human = (text: string, id: string) => new HumanMessage({ content: text, id });
const priorMessages = [human('earlier', 'h0'), new AIMessage('ok')];
const finalMessages = [
  ...priorMessages,
  human('Find me three fintech targets.', 'h1'),
  new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'query_companies', args: {} }] }),
  new ToolMessage({ content: '[]', tool_call_id: 't1' }),
  new AIMessage('Here are three.'),
];

describe('runBotTurn', () => {
  const invoke = vi.fn();
  const getMessages = vi.fn();
  const presence = { setPhase: vi.fn(), done: vi.fn(async () => undefined) };
  const stop = { signal: new AbortController().signal, dispose: vi.fn() };
  let deps: { [K in keyof Required<BotTurnDeps>]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ messages: [] });
    // The read before the run sees the old thread; the one after sees the turn.
    getMessages.mockReset().mockResolvedValueOnce(priorMessages).mockResolvedValue(finalMessages);
    presence.setPhase.mockReset();
    presence.done.mockClear();
    stop.dispose.mockReset();
    deps = {
      getGraph: vi.fn(async () => ({ invoke, getMessages }) as never),
      buildContext: vi.fn(async () => 'WORKSPACE'),
      claimTurn: vi.fn(async () => true),
      releaseTurn: vi.fn(async () => undefined),
      persistTurn: vi.fn(async () => undefined),
      persistQuestion: vi.fn(async () => 'q-row'),
      discardQuestion: vi.fn(async () => undefined),
      recallMemory: vi.fn(async () => null),
      botMemoryContext: vi.fn(async () => null),
      sleep: vi.fn(async () => undefined),
      startPresence: vi.fn(() => presence),
      watchStop: vi.fn(() => stop),
      publishReply: vi.fn(async () => undefined),
    };
  });

  it('puts what the bot remembers about the user into the turn, after the workspace context', async () => {
    deps.recallMemory = vi.fn(async () => '## What you remember about this user\n\n- Covers coal');

    await runBotTurn({ ...input, extraContext: '<other_bots>' }, deps as unknown as BotTurnDeps);

    expect(deps.recallMemory).toHaveBeenCalledWith('Find me three fintech targets.');
    const context = invoke.mock.calls[0][0].additionalSystemContext as string;
    expect(context.indexOf('WORKSPACE')).toBeLessThan(context.indexOf('- Covers coal'));
    expect(context.indexOf('- Covers coal')).toBeLessThan(context.indexOf('<other_bots>'));
  });

  it('runs the turn without memory when recall fails or is not wired', async () => {
    deps.recallMemory = vi.fn(async () => {
      throw new Error('bedrock down');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runBotTurn(input, deps as unknown as BotTurnDeps);
    expect(invoke.mock.calls[0][0].additionalSystemContext).toContain('WORKSPACE');
    spy.mockRestore();

    invoke.mockClear();
    getMessages.mockReset().mockResolvedValueOnce(priorMessages).mockResolvedValue(finalMessages);
    delete (deps as Partial<typeof deps>).recallMemory;
    await runBotTurn(input, deps as unknown as BotTurnDeps);
    expect(invoke.mock.calls[0][0].additionalSystemContext).toContain('WORKSPACE');
  });

  it("answers on the target's thread as the user, marked as from the mentioning bot, and stores it unread", async () => {
    const result = await runBotTurn(
      { ...input, extraContext: '<other_bots>' },
      deps as unknown as BotTurnDeps,
    );

    const [inputs, config] = invoke.mock.calls[0];
    expect(inputs.messages[0].content).toBe('Find me three fintech targets.');
    expect(inputs.messages[0].additional_kwargs[FROM_BOT_KWARG]).toEqual({ id: 'copilot', name: 'Copilot' });
    expect(inputs.additionalSystemContext).toContain('WORKSPACE');
    expect(inputs.additionalSystemContext).toContain('<other_bots>');
    expect(inputs.additionalSystemContext).toContain('Copilot, another of the user');
    // B is told its answer goes back to A, not that it is lost.
    expect(inputs.additionalSystemContext).toContain('passed back to Copilot');
    expect(inputs.override).toEqual({ systemPrompt: 'BOT', toolList: [] });
    expect(config.configurable).toMatchObject({ thread_id: 'chat-1', userId: 'u1', botId: 'scout', userEmail: 'a@b.c' });
    expect(deps.persistTurn).toHaveBeenCalledWith({
      chat,
      finalMessages,
      interactive: false,
      authorBotId: 'copilot',
      questionStored: true,
    });
    expect(deps.releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(result).toEqual({
      userText: 'Find me three fintech targets.',
      answerText: 'Here are three.',
      toolNames: ['query_companies'],
      turnId: 'turn-1',
    });
  });

  it('shows the bot as live for the whole turn, honours Stop, and announces the stored reply', async () => {
    await runBotTurn(input, deps as unknown as BotTurnDeps);

    expect(deps.startPresence).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: 'u1',
      chatId: 'chat-1',
      botId: 'scout',
      turnId: 'turn-1',
    });
    expect(deps.watchStop).toHaveBeenCalledWith('chat-1');
    const [, config] = invoke.mock.calls[0];
    expect(config.signal).toBe(stop.signal);
    expect(config.callbacks).toHaveLength(1);
    expect(config.callbacks[0]).toBeInstanceOf(PresenceCallbackHandler);
    expect(deps.publishReply).toHaveBeenCalledWith('ws-1', 'u1', { chatId: 'chat-1', botId: 'scout', turnId: 'turn-1' });
    // The lock goes first, then the live marker, then the stop watch.
    const order = [
      deps.releaseTurn.mock.invocationCallOrder[0],
      presence.done.mock.invocationCallOrder[0],
      stop.dispose.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('generates a turn id when the caller passes none', async () => {
    const { turnId } = await runBotTurn({ ...input, turnId: undefined }, deps as unknown as BotTurnDeps);
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(deps.startPresence.mock.calls[0][0].turnId).toBe(turnId);
  });

  it('stores the question before the agent runs, so the thread shows it while the bot works', async () => {
    await runBotTurn(input, deps as unknown as BotTurnDeps);

    const [call] = deps.persistQuestion.mock.calls;
    expect(call[0]).toMatchObject({ chat, prior: priorMessages, authorBotId: 'copilot' });
    expect(call[0].message).toBe(invoke.mock.calls[0][0].messages[0]);
    expect(deps.persistQuestion.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    expect(deps.discardQuestion).not.toHaveBeenCalled();
  });

  it('still runs, and stores the whole turn at the end, when the question cannot be stored up front', async () => {
    deps.persistQuestion.mockRejectedValue(new Error('db hiccup'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runBotTurn(input, deps as unknown as BotTurnDeps);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deps.persistTurn.mock.calls[0][0].questionStored).toBe(false);
    spy.mockRestore();
  });

  it('stores nothing when the turn never reached the thread, takes its question back out, and clears its live state', async () => {
    getMessages.mockReset().mockResolvedValue(priorMessages);

    const result = await runBotTurn(input, deps as unknown as BotTurnDeps);

    expect(deps.persistTurn).not.toHaveBeenCalled();
    expect(deps.discardQuestion).toHaveBeenCalledWith('q-row');
    expect(deps.publishReply).not.toHaveBeenCalled();
    expect(result.answerText).toBe('');
    expect(presence.done).toHaveBeenCalled();
    expect(deps.releaseTurn).toHaveBeenCalledWith('chat-1');
  });

  it("labels a user's @mention as theirs, written in the other bot's chat", async () => {
    await runBotTurn(
      { ...input, origin: { kind: 'user_mention', inBot: { id: 'copilot', name: 'Copilot' } } },
      deps as unknown as BotTurnDeps,
    );
    const [inputs] = invoke.mock.calls[0];
    expect(inputs.messages[0].additional_kwargs[FROM_BOT_KWARG]).toEqual({
      id: 'copilot',
      name: 'Copilot',
      kind: 'user_mention',
    });
    expect(inputs.additionalSystemContext).toContain('in their chat with Copilot');
    expect(deps.persistTurn.mock.calls[0][0].authorBotId).toBeNull();
  });

  it("labels a routine's message with the routine", async () => {
    await runBotTurn(
      { ...input, origin: { kind: 'routine', routine: { id: 'r1', title: 'Morning pipeline' } } },
      deps as unknown as BotTurnDeps,
    );
    const [inputs] = invoke.mock.calls[0];
    expect(inputs.messages[0].additional_kwargs).toEqual({
      [FROM_ROUTINE_KWARG]: { id: 'r1', title: 'Morning pipeline' },
    });
    expect(inputs.additionalSystemContext).toContain('routine "Morning pipeline"');
  });

  it("labels the other bots' answers as a reply from the first of them and tells the bot to close the loop", async () => {
    const replies = [
      { fromBot: { id: 'atlas', name: 'Atlas' }, requestId: 'r1', ask: 'NAV for Fund II?', answer: 'NAV is 1.2x.', failure: null },
      { fromBot: { id: 'miner', name: 'Miner' }, requestId: 'r2', ask: 'Coal comps?', answer: null, failure: 'timed out' },
    ];
    await runBotTurn({ ...input, origin: { kind: 'bot_reply', replies } }, deps as unknown as BotTurnDeps);

    const [inputs] = invoke.mock.calls[0];
    expect(inputs.messages[0].additional_kwargs[FROM_BOT_KWARG]).toEqual({ id: 'atlas', name: 'Atlas', kind: 'bot_reply' });
    const context = inputs.additionalSystemContext as string;
    expect(context).toContain('Atlas, Miner have answered');
    expect(context).toContain('- Atlas (you asked: «NAV for Fund II?»): NAV is 1.2x.');
    expect(context).toContain('- Miner (you asked: «Coal comps?»): could not complete it: timed out');
    expect(context).toContain('Do not @mention any bot about this again');
    expect(deps.persistTurn.mock.calls[0][0].authorBotId).toBe('atlas');
  });

  it('cannot send email, drive the browser or propose a routine nobody is there to approve', async () => {
    await runBotTurn(input, deps as unknown as BotTurnDeps);
    expect(invoke.mock.calls[0][0].withheldTools).toEqual([...BACKGROUND_WITHHELD_TOOLS]);
    expect(BACKGROUND_WITHHELD_TOOLS).toEqual(
      expect.arrayContaining(['send_email', 'navigate_page', 'propose_create_routine', 'delete_routine']),
    );
  });

  it('waits for an interactive turn on the same thread to finish', async () => {
    deps.claimTurn.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    await runBotTurn(input, deps as unknown as BotTurnDeps);

    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('gives up when the thread stays busy, without running, releasing a lock it never held, or going live', async () => {
    deps.claimTurn.mockResolvedValue(false);

    await expect(runBotTurn(input, deps as unknown as BotTurnDeps)).rejects.toBeInstanceOf(BotThreadBusyError);

    expect(deps.sleep).toHaveBeenCalledTimes(TURN_LOCK_WAIT_MS / TURN_LOCK_POLL_MS);
    expect(invoke).not.toHaveBeenCalled();
    expect(deps.releaseTurn).not.toHaveBeenCalled();
    expect(deps.startPresence).not.toHaveBeenCalled();
  });

  it('releases the lock and clears its live state when the turn fails', async () => {
    invoke.mockRejectedValue(new Error('anthropic 529'));

    await expect(runBotTurn(input, deps as unknown as BotTurnDeps)).rejects.toThrow('anthropic 529');

    expect(deps.releaseTurn).toHaveBeenCalledWith('chat-1');
    expect(presence.done).toHaveBeenCalled();
    expect(stop.dispose).toHaveBeenCalled();
    expect(deps.persistTurn).not.toHaveBeenCalled();
    // The failure came after the input was checkpointed: the question stays.
    expect(deps.discardQuestion).not.toHaveBeenCalled();
  });

  it('takes the question back out when the turn fails before reaching the thread', async () => {
    invoke.mockRejectedValue(new Error('anthropic 529'));
    getMessages.mockReset().mockResolvedValue(priorMessages);

    await expect(runBotTurn(input, deps as unknown as BotTurnDeps)).rejects.toThrow('anthropic 529');

    expect(deps.discardQuestion).toHaveBeenCalledWith('q-row');
    expect(deps.releaseTurn).toHaveBeenCalledWith('chat-1');
  });
});

describe('originContext', () => {
  it('names a single answering bot in the singular', () => {
    const context = originContext({
      kind: 'bot_reply',
      replies: [{ fromBot: { id: 'a', name: 'Atlas' }, requestId: 'r', ask: 'x', answer: 'y', failure: null }],
    });
    expect(context).toContain('Atlas has answered');
  });
});

describe('turnToolNames', () => {
  it("lists the latest turn's tool calls once each", () => {
    const call = (name: string) => new AIMessage({ content: '', tool_calls: [{ id: name, name, args: {} }] });
    expect(
      turnToolNames([new HumanMessage('a'), call('old'), new HumanMessage('b'), call('web_search'), call('web_search')]),
    ).toEqual(['web_search']);
  });
});
