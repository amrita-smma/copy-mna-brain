import { captureUserEvent, captureWorkspaceEvent } from '@/lib/posthog-server';
import { NO_ACTIVE_WORKSPACE_ID } from '@/lib/constants';

/** Why a client reported itself unhealthy. Only one cause so far. */
export type ClientHealthReason = 'ingest_blocked';

const VALID_REASONS: ReadonlySet<string> = new Set<ClientHealthReason>(['ingest_blocked']);

/** Narrow an untrusted request body value to a known reason, else null. */
export function parseClientHealthReason(value: unknown): ClientHealthReason | null {
  return typeof value === 'string' && VALID_REASONS.has(value)
    ? (value as ClientHealthReason)
    : null;
}

/**
 * Records that a browser could not reach our own `/ingest` PostHog proxy.
 *
 * The whole point is that the client can't report this itself — PostHog is
 * precisely what's blocked — so the browser posts to a first-party route and
 * the event is emitted from here, server-side, where no blocker can reach it.
 *
 * Without this, a blocked user is simply absent from PostHog and
 * indistinguishable from one who never visited.
 */
export class ClientHealthService {
  constructor(private readonly workspaceId: string) {}

  recordBlockedClient(input: {
    userId: string;
    reason: ClientHealthReason;
    userAgent?: string | null;
  }): void {
    const properties = {
      reason: input.reason,
      // The blocker is usually an extension, but the browser is the best proxy
      // we have for which population is affected.
      user_agent: input.userAgent ?? null,
    };

    // The probe runs on every authenticated page, including `/workspace` and
    // `/consent`, which resolve no workspace — `getActiveWorkspaceId()` returns
    // the fail-closed `NO_ACTIVE_WORKSPACE_ID` sentinel there. Stamping that
    // all-zero id as a PostHog group would invent a workspace that matches no
    // real row, so those reports are captured against the user alone. The
    // signal is what matters here; the workspace is a nice-to-have.
    if (this.workspaceId === NO_ACTIVE_WORKSPACE_ID) {
      captureUserEvent({
        distinctId: input.userId,
        event: 'client_telemetry_blocked',
        properties,
      });
      return;
    }

    captureWorkspaceEvent({
      workspaceId: this.workspaceId,
      distinctId: input.userId,
      event: 'client_telemetry_blocked',
      properties,
    });
  }
}
