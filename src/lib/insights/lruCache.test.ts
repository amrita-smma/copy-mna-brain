import { describe, it, expect } from 'vitest';
import { createLruCache } from './lruCache';

describe('createLruCache', () => {
  it('returns the value that was set, and undefined for a key never set', () => {
    const cache = createLruCache(2);
    cache.set('a', '<p>a</p>');
    expect(cache.get('a')).toBe('<p>a</p>');
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once over capacity', () => {
    const cache = createLruCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('B');
    expect(cache.get('c')).toBe('C');
  });

  it('counts a get as a use, so a recently-read entry survives eviction', () => {
    const cache = createLruCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a'); // touch a, making b the least recently used
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
  });

  it('overwriting an existing key updates its value without growing size past capacity', () => {
    const cache = createLruCache(2);
    cache.set('a', 'A');
    cache.set('a', 'A2');
    cache.set('b', 'B');

    expect(cache.get('a')).toBe('A2');
    expect(cache.get('b')).toBe('B');
  });

  it('holds non-string values, including falsy ones, as hits', () => {
    const cache = createLruCache<{ n: number } | 0>(2);
    const obj = { n: 1 };
    cache.set('obj', obj);
    cache.set('zero', 0);

    expect(cache.get('obj')).toBe(obj);
    expect(cache.get('zero')).toBe(0);
  });
});
