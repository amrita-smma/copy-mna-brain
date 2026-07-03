import { describe, it, expect } from 'vitest';
import {
  shouldSkip,
  isAutoReply,
  isNewsletter,
  isCalendarInvite,
  isInternalOnly,
  isPersonalOrOneOnOne,
} from './filter';
import { parseHeaders } from './parser';

describe('isAutoReply', () => {
  it('detects Auto-Submitted header', () => {
    expect(isAutoReply(parseHeaders('Auto-Submitted: auto-replied'))).toBe(true);
  });

  it('detects X-Autoreply header', () => {
    expect(isAutoReply(parseHeaders('X-Autoreply: yes'))).toBe(true);
  });

  it('detects Precedence: auto_reply', () => {
    expect(isAutoReply(parseHeaders('Precedence: auto_reply'))).toBe(true);
  });

  it('detects OOO subject pattern', () => {
    expect(isAutoReply(parseHeaders('Subject: Out of Office until Monday'))).toBe(true);
    expect(isAutoReply(parseHeaders('Subject: Automatic Reply'))).toBe(true);
  });

  it('detects multilingual OOO subjects', () => {
    expect(isAutoReply(parseHeaders('Subject: Abwesenheitsnotiz'))).toBe(true);
    expect(isAutoReply(parseHeaders('Subject: Réponse automatique : ...'))).toBe(true);
    expect(isAutoReply(parseHeaders('Subject: Balasan otomatis'))).toBe(true);
  });

  it('returns false for ordinary mail', () => {
    expect(isAutoReply(parseHeaders('Subject: Hello there'))).toBe(false);
  });
});

describe('isNewsletter', () => {
  it('detects List-Unsubscribe header', () => {
    expect(isNewsletter(parseHeaders('List-Unsubscribe: <https://x.com/unsub>'))).toBe(true);
  });

  it('detects X-Campaign-ID header', () => {
    expect(isNewsletter(parseHeaders('X-Campaign-ID: abc'))).toBe(true);
  });

  it('detects Precedence: bulk', () => {
    expect(isNewsletter(parseHeaders('Precedence: bulk'))).toBe(true);
  });

  it('detects noreply local part', () => {
    expect(isNewsletter(parseHeaders(''), 'noreply')).toBe(true);
    expect(isNewsletter(parseHeaders(''), 'no-reply')).toBe(true);
    expect(isNewsletter(parseHeaders(''), 'donotreply')).toBe(true);
    expect(isNewsletter(parseHeaders(''), 'newsletter')).toBe(true);
    expect(isNewsletter(parseHeaders(''), 'marketing')).toBe(true);
  });

  it('returns false for ordinary mail', () => {
    expect(isNewsletter(parseHeaders('Subject: Hi'), 'alice')).toBe(false);
  });
});

describe('isCalendarInvite', () => {
  it('detects text/calendar Content-Type at top level', () => {
    expect(isCalendarInvite(parseHeaders('Content-Type: text/calendar'), '')).toBe(true);
  });

  it('detects calendar part inside multipart', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="b"');
    const body = '--b\nContent-Type: text/calendar; method=REQUEST\n\nBEGIN:VCALENDAR\n';
    expect(isCalendarInvite(headers, body)).toBe(true);
  });

  it('returns false for plain text email', () => {
    expect(isCalendarInvite(parseHeaders('Content-Type: text/plain'), 'hello')).toBe(false);
  });
});

describe('isInternalOnly', () => {
  const ourDomains = new Set(['starcapital.co.id', 'aldiracita.com']);

  it('returns false when ourDomains is empty', () => {
    expect(isInternalOnly(parseHeaders('From: a@starcapital.co.id\nTo: b@external.com'), new Set())).toBe(false);
  });

  it('returns true when sender and all recipients are internal', () => {
    const headers = parseHeaders(
      'From: a@starcapital.co.id\nTo: b@aldiracita.com\nCc: c@starcapital.co.id',
    );
    expect(isInternalOnly(headers, ourDomains)).toBe(true);
  });

  it('returns false when at least one party is external', () => {
    const headers = parseHeaders('From: a@starcapital.co.id\nTo: external@other.com');
    expect(isInternalOnly(headers, ourDomains)).toBe(false);
  });

  it('returns false when sender domain is missing', () => {
    expect(isInternalOnly(parseHeaders('To: b@starcapital.co.id'), ourDomains)).toBe(false);
  });
});

describe('isPersonalOrOneOnOne', () => {
  it('detects 1:1 / 1-1 / one-on-one subjects', () => {
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Weekly 1:1'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Alice / Bob 1-1'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: One-on-one sync'))).toBe(true);
  });

  it('detects personal/social subjects', () => {
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Grab a coffee next week?'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Lunch on Friday'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Happy Birthday!'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Congratulations 🎉'))).toBe(true);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Quick catch up'))).toBe(true);
  });

  it('does NOT fire when deal language is present (conservative)', () => {
    // A catch-up about a live deal must not be dropped.
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Catch up on Project Domino'))).toBe(false);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Lunch to discuss the NDA'))).toBe(false);
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: 1:1 re term sheet'))).toBe(false);
  });

  it('returns false for ordinary business subjects and empty subjects', () => {
    expect(isPersonalOrOneOnOne(parseHeaders('Subject: Deal intro'))).toBe(false);
    expect(isPersonalOrOneOnOne(parseHeaders('From: a@b.com'))).toBe(false);
  });
});

describe('shouldSkip', () => {
  it('returns auto_reply reason first', () => {
    const r = shouldSkip(parseHeaders('Subject: Out of Office'), '');
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('auto_reply');
  });

  it('returns newsletter reason for List-Unsubscribe', () => {
    const r = shouldSkip(parseHeaders('List-Unsubscribe: <x>'), '');
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('newsletter');
  });

  it('returns newsletter reason for noreply sender', () => {
    const r = shouldSkip(parseHeaders('From: noreply@example.com'), '');
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('newsletter');
  });

  it('returns calendar_invite reason for text/calendar', () => {
    const r = shouldSkip(parseHeaders('Content-Type: text/calendar'), '');
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('calendar_invite');
  });

  it('returns internal_only reason when dropInternalOnly is set', () => {
    const headers = parseHeaders('From: a@x.com\nTo: b@x.com');
    const r = shouldSkip(headers, '', {
      ourDomains: new Set(['x.com']),
      dropInternalOnly: true,
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('internal_only');
  });

  it('returns personal reason for a 1-1 catch-up subject', () => {
    const r = shouldSkip(
      parseHeaders('From: a@external.com\nTo: b@starcapital.co.id\nSubject: Coffee catch up\nContent-Type: text/plain'),
      '',
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('personal');
  });

  it('does not mark a deal-related catch-up as personal', () => {
    const r = shouldSkip(
      parseHeaders('From: a@external.com\nTo: b@starcapital.co.id\nSubject: Catch up on the acquisition\nContent-Type: text/plain'),
      '',
    );
    expect(r.skip).toBe(false);
  });

  it('keeps internal_only by default', () => {
    const headers = parseHeaders('From: a@x.com\nTo: b@x.com');
    const r = shouldSkip(headers, '', { ourDomains: new Set(['x.com']) });
    expect(r.skip).toBe(false);
  });

  it('returns skip=false for ordinary inbound mail', () => {
    const headers = parseHeaders(
      'From: banker@external.com\nTo: alice@starcapital.co.id\nSubject: Deal intro\nContent-Type: text/plain',
    );
    expect(shouldSkip(headers, '')).toEqual({ skip: false, reason: '' });
  });
});
