import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseMboxContent,
  classifyEmails,
  extractEmailList,
  stripAngleBrackets,
  detectAttachments,
  createVaultExport,
} from './googleVaultService';

const CUSTODIAN = 'alice@starcapital.co.id';
const EXTERNAL = 'banker@externalfirm.com';

function makeMboxMessage(opts: {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}): string {
  return (
    `From ${opts.from} Mon Jan  1 00:00:00 2024\r\n` +
    `From: ${opts.from}\r\n` +
    `To: ${opts.to}\r\n` +
    `Subject: ${opts.subject}\r\n` +
    `Date: ${opts.date}\r\n` +
    `\r\n` +
    `${opts.body}\r\n`
  );
}

describe('parseMboxContent', () => {
  it('returns [] for empty string', () => {
    expect(parseMboxContent('')).toEqual([]);
  });

  it('parses a single plain-text email', () => {
    const mbox = makeMboxMessage({
      from: EXTERNAL,
      to: CUSTODIAN,
      subject: 'Deal proposal',
      date: 'Mon, 01 Jan 2024 10:00:00 +0000',
      body: 'Here is the deal proposal.',
    });

    const emails = parseMboxContent(mbox);
    expect(emails).toHaveLength(1);
    expect(emails[0].from_email).toBe(EXTERNAL);
    expect(emails[0].to_email).toBe(CUSTODIAN);
    expect(emails[0].subject).toBe('Deal proposal');
    expect(emails[0].body).toContain('Here is the deal proposal.');
    expect(emails[0].sent_at).toBeTruthy();
  });

  it('parses multiple emails from the same mbox', () => {
    const mbox =
      makeMboxMessage({
        from: EXTERNAL,
        to: CUSTODIAN,
        subject: 'First',
        date: 'Mon, 01 Jan 2024 10:00:00 +0000',
        body: 'First email body.',
      }) +
      makeMboxMessage({
        from: CUSTODIAN,
        to: EXTERNAL,
        subject: 'Second',
        date: 'Mon, 01 Jan 2024 11:00:00 +0000',
        body: 'Second email body.',
      });

    const emails = parseMboxContent(mbox);
    expect(emails).toHaveLength(2);
    expect(emails[0].subject).toBe('First');
    expect(emails[1].subject).toBe('Second');
  });

  it('handles base64 encoded body', () => {
    const bodyText = 'Encoded body content.';
    const encoded = Buffer.from(bodyText).toString('base64');
    const mbox =
      `From ${EXTERNAL} Mon Jan  1 00:00:00 2024\r\n` +
      `From: ${EXTERNAL}\r\n` +
      `To: ${CUSTODIAN}\r\n` +
      `Subject: Encoded\r\n` +
      `Date: Mon, 01 Jan 2024 10:00:00 +0000\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${encoded}\r\n`;

    const emails = parseMboxContent(mbox);
    expect(emails).toHaveLength(1);
    expect(emails[0].body).toContain(bodyText);
  });

  it('handles quoted-printable encoded body', () => {
    const mbox =
      `From ${EXTERNAL} Mon Jan  1 00:00:00 2024\r\n` +
      `From: ${EXTERNAL}\r\n` +
      `To: ${CUSTODIAN}\r\n` +
      `Subject: QP\r\n` +
      `Date: Mon, 01 Jan 2024 10:00:00 +0000\r\n` +
      `Content-Transfer-Encoding: quoted-printable\r\n` +
      `\r\n` +
      `Hello=20World\r\n`;

    const emails = parseMboxContent(mbox);
    expect(emails).toHaveLength(1);
    expect(emails[0].body).toContain('Hello World');
  });

  it('decodes RFC 2047 encoded subject', () => {
    const mbox =
      `From ${EXTERNAL} Mon Jan  1 00:00:00 2024\r\n` +
      `From: ${EXTERNAL}\r\n` +
      `To: ${CUSTODIAN}\r\n` +
      `Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=\r\n` +
      `Date: Mon, 01 Jan 2024 10:00:00 +0000\r\n` +
      `\r\n` +
      `Body.\r\n`;

    const emails = parseMboxContent(mbox);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('Hello World');
  });

  it('returns null sent_at for invalid date header', () => {
    const mbox =
      `From ${EXTERNAL} Mon Jan  1 00:00:00 2024\r\n` +
      `From: ${EXTERNAL}\r\n` +
      `To: ${CUSTODIAN}\r\n` +
      `Subject: Test\r\n` +
      `Date: not-a-date\r\n` +
      `\r\n` +
      `Body.\r\n`;

    const emails = parseMboxContent(mbox);
    expect(emails[0].sent_at).toBeNull();
  });

  it('extracts email address from angle bracket format', () => {
    const mbox =
      `From banker@firm.com Mon Jan  1 00:00:00 2024\r\n` +
      `From: Banker Name <banker@firm.com>\r\n` +
      `To: Alice <${CUSTODIAN}>\r\n` +
      `Subject: Test\r\n` +
      `Date: Mon, 01 Jan 2024 10:00:00 +0000\r\n` +
      `\r\n` +
      `Body.\r\n`;

    const emails = parseMboxContent(mbox);
    expect(emails[0].from_email).toBe('banker@firm.com');
    expect(emails[0].to_email).toBe(CUSTODIAN);
  });
});

