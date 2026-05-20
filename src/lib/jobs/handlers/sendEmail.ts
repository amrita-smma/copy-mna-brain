import { EmailService } from '@/lib/services/emailService';

export const SEND_EMAIL_TIMEOUT_SECONDS = 30;

/**
 * Discriminated union of every email kind the `send-email` queue handler can
 * produce. Add a new variant when you add a new transactional email — the
 * `switch` below is exhaustive, so TypeScript will flag any missing branch.
 */
export type SendEmailPayload = {
  kind: 'forgot_password';
  to: string;
  token: string;
  ttlMinutes?: number;
  appUrl?: string;
};

export interface SendEmailJobResult {
  kind: SendEmailPayload['kind'];
  to: string;
  messageId: string;
}

/**
 * Generic transactional email handler. Constructs the right template based on
 * the `kind` discriminator and delegates the actual SES call to `EmailService`.
 *
 * Invoked by the `send-email` queue consumer route with the queue message as
 * its payload. Intentionally tiny: payload validation + dispatch. Template
 * rendering lives in EmailService so it can be unit-tested in isolation.
 */
export async function runSendEmail(
  payload: SendEmailPayload,
  _deps: { emailService?: EmailService } = {},
): Promise<SendEmailJobResult> {
  const emailService = _deps.emailService ?? new EmailService();

  if (!payload || typeof payload !== 'object') {
    throw new Error('send_email: invalid payload');
  }
  if (!payload.to) throw new Error('send_email: `to` is required');

  switch (payload.kind) {
    case 'forgot_password': {
      if (!payload.token) {
        throw new Error('send_email[forgot_password]: `token` is required');
      }
      const { messageId } = await emailService.sendForgotPasswordEmail({
        email: payload.to,
        token: payload.token,
        ttlMinutes: payload.ttlMinutes,
        appUrl: payload.appUrl,
      });
      return { kind: 'forgot_password', to: payload.to, messageId };
    }
    default: {
      // Exhaustiveness check — adding a new `kind` without a case here is a
      // compile-time error.
      const _exhaustive: never = payload.kind;
      throw new Error(`send_email: unsupported kind ${String(_exhaustive)}`);
    }
  }
}
