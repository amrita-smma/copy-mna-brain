import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  workspaceSlugFromPath,
  readWorkspaceMap,
  rememberWorkspaces,
  resolveWorkspaceId,
  workspaceIdentityForPath,
} from './posthog-workspace';

/** Minimal in-memory localStorage so the util's browser path runs under the node test env. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

function stubWindow() {
  vi.stubGlobal('window', { localStorage: fakeLocalStorage() });
}

afterEach(() => vi.unstubAllGlobals());

describe('workspaceSlugFromPath', () => {
  it('extracts the slug from a workspace-scoped path', () => {
    expect(workspaceSlugFromPath('/w/togan-vcc/pipeline')).toBe('togan-vcc');
  });

  it('extracts the slug from the bare workspace root', () => {
    expect(workspaceSlugFromPath('/w/togan-vcc')).toBe('togan-vcc');
  });

  it('decodes percent-encoded slugs', () => {
    expect(workspaceSlugFromPath('/w/a%20b/crm')).toBe('a b');
  });

  it('returns null for non-workspace paths', () => {
    expect(workspaceSlugFromPath('/workspace')).toBeNull();
    expect(workspaceSlugFromPath('/login')).toBeNull();
    expect(workspaceSlugFromPath('/')).toBeNull();
  });
});

describe('workspace map persistence', () => {
  beforeEach(() => {
    stubWindow();
  });

  it('returns an empty map when nothing is stored', () => {
    expect(readWorkspaceMap()).toEqual({});
    expect(resolveWorkspaceId('anything')).toBeNull();
  });

  it('remembers and resolves a slug -> id entry', () => {
    rememberWorkspaces({ 'togan-vcc': 'ws-1' });
    expect(resolveWorkspaceId('togan-vcc')).toBe('ws-1');
  });

  it('merges new entries without dropping earlier ones', () => {
    rememberWorkspaces({ 'togan-vcc': 'ws-1' });
    rememberWorkspaces({ 'acme-fund': 'ws-2' });
    expect(readWorkspaceMap()).toEqual({ 'togan-vcc': 'ws-1', 'acme-fund': 'ws-2' });
  });

  it('overwrites an existing slug with a newer id', () => {
    rememberWorkspaces({ 'togan-vcc': 'ws-old' });
    rememberWorkspaces({ 'togan-vcc': 'ws-new' });
    expect(resolveWorkspaceId('togan-vcc')).toBe('ws-new');
  });

  it('ignores a corrupt stored value instead of throwing', () => {
    window.localStorage.setItem('mnab.posthog.workspaceMap', 'not json');
    expect(readWorkspaceMap()).toEqual({});
  });
});

describe('workspaceIdentityForPath', () => {
  beforeEach(() => {
    stubWindow();
  });

  it('returns null for a non-workspace path', () => {
    expect(workspaceIdentityForPath('/workspace')).toBeNull();
  });

  it('returns the slug with a resolved id when the map knows it', () => {
    rememberWorkspaces({ 'togan-vcc': 'ws-1' });
    expect(workspaceIdentityForPath('/w/togan-vcc/pipeline')).toEqual({
      slug: 'togan-vcc',
      id: 'ws-1',
    });
  });

  it('returns the slug with a null id when the map has not resolved it yet', () => {
    expect(workspaceIdentityForPath('/w/brand-new/pipeline')).toEqual({
      slug: 'brand-new',
      id: null,
    });
  });
});