describe('classifyEmails', () => {
  const custodianSet = new Set([CUSTODIAN.toLowerCase()]);

  it('classifies external-to-custodian as inbound', () => {
    const emails = parseMboxContent(
      makeMboxMessage({
        from: EXTERNAL,
        to: CUSTODIAN,
        subject: 'Hi',
        date: 'Mon, 01 Jan 2024 10:00:00 +0000',
        body: 'Body',
      }),
    );
    const msgs = classifyEmails(emails, custodianSet);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('inbound');
    expect(msgs[0].contact_email).toBe(EXTERNAL);
  });

  it('classifies custodian-to-external as outbound', () => {
    const emails = parseMboxContent(
      makeMboxMessage({
        from: CUSTODIAN,
        to: EXTERNAL,
        subject: 'Reply',
        date: 'Mon, 01 Jan 2024 11:00:00 +0000',
        body: 'Body',
      }),
    );
    const msgs = classifyEmails(emails, custodianSet);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('outbound');
    expect(msgs[0].contact_email).toBe(EXTERNAL);
  });

  it('skips emails between two custodians', () => {
    const secondCustodian = 'bob@starcapital.co.id';
    const set = new Set([CUSTODIAN.toLowerCase(), secondCustodian.toLowerCase()]);
    const emails = parseMboxContent(
      makeMboxMessage({
        from: CUSTODIAN,
        to: secondCustodian,
        subject: 'Internal',
        date: 'Mon, 01 Jan 2024 12:00:00 +0000',
        body: 'Body',
      }),
    );
    expect(classifyEmails(emails, set)).toHaveLength(0);
  });

  it('skips emails where neither party is a custodian', () => {
    const emails = parseMboxContent(
      makeMboxMessage({
        from: 'nobody@other.com',
        to: 'also@other.com',
        subject: 'Irrelevant',
        date: 'Mon, 01 Jan 2024 12:00:00 +0000',
        body: 'Body',
      }),
    );
    expect(classifyEmails(emails, custodianSet)).toHaveLength(0);
  });

  it('returns [] for empty email list', () => {
    expect(classifyEmails([], custodianSet)).toEqual([]);
  });
});

