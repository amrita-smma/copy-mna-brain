import { describe, it, expect } from 'vitest';
import {
  parseAddresses,
  cleanBody,
  extractSignature,
  extractQuotedThread,
  stripHtml,
  parseHeaders,
  normalizeDate,
  splitMboxMessages,
  streamMboxMessages,
  parseMessage,
  extractBody,
  type RawMessage,
} from './parser';

describe('parseAddresses', () => {
  it('returns [] for empty input', () => {
    expect(parseAddresses('')).toEqual([]);
  });

  it('parses a single bare address', () => {
    expect(parseAddresses('alice@example.com')).toEqual([{ name: '', email: 'alice@example.com' }]);
  });

  it('parses Name <email> form', () => {
    expect(parseAddresses('Alice Banker <alice@example.com>')).toEqual([
      { name: 'Alice Banker', email: 'alice@example.com' },
    ]);
  });

  it('parses multiple addresses', () => {
    expect(parseAddresses('Alice <a@x.com>, Bob <b@y.com>')).toEqual([
      { name: 'Alice', email: 'a@x.com' },
      { name: 'Bob', email: 'b@y.com' },
    ]);
  });

  it('handles quoted display name with embedded comma', () => {
    const out = parseAddresses('"Doe, John" <john@x.com>, Other <other@y.com>');
    expect(out).toHaveLength(2);
    expect(out[0].email).toBe('john@x.com');
    expect(out[1].email).toBe('other@y.com');
  });

  it('lowercases email addresses', () => {
    expect(parseAddresses('Alice <Alice@Example.COM>')).toEqual([
      { name: 'Alice', email: 'alice@example.com' },
    ]);
  });

  it('handles a bare <email> with no display-name prefix', () => {
    expect(parseAddresses('<banker@external.com>')).toEqual([
      { name: '', email: 'banker@external.com' },
    ]);
  });

  it('handles mixed bare-angle and name-angle forms in one list', () => {
    expect(parseAddresses('<a@x.com>, Bob <b@y.com>')).toEqual([
      { name: '', email: 'a@x.com' },
      { name: 'Bob', email: 'b@y.com' },
    ]);
  });
});

describe('cleanBody', () => {
  it('returns "" for empty input', () => {
    expect(cleanBody('')).toBe('');
  });

  it('strips quoted-reply lines starting with >', () => {
    const out = cleanBody('Hello there.\n> previous message\n> more quote\nThanks.');
    expect(out).not.toContain('previous message');
    expect(out).toContain('Hello there.');
    expect(out).toContain('Thanks.');
  });

  it('stops at "On ... wrote:" intro', () => {
    const out = cleanBody('Reply body.\nOn Mon, Jan 1 2024 Alice wrote:\nOriginal quoted body');
    expect(out).toBe('Reply body.');
  });

  it('stops at signature delimiter "-- "', () => {
    const out = cleanBody('Body content.\n-- \nBest,\nAlice');
    expect(out).toBe('Body content.');
  });

  it('stops at "From: ..." line', () => {
    const out = cleanBody('My reply.\nFrom: someone@x.com\nbody');
    expect(out).toBe('My reply.');
  });

  it('stops at "-----Original Message-----"', () => {
    const out = cleanBody('Reply.\n-----Original Message-----\nold body');
    expect(out).toBe('Reply.');
  });

  it('collapses runs of whitespace and newlines', () => {
    const out = cleanBody('Line one\n\n\n\nLine two   has    spaces');
    expect(out).toBe('Line one\n\nLine two has spaces');
  });

  it('strips zero-width characters', () => {
    const out = cleanBody('Hello\u200B\u200CWorld\uFEFF');
    expect(out).toBe('HelloWorld');
  });

  it('drops URLs when dropUrls is true', () => {
    const out = cleanBody('See https://example.com/foo for details.', true);
    expect(out).not.toContain('https://');
    expect(out).toContain('See');
    expect(out).toContain('for details.');
  });

  it('normalizes CRLF and CR to LF', () => {
    const out = cleanBody('A\r\nB\rC');
    expect(out).toBe('A\nB\nC');
  });

  it('preserves forwarded body after Gmail separator', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: banker@gs.com',
      'Date: Mon, 9 Jun 2026 10:00:00 +0000',
      'Subject: TechSlurry acquisition opportunity',
      'To: me@sqe.co.id',
      '',
      'We represent TechSlurry in a sell-side process.',
    ].join('\n');
    const out = cleanBody(body);
    expect(out).toContain('We represent TechSlurry in a sell-side process.');
    expect(out).not.toContain('banker@gs.com');
    expect(out).not.toContain('Forwarded message');
  });

  it('preserves forwarded body after Outlook separator (real example: Fw: Industrial Gas)', () => {
    const body = [
      '________________________________',
      'From: christin.chandra@starcapital.co.id',
      'Sent: Friday, January 2, 2026 1:59 PM',
      'To: team@sqe.co.id',
      'Subject: Case Study Assignment – Industrial Gas Sector',
      '',
      'Please find the case study details below.',
    ].join('\n');
    const out = cleanBody(body);
    expect(out).toContain('Please find the case study details below.');
    expect(out).not.toContain('starcapital.co.id');
    expect(out).not.toContain('________________________________');
  });

  it('preserves top note and forwarded body together', () => {
    const body = [
      'FYI, this looks interesting.',
      '',
      '________________________________',
      'From: banker@gs.com',
      'Sent: Friday, January 2, 2026',
      'Subject: TechSlurry opportunity',
      '',
      'We represent TechSlurry in a sell-side process.',
    ].join('\n');
    const out = cleanBody(body);
    expect(out).toContain('FYI, this looks interesting.');
    expect(out).toContain('We represent TechSlurry in a sell-side process.');
  });

  it('still stops at "From: ..." in a regular reply context (no forwarding separator)', () => {
    const out = cleanBody('My reply.\nFrom: someone@x.com\nbody');
    expect(out).toBe('My reply.');
  });
});

