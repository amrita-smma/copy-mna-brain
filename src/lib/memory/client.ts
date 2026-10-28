/**
 * Builds the mem0 `Memory` the CoPilot remembers through.
 *
 * Three pieces are swapped out of mem0's defaults:
 *
 * - **Storage** — `DrizzleMemoryVectorStore` over `user_memories`, instead of
 *   mem0's `pgvector` provider. See that file for why.
 * - **Embeddings** — Amazon Titan Embed Text v2 on Bedrock, the same model and
 *   1024 dimensions `rss.item_chunks` uses, so this app has exactly one
 *   embedding model. Through `BedrockMemoryEmbedder`, not mem0's `aws_bedrock`
 *   provider, which opens a new Bedrock client per request. See `./embedder.ts`.
 * - **Extraction LLM** — `AnthropicMemoryLlm`, ours. Neither of mem0's own
 *   providers works against the current Claude models: `anthropic` always sends
 *   a `temperature` they reject, and `langchain` returns an object where mem0's
 *   own parser expects a string. See `./llm.ts`.
 *
 * mem0's SQLite history store is disabled: it writes to the local filesystem,
 * which is ephemeral on Vercel. `user_memories.updated_at` plus the job log is
 * the audit trail we actually keep.
 *
 * mem0 is loaded with a dynamic `import()` so that (a) the telemetry opt-out
 * below lands in `process.env` *before* mem0's module body reads it — a static
 * import would be hoisted above it — and (b) a request that never touches
 * memory never pays to parse it.
 */
import type { UserMemoryRepository } from '@/lib/repositories';
import { AnthropicMemoryLlm } from './llm';
import { BedrockMemoryEmbedder } from './embedder';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@/lib/bedrock';
import { DrizzleMemoryVectorStore } from './vectorStore';
// Defined in a dependency-free module so `@/lib/flags` can read the
// kill-switch without pulling this file's graph into every route; re-exported
// here so callers that already need the client keep one import.
export { memoryConfigured, memoryDeploymentEnabled } from './switch';

/** The provider names our store and LLM are registered under in mem0's factories. */
const DRIZZLE_PROVIDER = 'mna-drizzle';
const ANTHROPIC_PROVIDER = 'mna-anthropic';
const BEDROCK_PROVIDER = 'mna-bedrock';

/**
 * Appended to mem0's extraction prompt. Everything it receives has already been
 * filtered by us, so it should pass statements through or drop them as
 * duplicates — never split, embellish, or find new ones.
 */
const MEM0_DEDUP_INSTRUCTIONS = [
  'Each incoming message is already a single, finished memory about the user, written by',
  'an upstream extractor that has applied strict criteria. Your only job is de-duplication.',
  '',
  '- Keep each statement as written. Do not rephrase, expand, split or merge.',
  '- Drop a statement that is already covered by an Existing Memory.',
  '- Never produce a memory that was not in the incoming messages. Do not infer, elaborate,',
  '  or add context of your own.',
  '- Never extract anything about a company, market, deal, price or valuation; these',
  '  memories are about the person only.',
].join('\n');

/**
 * Claude Haiku: fact extraction is a short, highly structured call made once
 * per remembered turn, so the cheapest capable model is the right one. Override
 * with MEM0_LLM_MODEL.
 */
const DEFAULT_MEMORY_LLM = 'claude-haiku-5-5';

/**
 * Enough for mem0's extraction JSON. Its own Anthropic provider defaults to
 * 2000; this keeps that, with headroom for the newer tokenizer.
 */
const MEMORY_LLM_MAX_TOKENS = 3_000;

export interface UserMemoryClientOptions {
  repository: UserMemoryRepository;
  /** The signed-in user. Every memory read and written is scoped to them. */
  userId: string;
}

/**
 * mem0's `Memory`, narrowed to what this app calls. Declared structurally so
 * nothing outside this module has to import types from `mem0ai/oss`.
 */
export interface UserMemoryClient {
  add(
    messages: string | { role: string; content: string }[],
    config: {
      userId: string;
      metadata?: Record<string, unknown>;
      infer?: boolean;
    },
  ): Promise<{ results: MemoryClientItem[] }>;
  // mem0 3.x reads and lists by `filters` only; a top-level `userId` (or
  // `limit`) throws "Top-level entity parameters [userId] are not supported".
  // `add` still takes `userId`.
  search(
    query: string,
    config: { filters: { user_id: string }; topK?: number; threshold?: number },
  ): Promise<{ results: MemoryClientItem[] }>;
  getAll(config: { filters: { user_id: string }; topK?: number }): Promise<{ results: MemoryClientItem[] }>;
  delete(memoryId: string): Promise<{ message: string }>;
}

export interface MemoryClientItem {
  id: string;
  memory: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  /** Set on `add` results: what mem0 decided to do with this fact. */
  event?: string;
}

/**
 * Teach mem0's factory about our store. Patching the static once per process
 * is the only injection point mem0 offers — `Memory` builds its vector store
 * internally from `vectorStore.provider`, and the built-in `langchain`
 * passthrough throws on `get`, `update` and `list`, which mem0's own write path
 * needs.
 *
 * Guarded so repeated calls (and HMR in dev) don't wrap the patch in itself.
 */
