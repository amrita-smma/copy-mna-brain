import { describe, it, expect } from 'vitest';
import {
  shouldSkip,
  isAutoReply,
  isNewsletter,
  isCalendarInvite,
  isInternalOnly,
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
