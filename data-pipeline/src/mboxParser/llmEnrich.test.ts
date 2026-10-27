import { describe, it, expect } from 'vitest';

import type { Candidate } from './extract';
import {
  buildUserPrompt,
  buildNoteOnlyPrompt,
  mergePeopleWithCandidates,
  safeCustomId,
  sanitizeEmailNote,
  repairToolInput,
  externalAddresses,
  dropThreadOnlyCompanies,
  EMAIL_EXTRACTION_SCHEMA,
  EMAIL_NOTE_SCHEMA,
  DEAL_NOTE_RUBRIC,
  SYSTEM_PROMPT,
  type LlmPerson,
  type QueueEntry,
} from './llmEnrich';

function makeEntry(overrides: Partial<QueueEntry['payload']> = {}): QueueEntry {
  return {
    message_id: '<m@x>',
    subject: 'subj',
    sender_email: 'alice@external.com',
    domain_tag: null,
    participants: [{ role: 'from', address: 'alice@external.com' }],
    payload: {
      body_snippet: '',
      candidates: [],
      want_topics: false,
      want_names: false,
      want_related_companies: false,
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
    expect(out).toContain('2. Extract 0-5 business-substance topic tags');
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
        specialization: null,
        coverage_region: null,
        email: 'john@goldman.com',
        phone: '+12125550100',
      },
    ]);
  });

  it('carries the stated focus and drops blank or sentence-length values', () => {
    const people: LlmPerson[] = [
      {
        name: 'John Smith',
        role: 'MD, Industrials Group',
        company: 'Goldman',
        specialization: '  Industrials ',
        coverage_region: 'Southeast Asia',
        candidate_indices: [0],
      },
      {
        name: 'Jen',
        role: null,
        company: null,
        specialization: '   ',
        coverage_region: 'x'.repeat(121),
        candidate_indices: [2],
      },
    ];
    const out = mergePeopleWithCandidates(people, candidates);
    expect(out[0]).toMatchObject({ specialization: 'Industrials', coverage_region: 'Southeast Asia' });
    expect(out[1]).toMatchObject({ specialization: null, coverage_region: null });
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

describe('buildUserPrompt related_companies', () => {
  it('includes related companies task when want_related_companies is true', () => {
    const out = buildUserPrompt(
      makeEntry({ want_related_companies: true, body_snippet: 'We represent TechSlurry.' }),
    );
    expect(out).toContain('3. Extract related target/opportunity companies');
  });

  it('includes SUBJECT section when want_related_companies is true', () => {
    const entry = makeEntry({ want_related_companies: true, body_snippet: 'body' });
    entry.subject = 'TechSlurry acquisition opportunity';
    const out = buildUserPrompt(entry);
    expect(out).toContain('SUBJECT:\nTechSlurry acquisition opportunity');
  });

  it('includes EMAIL BODY when want_related_companies is true even if want_topics is false', () => {
    const out = buildUserPrompt(
      makeEntry({ want_related_companies: true, want_topics: false, body_snippet: 'deal body text' }),
    );
    expect(out).toContain('EMAIL BODY:\ndeal body text');
  });

  it('does not include related companies task when flag is false', () => {
    const out = buildUserPrompt(makeEntry({ want_related_companies: false }));
    expect(out).not.toContain('related target');
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

describe('EMAIL_EXTRACTION_SCHEMA privacy', () => {
  it('does not require matched_text on related_companies', () => {
    const related = EMAIL_EXTRACTION_SCHEMA.properties.related_companies.items;
    expect(related.required).not.toContain('matched_text');
    expect(related.properties).not.toHaveProperty('matched_text');
  });
});

describe('buildUserPrompt with participants and notes', () => {
  it('includes PARTICIPANTS with correct internal/external tags', () => {
    const entry = makeEntry({
      want_topics: false,
      want_names: false,
      want_related_companies: false,
      body_snippet: 'Business content here',
    });
    entry.sender_email = 'alice@starcapital.co.id';
    entry.participants = [
      { role: 'from', address: 'alice@starcapital.co.id' },
      { role: 'to', address: 'bob@advisory.com' },
      { role: 'cc', address: 'charlie@external.com' },
    ];
    const out = buildUserPrompt(entry);
    expect(out).toContain(
      'PARTICIPANTS:\nFROM: alice@starcapital.co.id [internal]\nTO: bob@advisory.com [external]\nCC: charlie@external.com [external]',
    );
  });

  it('includes SUBJECT + EMAIL BODY when only a note is wanted (topics and related companies not wanted)', () => {
    const entry = makeEntry({
      want_topics: false,
      want_names: false,
      want_related_companies: false,
      body_snippet: 'Discussing the acquisition terms and valuation.',
    });
    entry.subject = 'Project Falcon Discussion';
    const out = buildUserPrompt(entry);
    expect(out).toContain('SUBJECT:\nProject Falcon Discussion');
    expect(out).toContain(
      'EMAIL BODY:\nDiscussing the acquisition terms and valuation.',
    );
  });
});

describe('buildNoteOnlyPrompt', () => {
  it('includes TASK, PARTICIPANTS, SUBJECT, and EMAIL BODY', () => {
    const entry = makeEntry({
      body_snippet: 'Note body text here',
    });
    entry.subject = 'Note subject';
    entry.participants = [{ role: 'from', address: 'banker@external.com' }];
    const out = buildNoteOnlyPrompt(entry);
    expect(out).toContain('TASK:');
    expect(out).toContain('PARTICIPANTS:\nFROM: banker@external.com [external]');
    expect(out).toContain('SUBJECT:\nNote subject');
    expect(out).toContain('EMAIL BODY:\nNote body text here');
  });
});

describe('EARLIER IN THREAD section', () => {
  const thread = 'On Mon Alice wrote:\nOption 2: 60% stake with an earn-out.';

  it('follows the body in the full prompt when a note is wanted', () => {
    const out = buildUserPrompt(
      makeEntry({ body_snippet: 'Agreed, go with option 2.', thread_context: thread }),
    );
    expect(out).toContain('EMAIL BODY:\nAgreed, go with option 2.');
    expect(out).toContain(`(context for the note only; extract nothing else from it):\n${thread}`);
    expect(out.indexOf('EMAIL BODY:')).toBeLessThan(out.indexOf('EARLIER IN THREAD'));
  });

  it('is in the note-only backfill prompt too', () => {
    const out = buildNoteOnlyPrompt(makeEntry({ body_snippet: 'Agreed.', thread_context: thread }));
    expect(out).toContain('EARLIER IN THREAD');
  });

  it('is left out when the email quotes nothing or there is no note to write', () => {
    expect(buildUserPrompt(makeEntry({ body_snippet: 'Hi', thread_context: '  ' }))).not.toContain(
      'EARLIER IN THREAD',
    );
    expect(
      buildUserPrompt(makeEntry({ body_snippet: '', want_names: true, thread_context: thread })),
    ).not.toContain('EARLIER IN THREAD');
  });
});

describe('dropThreadOnlyCompanies', () => {
  const company = (company_name: string) => ({
    company_name,
    reason: 'explicit_pitch' as const,
    reason_summary: 'Being sold.',
    keywords: [],
    confidence: 'high' as const,
  });
  const extraction = (...names: string[]) => ({ related_companies: names.map(company) });

  it('drops a company named only in the quoted thread', () => {
    const entry = makeEntry({
      body_snippet: "Agreed, let's go with option 2.",
      thread_context: 'On Mon Rina wrote:\nWe are selling PT Contoh Logistik.',
    });
    expect(dropThreadOnlyCompanies(extraction('PT Contoh Logistik'), entry)!.related_companies).toEqual(
      [],
    );
  });

  it('keeps a company the email itself names, ignoring legal forms and case', () => {
    const entry = makeEntry({
      body_snippet: 'Happy to look at contoh logistik further.',
      thread_context: 'On Mon Rina wrote:\nWe are selling PT Contoh Logistik Tbk.',
    });
    entry.subject = 'Re: Orchid';
    const out = dropThreadOnlyCompanies(extraction('PT Contoh Logistik Tbk', 'Other Co'), entry)!;
    expect(out.related_companies!.map((c) => c.company_name)).toEqual(['PT Contoh Logistik Tbk']);
  });

  it('matches a name in the subject', () => {
    const entry = makeEntry({ body_snippet: 'See below.', thread_context: 'On Mon X wrote:\nhi' });
    entry.subject = 'Re: Nusantara Foods teaser';
    expect(
      dropThreadOnlyCompanies(extraction('Nusantara Foods'), entry)!.related_companies,
    ).toHaveLength(1);
  });

  it('leaves an email that quotes nothing unchanged', () => {
    const input = extraction('PT Contoh Logistik');
    expect(dropThreadOnlyCompanies(input, makeEntry({ body_snippet: 'Unrelated text.' }))).toBe(input);
    expect(dropThreadOnlyCompanies(null, makeEntry())).toBeNull();
  });
});

describe('sanitizeEmailNote', () => {
  const externalAddrs = new Set(['bob@advisor.com', 'claire@law.com']);

  it('keeps the due_diligence, principal and other labels and drops an invented one', () => {
    const role = (label: string, address = 'bob@advisor.com') => ({
      address,
      label,
      confidence: 'medium',
      evidence: 'Paraphrased reason.',
    });
    const sanitized = sanitizeEmailNote(
      {
        summary: 'Summary',
        key_points: [],
        next_step: null,
        next_step_status: 'none',
        sentiment: 'neutral',
        counterparty_roles: [
          role('due_diligence'),
          role('principal', 'claire@law.com'),
          role('other'),
          role('insurance'),
        ],
      },
      externalAddrs,
    );
    expect(sanitized!.counterparty_roles.map((r) => r.label).sort()).toEqual([
      'due_diligence',
      'other',
      'principal',
    ]);
  });

  it('drops internal/unknown-address roles', () => {
    const note = {
      summary: 'Summary text',
      key_points: ['Point 1'],
      next_step: 'Follow up',
      next_step_status: 'action',
      sentiment: 'positive',
      counterparty_roles: [
        {
          address: 'internal@starcapital.co.id',
          label: 'advisory',
          confidence: 'high',
          evidence: 'Internal colleague.',
        },
        {
          address: 'unknown@stranger.com',
          label: 'funding',
          confidence: 'medium',
          evidence: 'Not in participants.',
        },
        {
          address: 'BOB@ADVISOR.COM',
          label: 'advisory',
          confidence: 'high',
          evidence: 'M&A sell-side advisor.',
        },
      ],
    };
    const sanitized = sanitizeEmailNote(note, externalAddrs);
    expect(sanitized).not.toBeNull();
    expect(sanitized!.counterparty_roles).toHaveLength(1);
    expect(sanitized!.counterparty_roles[0]).toEqual({
      address: 'bob@advisor.com',
      label: 'advisory',
      confidence: 'high',
      evidence: 'M&A sell-side advisor.',
    });
  });

  it('dedupes keeping the highest confidence', () => {
    const note = {
      summary: 'Summary',
      key_points: [],
      next_step: null,
      next_step_status: 'none',
      sentiment: 'neutral',
      counterparty_roles: [
        {
          address: 'bob@advisor.com',
          label: 'advisory',
          confidence: 'low',
          evidence: 'Possible advisory role.',
        },
        {
          address: 'bob@advisor.com',
          label: 'advisory',
          confidence: 'high',
          evidence: 'Confirmed advisory lead.',
        },
        {
          address: 'bob@advisor.com',
          label: 'advisory',
          confidence: 'medium',
          evidence: 'Advisor mentioned again.',
        },
      ],
    };
    const sanitized = sanitizeEmailNote(note, externalAddrs);
    expect(sanitized!.counterparty_roles).toHaveLength(1);
    expect(sanitized!.counterparty_roles[0].confidence).toBe('high');
    expect(sanitized!.counterparty_roles[0].evidence).toBe(
      'Confirmed advisory lead.',
    );
  });

  it('caps key points at 4', () => {
    const note = {
      summary: 'Summary',
      key_points: ['1', '2', '3', '4', '5', '6'],
      next_step: null,
      next_step_status: 'none',
      sentiment: 'neutral',
      counterparty_roles: [],
    };
    const sanitized = sanitizeEmailNote(note, externalAddrs);
    expect(sanitized!.key_points).toEqual(['1', '2', '3', '4']);
  });

  it('coerces bad enums to defaults', () => {
    const note = {
      summary: '  Spaced summary  ',
      key_points: ['  Spaced point  '],
      next_step: '  Spaced step  ',
      next_step_status: 'invalid_status',
      sentiment: 'super_happy',
      counterparty_roles: [],
    };
    const sanitized = sanitizeEmailNote(note, externalAddrs);
    expect(sanitized!.summary).toBe('Spaced summary');
    expect(sanitized!.key_points).toEqual(['Spaced point']);
    expect(sanitized!.next_step).toBe('Spaced step');
    expect(sanitized!.next_step_status).toBe('none');
    expect(sanitized!.sentiment).toBe('neutral');
  });

  it('drops the next step of an email with no business summary', () => {
    const sanitized = sanitizeEmailNote(
      {
        summary: '   ',
        key_points: [],
        next_step: 'Confirm the Tuesday call',
        next_step_status: 'action',
        sentiment: 'neutral',
        counterparty_roles: [],
      },
      externalAddrs,
    );
    expect(sanitized).toMatchObject({
      summary: null,
      next_step: null,
      next_step_status: 'none',
    });
  });

  it('blanks the note of an email the model judged not deal-related', () => {
    const sanitized = sanitizeEmailNote(
      {
        is_deal_related: false,
        summary: 'Team agreed to meet at the office on Thursday.',
        key_points: ['Meeting moved to Thursday'],
        next_step: 'Book the meeting room',
        next_step_status: 'action',
        sentiment: 'positive',
        counterparty_roles: [],
      },
      externalAddrs,
    );
    expect(sanitized).toMatchObject({
      summary: null,
      key_points: [],
      next_step: null,
      next_step_status: 'none',
    });
  });

  it('keeps the note of a deal-related email', () => {
    const sanitized = sanitizeEmailNote(
      {
        is_deal_related: true,
        summary: 'Banker shared the teaser for Project Titan.',
        key_points: ['Bids due end of month'],
        next_step: 'Sign the NDA',
        next_step_status: 'action',
        sentiment: 'positive',
        counterparty_roles: [],
      },
      externalAddrs,
    );
    expect(sanitized).toMatchObject({
      summary: 'Banker shared the teaser for Project Titan.',
      key_points: ['Bids due end of month'],
      next_step: 'Sign the NDA',
      next_step_status: 'action',
    });
  });

  it('keeps the note when the deal flag is missing rather than erasing it', () => {
    const sanitized = sanitizeEmailNote(
      {
        summary: 'Seller lowered the asking price.',
        key_points: [],
        next_step: null,
        next_step_status: 'none',
        sentiment: 'neutral',
        counterparty_roles: [],
      },
      externalAddrs,
    );
    expect(sanitized!.summary).toBe('Seller lowered the asking price.');
  });

  it('keeps counterparty roles on a non-deal note', () => {
    const sanitized = sanitizeEmailNote(
      {
        is_deal_related: false,
        summary: null,
        key_points: [],
        next_step: null,
        next_step_status: 'none',
        sentiment: 'neutral',
        counterparty_roles: [
          { address: 'claire@law.com', label: 'legal', confidence: 'high', evidence: 'Sent the firm invoice.' },
        ],
      },
      externalAddrs,
    );
    expect(sanitized!.counterparty_roles).toHaveLength(1);
  });

  it('puts the deal rubric into the extraction prompt and requires the flag', () => {
    expect(SYSTEM_PROMPT).toContain(DEAL_NOTE_RUBRIC);
    expect(EMAIL_NOTE_SCHEMA.properties.email_note.required).toContain('is_deal_related');
  });

  it('returns null on garbage input', () => {
    expect(sanitizeEmailNote(null, externalAddrs)).toBeNull();
    expect(sanitizeEmailNote(undefined, externalAddrs)).toBeNull();
    expect(sanitizeEmailNote('string', externalAddrs)).toBeNull();
    expect(sanitizeEmailNote(123, externalAddrs)).toBeNull();
    expect(sanitizeEmailNote([], externalAddrs)).toBeNull();
  });
});

describe('repairToolInput', () => {
  const note = {
    summary: 'Comments on the term sheet will follow.',
    key_points: [],
    next_step: 'Send term sheet comments',
    next_step_status: 'action',
    sentiment: 'neutral',
    counterparty_roles: [],
  };

  it('recovers the rest of the input the model spilled into the note string', () => {
    // Seen live from claude-haiku-5-5: the note, then the remaining fields.
    const spilled =
      JSON.stringify(note) +
      ', "is_personal": false, "topics": [{"name": "term-sheet", "is_deal_related": true}], "people": [], "related_companies": []}';
    const repaired = repairToolInput({ email_note: spilled }) as Record<string, unknown>;
    expect(repaired.email_note).toEqual(note);
    expect(repaired.is_personal).toBe(false);
    expect(repaired.topics).toEqual([{ name: 'term-sheet', is_deal_related: true }]);
  });

  it('parses a note that is only JSON-encoded, keeping the other fields', () => {
    const repaired = repairToolInput({ email_note: JSON.stringify(note), is_personal: true });
    expect(repaired).toEqual({ email_note: note, is_personal: true });
  });

  it('drops a stray quote the model left after the note object', () => {
    // Seen live from claude-haiku-5-5 (2026-10-21): `{note}"`.
    const repaired = repairToolInput({ email_note: `${JSON.stringify(note)}"`, is_personal: false });
    expect(repaired).toEqual({ email_note: note, is_personal: false });
  });

  it('recovers the spilled rest of the input after a stray quote', () => {
    // Seen live from claude-haiku-5-5 (2026-10-21): `{note}", "is_personal": …}`.
    const spilled =
      JSON.stringify(note) +
      '", "is_personal": false, "topics": [{"name": "account-opening", "is_deal_related": false}], "people": [], "related_companies": []}';
    const repaired = repairToolInput({ email_note: spilled }) as Record<string, unknown>;
    expect(repaired.email_note).toEqual(note);
    expect(repaired.is_personal).toBe(false);
    expect(repaired.topics).toEqual([{ name: 'account-opening', is_deal_related: false }]);
  });

  it('keeps the note when the spill after it is unreadable', () => {
    const repaired = repairToolInput({ email_note: `${JSON.stringify(note)}", "topics": [` });
    expect(repaired).toEqual({ email_note: note });
  });

  it('leaves well-formed, missing and unrecoverable notes alone', () => {
    const ok = { email_note: note };
    expect(repairToolInput(ok)).toBe(ok);
    const none = { topics: [] };
    expect(repairToolInput(none)).toBe(none);
    const junk = { email_note: '{not json' };
    expect(repairToolInput(junk)).toBe(junk);
    expect(sanitizeEmailNote(junk.email_note, new Set())).toBeNull();
    expect(repairToolInput(null)).toBeNull();
  });
});

describe('externalAddresses', () => {
  it('keeps only the lower-cased addresses outside our own domains', () => {
    expect(
      externalAddresses('Bob@Advisor.com', ['analyst@starcapital.co.id', 'claire@law.com'], ['ops@SMMA.id']),
    ).toEqual(new Set(['bob@advisor.com', 'claire@law.com']));
  });
});
