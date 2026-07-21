import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  RoleRepository,
  UserRepository,
  UserWorkspaceRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import {
  RoleNotFoundError,
  WorkspaceService,
  normalizeCopilotAgent,
  COPILOT_AGENTS,
} from './workspaceService';

function makeRepoStubs() {
  const workspaceRepo = {
    findAll: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  } as unknown as WorkspaceRepository;
  const userWorkspaceRepo = {
    findByUserId: vi.fn(),
    findByWorkspaceId: vi.fn(),
    insert: vi.fn(),
    findWorkspaceIdsBySyncedEmail: vi.fn(),
    findMembershipsForUser: vi.fn(),
    findMembersForWorkspace: vi.fn(),
    findOne: vi.fn(),
    updateRole: vi.fn(),
    updateEmailSync: vi.fn(),
    delete: vi.fn(),
  } as unknown as UserWorkspaceRepository;
  const roleRepo = {
    findAll: vi.fn(),
    findByName: vi.fn(),
    insert: vi.fn(),
  } as unknown as RoleRepository;
  const userRepo = {
    findById: vi.fn(),
  } as unknown as UserRepository;
  return { workspaceRepo, userWorkspaceRepo, roleRepo, userRepo };
}

describe('WorkspaceService.resolveDefaultWorkspaceId', () => {
  let repos: ReturnType<typeof makeRepoStubs>;
  let service: WorkspaceService;

  beforeEach(() => {
    repos = makeRepoStubs();
    service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);
  });

  it('returns null for a user with zero memberships', async () => {
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await service.resolveDefaultWorkspaceId('u1');

    expect(result).toBeNull();
  });

  it('prefers the MnA workspace when the user is a member of it', async () => {
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { workspaceId: 'other-ws', workspaceName: 'Other', workspaceSlug: 'other', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
      { workspaceId: MNA_WORKSPACE_ID, workspaceName: 'MnA', workspaceSlug: 'mna', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
    ]);

    const result = await service.resolveDefaultWorkspaceId('u1');

    expect(result).toBe(MNA_WORKSPACE_ID);
  });

  it('falls back to the oldest membership when the user is not in MnA', async () => {
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { workspaceId: 'oldest-ws', workspaceName: 'Oldest', workspaceSlug: 'oldest', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
      { workspaceId: 'newer-ws', workspaceName: 'Newer', workspaceSlug: 'newer', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
    ]);

    const result = await service.resolveDefaultWorkspaceId('u1');

    expect(result).toBe('oldest-ws');
  });
});

describe('WorkspaceService.isMember', () => {
  it('returns true when a membership row exists', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    (repos.userWorkspaceRepo.findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'uw1' });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.isMember('u1', 'w1');

    expect(result).toBe(true);
  });

  it('returns false when no membership row exists and the user is not a superadmin', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    (repos.userWorkspaceRepo.findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.isMember('u1', 'w-not-a-member');

    expect(result).toBe(false);
  });

  it('returns true for a superadmin even with no membership row (implicit access to every workspace)', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: true });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.isMember('u1', 'w-not-a-member');

    expect(result).toBe(true);
    expect(repos.userWorkspaceRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.getAccessibleWorkspacesForUser', () => {
  it('returns just the real memberships for a non-superadmin', async () => {
    const repos = makeRepoStubs();
    const memberships = [
      { workspaceId: 'w1', workspaceName: 'W1', workspaceSlug: 'w1', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
    ];
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(memberships);
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.getAccessibleWorkspacesForUser('u1');

    expect(result).toEqual(memberships);
    expect(repos.workspaceRepo.findAll).not.toHaveBeenCalled();
  });

  it('adds every other workspace with a synthetic superadmin role for a superadmin', async () => {
    const repos = makeRepoStubs();
    const memberships = [
      { workspaceId: 'w1', workspaceName: 'W1', workspaceSlug: 'w1', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
    ];
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(memberships);
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: true });
    (repos.workspaceRepo.findAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'w1', name: 'W1', slug: 'w1' },
      { id: 'w2', name: 'W2', slug: 'w2' },
    ]);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.getAccessibleWorkspacesForUser('u1');

    expect(result).toEqual([
      memberships[0],
      { workspaceId: 'w2', workspaceName: 'W2', workspaceSlug: 'w2', roleId: '', roleName: 'superadmin', isEmailSynced: false },
    ]);
  });
});

