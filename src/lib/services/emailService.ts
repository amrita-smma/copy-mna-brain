import {
  sendEmail,
  sendEmailWithAttachment,
  type SendEmailInput,
  type SendEmailResult,
  type SendEmailWithAttachmentInput,
} from '@/lib/ses';

const RESET_PATH = '/reset-password';

/**
 * Allow a `sender` (the SES wrapper) to be injected for tests. The default
 * implementation is the production `sendEmail` from `@/lib/ses`.
 */
export type EmailSender = (input: SendEmailInput) => Promise<SendEmailResult>;

export interface ForgotPasswordEmailInput {
  email: string;
  token: string;
  /**
   * The app's base URL used to build the reset link. Sourced from the
   * incoming request's origin in the API route, then carried through the
   * queue payload to this handler.
   */
  appUrl: string;
  /** Token TTL in minutes — surfaced in the body so users know the urgency. */
  ttlMinutes?: number;
}

/**
 * Build the reset URL that goes in the email body. Encodes the token to keep
 * special characters safe inside a query string.
 */
export function buildResetUrl(token: string, appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}${RESET_PATH}?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderForgotPasswordEmail(input: {
  resetUrl: string;
  ttlMinutes: number;
}): { subject: string; html: string; text: string } {
  const { resetUrl, ttlMinutes } = input;
  const safeUrl = escapeHtml(resetUrl);
  const subject = 'Reset your Brain 2.0 password';

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px; color:#111;">
    <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px; font-size:20px;">Reset your password</h1>
      <p style="margin:0 0 16px; line-height:1.5;">
        We received a request to reset the password for your Brain 2.0 account.
        Click the button below to choose a new password.
      </p>
      <p style="margin:24px 0;">
        <a
          href="${safeUrl}"
          style="display:inline-block; background:#111; color:#fff; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;"
        >Reset password</a>
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        Or paste this link into your browser:<br />
        <a href="${safeUrl}" style="color:#2563eb; word-break:break-all;">${safeUrl}</a>
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        This link expires in ${ttlMinutes} minutes. If you didn't request a
        password reset, you can safely ignore this email — your current
        password will continue to work.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    'Reset your Brain 2.0 password',
    '',
    'We received a request to reset the password for your Brain 2.0 account.',
    'Open the following link in your browser to choose a new password:',
    '',
    resetUrl,
    '',
    `This link expires in ${ttlMinutes} minutes. If you didn't request a`,
    'password reset, you can safely ignore this email — your current',
    'password will continue to work.',
  ].join('\n');

  return { subject, html, text };
}

export interface ResearchSummaryEmailInput {
  /** Recipient address — typically the requesting user's own email. */
  email: string;
  /** Heading used in the email body and PDF document title. */
  title: string;
  /**
   * Markdown-ish summary text the agent already composed. Forwarded verbatim
   * into the PDF body (rendered with light heading/bullet handling).
   */
  summaryMarkdown: string;
  /** Pre-rendered PDF bytes to attach. */
  pdfBuffer: Buffer;
  /** Optional override for the email subject — defaults to `Research summary: <title>`. */
  subject?: string;
  /** Optional PDF attachment filename — defaults to a slug of the title. */
  filename?: string;
}

export type AttachmentSender = (
  input: SendEmailWithAttachmentInput,
) => Promise<SendEmailResult>;

export function renderResearchSummaryEmail(input: {
  title: string;
  summaryMarkdown: string;
}): { subject: string; html: string; text: string } {
  const subject = `Research summary: ${input.title}`;
  const safeTitle = escapeHtml(input.title);
  const preview = input.summaryMarkdown.length > 280
    ? `${input.summaryMarkdown.slice(0, 280).trim()}…`
    : input.summaryMarkdown;
  const safePreview = escapeHtml(preview).replace(/\n/g, '<br />');

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px; color:#111;">
    <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px; font-size:20px;">${safeTitle}</h1>
      <p style="margin:0 0 16px; line-height:1.5;">
        Your research summary is ready. The full write-up is attached as a PDF.
      </p>
      <div style="margin:16px 0; padding:16px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; color:#374151; font-size:14px; line-height:1.5;">
        ${safePreview}
      </div>
      <p style="margin:16px 0 0; color:#52525b; font-size:13px;">
        Sent by Brain 2.0 Copilot at your request.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    input.title,
    '',
    'Your research summary is ready. The full write-up is attached as a PDF.',
    '',
    preview,
    '',
    'Sent by Brain 2.0 Copilot at your request.',
  ].join('\n');

  return { subject, html, text };
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'research-summary';
}

export class EmailService {
  constructor(
    private readonly sender: EmailSender = sendEmail,
    private readonly attachmentSender: AttachmentSender = sendEmailWithAttachment,
  ) {}

  /**
   * Send the forgot-password email containing a reset link to the user.
   * The `token` is the raw reset token from `reset_password_tokens.token`.
   */
  async sendForgotPasswordEmail(
    input: ForgotPasswordEmailInput,
  ): Promise<SendEmailResult> {
    const { email, token, appUrl } = input;
    if (!email) throw new Error('sendForgotPasswordEmail: email is required');
    if (!token) throw new Error('sendForgotPasswordEmail: token is required');
    if (!appUrl) throw new Error('sendForgotPasswordEmail: appUrl is required');

    const ttlMinutes = input.ttlMinutes ?? 60;
    const resetUrl = buildResetUrl(token, appUrl);
    const { subject, html, text } = renderForgotPasswordEmail({ resetUrl, ttlMinutes });

    return this.sender({
      to: email,
      subject,
      html,
      text,
    });
  }

  /**
   * Send a research-summary email with the agent-composed write-up attached
   * as a PDF. The HTML/text body carries a short preview so the message is
   * useful even before opening the attachment.
   */
  async sendResearchSummaryEmail(
    input: ResearchSummaryEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) {
      throw new Error('sendResearchSummaryEmail: email is required');
    }
    if (!input.title) {
      throw new Error('sendResearchSummaryEmail: title is required');
    }
    if (!input.summaryMarkdown) {
      throw new Error('sendResearchSummaryEmail: summaryMarkdown is required');
    }
    if (!input.pdfBuffer || input.pdfBuffer.length === 0) {
      throw new Error('sendResearchSummaryEmail: pdfBuffer is required');
    }

    const { subject, html, text } = renderResearchSummaryEmail({
      title: input.title,
      summaryMarkdown: input.summaryMarkdown,
    });

    const filename = input.filename ?? `${slugifyTitle(input.title)}.pdf`;

    return this.attachmentSender({
      to: input.email,
      subject: input.subject ?? subject,
      html,
      text,
      attachments: [
        {
          filename,
          content: input.pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
  }
}
