/**
 * The agent runtime: how one agent is constructed (`createLocalAgent`) and how
 * a built graph is driven (`AgentGraph` — streaming, invoking, resuming after a
 * HITL interrupt, and the pause-turn handling around all three).
 *
 * Knows nothing about which flavor is running: the caller passes the tool list
 * and system prompt. The flavor defaults here are the `mna` ones, for callers
 * that pass neither.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";

import { rewriteStaleFileBlocks } from "./rewriteFileReferences";
import { buildOrphanedToolRepairMessages } from "./repairOrphanedToolCalls";
import { getLangfuseCallbacks } from "@/lib/langfuse";
import { logger } from "../logger";
// The `mna` flavor module directly, not the `./flavors` barrel: the runtime
// needs one flavor's defaults, not all six evaluated.
import { CHAT_SYSTEM_PROMPT, defaultChatToolList } from "./flavors/mna";
import type { ToolList } from "./flavors/types";
import { EFFORT_TIERS, type EffortChoice } from "./effort";

/**
 * Beta flag required for the Files API — carried on the chat LLM so messages
 * may reference user-attached documents by their uploaded file id.
 */
const FILES_API_BETA = "files-api-2025-04-14" as const;

export interface AgentConfig {
  apiKey: string;
  checkpointer?: BaseCheckpointSaver;
  effort?: EffortChoice;
  /**
   * Enable context editing to clear prior tool uses on deep workforce loops.
   * Deliberately off for chat: clearing tool results rewrites the history,
   * which invalidates the cached prefix from the clear point onward. Chat
   * turns are short and benefit more from caching; workforce runs are long and
   * benefit more from clearing.
   */
  contextEditing?: boolean;
}

export interface InvokeOptions {
  messages: BaseMessage[];
  additionalSystemContext?: string;
  /**
   * Tool names left out of this one invocation's tool list (the chat route
   * withholds the whole-document tools on a turn that must hand off). The
   * thread and its checkpoint are unaffected; the next turn gets them back.
   */
  withheldTools?: readonly string[];
}

/**
 * `toolList` without the tools named in `withheld`. Pure; order is kept.
 * Changing the tool set mid-thread costs one prompt-cache miss. On a model
 * with preserved thinking (Opus 5.5, Fable 5.1) it is also a history edit that
 * drops or rejects earlier thinking blocks, so revisit this before moving a
 * chat tier onto one of those models.
 */
export function withoutTools(toolList: ToolList, withheld: readonly string[] = []): ToolList {
  if (withheld.length === 0) return toolList;
  const skip = new Set(withheld);
  return toolList.filter((t) => !skip.has((t as { name?: string }).name ?? ""));
}

export interface InvokeConfig {
  recursionLimit?: number;
  configurable?: Record<string, unknown>;
  /**
   * Abort signal forwarded to the underlying LangGraph run. When it fires
   * (e.g. the client disconnects or hits the UI stop button), LangChain
   * cancels the in-flight model request and halts graph execution.
   */
  signal?: AbortSignal;
}

export interface InvokeResult {
  messages: BaseMessage[];
  // Present when the agent paused on a HITL interrupt. The first element of
  // langgraph's __interrupt__ array is surfaced verbatim so callers can
  // render it or persist it to ai_workforce_queue.
  interrupt?: {
    actionRequests: Array<{
      name: string;
      args: Record<string, unknown>;
      description?: string;
    }>;
  };
}

/**
 * Build a streaming-capable agent with optional additional system context.
 *
 * `toolList` and `systemPrompt` control the agent's behavior:
 *   - Chat agents use defaultChatToolList() + CHAT_SYSTEM_PROMPT
 *     (read tools + chat-only delegation + chatty user-facing prose)
 *   - Workforce agents use workforceToolList() + WORKFORCE_SYSTEM_PROMPT
 *     (read tools + write tools + terse "do-and-report" execution)
 */
