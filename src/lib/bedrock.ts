/**
 * Amazon Bedrock text embeddings (Titan Embed v2).
 *
 * Shared by the ingest Lambda (embedding article chunks) and the app
 * (embedding a search query) so both sides always use the same model and
 * dimension count — a mismatch would silently return garbage neighbours.
 *
 * IMPORTANT: Bedrock is NOT available in ap-southeast-3 (Jakarta), where the
 * pipeline Lambdas run, and Titan Embed v2 is NOT offered in the nearer
 * ap-southeast-1 (Singapore) either. The region therefore comes from
 * BEDROCK_REGION and defaults to ap-southeast-2 (Sydney), never from
 * AWS_REGION.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const DEFAULT_BEDROCK_REGION = 'ap-southeast-2';
/** Titan v2 accepts ~8k tokens; ~32k characters is a safe ceiling. */
const MAX_INPUT_CHARS = 32_000;

export interface BedrockEmbeddingOptions {
  /** Injected in tests; defaults to a real BedrockRuntimeClient. */
  send?: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }>;
  modelId?: string;
  region?: string;
}

export class BedrockEmbeddingClient {
  private readonly modelId: string;
  private readonly region: string;
  private readonly injectedSend?: BedrockEmbeddingOptions['send'];
  private client: BedrockRuntimeClient | null = null;

  constructor(opts: BedrockEmbeddingOptions = {}) {
    this.modelId = opts.modelId ?? process.env.BEDROCK_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.region = opts.region ?? process.env.BEDROCK_REGION ?? DEFAULT_BEDROCK_REGION;
    this.injectedSend = opts.send;
  }

  async embed(text: string): Promise<number[]> {
    const inputText = text.trim().slice(0, MAX_INPUT_CHARS);
    if (inputText.length === 0) throw new Error('cannot embed empty text');

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    });

    const response = await this.send(command);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new Error('bedrock returned a non-JSON embedding response');
    }

    const embedding = (parsed as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `bedrock returned ${Array.isArray(embedding) ? embedding.length : 'no'} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return embedding as number[];
  }

  /**
   * Sequential on purpose: Titan has no batch endpoint, and the caller already
   * bounds how many items reach here per run. Order matches the input.
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }

  private send(command: InvokeModelCommand): Promise<{ body: Uint8Array }> {
    if (this.injectedSend) return this.injectedSend(command);
    this.client ??= new BedrockRuntimeClient({ region: this.region });
    return this.client.send(command) as unknown as Promise<{ body: Uint8Array }>;
  }
}
