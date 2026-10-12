import { describe, it, expect } from 'vitest';
import { describeMemoryFailure } from './failures';

describe('describeMemoryFailure', () => {
  it('names a missing memories table, which retrying cannot fix', () => {
    const failure = describeMemoryFailure(
      new Error('relation "user_memories" does not exist'),
    );

    expect(failure.permanent).toBe(true);
    expect(failure.status).toBe(503);
    expect(failure.message).toContain('pending migrations');
  });

  it('recognises the bare Postgres code too', () => {
    expect(describeMemoryFailure({ code: '42P01' }).permanent).toBe(true);
  });

  it('names a missing pgvector extension', () => {
    const failure = describeMemoryFailure(new Error('type "vector" does not exist'));

    expect(failure.permanent).toBe(true);
    expect(failure.message).toContain('pgvector');
  });

  it('names unreachable embeddings, the likeliest cause of a failed save', () => {
    // `memoryConfigured()` checks only the kill-switch and the Anthropic key, so
    // a deployment with no AWS credentials extracts fine and fails on save.
    for (const err of [
      new Error('Could not load credentials from any providers'),
      new Error('UnrecognizedClientException: The security token included is invalid'),
      new Error('AccessDeniedException'),
    ]) {
      const failure = describeMemoryFailure(err);
      expect(failure.permanent, err.message).toBe(true);
      expect(failure.message).toContain('embedding service');
    }
  });

  it('follows the cause chain, since SDK errors wrap the real one', () => {
    const wrapped = new Error('Insert failed', {
      cause: new Error('could not load credentials'),
    });

    expect(describeMemoryFailure(wrapped).permanent).toBe(true);
  });

  it('names a rejected sampling parameter, which retrying cannot fix', () => {
    // The exact 400 that broke both halves of memory on the 5.5 models.
    const failure = describeMemoryFailure(
      new Error('400 `temperature` is deprecated for this model.'),
    );

    expect(failure.permanent).toBe(true);
    expect(failure.message).not.toContain('try again');
    expect(failure.message).not.toContain('temperature');
  });

  it('treats provider overload as worth retrying', () => {
    const failure = describeMemoryFailure(new Error('529 overloaded_error'));

    expect(failure.permanent).toBe(false);
    expect(failure.message).toContain('try again');
  });

  it('defaults to transient for anything unrecognised', () => {
    // Telling someone their deployment is broken when it was a blip is the
    // worse of the two errors.
    const failure = describeMemoryFailure(new Error('something odd'));

    expect(failure.permanent).toBe(false);
    expect(failure.status).toBe(500);
  });

  it('never echoes the provider’s own text back to the user', () => {
    const failure = describeMemoryFailure(
      new Error('AccessDeniedException at https://bedrock-runtime.ap-southeast-2.amazonaws.com'),
    );

    expect(failure.message).not.toContain('amazonaws.com');
    expect(failure.message).not.toContain('AccessDenied');
  });

  it('survives a non-Error being thrown', () => {
    expect(describeMemoryFailure('boom').permanent).toBe(false);
    expect(describeMemoryFailure(null).permanent).toBe(false);
    expect(describeMemoryFailure(undefined).status).toBe(500);
  });
});