describe('extractQuotedThread', () => {
  it('returns the reply intro and everything under it, which cleanBody drops', () => {
    const raw = [
      'Agreed, go with option 2.',
      '',
      'On Mon, Jun 9 2026 Alice <alice@gs.com> wrote:',
      '> Option 1: full sale at 8x EBITDA.',
      '> Option 2: 60% stake with an earn-out.',
    ].join('\n');
    expect(cleanBody(raw)).toBe('Agreed, go with option 2.');
    expect(extractQuotedThread(raw)).toBe(
      'On Mon, Jun 9 2026 Alice <alice@gs.com> wrote:\nOption 1: full sale at 8x EBITDA.\nOption 2: 60% stake with an earn-out.',
    );
  });

  it('keeps inline > lines that cleanBody skips, without the markers', () => {
    expect(extractQuotedThread('Yes.\n>> Can you send the CIM?\nSending now.')).toBe(
      'Can you send the CIM?',
    );
  });

  it('finds the intro after the signature', () => {
    const raw = 'Sounds good.\n-- \nBob\nGS\n-----Original Message-----\nOld ask about the NDA';
    expect(extractQuotedThread(raw)).toBe('-----Original Message-----\nOld ask about the NDA');
  });

  it('does not repeat a forwarded body that cleanBody keeps', () => {
    const raw = [
      'FYI',
      '________________________________',
      'From: banker@gs.com',
      'Subject: TechSlurry opportunity',
      '',
      'We represent TechSlurry in a sell-side process.',
    ].join('\n');
    expect(cleanBody(raw)).toContain('We represent TechSlurry');
    expect(extractQuotedThread(raw)).toBe('');
  });

  it('returns empty for an email that quotes nothing', () => {
    expect(extractQuotedThread('Fresh email with no history.')).toBe('');
    expect(extractQuotedThread('')).toBe('');
  });

  it('caps the length, keeping the most recent quoted message first', () => {
    const raw = `Ok.\nOn Mon Alice wrote:\n${'a'.repeat(50)}\nOn Sun Bob wrote:\n${'b'.repeat(50)}`;
    const out = extractQuotedThread(raw, false, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith('On Mon Alice wrote:')).toBe(true);
  });
});

