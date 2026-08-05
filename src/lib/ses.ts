import net from 'node:net';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import { getActiveWorkspaceId } from '@/lib/workspace';

// SES Configuration
//
// Credentials and region are read from the standard AWS_* env vars (same set
// already used by `src/lib/s3.ts`). The SES API is regional — if the IAM user
// or domain identity lives in a different region than S3, set `SES_REGION`
// explicitly. Otherwise we fall back to `AWS_REGION`.
//
// `SES_FROM_EMAIL` (and optional `SES_REPLY_TO`) point at the sender identity
// you've verified in SES. They are intentionally hardcoded to safe placeholder
// defaults so the codepath compiles in environments where SES isn't yet
// provisioned — but those defaults will fail at send time, which is what we
// want (loud failure rather than silently dropping mail).
//
// Local docker-compose sets `SMTP_HOST=mailhog` so all outbound mail is
// captured by MailHog (UI on :8025) instead of hitting AWS SES.
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-3';
const SES_REGION = process.env.SES_REGION || AWS_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Hardcoded placeholder sender. Override via env in production.
export const DEFAULT_FROM_EMAIL =
  process.env.SES_FROM_EMAIL || 'Investment Brain <noreply@example.com>';
export const DEFAULT_REPLY_TO = process.env.SES_REPLY_TO || undefined;

// Every outbound email is CC'd to this address for visibility/records. This is
// intentionally hardcoded (not env-driven) so the CC is always applied to any
// mail this app sends, regardless of caller or environment.
export const ALWAYS_CC_EMAIL = 'nico.alimin@smma.id';

/**
 * Resolve the CC list for an outbound email: any caller-supplied CCs plus the
 * hardcoded {@link ALWAYS_CC_EMAIL}, deduped case-insensitively and with any
 * address already in the To list removed (no point CC'ing a primary recipient).
 */
function resolveCcAddresses(
  cc: string | string[] | undefined,
  toAddresses: string[],
): string[] {
  const provided = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const toSet = new Set(toAddresses.map((a) => a.trim().toLowerCase()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const addr of [...provided, ALWAYS_CC_EMAIL]) {
    const lower = addr.trim().toLowerCase();
    if (!lower || toSet.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    result.push(addr);
  }
  return result;
}

function smtpConfig(): { host: string; port: number } | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  // Unauthenticated SMTP is for local catchers (MailHog). Refuse in production
  // unless explicitly opted in — a leaked SMTP_HOST must not silently divert mail.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.SMTP_ALLOW_INSECURE !== '1'
  ) {
    throw new Error(
      'SMTP_HOST is set but insecure SMTP is not allowed in production. Unset SMTP_HOST or set SMTP_ALLOW_INSECURE=1 for an intentional override.',
    );
  }
  const port = Number(process.env.SMTP_PORT || '1025');
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid SMTP_PORT: ${process.env.SMTP_PORT}`);
  }
  return { host, port };
}

/** Extract bare address from `Name <addr@x>` or plain `addr@x`. */
function bareEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1] : address).trim();
}

let cachedClient: SESv2Client | null = null;

function getSesClient(): SESv2Client {
  if (cachedClient) return cachedClient;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
    );
  }
  cachedClient = new SESv2Client({
    region: SES_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
  /**
   * Additional CC recipients. {@link ALWAYS_CC_EMAIL} is always appended on top
   * of whatever is passed here, so callers never need to include it explicitly.
   */
  cc?: string | string[];
}

export interface SendEmailResult {
  messageId: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendEmailWithAttachmentInput extends SendEmailInput {
  attachments: EmailAttachment[];
}

/** Strip CR/LF so user-controlled values cannot inject raw MIME headers. */
function sanitizeMimeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildRawMimeMessage(
  input: SendEmailInput & { attachments?: EmailAttachment[] },
): Buffer {
  const boundary = `=_MNABrain_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fromAddress = sanitizeMimeHeaderValue(input.from || DEFAULT_FROM_EMAIL);
  const toList = Array.isArray(input.to) ? input.to : [input.to];
  const toAddresses = sanitizeMimeHeaderValue(toList.join(', '));
  const ccAddresses = resolveCcAddresses(input.cc, toList).map(sanitizeMimeHeaderValue);
  const replyTo = input.replyTo || DEFAULT_REPLY_TO;
  const attachments = input.attachments ?? [];
  const subject = sanitizeMimeHeaderValue(input.subject);

  const headers: string[] = [
    `From: ${fromAddress}`,
    `To: ${toAddresses}`,
  ];
  if (ccAddresses.length > 0) headers.push(`Cc: ${ccAddresses.join(', ')}`);
  headers.push(
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  );
  if (replyTo) headers.push(`Reply-To: ${sanitizeMimeHeaderValue(replyTo)}`);

  const altBoundary = `${boundary}_alt`;
  const parts: string[] = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.text,
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.html,
    '',
    `--${altBoundary}--`,
    '',
  ];

  for (const attachment of attachments) {
    const base64 = attachment.content.toString('base64');
    const wrapped = base64.match(/.{1,76}/g)?.join('\r\n') ?? base64;
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapped,
      '',
    );
  }

  parts.push(`--${boundary}--`, '');

  return Buffer.from(parts.join('\r\n'), 'utf-8');
}

