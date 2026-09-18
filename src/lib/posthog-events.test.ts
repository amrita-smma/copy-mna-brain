import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CaptureResult } from 'posthog-js';

const mocks = vi.hoisted(() => ({
  workspaceIdentityForPath: vi.fn(),
}));

vi.mock('@/lib/posthog-workspace', () => ({
  workspaceIdentityForPath: mocks.workspaceIdentityForPath,
}));

import {
  IDENTITY_EVENTS,
  applyWorkspaceIdentity,
  isUnauthenticatedPath,
  shouldDropEvent,
  transformEvent,
} from './posthog-events';

/** Minimal CaptureResult stand-in — only `event` and `properties` are read. */
function event(name: string, properties: Record<string, unknown> = {}): CaptureResult {
  return { event: name, properties } as unknown as CaptureResult;
}

beforeEach(() => {
  mocks.workspaceIdentityForPath.mockReset();
  mocks.workspaceIdentityForPath.mockReturnValue(null);
});

afterEach(() => vi.clearAllMocks());

describe('isUnauthenticatedPath', () => {
  it('matches the logged-out pages exactly', () => {
    expect(isUnauthenticatedPath('/login')).toBe(true);
    expect(isUnauthenticatedPath('/reset-password')).toBe(true);
  });

  it('matches subpaths of the logged-out pages', () => {
    expect(isUnauthenticatedPath('/reset-password/confirm')).toBe(true);
  });

  it('does not match a path that merely shares a prefix', () => {
    expect(isUnauthenticatedPath('/login-help')).toBe(false);
  });

  it('does not match authenticated pages', () => {
    expect(isUnauthenticatedPath('/w/acme/pipeline')).toBe(false);
    expect(isUnauthenticatedPath('/workspace')).toBe(false);
  });
});

describe('shouldDropEvent', () => {
  it('drops ordinary events captured on the login page', () => {
    expect(shouldDropEvent('$pageview', '/login')).toBe(true);
    expect(shouldDropEvent('deal_promoted', '/reset-password')).toBe(true);
  });

  it('keeps ordinary events captured on authenticated pages', () => {
    expect(shouldDropEvent('$pageview', '/w/acme/pipeline')).toBe(false);
  });

  it('keeps every identity event even on the login page', () => {
    for (const name of IDENTITY_EVENTS) {
      expect(shouldDropEvent(name, '/login')).toBe(false);
    }
  });

  it('keeps $identify on the login page — the regression this guards', () => {
    // `posthog.identify()` is a captured `$identify` event. A blanket
    // path filter swallowed it, losing the anon -> identified merge and the
    // `email`/`name` person properties it carries.
    expect(shouldDropEvent('$identify', '/login')).toBe(false);
  });
});

describe('applyWorkspaceIdentity', () => {
  it('stamps slug, id and the workspace group when the path resolves', () => {
    mocks.workspaceIdentityForPath.mockReturnValue({ slug: 'acme', id: 'ws-1' });
    const e = event('$pageview');

    applyWorkspaceIdentity(e, '/w/acme/pipeline');

    expect(e.properties).toMatchObject({
      workspace_slug: 'acme',
      workspace_id: 'ws-1',
      $groups: { workspace: 'ws-1' },
    });
  });

  it('preserves unrelated groups while setting the workspace group', () => {
    mocks.workspaceIdentityForPath.mockReturnValue({ slug: 'acme', id: 'ws-1' });
    const e = event('$pageview', { $groups: { company: 'c-1' } });

    applyWorkspaceIdentity(e, '/w/acme/pipeline');

    expect(e.properties.$groups).toEqual({ company: 'c-1', workspace: 'ws-1' });
  });

  it('stamps the slug but strips a stale id when the uuid is not resolved yet', () => {
    mocks.workspaceIdentityForPath.mockReturnValue({ slug: 'acme', id: null });
    const e = event('$pageview', {
      workspace_id: 'stale-ws',
      $groups: { workspace: 'stale-ws' },
    });

    applyWorkspaceIdentity(e, '/w/acme/pipeline');

    expect(e.properties.workspace_slug).toBe('acme');
    expect(e.properties.workspace_id).toBeUndefined();
    expect(e.properties.$groups).toEqual({});
  });

  it('strips all workspace attribution on a non-workspace route', () => {
    mocks.workspaceIdentityForPath.mockReturnValue(null);
    const e = event('$pageview', {
      workspace_slug: 'acme',
      workspace_id: 'ws-1',
      $groups: { workspace: 'ws-1' },
    });

    applyWorkspaceIdentity(e, '/workspace');

    expect(e.properties.workspace_slug).toBeUndefined();
    expect(e.properties.workspace_id).toBeUndefined();
    expect(e.properties.$groups).toEqual({});
  });

  it('creates the properties bag when the event has none', () => {
    mocks.workspaceIdentityForPath.mockReturnValue({ slug: 'acme', id: 'ws-1' });
    const e = { event: '$pageview' } as unknown as CaptureResult;

    applyWorkspaceIdentity(e, '/w/acme/pipeline');

    expect(e.properties.workspace_slug).toBe('acme');
  });
});

describe('transformEvent', () => {
  it('returns null unchanged', () => {
    expect(transformEvent(null, '/w/acme')).toBeNull();
  });

  it('drops an ordinary event captured on the login page', () => {
    expect(transformEvent(event('$pageview'), '/login')).toBeNull();
  });

  it('lets $identify through on the login page and stamps no workspace', () => {
    mocks.workspaceIdentityForPath.mockReturnValue(null);

    const result = transformEvent(event('$identify'), '/login');

    expect(result).not.toBeNull();
    expect(result?.properties.workspace_slug).toBeUndefined();
  });

  it('stamps the workspace onto an event captured on a workspace route', () => {
    mocks.workspaceIdentityForPath.mockReturnValue({ slug: 'acme', id: 'ws-1' });

    const result = transformEvent(event('deal_promoted'), '/w/acme/pipeline');

    expect(result?.properties).toMatchObject({
      workspace_slug: 'acme',
      workspace_id: 'ws-1',
    });
  });

  it('does not consult the workspace map for an event it drops', () => {
    transformEvent(event('$pageview'), '/login');
    expect(mocks.workspaceIdentityForPath).not.toHaveBeenCalled();
  });
});
