import { describe, it, expect } from 'vitest';
import { parseMboxContent, classifyEmails } from './googleVaultService';

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
