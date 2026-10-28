import { describe, it, expect, vi } from 'vitest';
import {
  DISPATCH_CLAIM_MS,
  claimDispatch,
  dequeueMessage,
  enqueueMessage,
  parseQueue,
  queueStorageKey,
  readQueue,
  removeQueuedMessage,
  writeQueue,
  type QueuedMessage,
} from './messageQueue';

const msg = (id: string, text = `text ${id}`): QueuedMessage => ({ id, text, queuedAt: 1 });

describe('queueStorageKey', () => {
  it('keeps one queue per bot', () => {
    expect(queueStorageKey('bot-1')).not.toBe(queueStorageKey('bot-2'));
  });

  it('shares one key when no bot is active yet', () => {
    expect(queueStorageKey(null)).toBe(queueStorageKey(undefined));
  });
});

describe('parseQueue', () => {
  it('returns [] for missing or non-JSON input', () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue('{not json')).toEqual([]);
    expect(parseQueue('{"id":"a"}')).toEqual([]);
  });

  it('drops malformed entries and keeps valid ones in order', () => {
    const raw = JSON.stringify([
      msg('a'),
      { id: 'b' },
      { id: 'c', text: '   ' },
      'nope',
      { ...msg('d'), insightTemplate: { id: 't1', name: 'Memo' } },
    ]);
    expect(parseQueue(raw)).toEqual([msg('a'), { ...msg('d'), insightTemplate: { id: 't1', name: 'Memo' } }]);
  });

  it('drops a malformed insight template but keeps the message', () => {
    const raw = JSON.stringify([{ ...msg('a'), insightTemplate: { id: 1 } }]);
    expect(parseQueue(raw)).toEqual([msg('a')]);
  });
});

describe('readQueue / writeQueue', () => {
  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    writeQueue(storage, 'k', [msg('a'), msg('b')]);
    expect(readQueue(storage, 'k')).toEqual([msg('a'), msg('b')]);
  });

  it('removes the key when the queue empties', () => {
    const removeItem = vi.fn();
    const setItem = vi.fn();
    writeQueue({ setItem, removeItem }, 'k', []);
    expect(removeItem).toHaveBeenCalledWith('k');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('swallows storage errors', () => {
    const throwing = () => {
      throw new Error('denied');
    };
    expect(readQueue({ getItem: throwing }, 'k')).toEqual([]);
    expect(() => writeQueue({ setItem: throwing, removeItem: throwing }, 'k', [msg('a')])).not.toThrow();
  });

  it('is a no-op without storage', () => {
    expect(readQueue(null, 'k')).toEqual([]);
    expect(() => writeQueue(null, 'k', [msg('a')])).not.toThrow();
  });
});

describe('enqueueMessage / removeQueuedMessage / dequeueMessage', () => {
  it('appends to the end and sends oldest first', () => {
    const queue = enqueueMessage(enqueueMessage([], msg('a')), msg('b'));
    expect(dequeueMessage(queue)).toEqual({ next: msg('a'), rest: [msg('b')] });
  });

  it('returns null when there is nothing to send', () => {
    expect(dequeueMessage([])).toBeNull();
  });

  it('deletes only the matching message', () => {
    expect(removeQueuedMessage([msg('a'), msg('b'), msg('c')], 'b')).toEqual([msg('a'), msg('c')]);
  });
});

describe('claimDispatch', () => {
  const memoryStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  };

  it('lets the first tab claim and blocks a second tab inside the window', () => {
    const storage = memoryStorage();
    expect(claimDispatch(storage, 'k', 'tab-a', 1000)).toBe(true);
    expect(claimDispatch(storage, 'k', 'tab-b', 1000 + DISPATCH_CLAIM_MS - 1)).toBe(false);
  });

  it('lets the same tab claim again', () => {
    const storage = memoryStorage();
    claimDispatch(storage, 'k', 'tab-a', 1000);
    expect(claimDispatch(storage, 'k', 'tab-a', 1001)).toBe(true);
  });

  it('lets another tab claim once the window has passed', () => {
    const storage = memoryStorage();
    claimDispatch(storage, 'k', 'tab-a', 1000);
    expect(claimDispatch(storage, 'k', 'tab-b', 1000 + DISPATCH_CLAIM_MS)).toBe(true);
  });

  it('claims when storage is missing or broken', () => {
    expect(claimDispatch(null, 'k', 'tab-a', 0)).toBe(true);
    const broken = {
      getItem: () => '{bad json',
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(claimDispatch(broken, 'k', 'tab-a', 0)).toBe(true);
  });
});
