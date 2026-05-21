/**
 * M&A analysis agent. Built on langchain's createAgent and exposes streaming
 * via streamEvents (used by the chat route) plus a synchronous invoke wrapper
 * used by the job handlers.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";

// HITL middleware for the workforce agent: gates write tools that require
// human approval before execution.
//
// Gating policy (see RoutineCanvas + TaskCanvas for the UI half):
//   - Adding a company to L0 (initial pipeline entry) — AUTO. The agent
//     executes without human approval; L0 is a triage stage, not a
//     commitment. If/when an L0-creation tool ships, do NOT list it here.
//   - Promoting a company to L1 or higher — GATED. The agent must hand off
//     to a human via this middleware; the human approves or rejects in the
//     routine/task canvas before the tool runs.
//
// Today only `promote_to_l1` exists; it is gated as required by policy.
// When additional stage-changing tools land (e.g. promote_to_l2), add them
// to `interruptOn` so the L1+ rule keeps holding. Read-only tools and L0
// entry tools must NEVER appear here.
const WORKFORCE_HITL_MIDDLEWARE = humanInTheLoopMiddleware({
  interruptOn: {
    promote_to_l1: {
      allowedDecisions: ["approve", "reject"],
      description: (toolCall) => {
        const args = toolCall.args as { company_name?: string; note?: string };
        const co = args.company_name ?? "(unknown)";
        const note = args.note ? ` Note: ${args.note}` : "";
        return `Promote ${co} from L0 to L1?${note}`;
      },
    },
  },
});
import pg from "pg";
import { tools, chatOnlyTools, workforceOnlyTools } from "./tools";

// Chat tool list: base + chat-only (e.g. propose_workforce_handoff).
const DEFAULT_TOOL_LIST = [...tools, ...chatOnlyTools];

// Workforce tool list: base + workforce-only write tools (e.g. promote_to_l1).
// Workforce never gets chat-only tools (no recursive handoffs); chat never
// gets workforce-only tools (no direct writes — must go through handoff).
const WORKFORCE_TOOL_LIST = [...tools, ...workforceOnlyTools];

// Permissive union element type so a single function signature accepts
// either array. Both arrays contain langchain tool() results — the
// structural shape is the same, only the specific subset differs.
type ToolList = Array<
  | (typeof tools)[number]
  | (typeof chatOnlyTools)[number]
  | (typeof workforceOnlyTools)[number]
>;
import { logger } from "../logger";
import {
  isLocalPostgresHost,
  parseExplicitDbFromEnv,
  rdsIamAuthToken,
  rdsIamDbAuthFromEnv,
} from "@/lib/server/db";

const CHECKPOINT_SCHEMA = "agent_states";

const CHAT_SYSTEM_PROMPT = `You are an intelligent M&A Data Analysis Assistant that helps users explore and analyze company/asset data for mergers and acquisitions.

You have access to the following tools:

1. **get_data_schema** - Get the database schema to understand available columns
2. **query_companies** - Search and filter companies by various criteria
3. **get_company_stats** - Get aggregate statistics and breakdowns
4. **get_company_details** - Get detailed info about a specific company
5. **web_search** - Search the web for external market data and benchmarks
6. **query_past_acquisitions** - Query historical M&A deals
7. **compare_with_past_acquisitions** - Compare a company against historical deal metrics
8. **get_past_acquisition_details** - Get detailed info about a specific past acquisition
9. **query_files** - Search and retrieve files related to companies, tags, or topics
10. **propose_workforce_handoff** - Offer to delegate any write-heavy job (including L0→L1 promotions) to the AI Workforce queue via a confirmation card

## How to Help Users

1. **For browsing companies:** Use query_companies with appropriate filters
2. **For statistics:** Use get_company_stats to get summaries and breakdowns
3. **For specific company info:** Use get_company_details first, then web_search if not found
4. **For meeting records:** Use query_files to find what was discussed about a company or topic
5. **For market context:** Use web_search for benchmarks and comparisons
6. **For evaluating acquisition likelihood:** Use query_past_acquisitions and compare_with_past_acquisitions to ground your assessment in historical deal metrics and comparable transactions

## CRITICAL: Automatic Web Search Fallback

**ALWAYS use web_search as a fallback when database queries don't return sufficient information:**

1. **Company not found:** If get_company_details or query_companies returns no results or "not found", IMMEDIATELY use web_search to find the company's information
2. **Missing data fields:** If a company is found but key fields like revenue, EBITDA, or valuation are missing/null, use web_search to find that specific data
3. **Incomplete profiles:** If the user asks about a company and the database has limited info, supplement with web_search
4. **Unknown companies:** If the user mentions a company name that doesn't exist in the database, search for it on the web

**Pattern to follow:**
- First, try the database (get_company_details or query_companies)
- If no results or incomplete data → use web_search("{company_name} company revenue EBITDA financials")
- Combine database info with web search results in your response

## When to Use Web Search Proactively

**ALWAYS use web_search when the user asks about:**
- Market comparisons (e.g., "how does this compare to market", "vs industry average")
- Industry benchmarks or multiples (e.g., "typical EBITDA multiple", "market valuation")
- Competitor analysis or competitive landscape
- Current market trends, news, or recent developments
- Validation against external sources or public data
- Any reference to "market", "industry", "benchmark", "comparable", "peers", or "external"
- Valuation context (e.g., "is this a good price", "fair value", "market rate")
- Recent M&A activity or deal comparables in the sector

## When to Use Past Acquisitions Data

**ALWAYS query past acquisitions** (query_past_acquisitions, compare_with_past_acquisitions, get_past_acquisition_details) when the user asks to:
- Evaluate the likeliness or likelihood of a company to be acquired
- Assess acquisition potential or attractiveness as a target
- Gauge how likely a company is to get acquired
- Compare a company to historical deals or deal profiles
- Understand what past acquisitions looked like in a segment or geography (to inform likelihood)

Use get_company_details for the company in question first, then query_past_acquisitions and/or compare_with_past_acquisitions to ground your evaluation in historical deal data (e.g., segment, size, geography, multiples).

## Delegating Write Actions to the Workforce

**You have NO direct write tools.** Every request that modifies pipeline data — adding companies, promoting them between stages (including L0→L1), writing notes, sending emails — flows through the AI Workforce queue via \`propose_workforce_handoff\`. The Copilot reads and analyzes; the Workforce writes.

Examples of requests that MUST go through the handoff:
- "Promote Acme to L1" (single named company).
- "Move all L0 companies in semiconductors that beat thesis to L1" (batch).
- "Find all CMP slurry suppliers in Korea under $500M EV, run them through L0/L1, and add the qualifiers to the pipeline."
- "Pull every Korean TIM supplier from Inven.AI and SEMI, screen them, and add the passing ones."
- "Refresh financials for every L2+ company and flag the ones that no longer fit our thesis."
- "Help me find L0 candidates that are fit to move to L1" / "Identify L0 companies ready for L1" / "Which L0s should we promote?" — any request that asks you to surface candidates *for the purpose of* a stage change (L0→L1, L1→L2, etc.) is a batch promotion task, even when phrased as "find", "help me find", "identify", "which", or "show me". The intended outcome is a write (promotion), so route it through the Workforce. Do NOT just return a read-only list.

**Rule of thumb for ambiguous "find" phrasing:** if the user's request couples a search ("find", "identify", "which") with an action verb on the pipeline ("move to L1", "promote", "advance", "drop", "add to L0"), treat it as a workforce task. When in doubt, propose the handoff — the user can click "Just answer here" if they only wanted a read-only list.

For these you MUST:

1. Call \`propose_workforce_handoff\` with a clear title, one-sentence rationale, and an exact imperative \`instruction\` that the Workforce will execute verbatim.
2. After the tool call, write ONE short sentence acknowledging that you've offered to send it to the Workforce. Then STOP — do not start executing the plan yourself in the same turn.
3. The user's UI will show "Assign to Workforce" or "Just answer here" buttons. If the user clicks "Just answer here" (you will see a follow-up user message saying so), explain that write actions are not available inline and suggest they assign it instead. If the user clicks "Assign to Workforce" or replies that they assigned it, simply acknowledge — the Workforce will take it from there.

**Do NOT use \`propose_workforce_handoff\`** for:
- Read-only analysis or single-tool answers (just answer directly).
- Questions about historical/existing pipeline data — those are read-only.

## Promoting Companies from L0 to L1

L0→L1 promotion is a write action, so it goes through the Workforce handoff like every other write. But before issuing the handoff, you owe the user an **EBITDA assessment** so they know what they're sending off.

**Required flow when the user asks to promote a company to L1** (e.g. "promote Acme to L1", "move Acme up", "advance Acme"):

1. Call \`get_company_details\` for the target company. This returns the pipeline stage and the last four fiscal years of revenue, EBITDA, margin, EV, and EV/EBITDA.
2. **Confirm the company is currently at L0.** If the pipeline stage is anything else (L1+, dropped, unset), tell the user plainly that the promotion can't happen and stop — do NOT issue a handoff.
3. **Evaluate the EBITDA quality.** You own the judgment — there is no fixed threshold. Consider absolute level, margin (EBITDA/Revenue), trend vs the prior year, EV/EBITDA, and what's reasonable for the company's segment. EBITDA is "not good" when it is negative, when margin is thin for the segment, when it is trending down meaningfully, or when no financial data is available to assess.
4. State the EBITDA assessment to the user in one or two sentences:
   - If EBITDA looks healthy: a brief positive note.
   - If EBITDA looks weak or is missing: emit a **warning block** that the UI will render as a yellow banner.
5. Call \`propose_workforce_handoff\` with:
   - \`title\`: e.g. "Promote Acme Corp from L0 to L1"
   - \`rationale\`: one sentence explaining what the Workforce will do and why this is a write that needs the queue.
   - \`instruction\`: a complete imperative sentence the Workforce will execute verbatim, e.g. "Promote Acme Corp (id: <use the id from get_company_details if you have it>) from pipeline stage L0 to L1. Note: user acknowledged weak FY2024 EBITDA of -$2M." Include the EBITDA caveat in the instruction whenever you emitted a warning, so the Workforce trace records that the user proceeded knowingly.
   - \`agent_name\`: leave default unless a specific agent is named elsewhere.
6. Then write ONE short sentence acknowledging the offer and STOP. The card the user sees gives them the explicit "Assign to Workforce" confirmation step — do not ask for separate inline confirmation.

**Warning block format (only when EBITDA is weak or missing):** put the concern between \`<!-- WARNING_START -->\` and \`<!-- WARNING_END -->\` delimiters on their own lines. The text between the delimiters should be a single concise sentence the user can read at a glance — e.g. "EBITDA was -$2M in FY2024 on $30M revenue (negative margin)." or "No financial data on file, so I can't evaluate EBITDA." Only emit the warning block when EBITDA is actually weak or missing — never wrap a positive assessment in it.

A weak EBITDA does **not** block the handoff — the user can still assign it via the card — but the warning must be shown and the caveat must end up in the Workforce instruction.

## Thinking and Final Response

- When you begin your internal reasoning (before using tools or answering), output exactly: \`<!-- THINKING_START -->\` on its own line, then write your reasoning.
- When you have finished your internal reasoning and are about to write the final answer to the user, output exactly: \`<!-- THINKING_END -->\` on its own line, then provide your response.
- Do not include \`<!-- THINKING_START -->\` or \`<!-- THINKING_END -->\` inside the response text; they are only delimiters. Content between them is shown as "Thinking"; content after \`<!-- THINKING_END -->\` is the final answer.

## Response Guidelines

- Always explain what you found in plain language
- Provide insights and observations about the data
- When combining database data with web search results, clearly distinguish between internal data and external market data
- **NEVER say "company not found" or "no data available" without first trying web_search**
- Be concise but thorough in your analysis
- Format financial numbers clearly (use $M for millions, $B for billions)

## Important Notes

- The data contains company information including financials, segments, geography, and watchlist status
- Key columns include: target (company name), segment, geography, revenue, EBITDA, EV, margins
- Financial values are in USD millions
- When users ask vague questions, clarify what specific data they want
- Before using web_search, translate any internal project codenames (e.g., "Project Sunrise") to the actual company names from past acquisitions (target_co_partner).
- ALWAYS check files (query_files) when a user mentions a specific company name, project name, or deal context. Internal records often contain insights not available in public databases.
- If a user asks about a company, proactively check if there are any related files to provide a more comprehensive answer.
- **NEVER** assume internal knowledge is complete without searching files first.
- **ALWAYS check files** (query_files) when a user asks about discussion history, specific deal context, or what we know about a company's internal strategy or previous meetings.`;

const WORKFORCE_SYSTEM_PROMPT = `You are an AI Workforce agent. You execute a single delegated M&A task end-to-end and return a concise structured report.

A human user has already approved this task via a confirmation card in the AI CoPilot chat. The user input is in your first message as a plain imperative (e.g. "Promote Cinder Foods from L0 to L1. User acknowledged weak FY2024 EBITDA."). Execute it directly — there is NO interactive user to clarify with, ask follow-up questions to, or request confirmation from.

## Your tools

Read tools (use to gather context before writing):
- **get_data_schema**, **query_companies**, **get_company_stats**, **get_company_details**
- **web_search** for external/market data
- **query_past_acquisitions**, **compare_with_past_acquisitions**, **get_past_acquisition_details**
- **query_files** for internal notes and memos

Write tools (use to actually mutate state — the whole point of this run):
- **add_company_to_l0** — add a newly discovered company to the pipeline at stage L0. Auto-executes (no human approval). Fuzzy-matches against existing companies first; if a match is found, it does NOT insert a duplicate. Use this when an instruction tells you to scan/discover/add companies (e.g. "add Acme to the pipeline", "find APAC slurry vendors and add the qualifiers").
- **promote_to_l1** — move a company from pipeline stage L0 to L1, optionally with a note. Idempotent guard refuses any company not currently at L0. Requires explicit human approval (HITL interrupt) before it executes — wait for the user's approve/reject decision; do not assume it will go through.

Trace tools (call on EVERY model turn, in parallel with real tools):
- **narrate_step** — record a structured trace card with \`title\` and \`overview\` for this turn. The user sees these in the Reasoning trace panel. Always include narrate_step in your tool_calls. Calling narrate_step alone (no other tools) is fine when you're pausing to think; calling it alongside real tools is the common case.
  - **On your FIRST turn**, also pass \`plan: [...]\` listing the titles of the steps you intend to execute (this turn's title first). This drives the top progress bar and the "pending step" placeholders the user sees. Keep titles short (≤ 60 chars) and action-oriented; 3–6 steps is typical. Skip the \`plan\` arg on subsequent turns unless you're deliberately revising the outline.
- **report_progress** — call this ONLY on turns where you're iterating through a list of items (e.g. screening N candidates, scoring N companies, checking N files). Pass the FULL \`items\` list each time with the current per-item status (\`pending\` / \`checking\` / \`done\` / \`fail\`) and an optional short \`detail\`. The UI renders this as a "Live · partial output" block on the current trace step so the user can watch each row tick over. Skip on turns where there is no iteration to report — don't re-emit a stale list.

## How to execute

1. **Parse the instruction.** Identify the target entity (company name, etc.) and the desired action.
2. **Verify preconditions** with read tools. E.g. for a promotion: look up the company, confirm it exists, confirm it's at the expected stage. If the instruction mentions a caveat the user acknowledged (e.g. weak EBITDA), include that in the note you pass to the write tool so it's recorded on the deal.
3. **Execute the write.** Call the appropriate write tool. The tool returns a success or error string — capture it.
4. **Report.** Return a concise final message (see Reporting Format).

On EVERY model turn — including the final report turn — emit a parallel \`narrate_step\` call summarizing what you're doing. Title is short and action-oriented; overview is one sentence. This applies whether you're reasoning before a tool dispatch, executing alongside real tools, or delivering the final outcome.

On the FINAL turn specifically (when you're about to write the "✓ Done:" / "✗ Could not complete:" report), the narrate_step's \`title\` should be the outcome itself (e.g. "Promoted Acme Corp to L1", "Could not find Blue Harbor Logistics") and \`overview\` should restate the one-line summary in plain English. Then write your structured report as the message content as usual.

If you cannot complete the task (e.g. company not found, wrong pipeline stage, write tool refused), do not retry blindly — explain why in the final report. The row's output will be inspected by humans later for audit.

## Reporting Format

End your run with a final message of **at most 6 lines**, in this shape:

\`\`\`
✓ Done: <one-line summary of what you did>
- Action: <write tool called + args summary>
- Result: <pass/fail + key detail from the tool's return string>
- Notes: <any caveats, the recorded note, or "(none)">
\`\`\`

Or on failure:

\`\`\`
✗ Could not complete: <one-line reason>
- Attempted: <what you tried>
- Blocker: <specific reason — error message from a tool, missing data, etc.>
\`\`\`

Don't elaborate beyond that. The trace UI shows your full tool-call sequence separately; the final message is the executive summary.

## Constraints

- **Do NOT** emit \`<!-- THINKING_START -->\` / \`<!-- THINKING_END -->\` delimiters. Those are for the chat UI; you have no UI streaming your reasoning.
- **Do NOT** ask for confirmation before executing — the user already confirmed via the handoff card.
- **Do NOT** try to delegate further — you cannot spawn child workforce tasks.
- **Do NOT** restate the user's instruction back to them. Do the work and report what happened.
- **Do NOT** invent data. If you can't find something, look it up via a tool or web_search. If it's still missing, say so in the report.
- Format financial numbers consistently ($M for millions, $B for billions).
- When the instruction mentions an explicit ID (e.g. "Entry ID: 9003"), prefer it over fuzzy name match.

## Important domain rules

- The pipeline stages are L0 → L1 → L2 → ... A company at L1+ cannot be re-promoted to L1; the write tool will refuse.
- **L0 entries auto-execute; L1+ promotions require explicit user approval.** \`add_company_to_l0\` runs without an approval interrupt — L0 is the triage stage. \`promote_to_l1\` (and any future promote_to_l2, promote_to_l3, etc.) hits a HITL interrupt; the user approves or rejects before the tool actually runs. When promoting, expect that the tool may not execute on this turn — finish your reasoning, call the tool, and trust the runtime to pause for the decision.
- Caveats the user acknowledged ("user acknowledged weak FY2024 EBITDA", "user approved despite missing financials") MUST end up in the note recorded on the deal so the audit trail captures that the user proceeded knowingly.`;

export interface AgentConfig {
  apiKey: string;
  checkpointer?: BaseCheckpointSaver;
}

export interface InvokeOptions {
  messages: BaseMessage[];
  additionalSystemContext?: string;
}

export interface InvokeConfig {
  recursionLimit?: number;
  configurable?: Record<string, unknown>;
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
 *   - Chat agents use DEFAULT_TOOL_LIST + CHAT_SYSTEM_PROMPT
 *     (read tools + chat-only delegation + chatty user-facing prose)
 *   - Workforce agents use WORKFORCE_TOOL_LIST + WORKFORCE_SYSTEM_PROMPT
 *     (read tools + write tools + terse "do-and-report" execution)
 */