describe('extractSignature', () => {
  it('returns "" for empty input', () => {
    expect(extractSignature('')).toBe('');
  });

  it('returns "" when no "-- " delimiter is present', () => {
    expect(extractSignature('Hi there.\nThanks,\nAlice')).toBe('');
  });

  it('returns the block after the "-- " delimiter', () => {
    const sig = extractSignature('Body content.\n-- \nAlice Banker\nVice President\n+62 812 1234 5678');
    expect(sig).toBe('Alice Banker\nVice President\n+62 812 1234 5678');
  });

  it('also matches the bare "--" delimiter without a trailing space', () => {
    expect(extractSignature('Body.\n--\nAlice')).toBe('Alice');
  });

  it('stops at a quoted reply that follows the signature', () => {
    const sig = extractSignature(
      'Body.\n-- \nAlice\n+62 812 0000\nOn Mon, Jan 1 2024 Bob wrote:\nold content',
    );
    expect(sig).toBe('Alice\n+62 812 0000');
  });

  it('stops at a `>`-prefixed quoted line that follows the signature', () => {
    const sig = extractSignature('Body.\n-- \nAlice\n+62 812 0000\n> previous message');
    expect(sig).toBe('Alice\n+62 812 0000');
  });

  it('returns "" when a quoted-reply intro appears before the delimiter', () => {
    expect(extractSignature('FYR\nOn Mon, Jan 1 Alice wrote:\n-- \nstale sig')).toBe('');
  });

  it('collapses runs of whitespace and newlines inside the signature', () => {
    const sig = extractSignature('Body.\n-- \nAlice    Banker\n\n\n\n+62 812 1234');
    expect(sig).toBe('Alice Banker\n\n+62 812 1234');
  });
});

describe('stripHtml', () => {
  it('removes <script> blocks entirely', () => {
    expect(stripHtml('<p>Hi</p><script>alert(1)</script>')).not.toContain('alert');
  });

  it('removes <style> blocks entirely', () => {
    expect(stripHtml('<style>p{color:red}</style><p>Hi</p>')).not.toContain('color:red');
  });

  it('inserts a newline for <br>, <p>, <div>', () => {
    expect(stripHtml('a<br>b')).toContain('\n');
    expect(stripHtml('<p>a</p><p>b</p>')).toContain('\n');
  });

  it('decodes named HTML entities', () => {
    expect(stripHtml('&amp;&lt;&gt;&quot;&#39;')).toContain('&');
    expect(stripHtml('&nbsp;')).toBe(' ');
  });

  it('decodes numeric HTML entities', () => {
    expect(stripHtml('&#65;')).toBe('A');
  });
});

describe('parseHeaders', () => {
  it('unfolds continuation lines', () => {
    const headers = parseHeaders('Subject: a long\n subject line\nFrom: a@x.com');
    expect(headers['subject']).toEqual(['a long subject line']);
    expect(headers['from']).toEqual(['a@x.com']);
  });

  it('lowercases header keys', () => {
    const headers = parseHeaders('CONTENT-TYPE: text/plain');
    expect(headers['content-type']).toEqual(['text/plain']);
  });

  it('keeps multiple values for repeated headers', () => {
    const headers = parseHeaders('Received: from a\nReceived: from b');
    expect(headers['received']).toEqual(['from a', 'from b']);
  });

  it('decodes RFC 2047 encoded-word values', () => {
    const headers = parseHeaders('Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=');
    expect(headers['subject']).toEqual(['Hello World']);
  });
});

describe('normalizeDate', () => {
  it('returns null for empty input', () => {
    expect(normalizeDate('')).toBeNull();
  });

  it('returns ISO string for a valid RFC 2822 date', () => {
    expect(normalizeDate('Mon, 01 Jan 2024 10:00:00 +0000')).toBe('2024-01-01T10:00:00.000Z');
  });

  it('returns the raw value for an unparseable date', () => {
    expect(normalizeDate('not-a-date')).toBe('not-a-date');
  });
});

