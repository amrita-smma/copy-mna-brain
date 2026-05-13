/**
 * M&A analysis agent. Built on langchain's createAgent and exposes streaming
 * via streamEvents (used by the chat route) plus a synchronous invoke wrapper
 * used by the job handlers.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import pg from "pg";
import { tools } from "./tools";
import { logger } from "../logger";
import {
  isLocalPostgresHost,
  parseExplicitDbFromEnv,
  rdsIamAuthToken,
  rdsIamDbAuthFromEnv,
} from "@/lib/server/db";

const CHECKPOINT_SCHEMA = "agent_states";

const SYSTEM_PROMPT = `You are an intelligent M&A Data Analysis Assistant that helps users explore and analyze company/asset data for mergers and acquisitions.

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
}

/**
 * Build a streaming-capable agent with optional additional system context.
 */
export function createLocalAgent(config: AgentConfig, additionalSystemContext?: string) {
  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    anthropicApiKey: config.apiKey,
    temperature: 0,
  });

  const fullSystemPrompt = additionalSystemContext
    ? `${SYSTEM_PROMPT}\n\n---\n\n## Additional Context\n\n${additionalSystemContext}`
    : SYSTEM_PROMPT;

  return createAgent({
    model: llm,
    tools,
    systemPrompt: fullSystemPrompt,
    checkpointer: config.checkpointer,
  });
}

/**
 * Wrapper around the streaming agent that exposes both invoke and streamEvents.
 */
export class AgentGraph {
  private config: AgentConfig;
  private defaultAgent: ReturnType<typeof createAgent>;

  constructor(config: AgentConfig) {
    this.config = config;
    this.defaultAgent = createLocalAgent(config);
  }

  private getAgent(additionalSystemContext?: string): ReturnType<typeof createAgent> {
    if (!additionalSystemContext) {
      return this.defaultAgent;
    }
    return createLocalAgent(this.config, additionalSystemContext);
  }

  async invoke(inputs: InvokeOptions, config?: InvokeConfig): Promise<InvokeResult> {
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
      logger.debug("✓ Agent graph invocation completed");

      logger.debug("✅ AGENT INVOCATION COMPLETED SUCCESSFULLY");
      logger.debug("=".repeat(60));

      if (result && typeof result === "object" && "messages" in result) {
        return { messages: result.messages as BaseMessage[] };
      }

      return { messages: [new AIMessage(JSON.stringify(result))] };
    } catch (error) {
      logger.error(`✗ AGENT INVOCATION FAILED: ${(error as Error).message}`);
      logger.debug("=".repeat(60));
      return { messages: [new AIMessage(`Error invoking agent: ${(error as Error).message}`)] };
    }
  }

  async ainvoke(inputs: InvokeOptions, config?: InvokeConfig): Promise<InvokeResult> {
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
      getState: (config: { configurable: { thread_id: string } }) => Promise<{
        values?: { messages?: BaseMessage[] };
      } | undefined>;
    };
    const state = await agent.getState({ configurable: { thread_id: threadId } });
    return state?.values?.messages ?? [];
  }
}

let agentGraph: AgentGraph | null = null;
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
    logger.error('With RDS_IAM_DB_AUTH, leave DB_PASSWORD empty; the app uses an IAM token.');
    return null;
  }
  if (!useIam && explicitDb.password === undefined) {
    logger.error('Without RDS_IAM_DB_AUTH, set DB_PASSWORD.');
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
        ? () => rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user)
        : explicitDb.password!,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
    await saver.setup();
    logger.info(`✓ PostgresSaver ready (schema: ${CHECKPOINT_SCHEMA}, ssl: ${!isLocal}, iam: ${useIam})`);
    return saver;
  })().catch((err) => {
    // Reset on failure so the next caller retries instead of inheriting the
    // rejected promise forever.
    checkpointerSetupPromise = null;
    throw err;
  });

  return checkpointerSetupPromise;
}

export async function getAgentGraph(): Promise<AgentGraph | null> {
  if (agentGraph) {
    return agentGraph;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY environment variable is required");
    return null;
  }

  try {
    const checkpointerPromise = getCheckpointer();
    const checkpointer = checkpointerPromise ? await checkpointerPromise : undefined;
    agentGraph = new AgentGraph({ apiKey, checkpointer });
    return agentGraph;
  } catch (error) {
    logger.error(`Failed to create agent: ${(error as Error).message}`);
    return null;
  }
}

export function resetAgent(): void {
  agentGraph = null;
  checkpointerSetupPromise = null;
}

export { HumanMessage, AIMessage };
