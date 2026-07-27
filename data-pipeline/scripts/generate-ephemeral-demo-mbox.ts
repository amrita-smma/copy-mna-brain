/**
 * Generate data-pipeline/fixtures/ephemeral-email-demo.mbox — a comprehensive
 * fixture for local single-pass processMboxSource testing.
 *
 * Usage:
 *   pnpm --filter data-pipeline exec tsx scripts/generate-ephemeral-demo-mbox.ts
 *
 * Custodian mailbox used in To:/Cc: headers: analyst@starcapital.co.id
 * (must exist with is_email_synced=true for mart visibility).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACHMENT_MIN_BYTES } from '../src/mboxParser/parser';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../fixtures/ephemeral-email-demo.mbox');

const CUSTODIAN = 'analyst@starcapital.co.id';
const DATE = 'Fri, 24 Jul 2026 10:00:00 +0000';

/** Pad binary to at least ATTACHMENT_MIN_BYTES so allowlisted extractors see it. */
function paddedBytes(label: string, min = ATTACHMENT_MIN_BYTES + 512): Buffer {
  const header = Buffer.from(`%PDF-1.4\n% ephemeral-demo ${label}\n`, 'utf8');
  const pad = Buffer.alloc(Math.max(0, min - header.length), 0x20);
  return Buffer.concat([header, pad, Buffer.from('\n%%EOF\n', 'utf8')]);
}

function b64Wrapped(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/(.{76})/g, '$1\n')
    .trim();
}

function escapeMboxBody(body: string): string {
  // mboxrd: lines beginning with "From " must be escaped.
  return body.replace(/^From /gm, '>From ');
}

function msg(opts: {
  envelopeFrom: string;
  headers: string[];
  body: string;
}): string {
  const hdr = opts.headers.join('\n');
  const body = escapeMboxBody(opts.body.replace(/\n/g, '\r\n'));
  return (
    `From ${opts.envelopeFrom} Fri Jul 24 10:00:00 2026\n` +
    `${hdr}\n` +
    `\n` +
    `${body}\n` +
    `\n`
  );
}

function multipart(opts: {
  envelopeFrom: string;
  headers: string[];
  textBody: string;
  attachment: {
    filename: string;
    mime: string;
    bytes: Buffer;
  };
}): string {
  const boundary = `ephemeral_demo_${opts.attachment.filename.replace(/\W/g, '_')}`;
  const headers = [
    ...opts.headers,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const body = [
    `This is a multi-part message in MIME format.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    opts.textBody,
    ``,
    `--${boundary}`,
    `Content-Type: ${opts.attachment.mime}; name="${opts.attachment.filename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    ``,
    b64Wrapped(opts.attachment.bytes),
    ``,
    `--${boundary}--`,
    ``,
  ].join('\n');
  return msg({ envelopeFrom: opts.envelopeFrom, headers, body });
}

const parts: string[] = [];

// ── 01 KEEP — inbound deal (term sheet) ─────────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'alice.chen@goldmansacks.example.com',
    headers: [
      `From: "Alice Chen" <alice.chen@goldmansacks.example.com>`,
      `To: "${CUSTODIAN}" <${CUSTODIAN}>`,
      `Subject: Project Titanium — Term Sheet v3`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-01-term-sheet@goldmansacks.example.com>`,
    ],
    body: [
      `Hi team,`,
      ``,
      `Please find our comments on the Project Titanium term sheet.`,
      `Key open points: valuation band, exclusivity window, and NDA schedule.`,
      `Happy to jump on a call to walk through the acquisition structure.`,
      ``,
      `Best,`,
      `Alice Chen`,
      `Goldman Sacks IBD`,
    ].join('\n'),
  }),
);

// ── 02 KEEP — deal + PDF (CIM) → AFD ────────────────────────────────────────
parts.push(
  multipart({
    envelopeFrom: 'bob.lee@morganstanley.example.com',
    headers: [
      `From: "Bob Lee" <bob.lee@morganstanley.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Cc: dealteam@morganstanley.example.com`,
      `Subject: Confidential Information Memorandum — Project Aurora`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-02-cim-pdf@morganstanley.example.com>`,
    ],
    textBody: [
      `Attached is the CIM for Project Aurora (semiconductors add-on).`,
      `Please treat as confidential under the existing NDA.`,
      `We are running a structured process with first-round bids next week.`,
    ].join('\n'),
    attachment: {
      filename: 'Project_Aurora_CIM.pdf',
      mime: 'application/pdf',
      bytes: paddedBytes('CIM'),
    },
  }),
);

