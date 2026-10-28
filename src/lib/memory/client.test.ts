import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@/lib/bedrock';

const mocks = vi.hoisted(() => ({
  MemoryCtor: vi.fn(),
  builtinCreate: vi.fn(),
  // The object the patch mutates. `create` starts as mem0's own factory and is
  // replaced in place, so assertions must call through this object — holding a
  // reference to the original function would always bypass the patch.
  factory: { create: (() => undefined) as (p: string, c: unknown) => unknown },
  llmFactory: { create: (() => undefined) as (p: string, c: unknown) => unknown },
  builtinLlmCreate: vi.fn(),
  embedderFactory: { create: (() => undefined) as (p: string, c: unknown) => unknown },
  builtinEmbedderCreate: vi.fn(),
}));

/**
 * `mem0ai/oss` is loaded with a dynamic `import()` inside `createUserMemory`,
 * so this mock stands in for the whole module. `VectorStoreFactory` is a plain
 * object with a mutable static — the same shape the real class presents to the
 * patch.
 */
vi.mock('mem0ai/oss', () => ({
  Memory: mocks.MemoryCtor,
  VectorStoreFactory: mocks.factory,
  LLMFactory: mocks.llmFactory,
  EmbedderFactory: mocks.embedderFactory,
}));

import { DrizzleMemoryVectorStore } from './vectorStore';
import { createUserMemory, memoryConfigured, resetFactoryPatchForTests } from './client';
import { AnthropicMemoryLlm } from './llm';
import { BedrockMemoryEmbedder } from './embedder';

const repository = { list: vi.fn() } as never;
const ORIGINAL_ENV = { ...process.env };

/** The config the `Memory` constructor was called with. */
const lastConfig = () => mocks.MemoryCtor.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  resetFactoryPatchForTests();
  mocks.builtinCreate.mockReset().mockReturnValue({ builtin: true });
  mocks.factory.create = mocks.builtinCreate;
  mocks.builtinLlmCreate.mockReset().mockReturnValue({ builtinLlm: true });
  mocks.llmFactory.create = mocks.builtinLlmCreate;
  mocks.builtinEmbedderCreate.mockReset().mockReturnValue({ builtinEmbedder: true });
  mocks.embedderFactory.create = mocks.builtinEmbedderCreate;
  mocks.MemoryCtor.mockImplementation(function (this: Record<string, unknown>) {
    return this;
  });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.MEM0_TELEMETRY;
  delete process.env.MEM0_LLM_MODEL;
  delete process.env.BEDROCK_REGION;
  delete process.env.BEDROCK_EMBEDDING_MODEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('memoryConfigured', () => {
  it('is false without an LLM key to extract memories with', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(memoryConfigured()).toBe(false);
  });

  it('is true once the key is set', () => {
    expect(memoryConfigured()).toBe(true);
  });
});

