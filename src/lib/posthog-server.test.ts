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
