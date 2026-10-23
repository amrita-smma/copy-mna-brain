import { describe, it, expect } from 'vitest';

import {
  domainTag,
  findBodyCandidates,
  processEmail,
  updateContact,
  type ContactRow,
} from './extract';
import type { ParsedEmail } from './parser';

function makeEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    message_id: 'm@x',
    date: '2026-01-01T00:00:00.000Z',
    sender: { name: 'Alice Banker', email: 'alice@external.com' },
    recipients: [{ name: 'Bob', email: 'bob@starcapital.co.id' }],
    cc: [],
    subject: 'subj',
    body: '',
    signature: '',
    ...overrides,
  };
}

describe('domainTag', () => {
  it('returns null for empty/invalid input', () => {
    expect(domainTag('')).toBeNull();
    expect(domainTag('not-an-address')).toBeNull();
  });

  it('tags by sender domain', () => {
    expect(domainTag('digest@bloomberg.com')).toBe('finance-news');
    expect(domainTag('noreply@linkedin.com')).toBe('professional-networking');
  });

  it('tags by local-part keyword when domain is unknown', () => {
    expect(domainTag('newsletter@example.com')).toBe('marketing');
    expect(domainTag('support@example.com')).toBe('support');
  });

  it('returns null when no pattern matches', () => {
    expect(domainTag('alice@starcapital.co.id')).toBeNull();
  });
});

describe('findBodyCandidates', () => {
  it('returns [] for empty body', () => {
    expect(findBodyCandidates('')).toEqual([]);
  });

  it('finds email candidates with context', () => {
    const out = findBodyCandidates(
      'Line 1\nReach me at alice@external.com for details.\nLine 3',
    );
    const email = out.find((c) => c.type === 'email');
    expect(email).toBeDefined();
    expect(email?.value).toBe('alice@external.com');
    expect(email?.context).toContain('alice@external.com');
  });

  it('lowercases email values', () => {
    const out = findBodyCandidates('contact ALICE@External.COM today');
    expect(out.find((c) => c.type === 'email')?.value).toBe('alice@external.com');
  });

  it('dedupes the same email across lines and keeps the longest context', () => {
    const body =
      'Short ref: alice@external.com.\n' +
      '\n' +
      'Long context here. Please reach alice@external.com for the full proposal and more details about the meeting.';
    const out = findBodyCandidates(body).filter((c) => c.type === 'email');
    expect(out).toHaveLength(1);
    expect(out[0].context.length).toBeGreaterThan(60);
  });

  it('finds Indonesian phone numbers and normalizes to E.164', () => {
    const out = findBodyCandidates('Phone: +62 812 1234 5678', 'ID');
    const phone = out.find((c) => c.type === 'phone');
    expect(phone).toBeDefined();
    expect(phone?.value.startsWith('+62')).toBe(true);
  });
});

describe('processEmail', () => {
  it('adds the sender as a candidate when not in body, using sig context', () => {
    const rec = makeEmail({
      body: 'Just a short note.',
      signature: 'Alice Banker\nVP Investments\n+62 812 1111 2222',
    });
    const out = processEmail(rec);
    const senderCandidate = out.candidates.find(
      (c) => c.type === 'email' && c.value === 'alice@external.com',
    );
    expect(senderCandidate).toBeDefined();
    expect(senderCandidate?.context).toContain('VP Investments');
  });

  it('upgrades sender body-candidate context to the signature when sender is also in body', () => {
    const rec = makeEmail({
      body: 'See alice@external.com in the body.',
      signature: 'Alice Banker\nVP Investments',
    });
    const out = processEmail(rec);
    const senderCandidates = out.candidates.filter(
      (c) => c.type === 'email' && c.value === 'alice@external.com',
    );
    expect(senderCandidates).toHaveLength(1);
    expect(senderCandidates[0].context).toContain('VP Investments');
  });

  it('falls back to last-20-non-empty-lines when signature is empty', () => {
    const rec = makeEmail({
      body: ['Para one.', '', 'Para two.', '', 'Best,', 'Alice', 'VP at External'].join('\n'),
      signature: '',
    });
    const out = processEmail(rec);
    const senderCandidate = out.candidates.find((c) => c.value === 'alice@external.com');
    expect(senderCandidate?.context).toContain('VP at External');
  });

  it('sets domain_tag and skips topic LLM when sender is a well-known domain', () => {
    const rec = makeEmail({
      sender: { name: 'Bloomberg Digest', email: 'digest@bloomberg.com' },
      body: '',
      signature: '',
    });
    const out = processEmail(rec);
    expect(out.domain_tag).toBe('finance-news');
    expect(out.llm_payload?.want_topics).toBe(false);
  });

  it('finds phone candidates that live only in the signature, not the body', () => {
    const rec = makeEmail({
      body: 'Just a short note.',
      signature: 'Alice Banker\nVP Investments\n+62 811 1301 9797',
    });
    const out = processEmail(rec);
    const phone = out.candidates.find((c) => c.type === 'phone');
    expect(phone).toBeDefined();
    expect(phone?.value).toBe('+6281113019797');
  });

  it('marks needs_llm=true when there are candidates and no domain tag', () => {
    const rec = makeEmail({ body: '', signature: 'Alice\nVP' });
    const out = processEmail(rec);
    expect(out.needs_llm).toBe(true);
    expect(out.llm_payload).not.toBeNull();
  });

  it('only upgrades external recipients to the sig context, never internal ones', () => {
    const rec = makeEmail({
      sender: { name: 'Alice', email: 'alice@starcapital.co.id' },
      recipients: [
        { name: 'Bob', email: 'bob@starcapital.co.id' }, // internal — should be skipped
        { name: 'Carol', email: 'carol@external.com' }, // external — eligible for upgrade
      ],
      // Short body lines so the sig context is genuinely richer than what
      // findBodyCandidates captured. The Python original (and this port) only
      // upgrades when len(sig) > len(existing.context).
      body: 'bob@starcapital.co.id\ncarol@external.com',
      signature:
        'Alice Banker, Managing Partner at STAR Capital Group, +62 812 1111 2222, alice@starcapital.co.id',
    });
    const out = processEmail(rec);
    const bob = out.candidates.find((c) => c.value === 'bob@starcapital.co.id');
    const carol = out.candidates.find((c) => c.value === 'carol@external.com');
    // Internal recipient should never be touched by the upgrade pass.
    expect(bob?.context).not.toContain('Managing Partner');
    // External recipient should pick up the richer sig context.
    expect(carol?.context).toContain('Managing Partner');
  });
});

