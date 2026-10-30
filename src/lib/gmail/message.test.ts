import { describe, expect, it } from 'vitest';
import { GMAIL_BODY_MAX_CHARS, htmlToText, parseMessage, parseMessageSummary, type GmailRawMessage } from './message';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

const headers = [
  { name: 'From', value: 'Alice <alice@x.com>' },
  { name: 'To', value: 'me@gmail.com' },
  { name: 'Cc', value: 'bob@x.com' },
  { name: 'Subject', value: 'Q3 numbers' },
];

describe('parseMessageSummary', () => {
  it('reads headers, unread state and the received time without a body', () => {
    const raw: GmailRawMessage = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Attached are the',
      internalDate: String(Date.parse('2026-10-28T08:30:00Z')),
      payload: { headers },
    };
    expect(parseMessageSummary(raw)).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'Alice <alice@x.com>',
      to: 'me@gmail.com',
      subject: 'Q3 numbers',
      date: '2026-10-28T08:30:00.000Z',
      snippet: 'Attached are the',
      unread: true,
      labels: ['INBOX', 'UNREAD'],
    });
  });

  it('tolerates a sparse message', () => {
    expect(parseMessageSummary({ id: 'm2' })).toMatchObject({
      from: null,
      subject: null,
      date: null,
      unread: false,
      labels: [],
      snippet: '',
    });
  });

  it('matches header names case-insensitively', () => {
    const msg = parseMessageSummary({ id: 'm', payload: { headers: [{ name: 'SUBJECT', value: ' Hi ' }] } });
    expect(msg.subject).toBe('Hi');
  });
});

describe('parseMessage', () => {
  it('reads a single-part plain-text message', () => {
    const msg = parseMessage({
      id: 'm1',
      payload: { mimeType: 'text/plain', headers, body: { size: 5, data: b64('Hello there') } },
    });
    expect(msg.body).toBe('Hello there');
    expect(msg.cc).toBe('bob@x.com');
    expect(msg.bodyTruncated).toBe(false);
    expect(msg.attachments).toEqual([]);
  });

  it("prefers the sender's text/plain alternative over the HTML", () => {
    const msg = parseMessage({
      id: 'm1',
      payload: {
        mimeType: 'multipart/alternative',
        headers,
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain version') } },
          { mimeType: 'text/html', body: { data: b64('<p>html version</p>') } },
        ],
      },
    });
    expect(msg.body).toBe('plain version');
  });

  it('falls back to readable text from HTML when there is no plain part', () => {
    const msg = parseMessage({
      id: 'm1',
      payload: {
        mimeType: 'text/html',
        headers,
        body: { data: b64('<style>p{color:red}</style><p>Line one</p><p>Fish &amp; chips&nbsp;now</p>') },
      },
    });
    expect(msg.body).toBe('Line one\nFish & chips now');
  });

  it('walks nested multiparts and lists attachment names without reading their contents', () => {
    const msg = parseMessage({
      id: 'm1',
      payload: {
        mimeType: 'multipart/mixed',
        headers,
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/plain', body: { data: b64('See attached') } }],
          },
          { mimeType: 'application/pdf', filename: 'report.pdf', body: { size: 2048, attachmentId: 'att1' } },
        ],
      },
    });
    expect(msg.body).toBe('See attached');
    expect(msg.attachments).toEqual([{ filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }]);
  });

  it('does not mistake a text attachment for the body', () => {
    const msg = parseMessage({
      id: 'm1',
      payload: {
        mimeType: 'multipart/mixed',
        headers,
        parts: [{ mimeType: 'text/plain', filename: 'notes.txt', body: { size: 9, data: b64('attached') } }],
      },
    });
    expect(msg.body).toBe('');
    expect(msg.attachments).toHaveLength(1);
  });

  it('decodes multi-byte text', () => {
    const msg = parseMessage({ id: 'm', payload: { mimeType: 'text/plain', body: { data: b64('Rp 10 miliar — ok ✓') } } });
    expect(msg.body).toBe('Rp 10 miliar — ok ✓');
  });

  it('cuts an oversized body and says so', () => {
    const msg = parseMessage({
      id: 'm',
      payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(GMAIL_BODY_MAX_CHARS + 100)) } },
    });
    expect(msg.body).toHaveLength(GMAIL_BODY_MAX_CHARS);
    expect(msg.bodyTruncated).toBe(true);
  });
});

describe('htmlToText', () => {
  it('drops script and head content, decodes numeric entities and collapses blank runs', () => {
    expect(htmlToText('<head><title>t</title></head><script>x()</script><div>a</div><div></div><div></div><div>&#169; &#x41;</div>')).toBe(
      'a\n\n© A',
    );
  });

  it('leaves an unknown entity as it was', () => {
    expect(htmlToText('a &madeup; b')).toBe('a &madeup; b');
  });
});
