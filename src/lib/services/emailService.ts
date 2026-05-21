import { sendEmail, type SendEmailInput, type SendEmailResult } from '@/lib/ses';

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

export class EmailService {
  constructor(private readonly sender: EmailSender = sendEmail) {}

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
}