export function createLocalAgent(
  config: AgentConfig,
  additionalSystemContext?: string,
  toolList: ToolList = defaultChatToolList(),
  systemPrompt: string = CHAT_SYSTEM_PROMPT,
  middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
): ReturnType<typeof createAgent> {
  const tier = EFFORT_TIERS[config.effort ?? 'medium'];
  const modelId = tier.model;
  const llm = new ChatAnthropic({
    model: modelId,
    anthropicApiKey: config.apiKey,
    // Documents attached to a chat are uploaded via the Files API and referenced
    // by id in the message; both the upload and any message that references it
    // must carry this beta header. Harmless when no file is attached.
    // output-128k-2025-02-19 raises the output ceiling to 128k tokens.
    // context-management-2025-06-27 enables context editing for workforce loops.
    betas: [
      FILES_API_BETA,
      "output-128k-2025-02-19",
      ...(config.contextEditing ? ["context-management-2025-06-27" as const] : []),
    ],
    // Per-tier, not a flat 128k. Thinking tokens count against this, so it is
    // the hard bound on how long one call can run — which is what makes the
    // tier's `turnBudgetMs` reachable rather than aspirational.
    maxTokens: tier.maxTokens,
    // Stream under the hood even for non-streaming callers (AgentGraph.invoke,
    // used by the workforce runtime and one-shot job handlers). The Anthropic
    // SDK rejects any non-streaming request whose maxTokens is large enough
    // that it could exceed the 10-minute request window ("Streaming is required
    // for operations that may take longer than 10 minutes") — at maxTokens
    // 128k that guard always fires. With streaming enabled, ChatAnthropic hits
    // the streaming endpoint and reassembles the full message, so .invoke()
    // still returns a complete result. The streamEvents (chat) path already
    // streams, so this is a no-op there.
    streaming: true,
    // Newer Anthropic models reject `temperature` (400: "temperature is
    // deprecated for this model"). Explicitly leave it unset — ChatAnthropic
    // omits the field from the request when this is undefined.
    temperature: undefined,
    // Opus 4.8/5 run with no reasoning at all when this is omitted;
    // display: 'summarized' is what makes the reasoning visible to the chat UI
    // (the default is omitted, which streams empty thinking text).
    thinking: {
      type: 'adaptive',
      // Cast until @anthropic-ai/sdk adds `display` to ThinkingConfigAdaptive.
      ['display' as any]: 'summarized',
    },
    // Always sent: omitting output_config means the API default (`high`), not the
    // tier's. Cast until @langchain/anthropic adds `xhigh` to OutputEffort.
    outputConfig: {
      effort: tier.effort as 'low' | 'medium' | 'high' | 'max',
    },
    ...(config.contextEditing
      ? {
          contextManagement: {
            edits: [{ type: 'clear_tool_uses_20250919' as const }],
          },
        }
      : {}),
  });

  // LangChain applies cache_control to the last content block of the last message,
  // caching tools + system + the whole conversation prefix. Cache reads are ~0.1x
  // input price; in a tool loop the prefix is resent every iteration.
  // Note: constructor cache_control is ignored by @langchain/anthropic at runtime;
  // binding via withConfig passes cache_control to call options where
  // applyCacheControlToPayload applies it to formatted messages.
  const boundModel = llm.withConfig({
    cache_control: { type: 'ephemeral' },
  });

  const fullSystemPrompt = additionalSystemContext
    ? `${systemPrompt}\n\n---\n\n## Additional Context\n\n${additionalSystemContext}`
    : systemPrompt;

  // createAgent's `middleware` and `tools` typings are strict generics.
  // The server tools interface lacks an explicit index signature, so toolList
  // is passed through `as any` at this call site. The runtime accepts AgentMiddleware[]
  // and (ClientTool | ServerTool)[].
  return createAgent({
    model: boundModel,
    tools: toolList as any,
    systemPrompt: fullSystemPrompt,
    checkpointer: config.checkpointer,
    ...(middleware.length > 0
      ? { middleware: middleware as unknown as never }
      : {}),
  });
}

/**
 * Resumption for 'pause_turn' is currently unimplemented; this is the tripwire for it.
 * When a server-tool chain pauses, Anthropic returns stop_reason: 'pause_turn'.
 * Unhandled, the turn stops early and appears as a truncated answer with no error.
 */
export const PAUSE_TURN_WARNING =
  "Agent turn ended with stop_reason: 'pause_turn' (model paused during server-tool execution and expected resumption). Turn resumption is currently unimplemented; response may be truncated.";

