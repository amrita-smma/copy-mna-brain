import { describe, it, expect, vi } from 'vitest';
import { BedrockMemoryEmbedder, EMBED_BATCH_CONCURRENCY } from './embedder';

/** A client double whose embeds settle only when the test says so. */
function deferredClient() {
  const pending: { text: string; resolve: (v: number[]) => void }[] = [];
  const embed = vi.fn(
    (text: string) => new Promise<number[]>((resolve) => pending.push({ text, resolve })),
  );
  return { client: { embed }, pending };
}

describe('BedrockMemoryEmbedder.embed', () => {
  it('delegates to the shared Bedrock client', async () => {
    const embed = vi.fn(async () => [0.1, 0.2]);
    const embedder = new BedrockMemoryEmbedder({ embed });

    await expect(embedder.embed('hello')).resolves.toEqual([0.1, 0.2]);
    expect(embed).toHaveBeenCalledWith('hello');
  });
});

describe('BedrockMemoryEmbedder.embedBatch', () => {
  it('returns [] without calling Bedrock for an empty batch', async () => {
    const embed = vi.fn();
    await expect(new BedrockMemoryEmbedder({ embed }).embedBatch([])).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('embeds a recall-sized batch in one parallel round, in input order', async () => {
    const { client, pending } = deferredClient();
    const texts = Array.from({ length: EMBED_BATCH_CONCURRENCY }, (_, i) => `entity-${i}`);
    const result = new BedrockMemoryEmbedder(client).embedBatch(texts);

    await Promise.resolve();
    // Every embed is in flight before any has answered.
    expect(client.embed).toHaveBeenCalledTimes(texts.length);

    // Settle out of order; the output still follows the input.
    [...pending].reverse().forEach((p) => p.resolve([Number(p.text.split('-')[1])]));
    await expect(result).resolves.toEqual(texts.map((_, i) => [i]));
  });

  it('keeps at most EMBED_BATCH_CONCURRENCY embeds in flight on a large batch', async () => {
    const { client, pending } = deferredClient();
    const texts = Array.from({ length: EMBED_BATCH_CONCURRENCY + 3 }, (_, i) => `t${i}`);
    const result = new BedrockMemoryEmbedder(client).embedBatch(texts);

    await Promise.resolve();
    expect(client.embed).toHaveBeenCalledTimes(EMBED_BATCH_CONCURRENCY);

    // Each answer frees a slot for the next text.
    for (let i = 0; i < texts.length; i++) {
      pending[i].resolve([i]);
      await Promise.resolve();
      await Promise.resolve();
    }
    await expect(result).resolves.toEqual(texts.map((_, i) => [i]));
    expect(client.embed).toHaveBeenCalledTimes(texts.length);
  });

  it('rejects when any embed fails, as mem0 expects', async () => {
    const embed = vi.fn(async (t: string) => {
      if (t === 'bad') throw new Error('throttled');
      return [1];
    });
    await expect(new BedrockMemoryEmbedder({ embed }).embedBatch(['ok', 'bad'])).rejects.toThrow(
      'throttled',
    );
  });
});
