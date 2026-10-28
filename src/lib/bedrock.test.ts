import { describe, it, expect, vi } from 'vitest';
import { BedrockEmbeddingClient, EMBEDDING_DIMENSIONS } from './bedrock';

function bedrockResponse(embedding: number[]) {
  return { body: new TextEncoder().encode(JSON.stringify({ embedding })) };
}

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

describe('BedrockEmbeddingClient.embed', () => {
  it('returns the embedding vector from the model response', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    expect(await client.embed('hello')).toEqual(vector);
  });

  it('asks Titan for the dimension count the schema expects', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    await client.embed('hello');

    const body = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(body).toEqual({ inputText: 'hello', dimensions: EMBEDDING_DIMENSIONS, normalize: true });
  });

  it('rejects an empty input rather than sending a useless call', async () => {
    const send = vi.fn();
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('   ')).rejects.toThrow('cannot embed empty text');
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the model returns a vector of the wrong width', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse([0.1, 0.2]));
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('hello')).rejects.toThrow(/expected 1024/);
  });

  it('throws a clear error when the response body is not valid JSON', async () => {
    const send = vi.fn().mockResolvedValue({ body: new TextEncoder().encode('not json') });
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('hello')).rejects.toThrow(/bedrock/i);
  });

  it('truncates input beyond the model token ceiling instead of erroring', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    await client.embed('x'.repeat(100_000));

    const body = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(body.inputText.length).toBeLessThanOrEqual(20_000);
  });

  it('shrinks and retries when Bedrock rejects the input for too many tokens', async () => {
    const tooMany = Object.assign(
      new Error(
        '400 Bad Request: Too many input tokens. Max input tokens: 8192, request input token count: 9246',
      ),
      { name: 'ValidationException' },
    );
    const send = vi.fn().mockRejectedValueOnce(tooMany).mockResolvedValueOnce(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    expect(await client.embed('x'.repeat(20_000))).toEqual(vector);

    expect(send).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(send.mock.calls[1][0].input.body as string).inputText as string;
    expect(retried.length).toBeLessThanOrEqual(Math.floor(20_000 * (8192 / 9246) * 0.9));
  });

  it('gives up after a bounded number of token-limit retries', async () => {
    const tooMany = new Error(
      'Too many input tokens. Max input tokens: 8192, request input token count: 8200',
    );
    const send = vi.fn().mockRejectedValue(tooMany);
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('x'.repeat(20_000))).rejects.toThrow(/Too many input tokens/);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not retry errors unrelated to the token limit', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('hello')).rejects.toThrow('AccessDeniedException');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('BedrockEmbeddingClient.embedMany', () => {
  it('embeds each text and preserves order', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(bedrockResponse(vector.map(() => 0.1)))
      .mockResolvedValueOnce(bedrockResponse(vector.map(() => 0.2)));
    const client = new BedrockEmbeddingClient({ send });

    const out = await client.embedMany(['a', 'b']);

    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0.1);
    expect(out[1][0]).toBe(0.2);
  });

  it('returns [] without calling the model for an empty list', async () => {
    const send = vi.fn();
    const client = new BedrockEmbeddingClient({ send });

    expect(await client.embedMany([])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
