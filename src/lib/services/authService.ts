import { randomBytes } from 'crypto';
import type { ResetPasswordTokenRepository, UserRepository } from '@/lib/repositories';
import { hashPassword, verifyPassword } from './password';
import { enqueueSendEmail } from '@/lib/queue';
import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_TOKEN_TTL_MINUTES = Math.round(RESET_TOKEN_TTL_MS / 60_000);

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly resetTokenRepo: ResetPasswordTokenRepository,
  ) {}

  async signIn(email: string, password: string) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) throw new Error('Invalid email or password');
    const ok = await verifyPassword(password, user.password);
    if (!ok) throw new Error('Invalid email or password');
    return user;
  }

  async signUp(email: string, name: string, password: string) {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail || !name || !password) {
      throw new Error('Email, name, and password are required');
    }
    const existing = await this.userRepo.findByEmail(normalizedEmail);
    if (existing) throw new Error('Email already registered');
    const passwordHash = await hashPassword(password);
    await this.userRepo.create({ email: normalizedEmail, name, password: passwordHash });
  }

  /**
   * Initiate the forgot-password flow.
   *
   * Always returns void regardless of whether the email is registered, so the
   * response cannot be used to enumerate accounts. The reset link is delivered
   * out-of-band via AWS SES, dispatched through Vercel Queues so the SES call
   * happens after the HTTP response has returned.
   *
   * Behavior:
   *   - Unknown email → no DB writes, no message published.
   *   - Known email   → token persisted in `reset_password_tokens`, then a
   *                     message is published to the `send-email` topic.
   *                     The consumer route (`/api/queues/send-email`) renders
   *                     and sends the email via SES.
   *
   * Errors from the queue publish are deliberately swallowed: we don't want a
   * transient queue outage to surface as an error response (which would leak
   * the email's account status). The token is still in the DB and the user
   * can retry.
   */
  async forgetPassword(email: string, appUrl: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) return;

    const user = await this.userRepo.findByEmail(normalizedEmail);
    if (!user) return;

    const token = randomBytes(24).toString('hex');
    const validUntil = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await this.resetTokenRepo.create({
      token,
      user_id: user.id,
      valid_until: validUntil,
    });

    const payload: SendEmailPayload = {
      kind: 'forgot_password',
      to: normalizedEmail,
      token,
      appUrl,
      ttlMinutes: RESET_TOKEN_TTL_MINUTES,
    };

    try {
      await enqueueSendEmail(payload);
    } catch (err) {
      // Log but don't throw — see method comment for rationale.
      console.error('[auth] enqueueSendEmail failed:', err);
    }
  }

  async resetPassword(key: string, password: string): Promise<void> {
    if (!key || !password) throw new Error('Key and password are required');
    const row = await this.resetTokenRepo.findValidByToken(key);
    if (!row) throw new Error('Invalid or expired reset token');
    const passwordHash = await hashPassword(password);
    await this.userRepo.update(row.user_id, { password: passwordHash });
    await this.resetTokenRepo.deleteByToken(key);
  }
}
