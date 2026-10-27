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
import { createAgent, dynamicSystemPromptMiddleware, type AgentMiddleware } from "langchain";
import { AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";

import { rewriteStaleFileBlocks } from "./rewriteFileReferences";
import { buildOrphanedToolRepairMessages } from "./repairOrphanedToolCalls";
import { stripCorruptServerToolCalls } from "./repairCorruptServerToolCalls";
import { cacheUsageFromModelEnd, formatCacheUsage } from "./cacheUsage";
import { withLangfuseCallbacks } from "@/lib/langfuse";
import { logger } from "../logger";
// The `mna` flavor module directly, not the `./flavors` barrel: the runtime
// needs one flavor's defaults, not all six evaluated.
import { CHAT_SYSTEM_PROMPT, defaultChatToolList } from "./flavors/mna";
import type { ToolList } from "./flavors/types";
import { EFFORT_TIERS, type EffortChoice } from "./effort";
import { DEFER_LOADING, isDeferredTool } from "./tools/server_tools";

/**
 * Beta flag required for the Files API — carried on the chat LLM so messages
 * may reference user-attached documents by their uploaded file id.
 */
const FILES_API_BETA = "files-api-2025-04-14" as const;
/** `createAgent`'s model node — the one node every agent graph has, whatever its middleware. */
export const MODEL_NODE = "model_request";

/**
 * The `configurable` key the per-turn system context travels under.
 *
 * The fixed system prompt is compiled into the agent once and carries the
 * prompt-cache breakpoint; whatever changes from turn to turn (workspace
 * context, recalled memories, the open insight's outline, …) is appended at
 * model-call time by `perTurnContextMiddleware` from this key. Keeping it out
 * of the compiled prompt is what lets one compiled agent serve every turn of
 * a bot, and keeping it in a *separate* system block after the cached one is
 * what lets the prefix hit the cache even though this block differs per turn.
 */
export const PER_TURN_CONTEXT_KEY = "additionalSystemContext" as const;

/** The per-turn context as it is appended to the system prompt. */
export function additionalContextBlock(context: string): string {
  return `\n\n---\n\n## Additional Context\n\n${context}`;
}

/**
 * The compiled system prompt: the fixed text in one block marked as a cache
 * breakpoint, so tools + prompt are read from cache on every call after the
 * first; an optional second, uncached block for context fixed at build time.
 */
export function buildSystemMessage(systemPrompt: string, additionalSystemContext?: string): SystemMessage {
  return new SystemMessage({
    content: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ...(additionalSystemContext
        ? [{ type: "text", text: additionalContextBlock(additionalSystemContext) }]
        : []),
    ],
  });
}

/**
 * Appends the turn's `PER_TURN_CONTEXT_KEY` context to the system prompt as
 * its own block at model-call time. Returning the empty string leaves the
 * prompt untouched (`SystemMessage.concat` merges an empty string away).
 */
const perTurnContextMiddleware = dynamicSystemPromptMiddleware((_state, runtime) => {
  const context = (runtime as { configurable?: Record<string, unknown> }).configurable?.[PER_TURN_CONTEXT_KEY];
  if (typeof context !== "string" || context.length === 0) return "";
  return new SystemMessage({ content: [{ type: "text", text: additionalContextBlock(context) }] });
});

/** How many compiled per-turn agents one graph keeps (bots × withheld-tool variants). */
const AGENT_CACHE_SIZE = 32;

/**
 * Middleware handed to `createAgent`: HITL for workforce graphs, history
 * summarization for permanent bot threads.
 */
export type AgentMiddlewareList = ReadonlyArray<AgentMiddleware>;

/**
 * A per-turn replacement for the graph's prompt, tools and middleware. A
 * Copilot bot thread (RFC 02) runs on its base flavour's cached graph and
 * swaps these in per turn, so the graph cache stays keyed by flavour and never
 * grows per bot.
 */
export interface AgentTurnOverride {
  systemPrompt: string;
  toolList: ToolList;
  middleware?: AgentMiddlewareList;
  contextEditing?: boolean;
}

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
  /** Replace the graph's prompt, tools and middleware for this turn only. */
  override?: AgentTurnOverride;
}

/** What a withheld on-demand tool answers when the model finds and calls it anyway. */
export const withheldToolResult = (name: string): string =>
  `**Error:** \`${name}\` is not available on this turn. Do not retry it; say so, or hand the request off.`;

