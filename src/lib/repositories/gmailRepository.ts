import { eq, sql } from 'drizzle-orm';
import { gmailConnections } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export type GmailConnectionRow = Tables<'gmail_connections'>;

export interface UpsertGmailConnection {
  userId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: string;
  scope: string | null;
  googleEmail: string | null;
}

export interface RefreshedGmailTokens {
  accessTokenEnc: string;
  /** Only when Google rotated it; otherwise the stored refresh token stays. */
  refreshTokenEnc?: string;
  accessTokenExpiresAt: string;
}

/**
 * Data access for the Gmail integration: each member's connection (encrypted
 * tokens).
 *
 * Deliberately NOT workspace-scoped. The connection is a person's Google
 * account — it follows them into every workspace, like `UserMemoryRepository`
 * and `MeetingIntelligenceRepository`. One member can still never read
 * another's: `userId` is on every predicate. Whether a workspace may use the
 * integration is the GMAIL_ENABLED flag.
 */
export class GmailRepository {
  constructor(private readonly db: DbClient) {}

  async findConnection(userId: string): Promise<GmailConnectionRow | null> {
    const [row] = await this.db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.user_id, userId))
      .limit(1);
    return row ?? null;
  }

  /** Create the member's connection, or replace it on a reconnect (resetting `connected_at`). */
  async upsertConnection(input: UpsertGmailConnection): Promise<GmailConnectionRow> {
    const values = {
      access_token_enc: input.accessTokenEnc,
      refresh_token_enc: input.refreshTokenEnc,
      access_token_expires_at: input.accessTokenExpiresAt,
      scope: input.scope,
      google_email: input.googleEmail,
    };
    const [row] = await this.db
      .insert(gmailConnections)
      .values({ user_id: input.userId, ...values })
      .onConflictDoUpdate({
        target: gmailConnections.user_id,
        set: { ...values, connected_at: sql`now()`, updated_at: sql`now()` },
      })
      .returning();
    return row!;
  }

  /** Store a refreshed access token (and the refresh token, when Google rotated it). */
  async saveRefreshedTokens(userId: string, tokens: RefreshedGmailTokens): Promise<void> {
    await this.db
      .update(gmailConnections)
      .set({
        access_token_enc: tokens.accessTokenEnc,
        ...(tokens.refreshTokenEnc ? { refresh_token_enc: tokens.refreshTokenEnc } : {}),
        access_token_expires_at: tokens.accessTokenExpiresAt,
        updated_at: sql`now()`,
      })
      .where(eq(gmailConnections.user_id, userId));
  }

  async deleteConnection(userId: string): Promise<void> {
    await this.db.delete(gmailConnections).where(eq(gmailConnections.user_id, userId));
  }
}
