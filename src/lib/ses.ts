import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

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
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-3';
const SES_REGION = process.env.SES_REGION || AWS_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Hardcoded placeholder sender. Override via env in production.
export const DEFAULT_FROM_EMAIL =
  process.env.SES_FROM_EMAIL || 'Brain 2.0 <noreply@example.com>';
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

/**
 * Send a transactional email via AWS SES (v2 API).
 *
 * Both `html` and `text` are required: SES rejects messages with neither, and
 * a text fallback is good etiquette for spam filters and accessibility.
 *
 * Returns the SES MessageId on success. Throws on credential/config errors or
 * any non-2xx response from SES — callers (the `send-email` queue handler) are
 * expected to let those propagate so Vercel Queues retries with backoff.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getSesClient();

  const fromAddress = input.from || DEFAULT_FROM_EMAIL;
  const toAddresses = Array.isArray(input.to) ? input.to : [input.to];
  const replyTo = input.replyTo || DEFAULT_REPLY_TO;

  if (toAddresses.length === 0) {
    throw new Error('sendEmail: at least one recipient is required');
  }

  const ccAddresses = resolveCcAddresses(input.cc, toAddresses);

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
  return { messageId: response.MessageId ?? '' };
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendEmailWithAttachmentInput extends SendEmailInput {
  attachments: EmailAttachment[];
}

function buildRawMimeMessage(input: SendEmailWithAttachmentInput): Buffer {
  const boundary = `=_MNABrain_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fromAddress = input.from || DEFAULT_FROM_EMAIL;
  const toList = Array.isArray(input.to) ? input.to : [input.to];
  const toAddresses = toList.join(', ');
  const ccAddresses = resolveCcAddresses(input.cc, toList);
  const replyTo = input.replyTo || DEFAULT_REPLY_TO;

  const headers: string[] = [
    `From: ${fromAddress}`,
    `To: ${toAddresses}`,
  ];
  if (ccAddresses.length > 0) headers.push(`Cc: ${ccAddresses.join(', ')}`);
  headers.push(
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  );
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

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

  for (const attachment of input.attachments) {
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
 * Send a transactional email via AWS SES with one or more file attachments.
 * Uses the SES Raw email API since `Content.Simple` cannot carry attachments.
 */
export async function sendEmailWithAttachment(
  input: SendEmailWithAttachmentInput,
): Promise<SendEmailResult> {
  const client = getSesClient();

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

  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: {
      ToAddresses: toAddresses,
      CcAddresses: ccAddresses.length > 0 ? ccAddresses : undefined,
    },
    Content: { Raw: { Data: raw } },
  });

  const response = await client.send(command);
  return { messageId: response.MessageId ?? '' };
}

/**
 * Reset the cached client. Test-only — exported so vitest can clear state
 * between test cases that mock env vars.
 */
export function _resetSesClientForTests(): void {
  cachedClient = null;
}