describe('extractEmailList', () => {
  it('returns [] for undefined / empty input', () => {
    expect(extractEmailList(undefined)).toEqual([]);
    expect(extractEmailList('')).toEqual([]);
  });

  it('parses a single bare address', () => {
    expect(extractEmailList('bob@y.com')).toEqual([
      { address: 'bob@y.com', displayName: null },
    ]);
  });

  it('parses a single address with display name in angle brackets', () => {
    expect(extractEmailList('Bob Smith <bob@y.com>')).toEqual([
      { address: 'bob@y.com', displayName: 'Bob Smith' },
    ]);
  });

  it('parses a quoted display name containing a comma', () => {
    expect(extractEmailList('"Doe, John" <jdoe@x.com>, bob@y.com')).toEqual([
      { address: 'jdoe@x.com', displayName: 'Doe, John' },
      { address: 'bob@y.com', displayName: null },
    ]);
  });

  it('parses display name in parens for bare addresses', () => {
    expect(extractEmailList('bob@y.com (Bob)')).toEqual([
      { address: 'bob@y.com', displayName: 'Bob' },
    ]);
  });

  it('handles multiple quoted-comma entries', () => {
    const out = extractEmailList(
      '"Doe, John" <jdoe@x.com>, "Smith, Jane" <jsmith@z.com>',
    );
    expect(out).toEqual([
      { address: 'jdoe@x.com', displayName: 'Doe, John' },
      { address: 'jsmith@z.com', displayName: 'Smith, Jane' },
    ]);
  });

  it('skips segments without a parseable address', () => {
    expect(extractEmailList('not an email, bob@y.com')).toEqual([
      { address: 'bob@y.com', displayName: null },
    ]);
  });
});

describe('stripAngleBrackets', () => {
  it('returns null for undefined / empty', () => {
    expect(stripAngleBrackets(undefined)).toBeNull();
    expect(stripAngleBrackets('')).toBeNull();
    expect(stripAngleBrackets('   ')).toBeNull();
  });

  it('strips wrapping angle brackets', () => {
    expect(stripAngleBrackets('<abc@x.com>')).toBe('abc@x.com');
  });

  it('leaves bare IDs unchanged', () => {
    expect(stripAngleBrackets('abc@x.com')).toBe('abc@x.com');
  });

  it('trims whitespace', () => {
    expect(stripAngleBrackets('  <abc@x.com>  ')).toBe('abc@x.com');
  });
});

describe('detectAttachments', () => {
  it('returns false for a plain text/plain email', () => {
    expect(
      detectAttachments({ 'content-type': 'text/plain' }, 'hello'),
    ).toBe(false);
  });

  it('returns true when Content-Disposition is attachment', () => {
    expect(
      detectAttachments(
        { 'content-disposition': 'attachment; filename="report.pdf"' },
        '',
      ),
    ).toBe(true);
  });

  it('returns true for a multipart with an attached PDF part', () => {
    const body =
      '--bnd\n' +
      'Content-Type: text/plain\n\n' +
      'hello\n' +
      '--bnd\n' +
      'Content-Type: application/pdf; name="report.pdf"\n' +
      'Content-Disposition: attachment; filename="report.pdf"\n\n' +
      'PDFBYTES\n' +
      '--bnd--\n';
    expect(
      detectAttachments(
        { 'content-type': 'multipart/mixed; boundary="bnd"' },
        body,
      ),
    ).toBe(true);
  });

  it('returns false for multipart/alternative (text + html, no attachment)', () => {
    const body =
      '--bnd\n' +
      'Content-Type: text/plain\n\n' +
      'hello\n' +
      '--bnd\n' +
      'Content-Type: text/html\n\n' +
      '<p>hello</p>\n' +
      '--bnd--\n';
    expect(
      detectAttachments(
        { 'content-type': 'multipart/alternative; boundary="bnd"' },
        body,
      ),
    ).toBe(false);
  });
});

