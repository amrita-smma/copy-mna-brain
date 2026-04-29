/**
 * M&A analysis agent. Built on langchain's createAgent and exposes streaming
 * via streamEvents (used by the chat route) plus a synchronous invoke wrapper
 * used by the job handlers.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { tools } from "./tools";
import { logger } from "../logger";

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
9. **inven_paid_data_source_search** - Search for companies using Inven's AI-powered search (for Screening/Sourcing)
10. **inven_paid_data_source_enrichment** - Get detailed company data from Inven by company IDs
11. **query_files** - Search and retrieve files related to companies, tags, or topics

## How to Help Users

1. **For browsing companies:** Use query_companies with appropriate filters
2. **For statistics:** Use get_company_stats to get summaries and breakdowns
3. **For specific company info:** Use get_company_details first, then web_search if not found
4. **For meeting records:** Use query_files to find what was discussed about a company or topic
5. **For market context:** Use web_search for benchmarks and comparisons
6. **For evaluating acquisition likelihood:** Use query_past_acquisitions and compare_with_past_acquisitions to ground your assessment in historical deal metrics and comparable transactions

## CRITICAL: Automatic Web Search Fallback

**ALWAYS use Inven as a data source first before going to web_search**
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
}

export interface InvokeOptions {
  messages: BaseMessage[];
  additionalSystemContext?: string;
}

export interface InvokeConfig {
  recursionLimit?: number;
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
}

let agentGraph: AgentGraph | null = null;

export function getAgentGraph(): AgentGraph | null {
  if (agentGraph) {
    return agentGraph;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY environment variable is required");
    return null;
  }

  try {
    agentGraph = new AgentGraph({ apiKey });
    return agentGraph;
  } catch (error) {
    logger.error(`Failed to create agent: ${(error as Error).message}`);
    return null;
  }
}

export function resetAgent(): void {
  agentGraph = null;
}

export { HumanMessage, AIMessage };
