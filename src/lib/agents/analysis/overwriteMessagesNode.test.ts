import { describe, it, expect } from 'vitest';
import { createAgent, createMiddleware } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { FakeListChatModel, FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { AIMessage, HumanMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { MODEL_NODE } from './runtime';

// updateState/getState are typed `never` on createAgent's graph in LangChain v1.
type Graph = {
  invoke: (input: { messages: BaseMessage[] }, config: object) => Promise<unknown>;
  getState: (config: object) => Promise<{ values: { messages: BaseMessage[] }; config: { configurable: { checkpoint_id?: string } } }>;
  updateState: (config: object, values: { messages: BaseMessage[] }, asNode?: string) => Promise<unknown>;
};

// Real LangGraph, no mocks. A bot thread runs with summarization middleware;
// its next turn fails in the model call (e.g. a 400 on a corrupt history),
// so the last node to write the thread is the middleware's `before_model`.
// The chat route then repairs the thread through the default graph, which
// has no such node.
describe('AgentGraph.overwriteMessages', () => {
  const setup = async () => {
    const checkpointer = new MemorySaver();
    const summarizer = createMiddleware({
      name: 'SummarizationMiddleware',
      beforeModel: () => undefined,
    });
    const botGraph = (model: FakeListChatModel | FakeStreamingChatModel) =>
      createAgent({ model, tools: [], checkpointer, middleware: [summarizer] }) as unknown as Graph;
    const defaultGraph = createAgent({
      model: new FakeListChatModel({ responses: ['hi'] }),
      tools: [],
      checkpointer,
    }) as unknown as Graph;
    const config = { configurable: { thread_id: 't1' } };

    await botGraph(new FakeListChatModel({ responses: ['hi'] })).invoke(
      { messages: [new HumanMessage({ content: 'q1', id: 'h1' })] },
      config,
    );
    await expect(
      botGraph(new FakeStreamingChatModel({ thrownErrorString: '400 invalid_request_error' })).invoke(
        { messages: [new HumanMessage({ content: 'q2', id: 'h2' })] },
        config,
      ),
    ).rejects.toThrow('400');

    const answer = (await defaultGraph.getState(config)).values.messages.find(AIMessage.isInstance)!;
    const replacement = new AIMessage({ id: answer.id, content: 'repaired' });
    return { defaultGraph, config, replacement };
  };

  it('reproduces the failure when the update is not pinned to a node', async () => {
    const { defaultGraph, config, replacement } = await setup();

    await expect(defaultGraph.updateState(config, { messages: [replacement] })).rejects.toThrow(
      'Node "SummarizationMiddleware.before_model" does not exist',
    );
  });

  it('lets a graph without the last writer node update the thread', async () => {
    const { defaultGraph, config, replacement } = await setup();

    await defaultGraph.updateState(config, { messages: [replacement] }, MODEL_NODE);

    const messages = (await defaultGraph.getState(config)).values.messages;
    expect(messages.map((m) => m.content)).toEqual(['q1', 'repaired', 'q2']);
  });

  it("replaces the whole thread through a remove-all update, moving the checkpoint id (the background summary's write)", async () => {
    const { defaultGraph, config } = await setup();
    const before = (await defaultGraph.getState(config)).config.configurable.checkpoint_id;
    const summary = new HumanMessage({ id: 's1', content: 'summary', additional_kwargs: { lc_source: 'summarization' } });
    const kept = new HumanMessage({ id: 'h2', content: 'q2' });

    await defaultGraph.updateState(
      config,
      { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), summary, kept] },
      MODEL_NODE,
    );

    const after = await defaultGraph.getState(config);
    expect(after.values.messages.map((m) => m.content)).toEqual(['summary', 'q2']);
    expect(after.config.configurable.checkpoint_id).not.toBe(before);
  });
});
