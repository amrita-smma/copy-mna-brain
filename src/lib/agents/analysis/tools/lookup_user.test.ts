import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findAllInWorkspace, getActiveWorkspaceId } = vi.hoisted(() => ({
  findAllInWorkspace: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId }));

vi.mock('@/lib/repositories', () => ({
  UserRepository: class {
    findAllInWorkspace = findAllInWorkspace;
  },
}));

import { lookupUser } from './lookup_user';

function invoke(args: Record<string, unknown>) {
  return lookupUser.invoke(args);
}

const USERS = [
  { id: 'u1', name: 'Nico Alimin', email: 'nico@e.com', role: 'admin' },
  { id: 'u2', name: 'Bob Smith', email: 'bob@e.com', role: 'user' },
  { id: 'u3', name: 'No Email', email: null, role: 'user' },
];

describe('lookup_user', () => {
  beforeEach(() => {
    findAllInWorkspace.mockReset();
    findAllInWorkspace.mockResolvedValue(USERS);
    getActiveWorkspaceId.mockReset();
    getActiveWorkspaceId.mockResolvedValue('ws-1');
  });

  it('requires a non-blank query', async () => {
    expect(String(await invoke({ query: '   ' }))).toMatch(/query is required/i);
    expect(findAllInWorkspace).not.toHaveBeenCalled();
  });

  it('only searches members of the active workspace', async () => {
    await invoke({ query: 'nico' });
    expect(findAllInWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('returns nothing when the active workspace has no members', async () => {
    findAllInWorkspace.mockResolvedValue([]);
    const result = String(await invoke({ query: 'nico' }));
    expect(result).toMatch(/No user in this workspace found/i);
    expect(result).not.toMatch(/nico@e\.com/);
  });

  it('matches by name fragment (case-insensitive) and returns only name + email', async () => {
    const result = String(await invoke({ query: 'nico' }));
    expect(result).toMatch(/nico@e\.com/);
    expect(result).toMatch(/Nico Alimin/);
    // Never leaks the id or role.
    expect(result).not.toMatch(/u1/);
    expect(result).not.toMatch(/admin/);
    // Only the one match, not Bob.
    expect(result).not.toMatch(/bob@e\.com/);
  });

  it('matches by email fragment', async () => {
    const result = String(await invoke({ query: 'BOB@' }));
    expect(result).toMatch(/bob@e\.com/);
    expect(result).toMatch(/Bob Smith/);
  });

  it('excludes users without an email', async () => {
    const result = String(await invoke({ query: 'no email' }));
    expect(result).toMatch(/No user in this workspace found/i);
  });

  it('reports when nothing matches', async () => {
    const result = String(await invoke({ query: 'zzz' }));
    expect(result).toMatch(/No user in this workspace found/i);
  });
});