describe('splitMboxMessages + parseMessage', () => {
  function makeMsg(opts: { from: string; to: string; subject: string; body: string; cc?: string }) {
    const cc = opts.cc ? `Cc: ${opts.cc}\n` : '';
    return (
      `From envelope@x Mon Jan  1 00:00:00 2024\n` +
      `From: ${opts.from}\n` +
      `To: ${opts.to}\n` +
      cc +
      `Subject: ${opts.subject}\n` +
      `Date: Mon, 01 Jan 2024 10:00:00 +0000\n` +
      `Message-ID: <msg-${opts.subject.replace(/\s+/g, '-')}@x>\n` +
      `\n` +
      `${opts.body}\n`
    );
  }

  it('splits a multi-message mbox', () => {
    const raw =
      makeMsg({ from: 'a@x.com', to: 'b@x.com', subject: 'one', body: 'body one is long enough.' }) +
      makeMsg({ from: 'c@x.com', to: 'd@x.com', subject: 'two', body: 'body two also long enough.' });
    const out = splitMboxMessages(raw);
    expect(out).toHaveLength(2);
  });

  it('parses sender, recipients, cc, subject, body', () => {
    const raw = makeMsg({
      from: 'Alice <alice@x.com>',
      to: 'Bob <bob@y.com>',
      cc: 'cc@z.com',
      subject: 'hello',
      body: 'Body text long enough to keep.',
    });
    const [msg] = splitMboxMessages(raw);
    const parsed = parseMessage(msg);
    expect(parsed.sender).toEqual({ name: 'Alice', email: 'alice@x.com' });
    expect(parsed.recipients).toEqual([{ name: 'Bob', email: 'bob@y.com' }]);
    expect(parsed.cc).toEqual([{ name: '', email: 'cc@z.com' }]);
    expect(parsed.subject).toBe('hello');
    expect(parsed.body).toBe('Body text long enough to keep.');
    expect(parsed.signature).toBe('');
    expect(parsed.message_id).toBe('<msg-hello@x>');
    expect(parsed.date).toBe('2024-01-01T10:00:00.000Z');
  });

  it('splits a reply into its own body and the quoted thread', () => {
    const raw = makeMsg({
      from: 'Alice <alice@x.com>',
      to: 'Bob <bob@y.com>',
      subject: 'Re: options',
      body: 'Agreed, go with option 2.\nOn Mon, Jan 1 2024 Bob wrote:\n> Option 2: 60% stake.',
    });
    const [msg] = splitMboxMessages(raw);
    const parsed = parseMessage(msg);
    expect(parsed.body).toBe('Agreed, go with option 2.');
    expect(parsed.quoted_thread).toBe('On Mon, Jan 1 2024 Bob wrote:\nOption 2: 60% stake.');
  });

  it('populates signature when the body has a "-- " delimiter', () => {
    const raw = makeMsg({
      from: 'Alice <alice@x.com>',
      to: 'Bob <bob@y.com>',
      subject: 'with sig',
      body: 'Body text long enough to keep.\n-- \nAlice Banker\nVice President\n+62 812 1234 5678',
    });
    const [msg] = splitMboxMessages(raw);
    const parsed = parseMessage(msg);
    expect(parsed.body).toBe('Body text long enough to keep.');
    expect(parsed.signature).toBe('Alice Banker\nVice President\n+62 812 1234 5678');
  });

  it('returns [] for empty content', () => {
    expect(splitMboxMessages('')).toEqual([]);
  });
});

