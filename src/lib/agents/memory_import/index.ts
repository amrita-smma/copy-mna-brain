/**
 * @memory_import — turns a block of text the user pasted from another tool
 * into memories in this app's store.
 *
 * Built on the shared agent runtime (`buildAgentGraph` → `createLocalAgent` →
 * langchain `createAgent`) like every other agent here, with two deliberate
 * differences:
 *
 * - **Stateless.** One paste is one run with no follow-up, so there is nothing
 *   to resume and no checkpointer — the same choice the one-shot job handlers
 *   make (`getStatelessAgentGraph`).
 * - **One tool.** The input is arbitrary text from outside the app. Anything
 *   that could read the workspace or reach the network would make an injection
 *   inside it worth attempting; see `tools/index.ts`.
 * - **Proposes, never writes.** The run returns statements; the user reviews
 *   and edits them, and only then does the service store the survivors.
 *
 * Runs on the `low` tier: extracting statements from text in front of it is
 * cheap, and the user is waiting on a dialog.
 *
 * The run is streamed (`AgentGraph.streamEvents`) rather than invoked, so a
 * long paste starts producing tool calls while the rest is still being read
 * and the request is not one opaque block. The import route drains the stream
 * and reports the result; it does not forward the events to the browser.
 */
import { buildAgentGraph, type AgentGraph } from '@/lib/agents/analysis';
import { HumanMessage } from '@langchain/core/messages';
import { MEMORY_IMPORT_SYSTEM_PROMPT, buildImportPrompt } from './prompt';
import { MEMORY_IMPORT_TOOLS } from './tools';
import { TRACE_NAMES } from '@/lib/langfuseTraceNames';

/** Cached per process — the graph holds no per-user state. */
let memoryImportGraph: AgentGraph | null = null;

export async function getMemoryImportAgentGraph(): Promise<AgentGraph | null> {
  if (memoryImportGraph) return memoryImportGraph;
  const graph = await buildAgentGraph(
    MEMORY_IMPORT_TOOLS as never,
    MEMORY_IMPORT_SYSTEM_PROMPT,
    [],
    // Stateless: no thread to resume, so no checkpointer.
    false,
    'low',
  );
  if (graph) memoryImportGraph = graph;
  return memoryImportGraph;
}

/** Exported for tests; lets a suite rebuild the graph against fresh mocks. */
export function resetMemoryImportAgent(): void {
  memoryImportGraph = null;
}

export interface RunMemoryImportInput {
  /** The raw text — pasted, or extracted from an uploaded file. Data, never instructions. */
  dump: string;
  /** Free-text label for where it came from. */
  origin?: string;
  /** Aborts the run — the request signal, or a time budget. */
  signal?: AbortSignal;
}

export interface MemoryImportRun {
  /** What the agent proposes storing. NOT saved — the user confirms first. */
  statements: string[];
  /** The agent's closing sentence, for the dialog to show. */
  summary: string;
}

/**
 * How many agent turns one import may take. The intended shape is a single
 * `propose_memories` call followed by a one-line report, so this is headroom for
 * a retry after a schema error, not a budget to plan against.
 */
const RECURSION_LIMIT = 8;

/**
 * Run one extraction to completion and return what it proposes.
 *
 * Nothing is written here. The caller shows the statements to the user, who
 * edits or drops any of them, and only the survivors are saved
 * (`UserMemoryService.saveReviewed`). That is why there is no `userId` on this
 * input at all: an extraction has no owner, so a line inside the text telling
 * the model to "save this to another user" has nothing to act on.
 */
export async function runMemoryImport({
  dump,
  origin,
  signal,
}: RunMemoryImportInput): Promise<MemoryImportRun> {
  const graph = await getMemoryImportAgentGraph();
  if (!graph) {
    throw new Error('Memory import agent is unavailable — check ANTHROPIC_API_KEY.');
  }

  // The tool appends into this; `configurable` is passed by reference, so the
  // proposals come back here rather than through the model's prose.
  const statements: string[] = [];

  const stream = await graph.streamEvents(
    { messages: [new HumanMessage(buildImportPrompt(dump, origin))] },
    {
      version: 'v2',
      runName: TRACE_NAMES.memoryImport,
      recursionLimit: RECURSION_LIMIT,
      configurable: {
        memory_proposal: statements,
        ...(origin ? { memory_origin: origin } : {}),
        agentRole: 'memory_import',
      },
      ...(signal ? { signal } : {}),
    },
  );

  // Drain the stream, keeping the text the model emitted. The events are not
  // forwarded anywhere — streaming is here so the run is incremental and
  // cancellable, not because a client is reading it.
  let summary = '';
  for await (const event of stream) {
    const chunk = finalTextFrom(event);
    if (chunk) summary += chunk;
  }

  return { statements, summary: summary.trim() };
}

/**
 * The assistant text out of one `streamEvents` event, or null. Reads
 * `on_chat_model_stream` chunks, which is where the closing sentence arrives
 * token by token.
 */
function finalTextFrom(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { event?: string; data?: { chunk?: { content?: unknown } } };
  if (e.event !== 'on_chat_model_stream') return null;

  const content = e.data?.chunk?.content;
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;

  // Anthropic streams content as blocks; only `text` blocks are the answer
  // (thinking and tool_use blocks are not).
  return (
    content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('') || null
  );
}
