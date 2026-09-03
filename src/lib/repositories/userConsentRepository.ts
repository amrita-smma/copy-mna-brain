import { eq, sql } from 'drizzle-orm';
import { userConsents } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

/** One user's acceptance of the Sync/Terms consent screen. Read/written via ConsentService. */
export class UserConsentRepository {
  constructor(private readonly db: DbClient) {}

  async findByUserId(userId: string): Promise<Tables<'user_consents'> | null> {
    const [row] = await this.db
      .select()
      .from(userConsents)
      .where(eq(userConsents.user_id, userId))
      .limit(1);
    return row ?? null;
  }

  /** Record (or re-record, on a later `policyVersion`) a user's consent. */
  async upsertConsent(userId: string, policyVersion: string): Promise<Tables<'user_consents'>> {
    const [row] = await this.db
      .insert(userConsents)
      .values({ user_id: userId, policy_version: policyVersion })
      .onConflictDoUpdate({
        target: userConsents.user_id,
        set: { policy_version: policyVersion, consented_at: sql`now()` },
      })
      .returning();
    return row;
  }
}
