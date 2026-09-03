import { describe, it, expect } from 'vitest';
import { chunkArticle, CHUNK_CHARS, CHUNK_OVERLAP_CHARS } from './rssChunk';

describe('chunkArticle', () => {
  it('returns a single chunk for a short article', () => {
    const chunks = chunkArticle('Acme raises $40m', 'A short body.');
    expect(chunks).toHaveLength(1);
  });

  it('prefixes every chunk with the title so each is independently retrievable', () => {
    const chunks = chunkArticle('Acme raises $40m', 'word '.repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.startsWith('Acme raises $40m'))).toBe(true);
  });

  it('splits long bodies into multiple chunks', () => {
    const chunks = chunkArticle('T', 'x'.repeat(CHUNK_CHARS * 3));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('overlaps consecutive chunks so a sentence on a boundary is not lost', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkArticle('T', body);
    const firstTail = chunks[0].slice(-CHUNK_OVERLAP_CHARS / 2);
    expect(chunks[1]).toContain(firstTail.trim().split(' ').slice(-3).join(' '));
  });

  it('falls back to the title alone when the body is empty', () => {
    expect(chunkArticle('Only a title', '')).toEqual(['Only a title']);
  });

  it('returns [] when there is neither title nor body', () => {
    expect(chunkArticle('', '')).toEqual([]);
  });

  it('never emits a blank chunk', () => {
    const chunks = chunkArticle('T', '\n\n\n   \n\n');
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it('caps the number of chunks so one enormous page cannot flood the index', () => {
    const chunks = chunkArticle('T', 'x'.repeat(CHUNK_CHARS * 100));
    expect(chunks.length).toBeLessThanOrEqual(40);
  });
});
