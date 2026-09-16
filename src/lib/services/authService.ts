import { randomBytes } from 'crypto';
import type { ResetPasswordTokenRepository, UserRepository } from '@/lib/repositories';
import { hashPassword, verifyPassword } from './password';
import { verifyGoogleIdToken } from './googleToken';
import { verifyLauncherToken } from './launcherToken';
import { enqueueSendEmail } from '@/lib/queue';
import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_TOKEN_TTL_MINUTES = Math.round(RESET_TOKEN_TTL_MS / 60_000);

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_TTL_MINUTES = Math.round(INVITE_TOKEN_TTL_MS / 60_000);

/**
 * Raised when a Google SSO flow authenticates a real Google identity whose
 * verified email has no matching local account. Google SSO is authentication
 * only — it proves the caller owns the email, but it never provisions access.
 * The message is surfaced verbatim to the user on the login page.
 */
export class UserNotRegisteredError extends Error {
  constructor() {
    super('Your user is not registered in the system, please contact the Investment Brain team');
    this.name = 'UserNotRegisteredError';
  }
}

/**
 * Raised by every sign-in path (password, Google SSO, launcher SSO) when the
 * resolved user's account has been deactivated (`users.deactivated_at` set)
 * from the admin portal's User Management section. The account and its
 * history are untouched — only sign-in is blocked, and a superadmin can
 * reactivate it at any time.
 */
export class AccountDeactivatedError extends Error {
  constructor() {
    super('Your account has been deactivated. Please contact the Investment Brain team');
    this.name = 'AccountDeactivatedError';
  }
}

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
    // Checked after the password, not before: a wrong password must still
    // read as "Invalid email or password" for an unauthenticated caller —
    // only someone who already proved the credentials learns the account
    // is deactivated.
    if (user.deactivated_at) throw new AccountDeactivatedError();
    return user;
  }

  /**
   * Sign in via a Google SSO ID token (the `?token=` value handed to the
   * dashboard). The token is validated against Google, the verified email is
   * extracted, and the matching local user is returned — from there the normal
   * NextAuth JWT session flow takes over, identical to password sign-in.
   *
   * No account is auto-provisioned: just like the credentials flow, an unknown
   * email is rejected with `UserNotRegisteredError` so only pre-existing users
   * can authenticate.
   */
  async signInWithGoogleToken(token: string) {
    const email = await verifyGoogleIdToken(token);
    const user = await this.userRepo.findByEmail(email);
    if (!user) throw new UserNotRegisteredError();
    if (user.deactivated_at) throw new AccountDeactivatedError();
    return user;
  }

  /**
   * Sign in via a launcher-signed RS256 JWT (the `?token=` value handed to the
   * dashboard by the Brain Launcher). The token is verified against the
   * launcher's JWKS endpoint; the verified email is extracted and the matching
   * local user is returned. No account is auto-provisioned — an unregistered
   * email is rejected with `UserNotRegisteredError`.
   */
  async signInWithLauncherToken(token: string) {
    const { email } = await verifyLauncherToken(token);
    const user = await this.userRepo.findByEmail(email);
    if (!user) throw new UserNotRegisteredError();
    if (user.deactivated_at) throw new AccountDeactivatedError();
    return user;
  }

  /**
   * Admin-initiated account creation (from the admin portal). The admin never
   * chooses a password — the new user gets one via a one-time "set your
   * password" link, reusing the same `reset_password_tokens` mechanics and
   * `/reset-password` page as the forgot-password flow. The row is created
   * with a random, never-communicated password so the account can't be
   * signed into until the link is used.
   *
   * The email publish is wrapped in try/catch like `forgetPassword`: a queue
   * outage shouldn't fail account creation (the row already exists), and the
   * user can always get a fresh link via the ordinary "Forgot password?" flow.
   */
  async signUp(email: string, name: string, appUrl: string) {
    const normalizedEmail = email.toLowerCase().trim();
    const trimmedName = name?.trim();
    if (!normalizedEmail || !trimmedName || !appUrl) {
      throw new Error('Email, name, and appUrl are required');
    }
    const existing = await this.userRepo.findByEmail(normalizedEmail);
    if (existing) throw new Error('Email already registered');

    const placeholderPassword = randomBytes(32).toString('hex');
    const passwordHash = await hashPassword(placeholderPassword);
    const user = await this.userRepo.create({
      email: normalizedEmail,
      name: trimmedName,
      password: passwordHash,
    });

    const token = randomBytes(24).toString('hex');
    const validUntil = new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString();
    await this.resetTokenRepo.create({
      token,
      user_id: user.id,
      valid_until: validUntil,
    });

    const payload: SendEmailPayload = {
      kind: 'account_invite',
      to: normalizedEmail,
      name: trimmedName,
      token,
      appUrl,
      ttlMinutes: INVITE_TOKEN_TTL_MINUTES,
    };

    try {
      await enqueueSendEmail(payload);
    } catch (err) {
      console.error('[auth] enqueueSendEmail failed:', err);
    }

    return { id: user.id, name: user.name, email: user.email };
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
