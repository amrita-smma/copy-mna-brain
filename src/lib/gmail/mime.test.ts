import { describe, expect, it } from 'vitest';
import { buildDraftMime, encodeSubject, isMailboxAddress, toBase64Url } from './mime';

const base = { to: ['ana@example.com'], subject: 'Hello', text: 'plain body', html: '<p>html body</p>' };

/** The decoded body of the part whose Content-Type starts with `type`. */
function partBody(message: string, type: string): string {
  const at = message.indexOf(`Content-Type: ${type}`);
  expect(at).toBeGreaterThan(-1);
  const body = message.slice(at).split('\r\n\r\n')[1]!.split('\r\n--')[0]!;
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf-8');
}

describe('isMailboxAddress', () => {
  it('accepts plain addresses', () => {
    expect(isMailboxAddress('ana@example.com')).toBe(true);
    expect(isMailboxAddress('first.last+tag@sub.example.co.id')).toBe(true);
  });

  it('rejects anything that could carry a second recipient or a header', () => {
    for (const bad of [
      'a@b.com, c@d.com',
      'a@b.com,c@d.com',
      'Ana <a@b.com>',
      '"a b"@c.com',
      'a@b.com\r\nBcc: x@y.com',
      'a@b',
      '@b.com',
      'a b@c.com',
      '',
    ]) {
      expect(isMailboxAddress(bad), bad).toBe(false);
    }
  });
});

describe('encodeSubject', () => {
  it('leaves printable ASCII alone', () => {
    expect(encodeSubject('Q3 numbers: 12% up')).toBe('Q3 numbers: 12% up');
  });

  it('encodes non-ASCII as RFC 2047 words that decode back, never splitting a character', () => {
    const subject = 'Rencana akuisisi — 日本語のとても長い件名がここに入ります、さらに続きます🙂 done';
    const encoded = encodeSubject(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, 'base64').toString('utf-8'))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('turns line breaks into spaces so a subject cannot start a header', () => {
    expect(encodeSubject('Hi\r\nBcc: evil@x.com')).toBe('Hi Bcc: evil@x.com');
    expect(encodeSubject('Hi\r\nBcc: evil@x.com')).not.toMatch(/[\r\n]/);
  });
});

describe('buildDraftMime', () => {
  it('builds a multipart/alternative message with both bodies and no sender headers', () => {
    const message = buildDraftMime(base);
    expect(message).toMatch(/^MIME-Version: 1.0\r\nTo: ana@example.com\r\nSubject: Hello\r\nContent-Type: multipart\/alternative;/);
    expect(message).not.toMatch(/^(From|Cc|Bcc|Date|Message-ID):/im);
    expect(partBody(message, 'text/plain')).toBe('plain body');
    expect(partBody(message, 'text/html')).toBe('<p>html body</p>');
    expect(message).not.toContain('multipart/mixed');
  });

  it('keeps non-ASCII and very long body lines intact (base64, not 7bit)', () => {
    const text = `Selamat siang — ${'x'.repeat(3000)}`;
    expect(partBody(buildDraftMime({ ...base, text }), 'text/plain')).toBe(text);
  });

  it('lists every recipient on the To header', () => {
    const message = buildDraftMime({ ...base, to: ['a@x.com', 'b@y.com'] });
    expect(message).toContain('To: a@x.com,\r\n b@y.com\r\n');
  });

  it('wraps attachments in multipart/mixed with base64 content', () => {
    const content = Buffer.from('%PDF-1.7 fake pdf bytes'.repeat(200));
    const message = buildDraftMime({
      ...base,
      attachments: [{ filename: 'summary.pdf', content, contentType: 'application/pdf' }],
    });
    expect(message).toContain('Content-Type: multipart/mixed;');
    expect(message).toContain('Content-Type: application/pdf; name="summary.pdf"');
    expect(message).toContain('Content-Disposition: attachment; filename="summary.pdf"');
    const attachment = message.slice(message.indexOf('Content-Type: application/pdf')).split('\r\n\r\n')[1]!.split('\r\n--')[0]!;
    for (const line of attachment.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(attachment.replace(/\r\n/g, ''), 'base64').equals(content)).toBe(true);
    // The body alternatives are still the first part.
    expect(partBody(message, 'text/plain')).toBe('plain body');
  });

  it('cleans attachment names and content types so neither can break out of its header', () => {
    const message = buildDraftMime({
      ...base,
      attachments: [
        {
          filename: 'a"b\r\nBcc: x@y.com/../laporan Q3 — final.xlsx',
          content: Buffer.from('x'),
          contentType: 'text/plain\r\nBcc: x@y.com',
        },
      ],
    });
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).toContain('Content-Type: application/octet-stream;');
    expect(message).toMatch(/filename\*=UTF-8''/);
    expect(message).not.toContain('a"b');
  });

  it('refuses a recipient that is not a plain address, and an empty list', () => {
    expect(() => buildDraftMime({ ...base, to: ['a@b.com,c@d.com'] })).toThrow(/plain email address/);
    expect(() => buildDraftMime({ ...base, to: ['a@b.com\r\nBcc: x@y.com'] })).toThrow(/plain email address/);
    expect(() => buildDraftMime({ ...base, to: [] })).toThrow(/at least one recipient/);
  });

  it('uses a fresh boundary per message', () => {
    const boundary = (m: string) => /boundary="([^"]+)"/.exec(m)![1];
    expect(boundary(buildDraftMime(base))).not.toBe(boundary(buildDraftMime(base)));
  });
});

describe('toBase64Url', () => {
  it('is URL-safe base64 without padding', () => {
    const encoded = toBase64Url('subjects?>>>~~~ and ünïcode');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(encoded, 'base64url').toString('utf-8')).toBe('subjects?>>>~~~ and ünïcode');
  });
});