describe('processEmail thread context', () => {
  it('carries the quoted thread into llm_payload apart from the body', () => {
    const out = processEmail(
      makeEmail({
        sender: { name: 'GS Banker', email: 'banker@gs.com' },
        body: 'Agreed, go with option 2.',
        quoted_thread: 'On Mon Alice wrote:\nOption 2: 60% stake.',
      }),
      { wantRelatedCompanies: true },
    );
    expect(out.llm_payload?.body_snippet).toBe('Agreed, go with option 2.');
    expect(out.llm_payload?.thread_context).toBe('On Mon Alice wrote:\nOption 2: 60% stake.');
  });
});

describe('processEmail wantRelatedCompanies gating', () => {
  it('sets want_related_companies=true in llm_payload and populates body_snippet', () => {
    // bloomberg.com is classified → want_topics=false. The real gap: without
    // want_related_companies, buildUserPrompt never includes the EMAIL BODY.
    // This test verifies the flag propagates into llm_payload so the prompt builder
    // can include the body for related-company extraction.
    const rec = makeEmail({
      sender: { name: 'GS Banker', email: 'banker@gs.com' },
      body: 'We represent TechSlurry in a sell-side process.',
      signature: '',
    });
    const out = processEmail(rec, { wantRelatedCompanies: true });
    expect(out.llm_payload).not.toBeNull();
    expect(out.llm_payload?.want_related_companies).toBe(true);
    expect(out.llm_payload?.body_snippet).toContain('TechSlurry');
  });

  it('forces needs_llm=true for an email that would otherwise have no LLM need', () => {
    // Construct the one case where needs_llm would normally be false:
    // known domain (bloomberg) → needsTopic=false, and override candidates to []
    // by using a sender with no body/sig content. In practice the sender is added
    // as a candidate, but with wantRelatedCompanies the email must go to LLM
    // regardless.
    const rec = makeEmail({
      sender: { name: 'Bloomberg', email: 'digest@bloomberg.com' },
      body: 'We represent TechSlurry in a sell-side process.',
      signature: '',
    });
    // With flag: must include body + want_related_companies
    const withFlag = processEmail(rec, { wantRelatedCompanies: true });
    expect(withFlag.needs_llm).toBe(true);
    expect(withFlag.llm_payload?.want_related_companies).toBe(true);
    expect(withFlag.llm_payload?.body_snippet).toBeTruthy();
  });

  it('does not set want_related_companies when flag is off', () => {
    const rec = makeEmail({
      sender: { name: 'GS Banker', email: 'banker@gs.com' },
      body: 'We represent TechSlurry in a sell-side process.',
      signature: '',
    });
    const out = processEmail(rec, {});
    expect(out.llm_payload?.want_related_companies).toBe(false);
  });
});

describe('updateContact', () => {
  it('counts occurrences and tracks latest date', () => {
    const table = new Map<string, ContactRow>();
    updateContact(table, 'alice@x.com', 'Alice', '2026-01-01T00:00:00Z');
    updateContact(table, 'alice@x.com', 'Alice', '2026-02-01T00:00:00Z');
    const row = table.get('alice@x.com');
    expect(row?.count).toBe(2);
    expect(row?.last_seen).toBe('2026-02-01T00:00:00Z');
  });

  it('prefers the longest non-empty name seen', () => {
    const table = new Map<string, ContactRow>();
    updateContact(table, 'alice@x.com', '', '2026-01-01T00:00:00Z');
    updateContact(table, 'alice@x.com', 'Alice', '2026-01-02T00:00:00Z');
    updateContact(table, 'alice@x.com', 'Alice Banker', '2026-01-03T00:00:00Z');
    expect(table.get('alice@x.com')?.name).toBe('Alice Banker');
  });

  it('does nothing for empty addr', () => {
    const table = new Map<string, ContactRow>();
    updateContact(table, '', 'Alice', '2026-01-01T00:00:00Z');
    expect(table.size).toBe(0);
  });
});