let factoryPatched = false;
function registerDrizzleStore(factory: {
  create: (provider: string, config: Record<string, unknown>) => unknown;
}): void {
  if (factoryPatched) return;
  factoryPatched = true;
  const original = factory.create.bind(factory);
  factory.create = (provider: string, config: Record<string, unknown>) =>
    provider === DRIZZLE_PROVIDER
      ? new DrizzleMemoryVectorStore(
          config as unknown as ConstructorParameters<typeof DrizzleMemoryVectorStore>[0],
        )
      : original(provider, config);
}

/**
 * Teach mem0's LLM factory about ours, for the reasons in `./llm.ts`. Same
 * patch shape as the vector store above — a static on an exported class is the
 * only injection point mem0 offers.
 */
let llmFactoryPatched = false;
function registerAnthropicLlm(factory: {
  create: (provider: string, config: Record<string, unknown>) => unknown;
}): void {
  if (llmFactoryPatched) return;
  llmFactoryPatched = true;
  const original = factory.create.bind(factory);
  factory.create = (provider: string, config: Record<string, unknown>) =>
    provider === ANTHROPIC_PROVIDER
      ? new AnthropicMemoryLlm(
          config as unknown as ConstructorParameters<typeof AnthropicMemoryLlm>[0],
        )
      : original(provider, config);
}

/**
 * Teach mem0's embedder factory about ours, for the reasons in `./embedder.ts`.
 * Same patch shape as the two above.
 */
let embedderFactoryPatched = false;
function registerBedrockEmbedder(factory: {
  create: (provider: string, config: Record<string, unknown>) => unknown;
}): void {
  if (embedderFactoryPatched) return;
  embedderFactoryPatched = true;
  const original = factory.create.bind(factory);
  factory.create = (provider: string, config: Record<string, unknown>) =>
    provider === BEDROCK_PROVIDER ? new BedrockMemoryEmbedder() : original(provider, config);
}

/** Exported for tests: lets a fresh test file re-register against a stub factory. */
export function resetFactoryPatchForTests(): void {
  factoryPatched = false;
  llmFactoryPatched = false;
  embedderFactoryPatched = false;
}

/**
 * Opt out of mem0's PostHog telemetry before its module body reads the flag.
 * Left alone if the environment already says something, so an operator can
 * turn it back on deliberately.
 */
function silenceTelemetry(): void {
  if (process.env.MEM0_TELEMETRY === undefined) {
    process.env.MEM0_TELEMETRY = 'false';
  }
}

/**
 * One `Memory` bound to one user. Deliberately per-request rather than a process
 * singleton: the store closes over a request-scoped repository, and building it
 * is just a few plain objects — the Anthropic client inside is lazy, and the
 * Bedrock client is shared across the process (`./embedder.ts`).
 */
export async function createUserMemory({
  repository,
  userId,
}: UserMemoryClientOptions): Promise<UserMemoryClient> {
  silenceTelemetry();

  const { Memory, VectorStoreFactory, LLMFactory, EmbedderFactory } = await import('mem0ai/oss');
  registerDrizzleStore(VectorStoreFactory as never);
  registerAnthropicLlm(LLMFactory as never);
  registerBedrockEmbedder(EmbedderFactory as never);

  const memory = new Memory({
    embedder: {
      // Model and region (BEDROCK_EMBEDDING_MODEL / BEDROCK_REGION) are read by
      // the shared client in `@/lib/bedrock`; mem0 reads only the dimension.
      provider: BEDROCK_PROVIDER,
      config: {
        model: process.env.BEDROCK_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
        embeddingDims: EMBEDDING_DIMENSIONS,
      },
    },
    llm: {
      provider: ANTHROPIC_PROVIDER,
      config: {
        model: process.env.MEM0_LLM_MODEL ?? DEFAULT_MEMORY_LLM,
        apiKey: process.env.ANTHROPIC_API_KEY,
        maxTokens: MEMORY_LLM_MAX_TOKENS,
      } as never,
    },
    vectorStore: {
      provider: DRIZZLE_PROVIDER,
      config: {
        repository,
        userId,
        collectionName: 'memories',
        // Given explicitly so mem0 skips the probe embedding it would
        // otherwise run on every construction to discover the dimension.
        dimension: EMBEDDING_DIMENSIONS,
        embeddingModelDims: EMBEDDING_DIMENSIONS,
      } as never,
    },
    // mem0's history store is SQLite on the local disk — ephemeral on Vercel.
    disableHistory: true,
    // Everything reaching mem0 has already been through our own extraction
    // (`memory/extract.ts` for a chat turn, the `@memory_import` agent for a
    // paste), so its job here is de-duplication, not discovery. Its stock
    // prompt is maximalist — "every piece of memorable information must be
    // captured" — and these instructions land last in its prompt to rein that
    // in on the second pass.
    customInstructions: MEM0_DEDUP_INSTRUCTIONS,
  });

  return memory as unknown as UserMemoryClient;
}
