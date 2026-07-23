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
