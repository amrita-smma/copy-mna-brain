import { describe, it, expect } from 'vitest';
import { encodeSseEvent, encodeSseComment } from './sse';

describe('encodeSseEvent', () => {
  it('encodes a payload as a data: frame terminated by a blank line', () => {
    expect(encodeSseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('prefixes an event: line when an event name is given', () => {
    expect(encodeSseEvent([1, 2], 'update')).toBe('event: update\ndata: [1,2]\n\n');
  });
});

describe('encodeSseComment', () => {
  it('encodes a comment line ignored by EventSource', () => {
    expect(encodeSseComment('hb')).toBe(': hb\n\n');
  });
});