describe('parseMboxContent — extended fields', () => {
  function mkMsgWithHeaders(extra: string, body = 'hello'): string {
    return (
      `From sender@x.com Mon Jan  1 00:00:00 2026\r\n` +
      `From: sender@x.com\r\n` +
      `To: receiver@y.com\r\n` +
      `Subject: test\r\n` +
      `Date: Mon, 1 Jan 2026 00:00:00 +0000\r\n` +
      `${extra}` +
      `\r\n` +
      `${body}\r\n`
    );
  }

  it('captures Message-ID, stripping angle brackets', () => {
    const mbox = mkMsgWithHeaders('Message-ID: <abc123@mail.x.com>\r\n');
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.message_id).toBe('abc123@mail.x.com');
  });

  it('leaves message_id null when the header is missing', () => {
    const mbox = mkMsgWithHeaders('');
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.message_id).toBeNull();
  });

  it('captures multi-recipient To with a quoted display name containing a comma', () => {
    const mbox =
      `From sender@x.com Mon Jan  1 00:00:00 2026\r\n` +
      `From: "Sender Co." <sender@x.com>\r\n` +
      `To: "Doe, John" <jdoe@x.com>, bob@y.com\r\n` +
      `Subject: t\r\n` +
      `Date: Mon, 1 Jan 2026 00:00:00 +0000\r\n` +
      `\r\n` +
      `hi\r\n`;
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.to_emails).toEqual(['jdoe@x.com', 'bob@y.com']);
    expect(parsed.from_display_name).toBe('Sender Co.');
    // Backwards-compat: first address kept as to_email
    expect(parsed.to_email).toBe('jdoe@x.com');
  });

  it('captures Cc list', () => {
    const mbox = mkMsgWithHeaders(
      'Cc: cc1@x.com, "Boss" <cc2@y.com>\r\n',
    );
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.cc_emails).toEqual(['cc1@x.com', 'cc2@y.com']);
  });

  it('captures In-Reply-To, References, X-Gm-Thrid', () => {
    const mbox = mkMsgWithHeaders(
      'In-Reply-To: <parent@mail.x.com>\r\n' +
        'References: <a@mail.x.com> <b@mail.x.com> <c@mail.x.com>\r\n' +
        'X-Gm-Thrid: 1234567890\r\n',
    );
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.in_reply_to).toBe('parent@mail.x.com');
    expect(parsed.references).toBe(
      '<a@mail.x.com> <b@mail.x.com> <c@mail.x.com>',
    );
    expect(parsed.gmail_thread_id).toBe('1234567890');
  });

  it('detects has_attachments in a multipart message', () => {
    const mbox =
      `From sender@x.com Mon Jan  1 00:00:00 2026\r\n` +
      `From: sender@x.com\r\n` +
      `To: receiver@y.com\r\n` +
      `Subject: with attachment\r\n` +
      `Date: Mon, 1 Jan 2026 00:00:00 +0000\r\n` +
      `Content-Type: multipart/mixed; boundary="bnd"\r\n` +
      `\r\n` +
      `--bnd\r\n` +
      `Content-Type: text/plain\r\n` +
      `\r\n` +
      `body\r\n` +
      `--bnd\r\n` +
      `Content-Type: application/pdf; name="x.pdf"\r\n` +
      `Content-Disposition: attachment; filename="x.pdf"\r\n` +
      `\r\n` +
      `PDFBYTES\r\n` +
      `--bnd--\r\n`;
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.has_attachments).toBe(true);
  });

  it('populates raw_headers with the decoded header map', () => {
    const mbox = mkMsgWithHeaders('Message-ID: <abc@x.com>\r\n');
    const [parsed] = parseMboxContent(mbox);
    expect(parsed.raw_headers['message-id']).toBe('<abc@x.com>');
    expect(parsed.raw_headers['from']).toBe('sender@x.com');
  });
});

describe('createVaultExport', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'export-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-02T00:00:00Z');

  it('requests an MBOX MAIL export without Gmail drafts', async () => {
    const fetchMock = stubFetch();
    await expect(
      createVaultExport('tok', 'm1', ['a@starcapital.co.id'], start, end),
    ).resolves.toBe('export-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/matters\/m1\/exports$/);
    const body = JSON.parse(init.body);
    expect(body.name).toMatch(/^Email Export /);
    expect(body.query).toEqual({
      corpus: 'MAIL',
      dataScope: 'ALL_DATA',
      searchMethod: 'ACCOUNT',
      accountInfo: { emails: ['a@starcapital.co.id'] },
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      mailOptions: { excludeDrafts: true },
    });
    expect(body.exportOptions).toEqual({
      mailOptions: {
        exportFormat: 'MBOX',
        showConfidentialModeContent: false,
        exportLinkedDriveFiles: false,
        useNewExport: true,
      },
    });
  });

});