describe('streamMboxMessages', () => {
  function makeMsg(i: number, body = `Body text for message ${i}, long enough to keep.`) {
    return (
      `From envelope${i} Mon Jan  1 00:00:00 2024\n` +
      `From: sender${i}@x.com\n` +
      `To: alice@y.com\n` +
      `Subject: msg ${i}\n` +
      `Date: Mon, 01 Jan 2024 10:0${i}:00 +0000\n` +
      `Message-ID: <m${i}@x>\n` +
      `\n` +
      `${body}\n`
    );
  }

  async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<RawMessage[]> {
    const out: RawMessage[] = [];
    for await (const m of streamMboxMessages(stream)) out.push(m);
    return out;
  }

  async function* chunk(text: string, size: number) {
    for (let i = 0; i < text.length; i += size) {
      yield Buffer.from(text.slice(i, i + size), 'utf-8');
    }
  }

  it('yields the same messages as splitMboxMessages for the same input', async () => {
    const raw = makeMsg(1) + makeMsg(2) + makeMsg(3);
    const streamed = await collect(chunk(raw, 1024));
    const sync = splitMboxMessages(raw);
    expect(streamed).toHaveLength(sync.length);
    for (let i = 0; i < sync.length; i++) {
      expect(streamed[i].headers['subject']).toEqual(sync[i].headers['subject']);
      expect(streamed[i].rawBody).toEqual(sync[i].rawBody);
    }
  });

  it('handles boundary that straddles a chunk break', async () => {
    const raw = makeMsg(1) + makeMsg(2) + makeMsg(3);
    // Tiny chunks force the "\nFrom " boundary to land across many splits.
    const streamed = await collect(chunk(raw, 7));
    expect(streamed).toHaveLength(3);
    expect(streamed[1].headers['subject']).toEqual(['msg 2']);
  });

  it('decodes UTF-8 multi-byte characters split across chunks', async () => {
    // The € sign is 3 bytes in UTF-8 (0xE2, 0x82, 0xAC). Force a chunk
    // boundary between byte 1 and byte 2 of the sequence.
    const body = '€100 deal value is the topic of this email body content.';
    const raw = makeMsg(1, body);
    const buf = Buffer.from(raw, 'utf-8');
    const splitPoint = buf.indexOf(0xe2) + 1;
    async function* chunkedBytes() {
      yield buf.subarray(0, splitPoint);
      yield buf.subarray(splitPoint);
    }
    const streamed = await collect(chunkedBytes());
    expect(streamed).toHaveLength(1);
    expect(streamed[0].rawBody).toContain('€100');
  });

  it('yields the last message even when there is no trailing boundary', async () => {
    const raw = makeMsg(1);
    const streamed = await collect(chunk(raw, 16));
    expect(streamed).toHaveLength(1);
  });

  it('yields nothing for empty input', async () => {
    async function* empty() {
      /* yield nothing */
    }
    expect(await collect(empty())).toEqual([]);
  });

  it('skips leading garbage before the first "From " line', async () => {
    const raw = 'X-some-prelude: garbage\nthat is not part of any message\n' + makeMsg(1);
    const streamed = await collect(chunk(raw, 32));
    expect(streamed).toHaveLength(1);
    expect(streamed[0].headers['subject']).toEqual(['msg 1']);
  });
});

describe('extractBody (multipart)', () => {
  it('picks text/plain over text/html when both are present', () => {
    const headers = parseHeaders(
      'Content-Type: multipart/alternative; boundary="bdy"\n',
    );
    const body =
      `--bdy\n` +
      `Content-Type: text/plain; charset=utf-8\n\n` +
      `Plain text content here long enough.\n` +
      `--bdy\n` +
      `Content-Type: text/html; charset=utf-8\n\n` +
      `<p>HTML content</p>\n` +
      `--bdy--\n`;
    expect(extractBody(headers, body)).toContain('Plain text content');
  });

  it('falls back to HTML when text/plain is a short placeholder', () => {
    const headers = parseHeaders('Content-Type: multipart/alternative; boundary="b"\n');
    const body =
      `--b\n` +
      `Content-Type: text/plain\n\n` +
      `HTML only.\n` +
      `--b\n` +
      `Content-Type: text/html\n\n` +
      `<p>This is the substantive HTML body with much more content in it than the plain placeholder.</p>\n` +
      `--b--\n`;
    const out = extractBody(headers, body);
    expect(out).toContain('substantive HTML body');
  });

  it('decodes base64 text/plain', () => {
    const headers = parseHeaders('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n');
    const body = Buffer.from('Decoded body content here.').toString('base64');
    expect(extractBody(headers, body)).toContain('Decoded body content here.');
  });

  it('decodes quoted-printable text/plain', () => {
    const headers = parseHeaders(
      'Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n',
    );
    expect(extractBody(headers, 'Hello=20World')).toBe('Hello World');
  });
});
