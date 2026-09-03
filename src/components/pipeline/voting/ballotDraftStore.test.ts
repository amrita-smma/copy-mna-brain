import { describe, it, expect, vi } from 'vitest';
import {
  ballotDraftKey,
  clearBallotDraft,
  initialBallotFields,
  readBallotDraft,
  writeBallotDraft,
  type DraftStorage,
} from './ballotDraftStore';

/** In-memory stand-in for `window.sessionStorage`. */
function makeStorage(seed: Record<string, string> = {}): DraftStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe('ballotDraftKey', () => {
  it('namespaces per voting round so two rounds never share a draft', () => {
    expect(ballotDraftKey('vs-1')).not.toBe(ballotDraftKey('vs-2'));
    expect(ballotDraftKey('vs-1')).toContain('vs-1');
  });
});

describe('writeBallotDraft / readBallotDraft', () => {
  it('round-trips a draft', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: 'hard_yes', bodyHtml: '<p>hi</p>' });

    expect(readBallotDraft(storage, 'vs-1')).toEqual({
      choice: 'hard_yes',
      bodyHtml: '<p>hi</p>',
    });
  });

  it('round-trips a rationale with no choice picked yet', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: null, bodyHtml: '<p>thinking</p>' });

    expect(readBallotDraft(storage, 'vs-1')).toEqual({
      choice: null,
      bodyHtml: '<p>thinking</p>',
    });
  });

  it('returns null when nothing is stored for the round', () => {
    expect(readBallotDraft(makeStorage(), 'vs-1')).toBeNull();
  });

  it('does not read another round’s draft', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: 'yes', bodyHtml: '<p>a</p>' });

    expect(readBallotDraft(storage, 'vs-2')).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', () => {
    const storage = makeStorage({ [ballotDraftKey('vs-1')]: 'not json' });

    expect(readBallotDraft(storage, 'vs-1')).toBeNull();
  });

  it('rejects a stored choice that is not a known vote option', () => {
    const storage = makeStorage({
      [ballotDraftKey('vs-1')]: JSON.stringify({ choice: 'maybe', bodyHtml: '<p>a</p>' }),
    });

    expect(readBallotDraft(storage, 'vs-1')).toBeNull();
  });

  it('rejects a stored body that is not a string', () => {
    const storage = makeStorage({
      [ballotDraftKey('vs-1')]: JSON.stringify({ choice: 'yes', bodyHtml: 42 }),
    });

    expect(readBallotDraft(storage, 'vs-1')).toBeNull();
  });

  it('treats a null storage handle as persistence-off', () => {
    expect(readBallotDraft(null, 'vs-1')).toBeNull();
    expect(() =>
      writeBallotDraft(null, 'vs-1', { choice: 'yes', bodyHtml: '' }),
    ).not.toThrow();
    expect(() => clearBallotDraft(null, 'vs-1')).not.toThrow();
  });

  it('swallows a storage that throws on read', () => {
    const storage: DraftStorage = {
      getItem: vi.fn(() => {
        throw new Error('denied');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(readBallotDraft(storage, 'vs-1')).toBeNull();
  });

  it('swallows a quota error on write so saving a vote never breaks', () => {
    const storage: DraftStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
      removeItem: vi.fn(),
    };

    expect(() =>
      writeBallotDraft(storage, 'vs-1', { choice: 'yes', bodyHtml: '<p>x</p>' }),
    ).not.toThrow();
  });
});

describe('clearBallotDraft', () => {
  it('removes only the targeted round’s draft', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: 'yes', bodyHtml: '<p>a</p>' });
    writeBallotDraft(storage, 'vs-2', { choice: 'no', bodyHtml: '<p>b</p>' });

    clearBallotDraft(storage, 'vs-1');

    expect(readBallotDraft(storage, 'vs-1')).toBeNull();
    expect(readBallotDraft(storage, 'vs-2')).toEqual({
      choice: 'no',
      bodyHtml: '<p>b</p>',
    });
  });
});

describe('initialBallotFields', () => {
  const savedDraft = {
    choice: 'yes' as const,
    bodyHtml: '<p>saved</p>',
    status: 'draft',
  };

  it('restores the unsaved draft when one exists — the tab-switch case', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: 'hard_no', bodyHtml: '<p>typing…</p>' });

    expect(initialBallotFields(storage, 'vs-1', savedDraft)).toEqual({
      choice: 'hard_no',
      bodyHtml: '<p>typing…</p>',
    });
  });

  it('falls back to the stored ballot when there is no local draft', () => {
    expect(initialBallotFields(makeStorage(), 'vs-1', savedDraft)).toEqual({
      choice: 'yes',
      bodyHtml: '<p>saved</p>',
    });
  });

  it('ignores a leftover draft once the ballot is submitted', () => {
    const storage = makeStorage();
    writeBallotDraft(storage, 'vs-1', { choice: 'hard_no', bodyHtml: '<p>stale</p>' });

    expect(
      initialBallotFields(storage, 'vs-1', { ...savedDraft, status: 'submitted' }),
    ).toEqual({ choice: 'yes', bodyHtml: '<p>saved</p>' });
  });

  it('normalizes a null stored body to an empty string', () => {
    expect(
      initialBallotFields(makeStorage(), 'vs-1', {
        choice: null,
        bodyHtml: null,
        status: 'draft',
      }),
    ).toEqual({ choice: null, bodyHtml: '' });
  });

  it('falls back to the stored ballot when persistence is off', () => {
    expect(initialBallotFields(null, 'vs-1', savedDraft)).toEqual({
      choice: 'yes',
      bodyHtml: '<p>saved</p>',
    });
  });
});
