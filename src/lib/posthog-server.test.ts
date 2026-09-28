import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('posthog-node', () => {
  const PostHog = vi.fn(function (this: object) {
    Object.assign(this, { capture: vi.fn(), shutdown: vi.fn() });
  });
  return { PostHog };
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