describe('createUserMemory', () => {
  it('opts out of mem0 telemetry before the module is loaded', async () => {
    await createUserMemory({ repository, userId: 'u1' });
    expect(process.env.MEM0_TELEMETRY).toBe('false');
  });

  it('leaves an explicit telemetry setting alone', async () => {
    process.env.MEM0_TELEMETRY = 'true';
    await createUserMemory({ repository, userId: 'u1' });
    expect(process.env.MEM0_TELEMETRY).toBe('true');
  });

  it('stores through our Drizzle-backed vector store, not mem0’s pgvector', async () => {
    await createUserMemory({ repository, userId: 'u1' });

    const { vectorStore } = lastConfig();
    expect(vectorStore.provider).toBe('mna-drizzle');
    expect(vectorStore.config).toMatchObject({ repository, userId: 'u1' });

    // The factory patch resolves that provider to our store, and still defers
    // every other provider to mem0's own factory.
    const built = mocks.factory.create('mna-drizzle', vectorStore.config);
    expect(built).toBeInstanceOf(DrizzleMemoryVectorStore);
    expect(mocks.factory.create('qdrant', {})).toEqual({ builtin: true });
    expect(mocks.builtinCreate).toHaveBeenCalledWith('qdrant', {});
  });

  it('declares the embedding dimension so mem0 skips its probe call', async () => {
    await createUserMemory({ repository, userId: 'u1' });

    const { vectorStore, embedder } = lastConfig();
    expect(vectorStore.config.dimension).toBe(EMBEDDING_DIMENSIONS);
    expect(embedder.config.embeddingDims).toBe(EMBEDDING_DIMENSIONS);
  });

  it('embeds through our shared Bedrock client, not mem0’s per-request one', async () => {
    await createUserMemory({ repository, userId: 'u1' });

    const { embedder } = lastConfig();
    expect(embedder).toEqual({
      provider: 'mna-bedrock',
      config: { model: 'amazon.titan-embed-text-v2:0', embeddingDims: EMBEDDING_DIMENSIONS },
    });

    // The factory patch resolves that provider to ours, and still defers every
    // other provider to mem0's own factory.
    expect(mocks.embedderFactory.create('mna-bedrock', embedder.config)).toBeInstanceOf(
      BedrockMemoryEmbedder,
    );
    expect(mocks.embedderFactory.create('aws_bedrock', {})).toEqual({ builtinEmbedder: true });
  });

  it('extracts through our own LLM, not either of mem0’s broken providers', async () => {
    // `anthropic` always sends a `temperature` the current families reject;
    // `langchain` returns an object where mem0's own parser wants a string.
    await createUserMemory({ repository, userId: 'u1' });

    const { llm } = lastConfig();
    expect(llm.provider).toBe('mna-anthropic');
    expect(llm.config).toMatchObject({ model: 'claude-haiku-5-5', apiKey: 'test-key' });

    // The factory patch resolves that provider to ours, and still defers every
    // other provider to mem0's own factory.
    expect(mocks.llmFactory.create('mna-anthropic', llm.config)).toBeInstanceOf(
      AnthropicMemoryLlm,
    );
    expect(mocks.llmFactory.create('openai', {})).toEqual({ builtinLlm: true });
  });

  it('honours MEM0_LLM_MODEL', async () => {
    process.env.MEM0_LLM_MODEL = 'claude-sonnet-5';

    await createUserMemory({ repository, userId: 'u1' });

    expect(lastConfig().llm.config.model).toBe('claude-sonnet-5');
  });

  it('disables mem0’s history store, which would write to an ephemeral disk', async () => {
    await createUserMemory({ repository, userId: 'u1' });
    expect(lastConfig().disableHistory).toBe(true);
  });

  it('tells mem0 to de-duplicate only, never to find memories of its own', async () => {
    // Its stock prompt is maximalist; everything reaching it has already been
    // through our own extraction, so the second pass must not re-mine.
    await createUserMemory({ repository, userId: 'u1' });

    const instructions = lastConfig().customInstructions as string;
    expect(instructions).toContain('only job is de-duplication');
    expect(instructions).toContain('Do not rephrase, expand, split or merge');
    expect(instructions).toContain('Never produce a memory that was not in the incoming');
  });

  it('patches mem0’s factory once, however many clients are built', async () => {
    await createUserMemory({ repository, userId: 'u1' });
    const patched = mocks.factory.create;
    await createUserMemory({ repository, userId: 'u2' });

    // A second patch would wrap the first; the reference stays the same.
    expect(mocks.factory.create).toBe(patched);
    expect(mocks.factory.create('qdrant', {})).toEqual({ builtin: true });
  });

  it('builds one Memory per call, bound to the user it was asked for', async () => {
    await createUserMemory({ repository, userId: 'u1' });
    await createUserMemory({ repository, userId: 'u2' });

    expect(mocks.MemoryCtor).toHaveBeenCalledTimes(2);
    expect(mocks.MemoryCtor.mock.calls[0][0].vectorStore.config.userId).toBe('u1');
    expect(mocks.MemoryCtor.mock.calls[1][0].vectorStore.config.userId).toBe('u2');
  });
});
