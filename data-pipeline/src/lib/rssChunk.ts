/**
 * Split an article into overlapping, embeddable chunks.
 *
 * Character-based rather than token-based: no tokenizer dependency, and at
 * ~4 chars/token 4800 chars ≈ 1200 tokens, which is the target chunk size
 * from the design. The title is prefixed to every chunk so a mid-article
 * chunk still carries the subject when it comes back from a vector search.
 */
export const CHUNK_CHARS = 4800;
export const CHUNK_OVERLAP_CHARS = 600;
/** Ceiling per article, so a pathological page can't dominate the index. */
export const MAX_CHUNKS = 40;

export interface ChunkOptions {
  chunkChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

export function chunkArticle(title: string, body: string, opts: ChunkOptions = {}): string[] {
  const chunkChars = opts.chunkChars ?? CHUNK_CHARS;
  const overlap = Math.min(opts.overlapChars ?? CHUNK_OVERLAP_CHARS, chunkChars - 1);
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;

  const cleanTitle = title.trim();
  const cleanBody = body.trim();

  if (cleanBody.length === 0) return cleanTitle.length > 0 ? [cleanTitle] : [];

  const prefix = cleanTitle.length > 0 ? `${cleanTitle}\n\n` : '';
  const room = Math.max(1, chunkChars - prefix.length);

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < cleanBody.length && chunks.length < maxChunks) {
    const end = Math.min(cursor + room, cleanBody.length);
    const isLast = end >= cleanBody.length;
    // Prefer a whitespace boundary so chunks don't split mid-word, but only
    // when one exists reasonably close to the target end. The final slice
    // is taken whole — no boundary search needed since there's nothing
    // after it to hand off to.
    const slice = cleanBody.slice(cursor, end);
    const boundary = !isLast ? slice.lastIndexOf(' ', room) : slice.length;
    const cut = boundary > room * 0.6 ? boundary : slice.length;

    const text = `${prefix}${slice.slice(0, cut)}`.trim();
    if (text.length > 0) chunks.push(text);

    // Once a slice reaches the end of the body there is no remainder left
    // to overlap into — advancing by cut - overlap here would under-advance
    // (or go negative) and loop forever in tiny increments. Stop instead.
    if (isLast) break;

    const advance = Math.max(1, cut - overlap);
    cursor += advance;
  }

  return chunks;
}