// ── 03 KEEP — deal + XLSX (Office bypass Haiku → AFD) ────────────────────────
parts.push(
  multipart({
    envelopeFrom: 'models@jpmm.example.com',
    headers: [
      `From: "JPMM Models" <models@jpmm.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Project Nova LBO model — financing sensitivities`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-03-lbo-xlsx@jpmm.example.com>`,
    ],
    textBody: [
      `Sharing the updated LBO model with financing and IRR sensitivities.`,
      `Tabs: Sources & Uses, Operating Model, Returns.`,
    ].join('\n'),
    attachment: {
      filename: 'Project_Nova_LBO_Model.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: paddedBytes('XLSX'),
    },
  }),
);

// ── 04 SKIP step1 — personal Gmail domain_blacklist ─────────────────────────
parts.push(
  msg({
    envelopeFrom: 'friend@gmail.com',
    headers: [
      `From: "Old Friend" <friend@gmail.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Weekend plans?`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-04-gmail@gmail.com>`,
    ],
    body: `Hey — are you free for brunch this weekend?\n`,
  }),
);

// ── 05 SKIP step2 — sensitive subject (salary) ──────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'hr@externalcorp.example.com',
    headers: [
      `From: HR <hr@externalcorp.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Salary review cycle — confidential`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-05-salary@externalcorp.example.com>`,
    ],
    body: `Please complete your salary review form by Friday.\n`,
  }),
);

// ── 06 SKIP step3 — sensitive attachment filename (payslip) ─────────────────
parts.push(
  multipart({
    envelopeFrom: 'payroll@vendor.example.com',
    headers: [
      `From: Payroll <payroll@vendor.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Documents for your records`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-06-payslip@vendor.example.com>`,
    ],
    textBody: `Attached as requested.`,
    attachment: {
      filename: 'July_2026_payslip.pdf',
      mime: 'application/pdf',
      bytes: paddedBytes('PAYSLIP'),
    },
  }),
);

// ── 07 SKIP step4 — OOO / auto-reply ────────────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'banker@lazard.example.com',
    headers: [
      `From: "Banker" <banker@lazard.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Out of Office: away until Monday`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-07-ooo@lazard.example.com>`,
      `Auto-Submitted: auto-replied`,
    ],
    body: `I am currently out of office with limited access to email.\n`,
  }),
);

// ── 08 SKIP step4 — newsletter ──────────────────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'newsletter@dealwire.example.com',
    headers: [
      `From: DealWire <newsletter@dealwire.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: This week in M&A — top 10 deals`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-08-newsletter@dealwire.example.com>`,
      `List-Unsubscribe: <https://dealwire.example.com/unsub>`,
      `Precedence: bulk`,
    ],
    body: `Top stories: mega-mergers, IPO window, and PE fundraising.\n`,
  }),
);

// ── 09 SKIP step4 — internal-only ───────────────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'colleague@starcapital.co.id',
    headers: [
      `From: "Colleague" <colleague@starcapital.co.id>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Internal standup notes`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-09-internal@starcapital.co.id>`,
    ],
    body: `Quick notes from today's internal standup — no external parties.\n`,
  }),
);

// ── 10 SKIP step4 — personal / social (no deal keywords) ────────────────────
parts.push(
  msg({
    envelopeFrom: 'peer@boutique.example.com',
    headers: [
      `From: "Peer" <peer@boutique.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Coffee catch-up next week?`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-10-coffee@boutique.example.com>`,
    ],
    body: `Would love to grab coffee and catch up — no agenda.\n`,
  }),
);

// ── 11 KEEP — outbound from internal banker → external ──────────────────────
parts.push(
  msg({
    envelopeFrom: CUSTODIAN,
    headers: [
      `From: "Star Analyst" <${CUSTODIAN}>`,
      `To: "Alice Chen" <alice.chen@goldmansacks.example.com>`,
      `Subject: RE: Project Titanium — Term Sheet v3`,
      `Date: Fri, 24 Jul 2026 11:30:00 +0000`,
      `Message-ID: <ephemeral-demo-11-outbound@starcapital.co.id>`,
      `In-Reply-To: <ephemeral-demo-01-term-sheet@goldmansacks.example.com>`,
      `References: <ephemeral-demo-01-term-sheet@goldmansacks.example.com>`,
    ],
    body: [
      `Alice — thanks, we are aligned on exclusivity.`,
      `Please send the revised term sheet and we will circle internally on valuation.`,
      ``,
      `Regards,`,
      `Star Analyst`,
    ].join('\n'),
  }),
);

// ── 12 KEEP — inbound reply (response-time pair with 01/11) ─────────────────
parts.push(
  msg({
    envelopeFrom: 'alice.chen@goldmansacks.example.com',
    headers: [
      `From: "Alice Chen" <alice.chen@goldmansacks.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: RE: Project Titanium — Term Sheet v3`,
      `Date: Fri, 24 Jul 2026 12:00:00 +0000`,
      `Message-ID: <ephemeral-demo-12-inbound-reply@goldmansacks.example.com>`,
      `In-Reply-To: <ephemeral-demo-11-outbound@starcapital.co.id>`,
      `References: <ephemeral-demo-01-term-sheet@goldmansacks.example.com> <ephemeral-demo-11-outbound@starcapital.co.id>`,
    ],
    body: [
      `Attached revisions incoming separately.`,
      `Also looping in our sector coverage for the diligence Q&A.`,
    ].join('\n'),
  }),
);

// ── 13 SKIP step4 — calendar invite ─────────────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'scheduler@external.example.com',
    headers: [
      `From: Scheduler <scheduler@external.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Meeting: Process update`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-13-calendar@external.example.com>`,
      `Content-Type: text/calendar; method=REQUEST; charset=UTF-8`,
    ],
    body: [
      `BEGIN:VCALENDAR`,
      `VERSION:2.0`,
      `BEGIN:VEVENT`,
      `SUMMARY:Process update`,
      `DTSTART:20260725T030000Z`,
      `END:VEVENT`,
      `END:VCALENDAR`,
    ].join('\n'),
  }),
);

