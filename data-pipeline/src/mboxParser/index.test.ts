import { describe, it, expect } from 'vitest';
import { parseAndFilterMbox, classifyByCustodian } from './index';

function makeMbox(
  msgs: Array<{
    from: string;
    to: string;
    subject?: string;
    body?: string;
    extraHeaders?: string;
    contentType?: string;
    messageId?: string;
  }>,
): string {
  return msgs
    .map((m, i) => {
      const extra = m.extraHeaders ? `${m.extraHeaders}\n` : '';
      const ct = m.contentType ?? 'text/plain';
      const mid = m.messageId ?? `<msg-${i}@x>`;
      return (
        `From envelope Mon Jan  1 00:00:00 2024\n` +
        `From: ${m.from}\n` +
        `To: ${m.to}\n` +
        `Subject: ${m.subject ?? 'Subject ' + i}\n` +
        `Date: Mon, 01 Jan 2024 10:0${i}:00 +0000\n` +
        `Message-ID: ${mid}\n` +
        `Content-Type: ${ct}\n` +
        extra +
        `\n` +
        `${m.body ?? 'Body content that is long enough to keep.'}\n`
      );
    })
    .join('');
}

describe('parseAndFilterMbox', () => {
  it('keeps clean inbound emails', () => {
    const mbox = makeMbox([{ from: 'banker@x.com', to: 'alice@y.com', body: 'Hi alice, here is a long enough body.' }]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(1);
    expect(counts.written).toBe(1);
  });

  it('filters auto-replies', () => {
    const mbox = makeMbox([
      { from: 'a@x.com', to: 'b@y.com', body: 'long enough body for the kept message.' },
      {
        from: 'ooo@x.com',
        to: 'b@y.com',
        subject: 'Out of Office',
        body: 'I am away until next week, thanks.',
      },
    ]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(1);
    expect(counts.filtered.auto_reply).toBe(1);
  });

  it('filters newsletters', () => {
    const mbox = makeMbox([
      {
        from: 'news@x.com',
        to: 'b@y.com',
        extraHeaders: 'List-Unsubscribe: <https://x.com/u>',
        body: 'newsletter body long enough for the minimum threshold.',
      },
    ]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(0);
    expect(counts.filtered.newsletter).toBe(1);
  });

  it('filters calendar invites', () => {
    const mbox = makeMbox([
      {
        from: 'a@x.com',
        to: 'b@y.com',
        contentType: 'text/calendar; method=REQUEST',
        body: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n',
      },
    ]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(0);
    expect(counts.filtered.calendar_invite).toBe(1);
  });

  it('filters internal-only when dropInternalOnly is true', () => {
    const mbox = makeMbox([
      { from: 'a@x.com', to: 'b@x.com', body: 'internal chatter content that is plenty long.' },
    ]);
    const { records, counts } = parseAndFilterMbox(mbox, {
      ourDomains: new Set(['x.com']),
      dropInternalOnly: true,
    });
    expect(records).toHaveLength(0);
    expect(counts.filtered.internal_only).toBe(1);
  });

  it('keeps internal-only by default', () => {
    const mbox = makeMbox([
      { from: 'a@x.com', to: 'b@x.com', body: 'internal chatter content that is plenty long.' },
    ]);
    const { records } = parseAndFilterMbox(mbox, { ourDomains: new Set(['x.com']) });
    expect(records).toHaveLength(1);
  });

  it('skips bodies shorter than minChars', () => {
    const mbox = makeMbox([{ from: 'a@x.com', to: 'b@y.com', body: 'short' }]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(0);
    expect(counts.skipped).toBe(1);
  });

  it('deduplicates by Message-ID', () => {
    const dup = '<dup@x.com>';
    const mbox = makeMbox([
      { from: 'a@x.com', to: 'b@y.com', messageId: dup, body: 'first long-enough message body.' },
      { from: 'a@x.com', to: 'b@y.com', messageId: dup, body: 'second long-enough message body.' },
    ]);
    const { records, counts } = parseAndFilterMbox(mbox);
    expect(records).toHaveLength(1);
    expect(counts.dupes).toBe(1);
  });

  it('keeps filtered messages tagged when auditFilter is true', () => {
    const mbox = makeMbox([
      {
        from: 'news@x.com',
        to: 'b@y.com',
        extraHeaders: 'List-Unsubscribe: <https://x.com/u>',
        body: 'newsletter body long enough for the minimum threshold.',
      },
    ]);
    const { records } = parseAndFilterMbox(mbox, { auditFilter: true });
    expect(records).toHaveLength(1);
    expect(records[0].filter_reason).toBe('newsletter');
  });

  it('respects limit', () => {
    const mbox = makeMbox([
      { from: 'a@x.com', to: 'b@y.com', body: 'long enough body number one for testing limit.' },
      { from: 'a@x.com', to: 'b@y.com', body: 'long enough body number two for testing limit.' },
      { from: 'a@x.com', to: 'b@y.com', body: 'long enough body number three for testing limit.' },
    ]);
    const { records } = parseAndFilterMbox(mbox, { limit: 2 });
    expect(records).toHaveLength(2);
  });

  it('returns empty result for empty mbox', () => {
    const result = parseAndFilterMbox('');
    expect(result.records).toEqual([]);
    expect(result.counts.written).toBe(0);
  });
});

describe('classifyByCustodian', () => {
  const custodians = new Set(['alice@x.com', 'bob@x.com']);

  it('classifies external→custodian as inbound', () => {
    const mbox = makeMbox([
      { from: 'banker@ext.com', to: 'alice@x.com', body: 'inbound deal email long enough body.' },
    ]);
    const { records } = parseAndFilterMbox(mbox);
    const msgs = classifyByCustodian(records, custodians);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('inbound');
    expect(msgs[0].contact_email).toBe('banker@ext.com');
  });

  it('classifies custodian→external as outbound', () => {
    const mbox = makeMbox([
      { from: 'alice@x.com', to: 'banker@ext.com', body: 'outbound reply email long enough body.' },
    ]);
    const { records } = parseAndFilterMbox(mbox);
    const msgs = classifyByCustodian(records, custodians);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('outbound');
    expect(msgs[0].contact_email).toBe('banker@ext.com');
  });

  it('skips custodian↔custodian', () => {
    const mbox = makeMbox([
      { from: 'alice@x.com', to: 'bob@x.com', body: 'internal email long enough body content.' },
    ]);
    const { records } = parseAndFilterMbox(mbox);
    expect(classifyByCustodian(records, custodians)).toHaveLength(0);
  });

  it('skips when neither party is a custodian', () => {
    const mbox = makeMbox([
      { from: 'x@a.com', to: 'y@b.com', body: 'cc-only email long enough body content here.' },
    ]);
    const { records } = parseAndFilterMbox(mbox);
    expect(classifyByCustodian(records, custodians)).toHaveLength(0);
  });
});
