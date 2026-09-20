import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CAPTURE_PATH,
  HEARTBEAT_EVENT,
  HEARTBEAT_INTERVAL_MS,
  MAX_TRACKED_USERS,
  captureUrl,
  claimHeartbeat,
  createHeartbeatThrottle,
  heartbeatBucket,
  heartbeatPayload,
  isActivityPath,
  resolveWorkspaceId,
  sendHeartbeat,
} from './posthog-heartbeat';

describe('isActivityPath', () => {
  it('counts workspace page navigations', () => {
    expect(isActivityPath('/w/mna/pipeline')).toBe(true);
  });

  it('counts ordinary API calls', () => {
    expect(isActivityPath('/api/companies')).toBe(true);
  });

  it('does not count the NextAuth session poll, which fires on an idle tab', () => {
    expect(isActivityPath('/api/auth/session')).toBe(false);
  });

  it('does not count the PostHog ingest proxy', () => {
    expect(isActivityPath('/ingest')).toBe(false);
    expect(isActivityPath('/ingest/static/array.js')).toBe(false);
  });

  it('does not count machine traffic or the liveness probe', () => {
    expect(isActivityPath('/api/cron/refresh')).toBe(false);
    expect(isActivityPath('/api/queues/consume')).toBe(false);
    expect(isActivityPath('/api/healthcheck')).toBe(false);
  });

  it('does not count the ad-blocker probe report, which is fired by page load', () => {
    expect(isActivityPath('/api/client-health')).toBe(false);
  });

  it('does not treat a path merely prefixed by an excluded name as excluded', () => {
    expect(isActivityPath('/api/healthcheck-history')).toBe(true);
  });
});

describe('heartbeatBucket', () => {
  // Aligned to a bucket boundary, so "+ interval - 1" stays inside one bucket.
  const base = Math.floor(1_700_000_000_000 / HEARTBEAT_INTERVAL_MS) * HEARTBEAT_INTERVAL_MS;

  it('returns the same bucket for two times inside one interval', () => {
    expect(heartbeatBucket(base)).toBe(heartbeatBucket(base + HEARTBEAT_INTERVAL_MS - 1));
  });

  it('advances to the next bucket at the interval boundary', () => {
    expect(heartbeatBucket(base + HEARTBEAT_INTERVAL_MS)).toBe(heartbeatBucket(base) + 1);
  });

  it('derives the bucket from wall clock alone, so separate instances agree', () => {
    // The property that makes duplicate heartbeats idempotent at query time.
    const now = 1_700_000_123_456;
    expect(heartbeatBucket(now)).toBe(Math.floor(now / HEARTBEAT_INTERVAL_MS));
  });
});

describe('claimHeartbeat', () => {
  it('allows the first claim in a bucket and refuses the second', () => {
    const throttle = createHeartbeatThrottle();
    expect(claimHeartbeat(throttle, 'user-1', 100)).toBe(true);
    expect(claimHeartbeat(throttle, 'user-1', 100)).toBe(false);
  });

  it('allows the same user again once the bucket advances', () => {
    const throttle = createHeartbeatThrottle();
    claimHeartbeat(throttle, 'user-1', 100);
    expect(claimHeartbeat(throttle, 'user-1', 101)).toBe(true);
  });

  it('tracks users independently', () => {
    const throttle = createHeartbeatThrottle();
    claimHeartbeat(throttle, 'user-1', 100);
    expect(claimHeartbeat(throttle, 'user-2', 100)).toBe(true);
  });

  it('evicts stale users once the map is full, bounding memory', () => {
    const throttle = createHeartbeatThrottle();
    for (let i = 0; i < MAX_TRACKED_USERS; i++) {
      throttle.seen.set(`old-${i}`, 100);
    }
    expect(claimHeartbeat(throttle, 'fresh', 101)).toBe(true);
    expect(throttle.seen.size).toBe(1);
    expect(throttle.seen.get('fresh')).toBe(101);
  });

  it('keeps current-bucket entries when stale ones can be evicted instead', () => {
    const throttle = createHeartbeatThrottle();
    for (let i = 0; i < MAX_TRACKED_USERS - 1; i++) {
      throttle.seen.set(`old-${i}`, 100);
    }
    throttle.seen.set('current', 101);
    claimHeartbeat(throttle, 'fresh', 101);
    expect(throttle.seen.get('current')).toBe(101);
  });

  it('stays bounded when every entry is in the current bucket', () => {
    // The case a stale-only sweep cannot free: more than MAX_TRACKED_USERS
    // distinct users inside a single window. Without front-eviction the map
    // would grow past the cap on every new user.
    const throttle = createHeartbeatThrottle();
    for (let i = 0; i < MAX_TRACKED_USERS; i++) {
      throttle.seen.set(`user-${i}`, 100);
    }
    claimHeartbeat(throttle, 'overflow', 100);
    expect(throttle.seen.size).toBe(MAX_TRACKED_USERS);
    expect(throttle.seen.get('overflow')).toBe(100);
    // Least-recently inserted is the one dropped.
    expect(throttle.seen.has('user-0')).toBe(false);
  });
});