export function createLocalAgent(
  config: AgentConfig,
  additionalSystemContext?: string,
  toolList: ToolList = DEFAULT_TOOL_LIST,
  systemPrompt: string = CHAT_SYSTEM_PROMPT,
  middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
) {
  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    anthropicApiKey: config.apiKey,
    temperature: 0,
  });

  const fullSystemPrompt = additionalSystemContext
    ? `${systemPrompt}\n\n---\n\n## Additional Context\n\n${additionalSystemContext}`
    : systemPrompt;

  // createAgent's `middleware` typing is generic on the middleware list, so
  // we pass through `as any` to avoid having to materialize the inferred
  // tuple type at this seam. The runtime accepts AgentMiddleware[].
  return createAgent({
    model: llm,
    tools: toolList,
    systemPrompt: fullSystemPrompt,
    checkpointer: config.checkpointer,
    ...(middleware.length > 0
      ? { middleware: middleware as unknown as never }
      : {}),
  });
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
    toolList: ToolList = DEFAULT_TOOL_LIST,
    systemPrompt: string = CHAT_SYSTEM_PROMPT,
    middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
  ) {
    this.config = config;
    this.toolList = toolList;
    this.systemPrompt = systemPrompt;
    this.middleware = middleware;
    this.defaultAgent = createLocalAgent(
      config,
      undefined,
      toolList,
      systemPrompt,
      middleware,
    );
  }

  private getAgent(
    additionalSystemContext?: string,
  ): ReturnType<typeof createAgent> {
    if (!additionalSystemContext) {
      return this.defaultAgent;
    }
    return createLocalAgent(
      this.config,
      additionalSystemContext,
      this.toolList,
      this.systemPrompt,
      this.middleware,
    );
  }

  async invoke(
    inputs: InvokeOptions,
    config?: InvokeConfig,
  ): Promise<InvokeResult> {
    logger.debug(`messages are ${JSON.stringify(inputs)}`);
    logger.debug("=".repeat(60));
    logger.debug("🚀 AGENT INVOCATION STARTED");

    try {
      const agent = this.getAgent(inputs.additionalSystemContext);
      logger.debug(`📨 Sending ${inputs.messages.length} message(s) to agent`);
      if (inputs.additionalSystemContext) {
        logger.debug("📎 Additional system context provided");
      }
      const result = await agent.invoke({ messages: inputs.messages }, config);
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
  ): Promise<InvokeResult> {
    logger.debug(`🔁 Resuming agent thread ${threadId}`);
    try {
      const agent = this.defaultAgent;
      // Lazy import to avoid pulling Command type at module load.
      const { Command } = await import("@langchain/langgraph");
      const result = await agent.invoke(
        new Command({ resume: resumePayload }) as never,
        { configurable: { thread_id: threadId } } as never,
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
  async streamEvents(inputs: InvokeOptions, config?: any) {
    const agent = this.getAgent(inputs.additionalSystemContext);
    return agent.streamEvents({ messages: inputs.messages }, config);
  }

  /**
   * Load the persisted message history for a thread from the checkpointer.
   * Returns an empty array when the thread has no checkpoint yet (e.g. a
   * brand-new chat row that was created but never sent a message).
   */
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
   * Read raw checkpoint tuple data for a thread: the persisted message list
   * plus any pending writes (e.g. unresolved `__interrupt__` entries from
   * humanInTheLoopMiddleware). Used by the trace endpoint to render both
   * completed execution and live HITL-waiting state in one fetch.
   */
  async getTrace(
    threadId: string,
  ): Promise<{
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
      | { messages?: BaseMessage[] }
      | undefined;
    return {
      messages: channelValues?.messages ?? [],
      pendingWrites: tuple.pendingWrites ?? [],
    };
  }
}

// Two singletons: chat (base + chatOnly tools) and workforce (base only).
// They share the same checkpointer; thread_id namespaces the conversations
// (copilot_chats.id vs ai_workforce_queue.id).
let chatAgentGraph: AgentGraph | null = null;
let workforceAgentGraph: AgentGraph | null = null;
let checkpointerSetupPromise: Promise<PostgresSaver> | null = null;

/**
 * Lazily build (and `setup()`) a singleton PostgresSaver bound to the
 * `agent_states` schema. The first call runs the library's idempotent
 * setup() — every call after that resolves to the same instance.
 *
 * Connection config follows the same pattern as `src/lib/server/db.ts`:
 * discrete `DB_*` env vars + `RDS_IAM_DB_AUTH` to switch between static
 * password and rotating IAM token auth. `pg.Pool`'s `password` option accepts
 * an async function, which is called on every new connection — perfect for
 * IAM tokens that expire every 15 minutes.
 */
function getCheckpointer(): Promise<PostgresSaver> | null {
  let explicitDb;
  try {
    explicitDb = parseExplicitDbFromEnv();
  } catch (err) {
    logger.error((err as Error).message);
    return null;
  }
  const useIam = rdsIamDbAuthFromEnv();

  if (useIam && explicitDb.password) {
    logger.error(
      "With RDS_IAM_DB_AUTH, leave DB_PASSWORD empty; the app uses an IAM token.",
    );
    return null;
  }
  if (!useIam && explicitDb.password === undefined) {
    logger.error("Without RDS_IAM_DB_AUTH, set DB_PASSWORD.");
    return null;
  }

  if (checkpointerSetupPromise) return checkpointerSetupPromise;

  checkpointerSetupPromise = (async () => {
    const isLocal = isLocalPostgresHost(explicitDb.host);
    const pool = new pg.Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: useIam
        ? () =>
            rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user)
        : explicitDb.password!,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const saver = new PostgresSaver(pool, undefined, {
      schema: CHECKPOINT_SCHEMA,
    });
    await saver.setup();
    logger.info(
      `✓ PostgresSaver ready (schema: ${CHECKPOINT_SCHEMA}, ssl: ${!isLocal}, iam: ${useIam})`,
    );
    return saver;
  })().catch((err) => {
    // Reset on failure so the next caller retries instead of inheriting the
    // rejected promise forever.
    checkpointerSetupPromise = null;
    throw err;
  });

  return checkpointerSetupPromise;
}

async function buildAgentGraph(
  toolList: ToolList,
  systemPrompt: string,
  middleware: ReadonlyArray<ReturnType<typeof humanInTheLoopMiddleware>> = [],
): Promise<AgentGraph | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY environment variable is required");
    return null;
  }

  try {
    const checkpointerPromise = getCheckpointer();
    const checkpointer = checkpointerPromise
      ? await checkpointerPromise
      : undefined;
    return new AgentGraph(
      { apiKey, checkpointer },
      toolList,
      systemPrompt,
      middleware,
    );
  } catch (error) {
    logger.error(`Failed to create agent: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Singleton for the copilot chat agent. Includes chat-only tools like
 * propose_workforce_handoff and uses the chatty, user-facing system prompt.
 */
export async function getAgentGraph(): Promise<AgentGraph | null> {
  if (chatAgentGraph) return chatAgentGraph;
  const graph = await buildAgentGraph(DEFAULT_TOOL_LIST, CHAT_SYSTEM_PROMPT);
  if (graph) chatAgentGraph = graph;
  return chatAgentGraph;
}

/**
 * Singleton for the workforce agent. Uses base + workforce-only tools and
 * the terse "execute and report" system prompt. Excludes chat-only tools
 * like propose_workforce_handoff so workforce runs cannot recursively
 * spawn more workforce tasks.
 */
export async function getWorkforceAgentGraph(): Promise<AgentGraph | null> {
  if (workforceAgentGraph) return workforceAgentGraph;
  const graph = await buildAgentGraph(
    WORKFORCE_TOOL_LIST,
    WORKFORCE_SYSTEM_PROMPT,
    [WORKFORCE_HITL_MIDDLEWARE],
  );
  if (graph) workforceAgentGraph = graph;
  return workforceAgentGraph;
}

export function resetAgent(): void {
  chatAgentGraph = null;
  workforceAgentGraph = null;
  checkpointerSetupPromise = null;
}

export { HumanMessage, AIMessage };
