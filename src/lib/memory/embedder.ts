/**
 * mem0's `Embedder` interface, over the app's own `BedrockEmbeddingClient`.
 *
 * mem0's `aws_bedrock` provider builds a new `BedrockRuntimeClient` per
 * `Memory`, and `Memory` is built per request — so every recall paid a fresh
 * SDK import, credential resolution and TLS handshake to the (cross-region)
 * Bedrock endpoint, all inside `RECALL_TIMEOUT_MS`. This one shares a single
 * client across the process, so a warm instance reuses its connection.
 *
 * `embedBatch` also runs in parallel (bounded) where mem0's runs four at a
 * time: recall embeds up to eight entities from the query for its entity
 * boost, and that was two more serial Bedrock round trips on the turn's
 * critical path.
 *
 * Same model, dimension and region as before (`@/lib/bedrock`), so stored
 * vectors stay comparable.
 */
import { BedrockEmbeddingClient } from '@/lib/bedrock';

/** The slice of `BedrockEmbeddingClient` this needs; injected in tests. */
export type TextEmbedder = Pick<BedrockEmbeddingClient, 'embed'>;

/**
 * How many embeds one `embedBatch` keeps in flight. Covers recall's eight
 * entities in one round; an import's larger batches stay under Bedrock's
 * per-second throttle.
 */
export const EMBED_BATCH_CONCURRENCY = 8;

let shared: BedrockEmbeddingClient | null = null;

/** One client per process: its connection and credentials outlive a request. */
function sharedClient(): BedrockEmbeddingClient {
  shared ??= new BedrockEmbeddingClient();
  return shared;
}

export class BedrockMemoryEmbedder {
  constructor(private readonly client: TextEmbedder = sharedClient()) {}

  embed(text: string): Promise<number[]> {
    return this.client.embed(text);
  }

  /** Order matches the input. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    let next = 0;
    const worker = async () => {
      while (next < texts.length) {
        const i = next++;
        out[i] = await this.client.embed(texts[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EMBED_BATCH_CONCURRENCY, texts.length) }, worker),
    );
    return out;
  }
}