describe('resolveWorkspaceId', () => {
  const workspaces = [
    { workspaceId: 'ws-mna', slug: 'mna' },
    { workspaceId: 'ws-other', slug: 'other' },
  ];

  it('resolves a slug the user is a member of', () => {
    expect(resolveWorkspaceId('mna', workspaces, 'ws-active')).toBe('ws-mna');
  });

  it('falls back to the active workspace for an unknown slug', () => {
    expect(resolveWorkspaceId('nope', workspaces, 'ws-active')).toBe('ws-active');
  });

  it('falls back to the active workspace when there is no slug', () => {
    expect(resolveWorkspaceId(null, workspaces, 'ws-active')).toBe('ws-active');
  });

  it('returns null when nothing resolves', () => {
    expect(resolveWorkspaceId(null, undefined, null)).toBeNull();
  });
});

describe('heartbeatPayload', () => {
  const ctx = {
    userId: 'user-1',
    email: 'a@b.com',
    workspaceSlug: 'mna',
    workspaceId: 'ws-mna',
    pathname: '/w/mna/pipeline',
    method: 'GET',
    bucket: 5_666_666,
  };

  it('builds a capture body with the heartbeat event and the user as distinct id', () => {
    const payload = heartbeatPayload('key', ctx);
    expect(payload.api_key).toBe('key');
    expect(payload.event).toBe(HEARTBEAT_EVENT);
    expect(payload.distinct_id).toBe('user-1');
  });

  it('carries the bucket so a query can group by window without knowing the interval', () => {
    const payload = heartbeatPayload('key', ctx);
    expect(payload.properties.heartbeat_bucket).toBe(5_666_666);
    expect(payload.properties.heartbeat_interval_seconds).toBe(300);
  });

  it('builds a byte-identical event for the same user and window', () => {
    // What makes a duplicate from a second instance dedupe at ingest rather
    // than double-count: same $insert_id AND same timestamp.
    const a = heartbeatPayload('key', { ...ctx, pathname: '/w/mna/a', method: 'GET' });
    const b = heartbeatPayload('key', { ...ctx, pathname: '/w/mna/a', method: 'GET' });
    expect(a).toEqual(b);
    expect(a.properties.$insert_id).toBe('user-1:5666666');
  });

  it('stamps the timestamp at the start of the window, not the moment of the request', () => {
    const payload = heartbeatPayload('key', ctx);
    expect(payload.timestamp).toBe(
      new Date(5_666_666 * HEARTBEAT_INTERVAL_MS).toISOString(),
    );
  });

  it('gives a different insert id to the next window', () => {
    const next = heartbeatPayload('key', { ...ctx, bucket: ctx.bucket + 1 });
    expect(next.properties.$insert_id).toBe('user-1:5666667');
  });

  it('stamps the workspace as both a property and a group', () => {
    const payload = heartbeatPayload('key', ctx);
    expect(payload.properties.workspace_slug).toBe('mna');
    expect(payload.properties.workspace_id).toBe('ws-mna');
    expect(payload.properties.$groups).toEqual({ workspace: 'ws-mna' });
  });

  it('omits the workspace group when no workspace resolved', () => {
    const payload = heartbeatPayload('key', {
      ...ctx,
      workspaceSlug: null,
      workspaceId: null,
    });
    expect(payload.properties.workspace_id).toBeUndefined();
    expect(payload.properties.$groups).toBeUndefined();
  });

  it('sets person properties so a permanently blocked user is still identifiable', () => {
    const payload = heartbeatPayload('key', ctx);
    expect(payload.properties.$set).toEqual({ email: 'a@b.com' });
  });

  it('omits $set rather than clobbering a good email with a blank one', () => {
    const payload = heartbeatPayload('key', { ...ctx, email: '  ' });
    expect(payload.properties.$set).toBeUndefined();
    expect(payload.properties.email).toBeUndefined();
  });

  it('stops stamping email on the event when SEND_EMAIL_WITH_EVENTS is off', () => {
    const payload = heartbeatPayload('key', ctx, { sendEmail: false });
    expect(payload.properties.email).toBeUndefined();
  });

  it('still sets the person email when SEND_EMAIL_WITH_EVENTS is off', () => {
    // The flag governs per-event stamping, not the person properties
    // `identify` would set anyway — and a blocked user has no other source.
    const payload = heartbeatPayload('key', ctx, { sendEmail: false });
    expect(payload.properties.$set).toEqual({ email: 'a@b.com' });
  });
});

describe('captureUrl', () => {
  it('points at the PostHog ingestion host, not our own /ingest proxy', () => {
    expect(captureUrl('https://us.i.posthog.com')).toBe(
      `https://us.i.posthog.com${CAPTURE_PATH}`,
    );
  });

  it('returns null when PostHog is not configured', () => {
    expect(captureUrl(undefined)).toBeNull();
    expect(captureUrl('posthog_host')).toBeNull();
  });
});

describe('sendHeartbeat', () => {
  const payload = {
    api_key: 'key',
    event: HEARTBEAT_EVENT,
    distinct_id: 'user-1',
    properties: {},
    timestamp: 'ts',
  };

  beforeEach(() => vi.clearAllMocks());

  it('POSTs the payload as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await sendHeartbeat('https://host/i/v0/e/', payload, fetchImpl as never);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://host/i/v0/e/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('swallows a network failure so telemetry cannot fail the request', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      sendHeartbeat('https://host/i/v0/e/', payload, fetchImpl as never),
    ).resolves.toBeUndefined();
  });
});
