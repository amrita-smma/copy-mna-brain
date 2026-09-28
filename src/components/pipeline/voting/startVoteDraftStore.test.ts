import { describe, it, expect, vi } from 'vitest';
import { ballotDraftKey, type DraftStorage } from './ballotDraftStore';
import {
  clearStartVoteDraft,
  hasStartVoteDraft,
  readStartVoteDraft,
  startVoteDraftKey,
  writeStartVoteDraft,
  type StoredStartVoteDraft,
} from './startVoteDraftStore';

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

/** A wizard launched from a completed round. */
const draft: StoredStartVoteDraft = {
  afterSessionId: 'vs-1',
  step: 'deadline',
  voterIds: ['u-1', 'u-2'],
  deadlineDay: '2026-09-30',
  deadlineTime: '17:30',
};

describe('startVoteDraftKey', () => {
  it('namespaces per company so two companies never share a wizard', () => {
    expect(startVoteDraftKey('c-1')).not.toBe(startVoteDraftKey('c-2'));
    expect(startVoteDraftKey('c-1')).toContain('c-1');
  });

  it('does not collide with the ballot draft for the same id', () => {
    expect(startVoteDraftKey('x')).not.toBe(ballotDraftKey('x'));
  });
});

describe('writeStartVoteDraft / readStartVoteDraft', () => {
  it('round-trips a wizard — the tab-switch case', () => {
    const storage = makeStorage();
    writeStartVoteDraft(storage, 'c-1', draft);

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toEqual(draft);
  });

  it('round-trips the voter step with no voters picked yet', () => {
    const storage = makeStorage();
    const early: StoredStartVoteDraft = {
      afterSessionId: 'vs-1',
      step: 'voters',
      voterIds: [],
      deadlineDay: '2026-09-30',
      deadlineTime: '09:00',
    };
    writeStartVoteDraft(storage, 'c-1', early);

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toEqual(early);
  });

  it('returns null when nothing is stored for the company', () => {
    expect(readStartVoteDraft(makeStorage(), 'c-1', 'vs-1')).toBeNull();
  });

  it('does not read another company’s wizard', () => {
    const storage = makeStorage();
    writeStartVoteDraft(storage, 'c-1', draft);

    expect(readStartVoteDraft(storage, 'c-2', 'vs-1')).toBeNull();
  });

  it('refuses a wizard launched from a different round', () => {
    const storage = makeStorage();
    writeStartVoteDraft(storage, 'c-1', draft);

    // The round moved on underneath the abandoned wizard.
    expect(readStartVoteDraft(storage, 'c-1', 'vs-2')).toBeNull();
    expect(readStartVoteDraft(storage, 'c-1', null)).toBeNull();
  });

  it('round-trips a wizard started when the company had no round at all', () => {
    const storage = makeStorage();
    const first: StoredStartVoteDraft = { ...draft, afterSessionId: null };
    writeStartVoteDraft(storage, 'c-1', first);

    expect(readStartVoteDraft(storage, 'c-1', null)).toEqual(first);
    // …and it must not survive the round it was about to create.
    expect(readStartVoteDraft(storage, 'c-1', 'vs-9')).toBeNull();
  });

  it('rejects a stored round id that is neither a string nor null', () => {
    const storage = makeStorage({
      [startVoteDraftKey('c-1')]: JSON.stringify({ ...draft, afterSessionId: 7 }),
    });

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', () => {
    const storage = makeStorage({ [startVoteDraftKey('c-1')]: 'not json' });

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
  });

  it('rejects a stored step the wizard cannot resume into', () => {
    const storage = makeStorage({
      [startVoteDraftKey('c-1')]: JSON.stringify({ ...draft, step: 'idle' }),
    });

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
  });

  it('rejects voter ids that are not a list of strings', () => {
    const storage = makeStorage({
      [startVoteDraftKey('c-1')]: JSON.stringify({ ...draft, voterIds: [1, 2] }),
    });

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
  });

  it('rejects a deadline day or time the picker could not have written', () => {
    const badDay = makeStorage({
      [startVoteDraftKey('c-1')]: JSON.stringify({ ...draft, deadlineDay: '30/09/2026' }),
    });
    const badTime = makeStorage({
      [startVoteDraftKey('c-2')]: JSON.stringify({ ...draft, deadlineTime: '5pm' }),
    });
    // A wizard written before the deadline picker replaced the days/hours one.
    const legacy = makeStorage({
      [startVoteDraftKey('c-3')]: JSON.stringify({
        afterSessionId: 'vs-1',
        step: 'voters',
        voterIds: ['u-1'],
        days: 2,
        hours: 0,
      }),
    });

    expect(readStartVoteDraft(badDay, 'c-1', 'vs-1')).toBeNull();
    expect(readStartVoteDraft(badTime, 'c-2', 'vs-1')).toBeNull();
    expect(readStartVoteDraft(legacy, 'c-3', 'vs-1')).toBeNull();
  });

  it('treats a null storage handle as persistence-off', () => {
    expect(readStartVoteDraft(null, 'c-1', 'vs-1')).toBeNull();
    expect(() => writeStartVoteDraft(null, 'c-1', draft)).not.toThrow();
    expect(() => clearStartVoteDraft(null, 'c-1')).not.toThrow();
  });

  it('swallows a storage that throws on read', () => {
    const storage: DraftStorage = {
      getItem: vi.fn(() => {
        throw new Error('denied');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
  });

  it('swallows a quota error on write so starting a round never breaks', () => {
    const storage: DraftStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
      removeItem: vi.fn(),
    };

    expect(() => writeStartVoteDraft(storage, 'c-1', draft)).not.toThrow();
  });
});

describe('clearStartVoteDraft', () => {
  it('removes only the targeted company’s wizard', () => {
    const storage = makeStorage();
    writeStartVoteDraft(storage, 'c-1', draft);
    writeStartVoteDraft(storage, 'c-2', { ...draft, voterIds: ['u-9'] });

    clearStartVoteDraft(storage, 'c-1');

    expect(readStartVoteDraft(storage, 'c-1', 'vs-1')).toBeNull();
    expect(readStartVoteDraft(storage, 'c-2', 'vs-1')).toEqual({
      ...draft,
      voterIds: ['u-9'],
    });
  });
});

describe('hasStartVoteDraft', () => {
  it('is false for a wizard belonging to another round', () => {
    const storage = makeStorage();
    writeStartVoteDraft(storage, 'c-1', draft);

    expect(hasStartVoteDraft(storage, 'c-1', 'vs-1')).toBe(true);
    expect(hasStartVoteDraft(storage, 'c-1', 'vs-2')).toBe(false);
  });

  it('is true only while a wizard is mid-flight', () => {
    const storage = makeStorage();
    expect(hasStartVoteDraft(storage, 'c-1', 'vs-1')).toBe(false);

    writeStartVoteDraft(storage, 'c-1', draft);
    expect(hasStartVoteDraft(storage, 'c-1', 'vs-1')).toBe(true);

    clearStartVoteDraft(storage, 'c-1');
    expect(hasStartVoteDraft(storage, 'c-1', 'vs-1')).toBe(false);
  });

  it('is false when persistence is off', () => {
    expect(hasStartVoteDraft(null, 'c-1', 'vs-1')).toBe(false);
  });
});
