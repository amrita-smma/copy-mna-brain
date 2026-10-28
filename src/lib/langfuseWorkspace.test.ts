import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock('@/lib/repositories', () => ({
  WorkspaceRepository: class {
    findById = findById;
  },
}));

import { getLangfuseWorkspaceSlug } from './langfuseUser';
import {
  resetWorkspaceSlugCacheForTests,
  resolveWorkspaceSlug,
  runWithLangfuseWorkspaceId,
} from './langfuseWorkspace';

const db = {} as never;

describe('resolveWorkspaceSlug', () => {
  beforeEach(() => {
    findById.mockReset();
    resetWorkspaceSlugCacheForTests();
  });

  it('returns null without hitting the DB when there is no workspace id', async () => {
    expect(await resolveWorkspaceSlug(db, null)).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("reads the workspace's slug", async () => {
    findById.mockResolvedValueOnce({ id: 'ws-1', slug: 'acme' });

    expect(await resolveWorkspaceSlug(db, 'ws-1')).toBe('acme');
    expect(findById).toHaveBeenCalledWith('ws-1');
  });

  it('reuses a resolved slug instead of querying on every run', async () => {
    findById.mockResolvedValue({ id: 'ws-1', slug: 'acme' });

    await resolveWorkspaceSlug(db, 'ws-1', () => 0);
    await resolveWorkspaceSlug(db, 'ws-1', () => 1_000);

    expect(findById).toHaveBeenCalledTimes(1);
  });

  it('looks the slug up again once the cached one expires', async () => {
    findById.mockResolvedValueOnce({ slug: 'old' }).mockResolvedValueOnce({ slug: 'new' });

    await resolveWorkspaceSlug(db, 'ws-1', () => 0);
    expect(await resolveWorkspaceSlug(db, 'ws-1', () => 10 * 60_000)).toBe('new');
  });

  it('reads a lookup failure as no slug, and does not cache it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    findById.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ slug: 'acme' });

    expect(await resolveWorkspaceSlug(db, 'ws-1')).toBeNull();
    expect(await resolveWorkspaceSlug(db, 'ws-1')).toBe('acme');
    warn.mockRestore();
  });
});

describe('runWithLangfuseWorkspaceId', () => {
  beforeEach(() => {
    findById.mockReset();
    resetWorkspaceSlugCacheForTests();
  });

  it("runs the work with the workspace's slug in the Langfuse context", async () => {
    findById.mockResolvedValueOnce({ slug: 'acme' });

    const seen = await runWithLangfuseWorkspaceId(db, 'ws-1', async () => getLangfuseWorkspaceSlug());

    expect(seen).toBe('acme');
  });

  it('still runs the work when the workspace has no slug', async () => {
    findById.mockResolvedValueOnce(undefined);

    const seen = await runWithLangfuseWorkspaceId(db, 'ws-1', async () => getLangfuseWorkspaceSlug());

    expect(seen).toBeUndefined();
  });
});
