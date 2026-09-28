import { describe, it, expect, vi, beforeEach } from 'vitest';

const vercelMocks = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock('@vercel/functions', () => ({ waitUntil: vercelMocks.waitUntil }));

vi.mock('posthog-node', () => {
  const PostHog = vi.fn(function (this: object) {
    Object.assign(this, {
      capture: vi.fn(),
      // `capture()` only enqueues; `flush()` is what actually delivers.
      flush: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn(),
    });
  });
  return { PostHog };
});

beforeEach(() => {
  vercelMocks.waitUntil.mockReset();
});

describe('getPostHogClient', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('returns null when NEXT_PUBLIC_POSTHOG_KEY is not set', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { getPostHogClient } = await import('./posthog-server');
    expect(getPostHogClient()).toBeNull();
  });

  it('returns a PostHog instance when key is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient } = await import('./posthog-server');
    expect(getPostHogClient()).not.toBeNull();
  });
});

describe('captureWorkspaceEvent', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('stamps workspace_id onto properties and sets the workspace group', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureWorkspaceEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureWorkspaceEvent({
      workspaceId: 'ws-1',
      distinctId: 'user-1',
      event: 'thing_happened',
      properties: { foo: 'bar' },
    });

    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'thing_happened',
      properties: { foo: 'bar', workspace_id: 'ws-1' },
      groups: { workspace: 'ws-1' },
    });
  });

  it('stamps workspace_id even when no properties are passed', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureWorkspaceEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureWorkspaceEvent({
      workspaceId: 'ws-2',
      distinctId: 'server',
      event: 'server_thing',
    });

    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: { workspace_id: 'ws-2' },
        groups: { workspace: 'ws-2' },
      }),
    );
  });

  it('stamps workspace_slug when the caller knows it', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureWorkspaceEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureWorkspaceEvent({
      workspaceId: 'ws-3',
      workspaceSlug: 'acme',
      distinctId: 'user-3',
      event: 'thing_happened',
      properties: { foo: 'bar' },
    });

    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: { foo: 'bar', workspace_id: 'ws-3', workspace_slug: 'acme' },
      }),
    );
  });

  it('omits workspace_slug entirely when it is null, undefined or blank', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureWorkspaceEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    const blanks = [null, undefined, '', '  '] as const;
    for (const workspaceSlug of blanks) {
      captureWorkspaceEvent({
        workspaceId: 'ws-4',
        workspaceSlug,
        distinctId: 'user-4',
        event: 'thing_happened',
      });
    }

    // Exact payload: a present `workspace_slug` (even null) would fail this,
    // and `toHaveBeenCalledTimes` keeps an empty mock from passing the loop.
    expect(client.capture).toHaveBeenCalledTimes(blanks.length);
    for (let n = 1; n <= blanks.length; n++) {
      expect(client.capture).toHaveBeenNthCalledWith(n, {
        distinctId: 'user-4',
        event: 'thing_happened',
        properties: { workspace_id: 'ws-4' },
        groups: { workspace: 'ws-4' },
      });
    }
  });

  it('is a no-op when PostHog is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { captureWorkspaceEvent } = await import('./posthog-server');
    expect(() =>
      captureWorkspaceEvent({
        workspaceId: 'ws-1',
        distinctId: 'user-1',
        event: 'thing_happened',
      }),
    ).not.toThrow();
  });
});

describe('captureUserEvent', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('captures against the user without any workspace attribution', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureUserEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureUserEvent({
      distinctId: 'user-1',
      event: 'user_signed_in',
      properties: { method: 'credentials' },
    });

    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'user_signed_in',
      properties: { method: 'credentials' },
    });
  });

  it('does not invent a workspace group — that is captureWorkspaceEvent’s job', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureUserEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' });

    expect(client.capture).toHaveBeenCalledWith(
      expect.not.objectContaining({ groups: expect.anything() }),
    );
  });

  it('is a no-op when PostHog is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { captureUserEvent } = await import('./posthog-server');
    expect(() =>
      captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' }),
    ).not.toThrow();
  });
});

describe('flushPostHog', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('drains the queue and resolves once delivery has completed', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, flushPostHog } = await import('./posthog-server');
    const client = getPostHogClient()!;

    await expect(flushPostHog()).resolves.toBeUndefined();
    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('swallows a delivery failure — telemetry must never fail its caller', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, flushPostHog } = await import('./posthog-server');
    const client = getPostHogClient()!;
    vi.mocked(client.flush).mockRejectedValue(new Error('network down'));

    await expect(flushPostHog()).resolves.toBeUndefined();
  });

  it('resolves immediately when PostHog is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { flushPostHog } = await import('./posthog-server');

    await expect(flushPostHog()).resolves.toBeUndefined();
  });
});

describe('capture delivery on a frozen instance', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('flushes after captureWorkspaceEvent instead of leaving the POST in flight', async () => {
    // A serverless instance is frozen the moment the response is written. An
    // event that is only *queued* at that point never leaves the process.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureWorkspaceEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureWorkspaceEvent({ workspaceId: 'ws-1', distinctId: 'user-1', event: 'e' });

    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('flushes after captureUserEvent too', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureUserEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' });

    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('hands the flush to waitUntil so the platform keeps the instance alive', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { captureUserEvent } = await import('./posthog-server');

    captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' });

    expect(vercelMocks.waitUntil).toHaveBeenCalledTimes(1);
    await expect(vercelMocks.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('still captures when waitUntil is unavailable off-platform', async () => {
    // `next dev`, job handlers and tests have no Vercel request context.
    vercelMocks.waitUntil.mockImplementation(() => {
      throw new Error('waitUntil() is not supported in this environment');
    });
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, captureUserEvent } = await import('./posthog-server');
    const client = getPostHogClient()!;

    expect(() =>
      captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' }),
    ).not.toThrow();
    expect(client.capture).toHaveBeenCalledTimes(1);
    // The flush is what delivers; a throwing waitUntil must not skip it.
    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('does not touch waitUntil when PostHog is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { captureUserEvent } = await import('./posthog-server');

    captureUserEvent({ distinctId: 'user-1', event: 'user_signed_in' });

    expect(vercelMocks.waitUntil).not.toHaveBeenCalled();
  });
});

describe('flushPostHogWithin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('resolves as soon as the flush lands', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, flushPostHogWithin } = await import('./posthog-server');
    const client = getPostHogClient()!;

    await expect(flushPostHogWithin(50_000)).resolves.toBeUndefined();
    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('stops waiting at the cap rather than holding the request open', async () => {
    // `@posthog/core` bounds a flush only by retries x request timeout, which
    // is tens of seconds against an unreachable ingestion host — far too long
    // to keep a diagnostics request open for.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { getPostHogClient, flushPostHogWithin } = await import('./posthog-server');
    const client = getPostHogClient()!;
    vi.mocked(client.flush).mockReturnValue(new Promise(() => {}));

    await expect(flushPostHogWithin(1)).resolves.toBeUndefined();
  });

  it('keeps the abandoned flush alive in the background', async () => {
    // Giving up is about waiting, not about delivery.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_testkey');
    const { flushPostHogWithin } = await import('./posthog-server');

    await flushPostHogWithin(1);

    expect(vercelMocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('caps the wait well below PostHog\'s own retry budget by default', async () => {
    const { FLUSH_WAIT_MS } = await import('./posthog-server');
    expect(FLUSH_WAIT_MS).toBe(3_000);
  });
});
