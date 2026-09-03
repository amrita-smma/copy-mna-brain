import type { Tables, UserConsentRepository, UserRepository, UserWorkspaceRepository } from '@/lib/repositories';
import { EmailService } from './emailService';

const CONSENT_NOTIFICATION_EMAIL = 'nico.alimin@smma.id';

/** Bump when the Sync/Terms consent screen's content materially changes. */
export const CURRENT_POLICY_VERSION = 'v1';

export class ConsentService {
  constructor(
    private readonly consentRepo: UserConsentRepository,
    private readonly userRepo: UserRepository,
    private readonly userWorkspaceRepo: UserWorkspaceRepository,
    private readonly emailService: EmailService = new EmailService(),
  ) {}

  /**
   * Whether this user is clear to pass the consent gate: either they've
   * accepted the current policy, or none of their workspace memberships have
   * email sync enabled, so there's nothing for them to consent to.
   */
  async hasConsented(userId: string): Promise<boolean> {
    const anySyncEnabled = await this.userWorkspaceRepo.hasAnySyncEnabled(userId);
    if (!anySyncEnabled) return true;

    const row = await this.consentRepo.findByUserId(userId);
    return row !== null;
  }

  /**
   * Record a user's consent, then best-effort email nico.alimin@smma.id. The
   * consent row must land regardless of whether the notification email
   * succeeds — a down SES must never cost the user their recorded consent.
   */
  async recordConsent(userId: string): Promise<Tables<'user_consents'>> {
    const row = await this.consentRepo.upsertConsent(userId, CURRENT_POLICY_VERSION);

    try {
      const user = await this.userRepo.findById(userId);
      await this.emailService.sendConsentRecordedEmail({
        email: CONSENT_NOTIFICATION_EMAIL,
        userName: user?.name || 'Unknown user',
        userEmail: user?.email || 'unknown',
        policyVersion: row.policy_version,
        consentedAtLabel: new Date(row.consented_at).toLocaleString('en-US', {
          dateStyle: 'long',
          timeStyle: 'short',
        }),
      });
    } catch (error) {
      console.error('ConsentService.recordConsent: failed to send notification email', error);
    }

    return row;
  }
}