/**
 * The definition that stands in for a withheld on-demand tool. A deferred
 * tool cannot simply be left out: once a thread's history holds a
 * `tool_search_tool_result` that references it, every later request must
 * carry a definition under that name or the API rejects the whole turn
 * ("Tool reference 'send_email' not found in available tools"). So the name
 * stays, still deferred, with a description that says it is closed and a body
 * that refuses.
 */
function withheldStandIn(name: string): ToolList[number] {
  return tool(async () => withheldToolResult(name), {
    name,
    description: `Not available on this turn; calling it returns an error. (On other turns it is loaded on demand.)`,
    schema: z.object({}).passthrough(),
    extras: DEFER_LOADING,
  }) as unknown as ToolList[number];
}

/**
 * `toolList` without the tools named in `withheld`. Pure; order is kept. A
 * withheld tool that loads on demand (`isDeferredTool`) is replaced by
 * `withheldStandIn` rather than dropped — see there for why.
 *
 * Changing the tool set mid-thread costs one prompt-cache miss. On a model
 * with preserved thinking (Opus 5.5, Fable 5.1) it is also a history edit that
 * drops or rejects earlier thinking blocks, so revisit this before moving a
 * chat tier onto one of those models.
 */
export function withoutTools(toolList: ToolList, withheld: readonly string[] = []): ToolList {
  if (withheld.length === 0) return toolList;
  const skip = new Set(withheld);
  const out: ToolList = [];
  for (const t of toolList) {
    const name = (t as { name?: string }).name ?? "";
    if (!skip.has(name)) out.push(t);
    else if (isDeferredTool(t)) out.push(withheldStandIn(name));
  }
  return out;
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
  /**
   * Extra LangChain callback handlers for this run, merged ahead of the
   * Langfuse ones (`withLangfuseCallbacks`). The bots' presence detector
   * rides here.
   */
  callbacks?: unknown[];
  /**
   * The root run's id. The Langfuse handler files the trace under it, so a
   * caller that needs to find the trace again (reply feedback) or add to it
   * after the run (the chat turn's timeline) picks it.
   */
  runId?: string;
}

/** What `AgentGraph.getThreadSnapshot` reads in one checkpoint round trip. */
export interface ThreadSnapshot {
  messages: BaseMessage[];
  /** The thread is paused on a HITL interrupt; its open tool_calls are waiting, not orphaned. */
  hasInterrupt: boolean;
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
  middleware: AgentMiddlewareList = [],
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
    // Opus 5.5 and Sonnet 5.5 always think, so this is no longer what turns
    // reasoning on — but display: 'summarized' is still what makes it visible
    // to the chat UI (the default is omitted, which streams empty thinking
    // text). It also carries the inter-tool-call progress updates, which these
    // models return as thinking blocks rather than text blocks.
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

  // Two cache breakpoints. `withConfig` puts one on the last content block of
  // the last message (constructor cache_control is ignored by
  // @langchain/anthropic; the call option reaches applyCacheControlToPayload),
  // which caches the conversation so far for the next iteration of a tool
  // loop. `buildSystemMessage` puts the other on the fixed system prompt,
  // which caches tools + prompt across turns even when the per-turn context
  // block after it (and the history) differ. Without the second one a single
  // changed byte of per-turn context re-read the whole prefix uncached on
  // every turn's first call. Cache reads are ~0.1x input price.
  const boundModel = llm.withConfig({
    cache_control: { type: 'ephemeral' },
  });