describe('WorkspaceService.isSuperadmin', () => {
  it('returns true when the user row has is_superadmin set', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: true });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.isSuperadmin('u1')).toBe(true);
  });

  it('returns false when the user row has is_superadmin false', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.isSuperadmin('u1')).toBe(false);
  });

  it('returns false when the user does not exist', async () => {
    const repos = makeRepoStubs();
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.isSuperadmin('missing')).toBe(false);
  });
});

describe('WorkspaceService.addMember', () => {
  it('resolves the role name to a role_id before inserting', async () => {
    const repos = makeRepoStubs();
    (repos.roleRepo.findByName as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'role-editor', name: 'editor' });
    (repos.userWorkspaceRepo.insert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'uw1' });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await service.addMember({ userId: 'u1', workspaceId: 'w1', roleName: 'editor' });

    expect(repos.userWorkspaceRepo.insert).toHaveBeenCalledWith({
      user_id: 'u1',
      workspace_id: 'w1',
      role_id: 'role-editor',
    });
  });

  it('throws RoleNotFoundError for an unseeded role name', async () => {
    const repos = makeRepoStubs();
    (repos.roleRepo.findByName as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(service.addMember({ userId: 'u1', workspaceId: 'w1', roleName: 'owner' })).rejects.toThrow(
      RoleNotFoundError,
    );
    expect(repos.userWorkspaceRepo.insert).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.setMemberRole', () => {
  it('resolves the role name and updates the membership row', async () => {
    const repos = makeRepoStubs();
    (repos.roleRepo.findByName as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'role-admin', name: 'admin' });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await service.setMemberRole('u1', 'w1', 'admin');

    expect(repos.userWorkspaceRepo.updateRole).toHaveBeenCalledWith('u1', 'w1', 'role-admin');
  });
});

describe('WorkspaceService.setMemberEmailSync', () => {
  it('delegates to the repository update', async () => {
    const repos = makeRepoStubs();
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await service.setMemberEmailSync('u1', 'w1', true);

    expect(repos.userWorkspaceRepo.updateEmailSync).toHaveBeenCalledWith('u1', 'w1', true);
  });
});

describe('WorkspaceService.removeMember', () => {
  it('delegates to the repository delete', async () => {
    const repos = makeRepoStubs();
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await service.removeMember('u1', 'w1');

    expect(repos.userWorkspaceRepo.delete).toHaveBeenCalledWith('u1', 'w1');
  });
});

