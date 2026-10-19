import { describe, expect, it } from 'vitest';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { Command } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { askOwner, askOwnerResult } from './ask_owner';
import { WORKFORCE_HITL_INTERRUPT_ON, buildResumeDecision } from '../hitl';

const ASK = {
  question: 'The Q3 source report is gone. Use the Q2 figures?',
  recommendation: 'Use Q2 and flag the gap in the header',
  rationale: 'Q2 is the latest audited set; dropping the section breaks the layout.',
};

describe('ask_owner schema', () => {
  it.each([
    ['no recommendation', { question: ASK.question, rationale: ASK.rationale }],
    ['a blank recommendation', { ...ASK, recommendation: '   ' }],
    ['no question', { recommendation: 'x', rationale: 'y' }],
    ['no rationale', { question: 'q', recommendation: 'x' }],
    ['more than six options', { ...ASK, options: ['1', '2', '3', '4', '5', '6', '7'] }],
  ])('rejects a call with %s', async (_label, args) => {
    await expect(askOwner.invoke(args as never)).rejects.toThrow();
  });

  it('is named ask_owner and kept out of a move_stage turn', () => {
    expect(askOwner.name).toBe('ask_owner');
    expect(askOwner.description).toMatch(/never in the same turn as a gated move_stage/i);
  });
});

describe('askOwnerResult', () => {
  it('tells the agent not to guess when no owner decision is present', () => {
    expect(askOwnerResult(ASK)).toMatch(/^No answer from the owner was recorded.*Do not guess/);
  });
});

/**
 * Scripted chat model: returns the queued AIMessages in order. Enough for
 * createAgent (bindTools is a no-op) to drive the real HITL middleware.
 */
class ScriptedChatModel extends BaseChatModel {
  private readonly script: AIMessage[];
  readonly seen: BaseMessage[][] = [];

  constructor(script: AIMessage[], params: BaseChatModelParams = {}) {
    super(params);
    this.script = [...script];
  }

  _llmType(): string {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    const next = this.script.shift() ?? new AIMessage('✓ Done: nothing left to do');
    return { generations: [{ message: next, text: String(next.content ?? '') }] };
  }
}

const narrate = tool(async () => 'ok', {
  name: 'narrate_step',
  description: 'trace',
  schema: z.object({ title: z.string() }),
});

type ApiDecision = {
  decision: 'approve' | 'answer' | 'reject';
  answer?: string;
  rejectionMessage?: string;
};

/**
 * Runs ask_owner alongside a parallel narrate_step (the workforce norm) to the
 * interrupt, rebuilds the resume exactly as the decision route does, resumes,
 * and returns what the model sees next.
 */
async function runToInterruptThenResume(apiDecision: ApiDecision) {
  const model = new ScriptedChatModel([
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-ask-1', name: 'ask_owner', args: ASK, type: 'tool_call' },
        { id: 'call-narr', name: 'narrate_step', args: { title: 'Asking' }, type: 'tool_call' },
      ],
    }),
    new AIMessage('✓ Done: refreshed'),
  ]);
  const agent = createAgent({
    model,
    tools: [askOwner, narrate],
    checkpointer: new MemorySaver(),
    middleware: [humanInTheLoopMiddleware({ interruptOn: WORKFORCE_HITL_INTERRUPT_ON })],
  });
  const config = { configurable: { thread_id: `t-${apiDecision.decision}` } };

  const first = (await agent.invoke(
    { messages: [new HumanMessage('Refresh the insight')] } as never,
    config,
  )) as { __interrupt__?: Array<{ value: { actionRequests: Array<{ description: string; args: unknown }> } }> };
  const interrupt = first.__interrupt__?.[0]?.value;
  expect(interrupt?.actionRequests).toHaveLength(1);

  const built = buildResumeDecision({
    toolName: 'ask_owner',
    decision: apiDecision.decision,
    storedArgs: interrupt!.actionRequests[0].args,
    answer: apiDecision.answer,
    rejectionMessage: apiDecision.rejectionMessage,
  });
  if (!built.ok) throw new Error('decision refused');

  await agent.invoke(new Command({ resume: { decisions: [built.decision] } }) as never, config);

  const next = model.seen[1];
  expect(next).toBeDefined();
  const toolMessage = next.find(
    (m): m is ToolMessage => ToolMessage.isInstance(m) && m.tool_call_id === 'call-ask-1',
  );
  return { interruptQuestion: interrupt!.actionRequests[0].description, next, toolMessage };
}

describe('ask_owner through the real HITL middleware (resume payload end to end)', () => {
  it.each<[ApiDecision, string[]]>([
    [
      { decision: 'approve' },
      [`The owner accepted your recommendation. Their answer: "${ASK.recommendation}". Proceed on that basis.`],
    ],
    [
      { decision: 'answer', answer: 'Drop the section' },
      [
        'The owner answered differently: "Drop the section"',
        `instead of your recommendation ("${ASK.recommendation}")`,
      ],
    ],
    [
      { decision: 'reject', rejectionMessage: 'wait for Q3' },
      ['The owner declined to answer', 'Their note: "wait for Q3"', 'Do not guess'],
    ],
  ])('pauses with the question, and after %o returns the owner outcome with every tool call answered', async (apiDecision, expected) => {
    const { interruptQuestion, next, toolMessage } = await runToInterruptThenResume(apiDecision);

    expect(interruptQuestion).toBe(ASK.question);
    for (const text of expected) expect(String(toolMessage?.content)).toContain(text);

    // A parallel call left without a result would orphan the model's next turn.
    const callIds = next.flatMap((m) =>
      AIMessage.isInstance(m) ? (m.tool_calls ?? []).map((c) => c.id) : [],
    );
    const resultIds = next.flatMap((m) => (ToolMessage.isInstance(m) ? [m.tool_call_id] : []));
    for (const id of callIds) expect(resultIds).toContain(id);
  });
});
