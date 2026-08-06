import { describe, it, expect } from 'vitest';
import { isWorkspaceScopedPath, resolveSsoLandingPath } from './ssoLanding';

describe('isWorkspaceScopedPath', () => {
  it('matches a bare workspace root', () => {
    expect(isWorkspaceScopedPath('/w/acme')).toBe(true);
  });

  it('matches a nested workspace path', () => {
    expect(isWorkspaceScopedPath('/w/acme/pipeline')).toBe(true);
  });

  it('matches a workspace path carrying a query string', () => {
    expect(isWorkspaceScopedPath('/w/acme/pipeline?stage=L0')).toBe(true);
  });

  it('does not match a path with no slug segment', () => {
    expect(isWorkspaceScopedPath('/w/')).toBe(false);
    expect(isWorkspaceScopedPath('/w')).toBe(false);
  });

  it('does not match flat app paths', () => {
    expect(isWorkspaceScopedPath('/')).toBe(false);
    expect(isWorkspaceScopedPath('/chat')).toBe(false);
    expect(isWorkspaceScopedPath('/workspace')).toBe(false);
  });

  it('does not match a path that merely contains /w/ later on', () => {
    expect(isWorkspaceScopedPath('/chat/w/acme')).toBe(false);
  });
});

describe('resolveSsoLandingPath', () => {
  it('sends a multi-workspace user to the picker instead of a guessed workspace', () => {
    expect(resolveSsoLandingPath({ callbackUrl: '/', workspaceCount: 3 })).toBe('/workspace');
  });

  it('sends a multi-workspace user to the picker even from a flat deeplink', () => {
    expect(resolveSsoLandingPath({ callbackUrl: '/chat', workspaceCount: 2 })).toBe('/workspace');
  });

  it('keeps the callback for a single-workspace user', () => {
    expect(resolveSsoLandingPath({ callbackUrl: '/chat', workspaceCount: 1 })).toBe('/chat');
  });

  it('keeps the callback for a user with no workspaces at all', () => {
    expect(resolveSsoLandingPath({ callbackUrl: '/', workspaceCount: 0 })).toBe('/');
  });

  it('honours a workspace-scoped deeplink regardless of how many workspaces the user has', () => {
    expect(
      resolveSsoLandingPath({ callbackUrl: '/w/acme/pipeline?stage=L0', workspaceCount: 5 }),
    ).toBe('/w/acme/pipeline?stage=L0');
  });
});