describe('WorkspaceService.getMembersForWorkspace', () => {
  it('delegates to the repository join', async () => {
    const repos = makeRepoStubs();
    const rows = [{ userId: 'u1', userName: 'Alice', userEmail: 'alice@x', roleId: 'r1', roleName: 'editor' }];
    (repos.userWorkspaceRepo.findMembersForWorkspace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.getMembersForWorkspace('w1');

    expect(result).toEqual(rows);
    expect(repos.userWorkspaceRepo.findMembersForWorkspace).toHaveBeenCalledWith('w1');
  });
});

describe('WorkspaceService.renameWorkspace', () => {
  it('delegates to the repository update', async () => {
    const repos = makeRepoStubs();
    const row = { id: 'w1', name: 'Renamed', slug: 'mna' };
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.renameWorkspace('w1', 'Renamed');

    expect(result).toEqual(row);
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', { name: 'Renamed' });
  });
});

describe('WorkspaceService.updateWorkspaceSlug', () => {
  it('delegates to the repository update', async () => {
    const repos = makeRepoStubs();
    const row = { id: 'w1', name: 'MnA', slug: 'kenhua' };
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.updateWorkspaceSlug('w1', 'kenhua');

    expect(result).toEqual(row);
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', { slug: 'kenhua' });
  });
});

describe('normalizeCopilotAgent', () => {
  it('accepts the investment flavor', () => {
    expect(normalizeCopilotAgent('investment')).toBe('investment');
  });

  it('accepts the combined flavor', () => {
    expect(normalizeCopilotAgent('combined')).toBe('combined');
  });

  it('defaults to mna for null, undefined, or unrecognized values', () => {
    expect(normalizeCopilotAgent(null)).toBe('mna');
    expect(normalizeCopilotAgent(undefined)).toBe('mna');
    expect(normalizeCopilotAgent('mna')).toBe('mna');
    expect(normalizeCopilotAgent('bogus')).toBe('mna');
  });

  it('exposes exactly the three supported flavors', () => {
    expect([...COPILOT_AGENTS]).toEqual(['mna', 'investment', 'combined']);
  });
});

describe('WorkspaceService.getCopilotAgent', () => {
  it('returns the stored flavor when it is investment', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      copilot_agent: 'investment',
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getCopilotAgent('w1')).toBe('investment');
    expect(repos.workspaceRepo.findById).toHaveBeenCalledWith('w1');
  });

  it('defaults to mna when the workspace is missing or the value is unset', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getCopilotAgent('missing')).toBe('mna');
  });
});

describe('WorkspaceService.updateCopilotAgent', () => {
  it('delegates to the repository update with the copilot_agent column', async () => {
    const repos = makeRepoStubs();
    const row = { id: 'w1', name: 'MnA', slug: 'mna', copilot_agent: 'investment' };
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.updateCopilotAgent('w1', 'investment');

    expect(result).toEqual(row);
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', { copilot_agent: 'investment' });
  });
});

describe('WorkspaceService.isWorkspaceAdmin', () => {
  let repos: ReturnType<typeof makeRepoStubs>;
  let service: WorkspaceService;

  beforeEach(() => {
    repos = makeRepoStubs();
    service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);
  });

  it('returns true for a platform superadmin without checking memberships', async () => {
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: true });

    const result = await service.isWorkspaceAdmin('u1', 'w1');

    expect(result).toBe(true);
    expect(repos.userWorkspaceRepo.findMembershipsForUser).not.toHaveBeenCalled();
  });

  it('returns true when the user has the admin role in the workspace', async () => {
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { workspaceId: 'other', workspaceName: 'Other', workspaceSlug: 'other', roleId: 'r1', roleName: 'admin', isEmailSynced: false },
      { workspaceId: 'w1', workspaceName: 'W1', workspaceSlug: 'w1', roleId: 'r2', roleName: 'admin', isEmailSynced: false },
    ]);

    const result = await service.isWorkspaceAdmin('u1', 'w1');

    expect(result).toBe(true);
  });

  it('returns false when the user is only an editor/viewer in the workspace', async () => {
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { workspaceId: 'w1', workspaceName: 'W1', workspaceSlug: 'w1', roleId: 'r2', roleName: 'editor', isEmailSynced: false },
    ]);

    const result = await service.isWorkspaceAdmin('u1', 'w1');

    expect(result).toBe(false);
  });

  it('returns false when the admin role is for a different workspace', async () => {
    (repos.userRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', is_superadmin: false });
    (repos.userWorkspaceRepo.findMembershipsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { workspaceId: 'other', workspaceName: 'Other', workspaceSlug: 'other', roleId: 'r1', roleName: 'admin', isEmailSynced: false },
    ]);

    const result = await service.isWorkspaceAdmin('u1', 'w1');

    expect(result).toBe(false);
  });
});
