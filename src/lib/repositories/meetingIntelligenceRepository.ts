import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { meetingIntelligenceClients, meetingIntelligenceConnections } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export type MeetingIntelligenceConnectionRow = Tables<'meeting_intelligence_connections'>;

export interface UpsertMeetingIntelligenceConnection {
  userId: string;
  serverUrl: string;
  clientId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: string;
  scope: string | null;
  externalName: string | null;
  externalEmail: string | null;
}

export interface RefreshedMeetingIntelligenceTokens {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: string;
  scope: string | null;
}

/**
 * Data access for the Meeting Intelligence integration: the app's registered
 * OAuth clients and each member's connection (encrypted tokens).
 *
 * Deliberately NOT workspace-scoped. A client registration is the app's own
 * identity with the server, and a connection is a person's account on the
 * other system — it follows them into every workspace, like
 * `UserMemoryRepository`. One member can still never read another's
 * connection: `userId` is on every connection predicate. Whether a workspace
 * may use the integration is the MEETING_INTELLIGENCE_ENABLED flag.
 */
export class MeetingIntelligenceRepository {
  constructor(private readonly db: DbClient) {}

  async findClientId(serverUrl: string, redirectUri: string): Promise<string | null> {
    const [row] = await this.db
      .select({ client_id: meetingIntelligenceClients.client_id })
      .from(meetingIntelligenceClients)
      .where(
        and(
          eq(meetingIntelligenceClients.server_url, serverUrl),
          eq(meetingIntelligenceClients.redirect_uri, redirectUri),
        ),
      )
      .limit(1);
    return row?.client_id ?? null;
  }

  /** Store (or replace, after a re-registration) the client id for this redirect URI. */
  async saveClientId(serverUrl: string, redirectUri: string, clientId: string): Promise<void> {
    await this.db
      .insert(meetingIntelligenceClients)
      .values({ server_url: serverUrl, redirect_uri: redirectUri, client_id: clientId })
      .onConflictDoUpdate({
        target: [meetingIntelligenceClients.server_url, meetingIntelligenceClients.redirect_uri],
        set: { client_id: clientId },
      });
  }

  async deleteClientId(serverUrl: string, redirectUri: string): Promise<void> {
    await this.db
      .delete(meetingIntelligenceClients)
      .where(
        and(
          eq(meetingIntelligenceClients.server_url, serverUrl),
          eq(meetingIntelligenceClients.redirect_uri, redirectUri),
        ),
      );
  }

  async findConnection(userId: string): Promise<MeetingIntelligenceConnectionRow | null> {
    const [row] = await this.db
      .select()
      .from(meetingIntelligenceConnections)
      .where(eq(meetingIntelligenceConnections.user_id, userId))
      .limit(1);
    return row ?? null;
  }

  /** Create the member's connection, or replace it on a reconnect (resetting `connected_at`). */
  async upsertConnection(input: UpsertMeetingIntelligenceConnection): Promise<MeetingIntelligenceConnectionRow> {
    const values = {
      server_url: input.serverUrl,
      client_id: input.clientId,
      access_token_enc: input.accessTokenEnc,
      refresh_token_enc: input.refreshTokenEnc,
      access_token_expires_at: input.accessTokenExpiresAt,
      scope: input.scope,
      external_name: input.externalName,
      external_email: input.externalEmail,
      refresh_lease_until: null,
    };
    const [row] = await this.db
      .insert(meetingIntelligenceConnections)
      .values({ user_id: input.userId, ...values })
      .onConflictDoUpdate({
        target: meetingIntelligenceConnections.user_id,
        set: { ...values, connected_at: sql`now()`, updated_at: sql`now()` },
      })
      .returning();
    return row!;
  }

  /**
   * Atomically claim the right to refresh this member's tokens for
   * `leaseSeconds`. Returns the row (with the refresh token to present) when
   * claimed, or null when another request holds an unexpired lease — or the
   * connection is gone. A single conditional UPDATE, so two concurrent
   * claimers can never both win.
   */
  async claimRefreshLease(userId: string, leaseSeconds: number): Promise<MeetingIntelligenceConnectionRow | null> {
    const [row] = await this.db
      .update(meetingIntelligenceConnections)
      .set({ refresh_lease_until: sql`now() + make_interval(secs => ${leaseSeconds})` })
      .where(
        and(
          eq(meetingIntelligenceConnections.user_id, userId),
          or(
            isNull(meetingIntelligenceConnections.refresh_lease_until),
            lt(meetingIntelligenceConnections.refresh_lease_until, sql`now()`),
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Store a rotated token pair and release the refresh lease. */
  async saveRefreshedTokens(userId: string, tokens: RefreshedMeetingIntelligenceTokens): Promise<void> {
    await this.db
      .update(meetingIntelligenceConnections)
      .set({
        access_token_enc: tokens.accessTokenEnc,
        refresh_token_enc: tokens.refreshTokenEnc,
        access_token_expires_at: tokens.accessTokenExpiresAt,
        scope: tokens.scope,
        refresh_lease_until: null,
        updated_at: sql`now()`,
      })
      .where(eq(meetingIntelligenceConnections.user_id, userId));
  }

  async releaseRefreshLease(userId: string): Promise<void> {
    await this.db
      .update(meetingIntelligenceConnections)
      .set({ refresh_lease_until: null })
      .where(eq(meetingIntelligenceConnections.user_id, userId));
  }

  async deleteConnection(userId: string): Promise<void> {
    await this.db
      .delete(meetingIntelligenceConnections)
      .where(eq(meetingIntelligenceConnections.user_id, userId));
  }
}