  // createAgent's `middleware` and `tools` typings are strict generics.
  // The server tools interface lacks an explicit index signature, so toolList
  // is passed through `as any` at this call site. The runtime accepts AgentMiddleware[]
  // and (ClientTool | ServerTool)[].
  return createAgent({
    model: boundModel,
    tools: toolList as any,
    systemPrompt: buildSystemMessage(systemPrompt, additionalSystemContext),
    checkpointer: config.checkpointer,
    middleware: [...middleware, perTurnContextMiddleware] as unknown as never,
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
  private middleware: AgentMiddlewareList;
  /**
   * Compiled per-turn variants (a bot's prompt + tools, a turn with tools
   * withheld), keyed by what goes into the compile. A Copilot bot turn always
   * carries an override, so without this every turn re-created the model and
   * re-compiled the graph over ~40 tools. Per-turn context is not part of the
   * key: it rides on `configurable` (`PER_TURN_CONTEXT_KEY`).
   */
  private readonly agentCache = new Map<
    string,
    { agent: ReturnType<typeof createAgent>; middleware: AgentMiddlewareList }
  >();

  constructor(
    config: AgentConfig,
    toolList: ToolList = defaultChatToolList(),
    systemPrompt: string = CHAT_SYSTEM_PROMPT,
    middleware: AgentMiddlewareList = [],
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
    withheldTools: readonly string[] = [],
    override?: AgentTurnOverride,
  ): ReturnType<typeof createAgent> {
    if (!override && withheldTools.length === 0) {
      return this.defaultAgent;
    }
    const config =
      override?.contextEditing === undefined
        ? this.config
        : { ...this.config, contextEditing: override.contextEditing };
    const toolList = withoutTools(override?.toolList ?? this.toolList, withheldTools);
    const systemPrompt = override?.systemPrompt ?? this.systemPrompt;
    const middleware = override?.middleware ?? this.middleware;

    // The withheld names are part of the key because a withheld on-demand
    // tool keeps its name in the list (as a stand-in), so names alone would
    // not tell the two agents apart.
    const key = JSON.stringify([
      config.contextEditing ?? false,
      systemPrompt,
      toolList.map((t) => (t as { name?: string }).name ?? ""),
      [...withheldTools].sort(),
    ]);
    const cached = this.agentCache.get(key);
    // The middleware list is compared by identity: a bot's is built once per
    // process (`botThreadMiddleware`), a test's may differ per call.
    if (cached && cached.middleware === middleware) return cached.agent;

    const agent = createLocalAgent(config, undefined, toolList, systemPrompt, middleware);
    if (this.agentCache.size >= AGENT_CACHE_SIZE) {
      const oldest = this.agentCache.keys().next().value;
      if (oldest !== undefined) this.agentCache.delete(oldest);
    }
    this.agentCache.set(key, { agent, middleware });
    return agent;
  }

  /** The run config with this turn's system context attached for `perTurnContextMiddleware`. */
  private withTurnContext<T extends { configurable?: Record<string, unknown> } | undefined>(
    config: T,
    additionalSystemContext: string | undefined,
  ): NonNullable<T> {
    const base = (config ?? {}) as NonNullable<T>;
    if (!additionalSystemContext) return base;
    return {
      ...base,
      configurable: { ...(base.configurable ?? {}), [PER_TURN_CONTEXT_KEY]: additionalSystemContext },
    };
  }

  /** The graph's own tool list (a bot turn builds its override on top of it). */
  getToolList(): ToolList {
    return this.toolList;
  }

  /** The graph's own system prompt (a bot turn layers its prompt around it). */
  getSystemPrompt(): string {
    return this.systemPrompt;
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
      const agent = this.getAgent(inputs.withheldTools, inputs.override);
      logger.debug(`📨 Sending ${inputs.messages.length} message(s) to agent`);
      if (inputs.additionalSystemContext) {
        logger.debug("📎 Additional system context provided");
      }

      const mergedConfig = withLangfuseCallbacks({
        ...this.withTurnContext(config, inputs.additionalSystemContext),
        metadata: { ...((config as any)?.metadata ?? {}), ...this.traceMetadata() },
      });
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
      const mergedConfig = withLangfuseCallbacks({
        ...config,
        configurable: {
          thread_id: threadId,
          ...((config?.configurable as Record<string, unknown> | undefined) ?? {}),
        },
        metadata: {
          ...((config as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}),
          ...this.traceMetadata(),
        },
      }) as never;
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
    const agent = this.getAgent(inputs.withheldTools, inputs.override);
    const mergedConfig = withLangfuseCallbacks({
      ...this.withTurnContext(config, inputs.additionalSystemContext),
      metadata: { ...(config?.metadata ?? {}), ...this.traceMetadata() },
    });
    const stream = await agent.streamEvents({ messages: inputs.messages }, mergedConfig);
    return this.wrapEventStream(stream);
  }

  /**
   * Tap the LangChain event stream to detect 'pause_turn' stop reasons during streaming
   * and to log each model call's prompt-cache usage (`cacheUsage.ts`).
   * To avoid recursive O(messages) walks on every event during hot streaming (particularly
   * on LangGraph state events like 'on_chain_end' and every chunk of 'on_chat_model_stream'),
   * we gate strictly on 'on_chat_model_end', which is the event that marks the completion
   * of a chat model turn and carries its output stop_reason and usage.
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
    let modelCalls = 0;
    for await (const event of stream as AsyncIterable<unknown>) {
      if ((event as { event?: string })?.event === "on_chat_model_end") {
        modelCalls += 1;
        const usage = cacheUsageFromModelEnd(event);
        if (usage) logger.info(`[agent] prompt cache ${formatCacheUsage(modelCalls, usage)}`);
        if (!warned && isPauseTurn(event)) {
          warned = true;
          logger.warn(PAUSE_TURN_WARNING);
        }
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
    await this.overwriteMessages(threadId, replacements);
  }

  /**
   * Strip server_tool_use blocks the API would reject on replay (see
   * repairCorruptServerToolCalls.ts): ones whose input was blanked by the
   * pre-patch `@langchain/anthropic` (replayed as `input: {}`, which the model
   * reads as its own malformed calls and imitates), and ones a cut-off turn
   * left without their `*_tool_result` block (a hard 400: "`web_search` tool
   * use … was found without a corresponding `web_search_tool_result` block").
   */
  async repairCorruptServerToolCalls(
    threadId: string,
    /** The thread's messages when the caller already read them, to skip a second read. */
    knownMessages?: BaseMessage[],
  ): Promise<number> {
    const messages = knownMessages ?? (await this.getMessages(threadId));
    const replacements = stripCorruptServerToolCalls(messages);
    if (replacements.length === 0) return 0;
    await this.overwriteMessages(threadId, replacements);
    return replacements.length;
  }

  /**
   * Close orphaned tool_calls left when a run aborted mid-tool (chat switch /
   * Stop during long work like PPTX). Without matching ToolMessages, Anthropic
   * rejects the next turn. Skips threads paused on a HITL interrupt — those
   * open tool_calls are waiting for approval, not cancelled.
   */
  async repairOrphanedToolCalls(
    threadId: string,
    /** The thread's snapshot when the caller already read it, to skip a second checkpoint read. */
    known?: ThreadSnapshot,
  ): Promise<number> {
    const { messages, hasInterrupt } = known ?? (await this.getThreadSnapshot(threadId));
    if (hasInterrupt) return 0;

    const repairs = buildOrphanedToolRepairMessages(messages);
    if (repairs.length === 0) return 0;

    await this.overwriteMessages(threadId, repairs);
    return repairs.length;
  }

  /**
   * Write repaired messages into an existing thread's checkpoint (same ids, so
   * the messages reducer overwrites in place). `asNode` is pinned to the model
   * node because LangGraph otherwise attributes the update to the node that
   * last wrote the thread — and a thread last run with different middleware
   * (a bot turn's `SummarizationMiddleware.before_model`) names a node the
   * default graph lacks: `InvalidUpdateError: Node "…" does not exist`.
   */
  private async overwriteMessages(threadId: string, messages: BaseMessage[]): Promise<void> {
    // updateState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      updateState: (
        config: { configurable: { thread_id: string } },
        values: { messages: BaseMessage[] },
        asNode?: string,
      ) => Promise<unknown>;
    };
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages },
      MODEL_NODE,
    );
  }

  async getMessages(threadId: string): Promise<BaseMessage[]> {
    return (await this.getThreadSnapshot(threadId)).messages;
  }

  /**
   * One checkpoint read for everything a turn needs to know about its thread
   * before running: the persisted messages, and whether the thread is paused
   * on a HITL interrupt (a pending task carrying one). The chat route reads
   * this once and hands it to the repairs, which used to each read again —
   * a permanent bot thread's checkpoint is large, and it was deserialized
   * three times per turn.
   */
  async getThreadSnapshot(threadId: string): Promise<ThreadSnapshot> {
    // getState is marked @internal in LangChain v1 typings (return type
    // `never`) but it's the documented LangGraph API and works at runtime.
    const agent = this.defaultAgent as unknown as {
      getState: (config: { configurable: { thread_id: string } }) => Promise<
        | {
            values?: { messages?: BaseMessage[] };
            tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
          }
        | undefined
      >;
    };
    const state = await agent.getState({
      configurable: { thread_id: threadId },
    });
    return {
      messages: state?.values?.messages ?? [],
      hasInterrupt: (state?.tasks ?? []).some((task) => (task.interrupts?.length ?? 0) > 0),
    };
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