// ── 14 KEEP — explicit pitch / related-company signal ───────────────────────
parts.push(
  msg({
    envelopeFrom: 'banker@evercore.example.com',
    headers: [
      `From: "Evercore MD" <banker@evercore.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Introducing Nordfjord Robotics as a potential add-on`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-14-pitch@evercore.example.com>`,
    ],
    body: [
      `We are pitching Nordfjord Robotics as a potential add-on for your portfolio.`,
      `They have strong industrial IoT exposure and an open mandate for a minority growth round.`,
      `Happy to share a teaser and schedule management meetings.`,
    ].join('\n'),
  }),
);

// ── 15 SKIP step4 — noreply local-part newsletter heuristic ─────────────────
parts.push(
  msg({
    envelopeFrom: 'noreply@saas-alerts.example.com',
    headers: [
      `From: Alerts <noreply@saas-alerts.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Your weekly digest is ready`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-15-noreply@saas-alerts.example.com>`,
    ],
    body: `Click here to view your digest.\n`,
  }),
);

// ── 16 KEEP — DOCX attachment (Office direct → AFD) ─────────────────────────
parts.push(
  multipart({
    envelopeFrom: 'counsel@kirkland.example.com',
    headers: [
      `From: "Deal Counsel" <counsel@kirkland.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Project Titanium — draft SPA markup`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-16-spa-docx@kirkland.example.com>`,
    ],
    textBody: [
      `Attached is our first markup of the share purchase agreement.`,
      `Please review reps & warranties and conditions precedent.`,
    ].join('\n'),
    attachment: {
      filename: 'Project_Titanium_SPA_markup.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: paddedBytes('DOCX'),
    },
  }),
);

// ── 17 SKIP step2 — PIP / HR confidential ───────────────────────────────────
parts.push(
  msg({
    envelopeFrom: 'people@partnercorp.example.com',
    headers: [
      `From: People Ops <people@partnercorp.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: HR confidential — performance improvement plan`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-17-pip@partnercorp.example.com>`,
    ],
    body: `Please treat this PIP discussion as strictly confidential.\n`,
  }),
);

// ── 18 KEEP — social word BUT deal keyword wins (must ingest) ───────────────
parts.push(
  msg({
    envelopeFrom: 'md@rothschild.example.com',
    headers: [
      `From: "Rothschild MD" <md@rothschild.example.com>`,
      `To: <${CUSTODIAN}>`,
      `Subject: Lunch to discuss Project Helios NDA and valuation`,
      `Date: ${DATE}`,
      `Message-ID: <ephemeral-demo-18-lunch-deal@rothschild.example.com>`,
    ],
    body: [
      `Can we do lunch next week to walk through the Project Helios NDA`,
      `and the latest valuation bridge ahead of exclusivity?`,
    ].join('\n'),
  }),
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, parts.join(''), 'utf8');

const keep = [1, 2, 3, 11, 12, 14, 16, 18];
const skip = [4, 5, 6, 7, 8, 9, 10, 13, 15, 17];
console.log(`Wrote ${outPath}`);
console.log(`Messages: ${parts.length} (expect keep ~${keep.length}, skip ~${skip.length})`);
console.log(`Custodian in headers: ${CUSTODIAN}`);
console.log(`Attachment pad size: >= ${ATTACHMENT_MIN_BYTES} bytes`);
