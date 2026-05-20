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

  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: toAddresses },
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

/**
 * Reset the cached client. Test-only — exported so vitest can clear state
 * between test cases that mock env vars.
 */
export function _resetSesClientForTests(): void {
  cachedClient = null;
}
