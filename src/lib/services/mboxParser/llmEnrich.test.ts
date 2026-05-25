import { describe, it, expect } from 'vitest';

import type { Candidate } from './extract';
import {
  buildUserPrompt,
  mergePeopleWithCandidates,
  safeCustomId,
  type LlmPerson,
  type QueueEntry,
} from './llmEnrich';

function makeEntry(overrides: Partial<QueueEntry['payload']> = {}): QueueEntry {
  return {
    message_id: '<m@x>',
    subject: 'subj',
    sender_email: 'alice@external.com',
    domain_tag: null,
    payload: {
      body_snippet: '',
      candidates: [],
      want_topics: false,
      want_names: false,
      ...overrides,
    },
  };
}

describe('buildUserPrompt', () => {
  it('includes the names task only when want_names is true', () => {
    const out = buildUserPrompt(
      makeEntry({ want_names: true, candidates: [{ type: 'email', value: 'a@b.com', context: 'Alice' }] }),
    );
    expect(out).toContain('1. For each CANDIDATE below');
    expect(out).not.toContain('2. Extract 1-5 topic tags');
  });

  it('includes the topics task only when want_topics is true', () => {
    const out = buildUserPrompt(makeEntry({ want_topics: true, body_snippet: 'Body here.' }));
    expect(out).toContain('2. Extract 1-5 topic tags');
    expect(out).not.toContain('1. For each CANDIDATE');
  });

  it('emits CANDIDATES section in the correct format and order', () => {
    const cands: Candidate[] = [
      { type: 'email', value: 'a@b.com', context: 'Alice ctx' },
      { type: 'phone', value: '+62123', context: 'Alice ctx' },
    ];
    const out = buildUserPrompt(makeEntry({ want_names: true, candidates: cands }));
    expect(out).toContain('[0] EMAIL: a@b.com');
    expect(out).toContain('    CONTEXT: Alice ctx');
    expect(out).toContain('[1] PHONE: +62123');
    // CANDIDATES must appear before EMAIL BODY so the model attends to them first.
    const candIdx = out.indexOf('CANDIDATES:');
    const bodyIdx = out.indexOf('EMAIL BODY:');
    if (bodyIdx !== -1) expect(candIdx).toBeLessThan(bodyIdx);
  });

  it('omits the CANDIDATES section when want_names is true but the list is empty', () => {
    const out = buildUserPrompt(makeEntry({ want_names: true, candidates: [] }));
    expect(out).not.toContain('CANDIDATES:');
  });

  it('truncates body_snippet to 2000 chars for the topic task', () => {
    const big = 'x'.repeat(3000);
    const out = buildUserPrompt(makeEntry({ want_topics: true, body_snippet: big }));
    const bodyStart = out.indexOf('EMAIL BODY:\n');
    const bodyText = out.slice(bodyStart + 'EMAIL BODY:\n'.length);
    expect(bodyText.length).toBe(2000);
  });
});

describe('mergePeopleWithCandidates', () => {
  const candidates: Candidate[] = [
    { type: 'email', value: 'john@goldman.com', context: 'John Smith ...' },
    { type: 'phone', value: '+12125550100', context: 'John Smith ...' },
    { type: 'email', value: 'jen@startup.io', context: 'forwarded ...' },
  ];

  it('pairs email + phone candidates into one EnrichedPerson via candidate_indices', () => {
    const people: LlmPerson[] = [
      { name: 'John Smith', role: 'MD', company: 'Goldman', candidate_indices: [0, 1] },
    ];
    const out = mergePeopleWithCandidates(people, candidates);
    expect(out).toEqual([
      {
        name: 'John Smith',
        role: 'MD',
        company: 'Goldman',
        email: 'john@goldman.com',
        phone: '+12125550100',
      },
    ]);
  });

  it('drops people whose candidate_indices resolve to nothing (model hallucinations)', () => {
    const people: LlmPerson[] = [
      { name: 'Phantom', role: null, company: null, candidate_indices: [] },
      { name: 'Real', role: null, company: null, candidate_indices: [2] },
    ];
    const out = mergePeopleWithCandidates(people, candidates);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Real');
    expect(out[0].email).toBe('jen@startup.io');
  });

  it('ignores out-of-range candidate indices safely', () => {
    const people: LlmPerson[] = [
      { name: 'Bob', role: null, company: null, candidate_indices: [99, 0] },
    ];
    const out = mergePeopleWithCandidates(people, candidates);
    expect(out).toHaveLength(1);
    expect(out[0].email).toBe('john@goldman.com');
  });

  it('returns [] when LLM returned no people', () => {
    expect(mergePeopleWithCandidates([], candidates)).toEqual([]);
  });
});

describe('safeCustomId', () => {
  it('replaces non-alphanumeric chars with underscores', () => {
    expect(safeCustomId('<abc@example.com>')).toBe('_abc_example_com_');
  });

  it('passes through valid IDs unchanged', () => {
    expect(safeCustomId('valid-id_123')).toBe('valid-id_123');
  });

  it('hashes IDs that would exceed 64 chars after sanitization', () => {
    const long = 'a'.repeat(70);
    const out = safeCustomId(long);
    expect(out).toMatch(/^[a-f0-9]{32}$/);
  });

  it('hashes empty input to a deterministic placeholder', () => {
    const out = safeCustomId('');
    expect(out).toMatch(/^[a-f0-9]{32}$/);
    // Must be deterministic across calls so we can map back to a message_id.
    expect(safeCustomId('')).toBe(out);
  });
});