/**
 * Deliver a raw RFC822 message over unauthenticated SMTP (MailHog / Mailpit).
 * No TLS/AUTH — intended for local catchers only.
 */
async function sendViaSmtp(opts: {
  host: string;
  port: number;
  from: string;
  recipients: string[];
  raw: Buffer;
}): Promise<string> {
  const messageId = `smtp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const fromAddr = bareEmail(opts.from);
  const rcpts = opts.recipients.map(bareEmail).filter(Boolean);

  if (rcpts.length === 0) {
    throw new Error('SMTP send: at least one recipient is required');
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    let buffer = '';
    let settled = false;
    let rcptIndex = 0;
    let phase:
      | 'greet'
      | 'ehlo'
      | 'mail'
      | 'rcpt'
      | 'data'
      | 'body'
      | 'quit'
      | 'done' = 'greet';

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve();
    };

    const write = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    // SMTP allows multiline replies (250-... / 250 ...); only advance on the
    // final line of each response (space after the status code).
    const onLine = (line: string) => {
      if (!/^\d{3}[ -]/.test(line)) return;
      const code = Number(line.slice(0, 3));
      const isFinal = line[3] === ' ';
      if (!isFinal) return;

      if (code >= 400) {
        fail(new Error(`SMTP error (${phase}): ${line}`));
        return;
      }

      switch (phase) {
        case 'greet':
          write('EHLO localhost');
          phase = 'ehlo';
          break;
        case 'ehlo':
          write(`MAIL FROM:<${fromAddr}>`);
          phase = 'mail';
          break;
        case 'mail':
          write(`RCPT TO:<${rcpts[rcptIndex]}>`);
          phase = 'rcpt';
          break;
        case 'rcpt':
          rcptIndex += 1;
          if (rcptIndex < rcpts.length) {
            write(`RCPT TO:<${rcpts[rcptIndex]}>`);
          } else {
            write('DATA');
            phase = 'data';
          }
          break;
        case 'data': {
          const payload = opts.raw.toString('utf-8').replace(/\r?\n/g, '\r\n');
          const normalized = payload.endsWith('\r\n') ? payload : `${payload}\r\n`;
          // Dot-stuff lines that start with "."
          const stuffed = normalized
            .split('\r\n')
            .map((l) => (l.startsWith('.') ? `.${l}` : l))
            .join('\r\n');
          socket.write(`${stuffed}.\r\n`);
          phase = 'body';
          break;
        }
        case 'body':
          write('QUIT');
          phase = 'quit';
          break;
        case 'quit':
          phase = 'done';
          succeed();
          break;
        default:
          break;
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    socket.on('error', (err) => fail(err));
    socket.on('timeout', () => fail(new Error('SMTP connection timed out')));
    socket.setTimeout(30_000);
  });

  return messageId;
}

async function captureSent(opts: {
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  fromAddress: string;
  hasAttachments: boolean;
  attachmentCount?: number;
}): Promise<void> {
  captureWorkspaceEvent({
    workspaceId: await getActiveWorkspaceId(),
    distinctId: 'server',
    event: 'email_sent',
    properties: {
      recipient_count: opts.toAddresses.length,
      cc_count: opts.ccAddresses.length,
      subject: opts.subject,
      from_address: opts.fromAddress,
      has_attachments: opts.hasAttachments,
      ...(opts.attachmentCount !== undefined
        ? { attachment_count: opts.attachmentCount }
        : {}),
    },
  });
}

/**
 * Send a transactional email via AWS SES (v2 API), or via SMTP when
 * `SMTP_HOST` is set (local MailHog).
 *
 * Both `html` and `text` are required: SES rejects messages with neither, and
 * a text fallback is good etiquette for spam filters and accessibility.
 *
 * Returns the SES MessageId on success (or a synthetic id for SMTP). Throws on
 * credential/config errors or any non-2xx response from SES — callers (the
 * `send-email` queue handler) are expected to let those propagate so Vercel
 * Queues retries with backoff.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const fromAddress = input.from || DEFAULT_FROM_EMAIL;
  const toAddresses = Array.isArray(input.to) ? input.to : [input.to];
  const replyTo = input.replyTo || DEFAULT_REPLY_TO;

  if (toAddresses.length === 0) {
    throw new Error('sendEmail: at least one recipient is required');
  }

  const ccAddresses = resolveCcAddresses(input.cc, toAddresses);
  const smtp = smtpConfig();

  if (smtp) {
    const raw = buildRawMimeMessage({ ...input, from: fromAddress, replyTo });
    const messageId = await sendViaSmtp({
      host: smtp.host,
      port: smtp.port,
      from: fromAddress,
      recipients: [...toAddresses, ...ccAddresses],
      raw,
    });
    await captureSent({
      toAddresses,
      ccAddresses,
      subject: input.subject,
      fromAddress,
      hasAttachments: false,
    });
    return { messageId };
  }

  const client = getSesClient();

  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: {
      ToAddresses: toAddresses,
      CcAddresses: ccAddresses.length > 0 ? ccAddresses : undefined,
    },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: input.html, Charset: 'UTF-8' },
          Text: { Data: input.text, Charset: 'UTF-8' },
        },
      },
    },
  });

  const response = await client.send(command);

  await captureSent({
    toAddresses,
    ccAddresses,
    subject: input.subject,
    fromAddress,
    hasAttachments: false,
  });

  return { messageId: response.MessageId ?? '' };
}

/**
 * Send a transactional email via AWS SES with one or more file attachments.
 * Uses the SES Raw email API since `Content.Simple` cannot carry attachments.
 * When `SMTP_HOST` is set, delivers the same raw MIME over SMTP (MailHog).
 */
export async function sendEmailWithAttachment(
  input: SendEmailWithAttachmentInput,
): Promise<SendEmailResult> {
  const fromAddress = input.from || DEFAULT_FROM_EMAIL;
  const toAddresses = Array.isArray(input.to) ? input.to : [input.to];

  if (toAddresses.length === 0) {
    throw new Error('sendEmailWithAttachment: at least one recipient is required');
  }
  if (!input.attachments || input.attachments.length === 0) {
    throw new Error('sendEmailWithAttachment: at least one attachment is required');
  }

  const ccAddresses = resolveCcAddresses(input.cc, toAddresses);
  const raw = buildRawMimeMessage(input);
  const smtp = smtpConfig();

  if (smtp) {
    const messageId = await sendViaSmtp({
      host: smtp.host,
      port: smtp.port,
      from: fromAddress,
      recipients: [...toAddresses, ...ccAddresses],
      raw,
    });
    await captureSent({
      toAddresses,
      ccAddresses,
      subject: input.subject,
      fromAddress,
      hasAttachments: true,
      attachmentCount: input.attachments.length,
    });
    return { messageId };
  }

  const client = getSesClient();

  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: {
      ToAddresses: toAddresses,
      CcAddresses: ccAddresses.length > 0 ? ccAddresses : undefined,
    },
    Content: { Raw: { Data: raw } },
  });

  const response = await client.send(command);

  await captureSent({
    toAddresses,
    ccAddresses,
    subject: input.subject,
    fromAddress,
    hasAttachments: true,
    attachmentCount: input.attachments.length,
  });

  return { messageId: response.MessageId ?? '' };
}

/**
 * Reset the cached client. Test-only — exported so vitest can clear state
 * between test cases that mock env vars.
 */
export function _resetSesClientForTests(): void {
  cachedClient = null;
}