export function isPauseTurn(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const rec = target as Record<string, unknown>;
  if (rec.stop_reason === "pause_turn") return true;
  if (
    rec.response_metadata &&
    typeof rec.response_metadata === "object" &&
    (rec.response_metadata as Record<string, unknown>).stop_reason === "pause_turn"
  ) {
    return true;
  }
  if (
    rec.additional_kwargs &&
    typeof rec.additional_kwargs === "object" &&
    (rec.additional_kwargs as Record<string, unknown>).stop_reason === "pause_turn"
  ) {
    return true;
  }
  // Recurse into messages for shapeInvokeResult (the synchronous invoke() path,
  // where the result object contains a messages array). The hot streaming path
  // gates on on_chat_model_end, so it does not walk messages arrays.
  if (Array.isArray(rec.messages)) {
    return rec.messages.some((m) => isPauseTurn(m));
  }
  if (rec.data && typeof rec.data === "object") {
    if (isPauseTurn(rec.data)) return true;
  }
  if (rec.output && typeof rec.output === "object") {
    if (isPauseTurn(rec.output)) return true;
  }
  if (rec.chunk && typeof rec.chunk === "object") {
    if (isPauseTurn(rec.chunk)) return true;
  }
  if (rec.message && typeof rec.message === "object") {
    if (isPauseTurn(rec.message)) return true;
  }
  if (Array.isArray(rec.generations)) {
    return rec.generations.some((g) =>
      Array.isArray(g) ? g.some((item) => isPauseTurn(item)) : isPauseTurn(g),
    );
  }
  return false;
}

/**
 * Wrapper around the streaming agent that exposes both invoke and streamEvents.
 */
export class AgentGraph {
  private config: AgentConfig;
  private defaultAgent: ReturnType<typeof createAgent>;
  private toolList: ToolList;
  private systemPrompt: string;
  private middleware: ReadonlyArray<
    ReturnType<typeof humanInTheLoopMiddleware>
  >;

  constructor(
    config: AgentConfig,
    toolList: ToolList = defaultChatToolList(),
    systemPrompt: string = CHAT_SYSTEM_PROMPT,
    middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
  ) {
    this.config = { ...config };
    this.toolList = toolList;
    this.systemPrompt = systemPrompt;
    this.middleware = middleware;
    this.defaultAgent = createLocalAgent(
      this.config,
      undefined,
      toolList,
      systemPrompt,
      middleware,
    );
  }

  private getAgent(
    additionalSystemContext?: string,
    withheldTools: readonly string[] = [],
  ): ReturnType<typeof createAgent> {
    if (!additionalSystemContext && withheldTools.length === 0) {
      return this.defaultAgent;
    }
    return createLocalAgent(
      this.config,
      additionalSystemContext,
      withoutTools(this.toolList, withheldTools),
      this.systemPrompt,
      this.middleware,
    );
  }

  async getState(config: import('@langchain/core/runnables').RunnableConfig) {
    return this.defaultAgent.getState(config);
  }

  /**
   * Stamped onto every traced run. `output_config` and `thinking` ARE sent on
   * the wire (they are part of ChatAnthropic's invocationParams), but Langfuse's
   * LangChain mapper keeps only a known subset in `modelParameters`, so a trace
   * shows the model id and nothing about the effort rung that produced it.
   * Recording the tier here is what makes "which tier ran this turn?" answerable
   * from a trace instead of from a wire-capture script.
   */
  private traceMetadata(): Record<string, string> {
    const tier = this.config.effort ?? 'medium';
    return {
      effort_tier: tier,
      effort_model: EFFORT_TIERS[tier].model,
      output_effort: EFFORT_TIERS[tier].effort,
    };
  }

  async invoke(
    inputs: InvokeOptions,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    logger.debug(`messages are ${JSON.stringify(inputs)}`);
    logger.debug("=".repeat(60));
    logger.debug("🚀 AGENT INVOCATION STARTED");

    try {
      const agent = this.getAgent(inputs.additionalSystemContext, inputs.withheldTools);
      logger.debug(`📨 Sending ${inputs.messages.length} message(s) to agent`);
      if (inputs.additionalSystemContext) {
        logger.debug("📎 Additional system context provided");
      }
      
      const mergedConfig = {
        ...config,
        metadata: { ...((config as any)?.metadata ?? {}), ...this.traceMetadata() },
        callbacks: [...((config as any)?.callbacks || []), ...getLangfuseCallbacks()]
      };
      const result = await agent.invoke({ messages: inputs.messages }, mergedConfig);
      return this.shapeInvokeResult(result);
    } catch (error) {
      logger.error(`✗ AGENT INVOCATION FAILED: ${(error as Error).message}`);
      logger.debug("=".repeat(60));
      return {
        messages: [
          new AIMessage(`Error invoking agent: ${(error as Error).message}`),
        ],
      };
    }
  }

