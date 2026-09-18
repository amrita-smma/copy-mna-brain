import { describe, it, expect, vi, beforeEach } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  captureWorkspaceEvent: vi.fn(),
  captureUserEvent: vi.fn(),
}));
vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: posthogMocks.captureWorkspaceEvent,
  captureUserEvent: posthogMocks.captureUserEvent,
}));

import { ClientHealthService, parseClientHealthReason } from './clientHealthService';

const WORKSPACE_ID = 'ws-test';

beforeEach(() => {
  posthogMocks.captureWorkspaceEvent.mockReset();
  posthogMocks.captureUserEvent.mockReset();
});

describe('parseClientHealthReason', () => {
  it('accepts the known reason', () => {
    expect(parseClientHealthReason('ingest_blocked')).toBe('ingest_blocked');
  });

  it('rejects an unknown string', () => {
    expect(parseClientHealthReason('something_else')).toBeNull();
  });

  it('rejects non-string values from an untrusted body', () => {
    expect(parseClientHealthReason(undefined)).toBeNull();
    expect(parseClientHealthReason(null)).toBeNull();
    expect(parseClientHealthReason(42)).toBeNull();
    expect(parseClientHealthReason({ reason: 'ingest_blocked' })).toBeNull();
  });
});

describe('ClientHealthService.recordBlockedClient', () => {
  it('captures the blockage against the reporting user and workspace', () => {
    new ClientHealthService(WORKSPACE_ID).recordBlockedClient({
      userId: 'user-7',
      reason: 'ingest_blocked',
      userAgent: 'Mozilla/5.0',
    });

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      distinctId: 'user-7',
      event: 'client_telemetry_blocked',
      properties: { reason: 'ingest_blocked', user_agent: 'Mozilla/5.0' },
    });
  });

  it('records a null user agent rather than omitting the property', () => {
    new ClientHealthService(WORKSPACE_ID).recordBlockedClient({
      userId: 'user-7',
      reason: 'ingest_blocked',
    });

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { reason: 'ingest_blocked', user_agent: null } }),
    );
  });
});

describe('ClientHealthService.recordBlockedClient — no active workspace', () => {
  it('captures against the user alone rather than stamping the nil-workspace sentinel', async () => {
    // The probe runs on `/workspace` and `/consent` too, where
    // `getActiveWorkspaceId()` fails closed to NO_ACTIVE_WORKSPACE_ID. Stamping
    // that all-zero id as a PostHog group would invent a workspace.
    const { NO_ACTIVE_WORKSPACE_ID } = await import('@/lib/constants');
    const { captureUserEvent } = await import('@/lib/posthog-server');

    new ClientHealthService(NO_ACTIVE_WORKSPACE_ID).recordBlockedClient({
      userId: 'user-7',
      reason: 'ingest_blocked',
      userAgent: 'Mozilla/5.0',
    });

    expect(posthogMocks.captureWorkspaceEvent).not.toHaveBeenCalled();
    expect(captureUserEvent).toHaveBeenCalledWith({
      distinctId: 'user-7',
      event: 'client_telemetry_blocked',
      properties: { reason: 'ingest_blocked', user_agent: 'Mozilla/5.0' },
    });
  });
});