  /**
   * Resume a paused agent thread with a HITL decision payload. Wraps the
   * payload in a langgraph `Command({ resume })` and invokes the agent on
   * the same checkpoint thread. Returns the same shape as `invoke`, so
   * `result.interrupt` will be populated again if the agent paused on
   * another HITL interrupt during resume.
   */
  async resume(
    threadId: string,
    resumePayload: unknown,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    logger.debug(`🔁 Resuming agent thread ${threadId}`);
    try {
      const agent = this.defaultAgent;
      // Lazy import to avoid pulling Command type at module load.
      const { Command } = await import("@langchain/langgraph");
      const incomingCallbacks = (config as { callbacks?: unknown } | undefined)
        ?.callbacks;
      const configCallbacks = Array.isArray(incomingCallbacks)
        ? incomingCallbacks
        : incomingCallbacks
          ? [incomingCallbacks]
          : [];
      const mergedConfig = {
        ...config,
        configurable: {
          thread_id: threadId,
          ...((config?.configurable as Record<string, unknown> | undefined) ?? {}),
        },
        metadata: {
          ...((config as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}),
          ...this.traceMetadata(),
        },
        callbacks: [...configCallbacks, ...getLangfuseCallbacks()],
      } as never;
      const result = await agent.invoke(
        new Command({ resume: resumePayload }) as never,
        mergedConfig,
      );
      return this.shapeInvokeResult(result);
    } catch (error) {
      logger.error(`✗ AGENT RESUME FAILED: ${(error as Error).message}`);
      return {
        messages: [
          new AIMessage(`Error resuming agent: ${(error as Error).message}`),
        ],
      };
    }
  }

  private shapeInvokeResult(result: unknown): InvokeResult {
    logger.debug("✓ Agent graph invocation completed");
    logger.debug("✅ AGENT INVOCATION COMPLETED SUCCESSFULLY");
    logger.debug("=".repeat(60));

    if (isPauseTurn(result)) {
      logger.warn(PAUSE_TURN_WARNING);
    }

    if (result && typeof result === "object" && "messages" in result) {
      const out: InvokeResult = {
        messages: (result as { messages: BaseMessage[] }).messages,
      };
      const interruptRaw = (result as Record<string, unknown>).__interrupt__;
      if (Array.isArray(interruptRaw) && interruptRaw.length > 0) {
        const first = interruptRaw[0] as { value?: unknown };
        const value = (first?.value ?? first) as {
          actionRequests?: NonNullable<
            InvokeResult["interrupt"]
          >["actionRequests"];
        };
        if (value?.actionRequests?.length) {
          out.interrupt = { actionRequests: value.actionRequests };
        }
      }
      return out;
    }
    return { messages: [new AIMessage(JSON.stringify(result))] };
  }

  async ainvoke(
    inputs: InvokeOptions,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    return this.invoke(inputs, config);
  }

  /**
   * Stream events from the agent. The chat route consumes these to push
   * incremental updates to the client.
   */
  async streamEvents(
    inputs: InvokeOptions,
    config?: any,
  ): Promise<AsyncGenerator<unknown, void, unknown>> {
    const agent = this.getAgent(inputs.additionalSystemContext, inputs.withheldTools);
    const mergedConfig = {
      ...config,
      metadata: { ...(config?.metadata ?? {}), ...this.traceMetadata() },
      callbacks: [...(config?.callbacks || []), ...getLangfuseCallbacks()],
    };
    const stream = await agent.streamEvents({ messages: inputs.messages }, mergedConfig);
    return this.wrapEventStream(stream);
  }

  /**
   * Tap the LangChain event stream to detect 'pause_turn' stop reasons during streaming.
   * To avoid recursive O(messages) walks on every event during hot streaming (particularly
   * on LangGraph state events like 'on_chain_end' and every chunk of 'on_chat_model_stream'),
   * we gate strictly on 'on_chat_model_end', which is the event that marks the completion
   * of a chat model turn and carries its output stop_reason.
   */
  private async *wrapEventStream(
    stream: unknown,
  ): AsyncGenerator<unknown, void, unknown> {
    if (!stream || typeof stream !== "object") {
      return;
    }
    if (
      typeof (stream as Record<symbol, unknown>)[Symbol.asyncIterator] !== "function" &&
      typeof (stream as Record<symbol, unknown>)[Symbol.iterator] !== "function"
    ) {
      return;
    }
    let warned = false;
    for await (const event of stream as AsyncIterable<unknown>) {
      if (
        !warned &&
        (event as { event?: string })?.event === "on_chat_model_end" &&
        isPauseTurn(event)
      ) {
        warned = true;
        logger.warn(PAUSE_TURN_WARNING);
      }
      yield event;
    }
  }

  /**
   * Load the persisted message history for a thread from the checkpointer.
   * Returns an empty array when the thread has no checkpoint yet (e.g. a
   * brand-new chat row that was created but never sent a message).
   */
  /**
   * Repoint (or neutralize) stale Files-API references in a thread's persisted
   * history so replaying it doesn't 404. Chat attachments are deleted from
   * Anthropic after every turn; `freshFileIds` are the ids re-uploaded for the
   * current turn. Rewritten messages reuse their original id, so the messages
   * reducer overwrites them in place rather than appending duplicates.
   */
  async rewriteFileReferences(
    threadId: string,
    freshFileIds: string[],
    /** The thread's messages when the caller already read them, to skip a second read. */
    knownMessages?: BaseMessage[],
  ): Promise<void> {
    const messages = knownMessages ?? (await this.getMessages(threadId));
    const replacements = rewriteStaleFileBlocks(messages, freshFileIds);
    if (replacements.length === 0) return;
    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages: replacements },
    );
  }

  /**
   * Close orphaned tool_calls left when a run aborted mid-tool (chat switch /
   * Stop during long work like PPTX). Without matching ToolMessages, Anthropic
   * rejects the next turn. Skips threads paused on a HITL interrupt — those
   * open tool_calls are waiting for approval, not cancelled.
   */
  async repairOrphanedToolCalls(threadId: string): Promise<number> {
    const { messages, pendingWrites } = await this.getTrace(threadId);
    const hasInterrupt = pendingWrites.some(
      (write) => Array.isArray(write) && write[1] === "__interrupt__",
    );
    if (hasInterrupt) return 0;

    const repairs = buildOrphanedToolRepairMessages(messages);
    if (repairs.length === 0) return 0;

    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages: repairs },
    );
    return repairs.length;
  }

  async getMessages(threadId: string): Promise<BaseMessage[]> {
    // getState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<
        | {
            values?: { messages?: BaseMessage[] };
          }
        | undefined
      >;
    };
    const state = await agent.getState({
      configurable: { thread_id: threadId },
    });
    return state?.values?.messages ?? [];
  }

  /**
   * Seed a thread's checkpoint with an initial set of messages without running
   * the model. Used to fork a cached turn-1 (first question + first answer)
   * into a brand-new thread the caller owns, so the user can continue from
   * there with the prior context in place. `messages` is appended via the
   * graph's add-reducer; on a fresh thread that yields exactly these messages.
   */
  async seedMessages(threadId: string, messages: BaseMessage[]): Promise<void> {
    // updateState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages },
    );
  }

  /**
   * Read raw checkpoint tuple data for a thread: the persisted message list
   * plus any pending writes (e.g. unresolved `__interrupt__` entries from
   * humanInTheLoopMiddleware). Used by the trace endpoint to render both
   * completed execution and live HITL-waiting state in one fetch.
   */
  async getTrace(threadId: string): Promise<{
    messages: BaseMessage[];
    pendingWrites: CheckpointPendingWrite[];
  }> {
    if (!this.config.checkpointer) {
      return { messages: [], pendingWrites: [] };
    }
    const tuple = await this.config.checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!tuple) {
      return { messages: [], pendingWrites: [] };
    }
    const channelValues = tuple.checkpoint.channel_values as
      { messages?: BaseMessage[] } | undefined;
    return {
      messages: channelValues?.messages ?? [],
      pendingWrites: tuple.pendingWrites ?? [],
    };
  }
}
