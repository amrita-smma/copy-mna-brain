import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  RoleRepository,
  UserRepository,
  UserWorkspaceRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import {
  NotSuperadminError,
  RoleNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceService,
  normalizeCopilotAgent,
  COPILOT_AGENTS,
  WORKSPACE_CURRENCIES,
} from './workspaceService';

function makeRepoStubs() {
  const workspaceRepo = {
    findAll: vi.fn(),
    findAllIncludingDeleted: vi.fn(),
    // Default to a live workspace. `isMember`/`isWorkspaceAdmin` read the row
    // to reject soft-deleted workspaces, so without this every membership test
    // would fail on a missing row rather than on the behaviour it's asserting.
    // Archive-specific tests override with `mockResolvedValueOnce`.
    findById: vi.fn(async (id: string) => ({ id, name: 'W', slug: 'w', deleted_at: null })),
    findActiveById: vi.fn(),
    findBySlug: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    restore: vi.fn(),
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

  it('accepts the vc flavor', () => {
    expect(normalizeCopilotAgent('vc')).toBe('vc');
  });

  it('accepts the crowdfunding flavor', () => {
    expect(normalizeCopilotAgent('crowdfunding')).toBe('crowdfunding');
  });

  it('accepts the minority-stakes portfolio manager flavor', () => {
    expect(normalizeCopilotAgent('minority')).toBe('minority');
  });

  it('accepts the investment banking advisory flavor', () => {
    expect(normalizeCopilotAgent('investment_banking')).toBe('investment_banking');
  });

  it('accepts the capital markets flavor', () => {
    expect(normalizeCopilotAgent('capital_markets')).toBe('capital_markets');
  });

  it('defaults to mna for null, undefined, or unrecognized values', () => {
    expect(normalizeCopilotAgent(null)).toBe('mna');
    expect(normalizeCopilotAgent(undefined)).toBe('mna');
    expect(normalizeCopilotAgent('mna')).toBe('mna');
    expect(normalizeCopilotAgent('bogus')).toBe('mna');
  });

  it('exposes exactly the supported flavors', () => {
    expect([...COPILOT_AGENTS]).toEqual([
      'mna',
      'investment',
      'combined',
      'vc',
      'minority',
      'crowdfunding',
      'investment_banking',
      'capital_markets',
    ]);
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

describe('WORKSPACE_CURRENCIES', () => {
  it('exposes exactly the three supported currencies', () => {
    expect([...WORKSPACE_CURRENCIES]).toEqual(['USD', 'IDR', 'CNY']);
  });
});

describe('WorkspaceService.getDefaultCurrency', () => {
  it('returns the stored currency when it is IDR', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      default_currency: 'IDR',
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getDefaultCurrency('w1')).toBe('IDR');
    expect(repos.workspaceRepo.findById).toHaveBeenCalledWith('w1');
  });

  it('defaults to USD when the workspace is missing or the value is unset', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getDefaultCurrency('missing')).toBe('USD');
  });
});

describe('WorkspaceService.updateDefaultCurrency', () => {
  it('delegates to the repository update with the default_currency column', async () => {
    const repos = makeRepoStubs();
    const row = { id: 'w1', name: 'MnA', slug: 'mna', default_currency: 'CNY' };
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.updateDefaultCurrency('w1', 'CNY');

    expect(result).toEqual(row);
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', { default_currency: 'CNY' });
  });
});

describe('WorkspaceService.getPipelineHeading', () => {
  it('returns the workspace\u2019s stored title and subtitle', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pipeline_title: 'Acquisitions',
      pipeline_subtitle: 'Live targets only',
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getPipelineHeading('w1')).toEqual({
      title: 'Acquisitions',
      subtitle: 'Live targets only',
    });
    expect(repos.workspaceRepo.findById).toHaveBeenCalledWith('w1');
  });

  it('falls back to the product defaults for a workspace that never set one', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pipeline_title: null,
      pipeline_subtitle: null,
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getPipelineHeading('w1')).toEqual({
      title: 'Deal Pipeline',
      subtitle: 'Track companies through all stages',
    });
  });

  it('falls back to the defaults when the workspace row is missing', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    expect(await service.getPipelineHeading('missing')).toEqual({
      title: 'Deal Pipeline',
      subtitle: 'Track companies through all stages',
    });
  });
});

describe('WorkspaceService.updatePipelineHeading', () => {
  it('writes both columns and returns the resolved heading', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pipeline_title: 'Acquisitions',
      pipeline_subtitle: 'Live targets only',
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.updatePipelineHeading('w1', {
      title: 'Acquisitions',
      subtitle: 'Live targets only',
    });

    expect(result).toEqual({ title: 'Acquisitions', subtitle: 'Live targets only' });
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', {
      pipeline_title: 'Acquisitions',
      pipeline_subtitle: 'Live targets only',
    });
  });

  it('stores null to clear a field, and reads back the default for it', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pipeline_title: 'Acquisitions',
      pipeline_subtitle: null,
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    const result = await service.updatePipelineHeading('w1', {
      title: 'Acquisitions',
      subtitle: null,
    });

    expect(result).toEqual({
      title: 'Acquisitions',
      subtitle: 'Track companies through all stages',
    });
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', {
      pipeline_title: 'Acquisitions',
      pipeline_subtitle: null,
    });
  });

  it('throws WorkspaceNotFoundError when the update matches no row', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(
      service.updatePipelineHeading('missing', { title: 'Acquisitions', subtitle: null }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
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

/** A live workspace row, as the archive-aware lookups see it. */
const LIVE_WORKSPACE = { id: 'w1', name: 'W1', slug: 'w1', deleted_at: null };
/** The same workspace, soft-deleted. */
const ARCHIVED_WORKSPACE = { id: 'w1', name: 'W1', slug: 'w1', deleted_at: '2026-09-15T00:00:00.000Z' };

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/** Fresh stubs plus a service wired to them, for the soft-delete suites. */
function makeArchiveHarness() {
  const repos = makeRepoStubs();
  const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);
  const actingAs = (isSuperadmin: boolean) =>
    asMock(repos.userRepo.findById).mockResolvedValue({ id: 'u1', is_superadmin: isSuperadmin });
  return { repos, service, actingAs };
}

describe('WorkspaceService.softDeleteWorkspace', () => {
  let harness: ReturnType<typeof makeArchiveHarness>;

  beforeEach(() => {
    harness = makeArchiveHarness();
  });

  it('archives the workspace for a superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(LIVE_WORKSPACE);
    asMock(repos.workspaceRepo.softDelete).mockResolvedValueOnce(ARCHIVED_WORKSPACE);

    const result = await service.softDeleteWorkspace('u1', 'w1');

    expect(result).toEqual(ARCHIVED_WORKSPACE);
    expect(repos.workspaceRepo.softDelete).toHaveBeenCalledWith('w1');
  });

  it('rejects a non-superadmin without touching the row', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(false);

    await expect(service.softDeleteWorkspace('u1', 'w1')).rejects.toBeInstanceOf(NotSuperadminError);
    expect(repos.workspaceRepo.softDelete).not.toHaveBeenCalled();
  });

  it('throws WorkspaceNotFoundError for an unknown id', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(undefined);

    await expect(service.softDeleteWorkspace('u1', 'nope')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('is a no-op on an already-archived workspace, preserving deleted_at', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(ARCHIVED_WORKSPACE);

    const result = await service.softDeleteWorkspace('u1', 'w1');

    expect(result).toEqual(ARCHIVED_WORKSPACE);
    expect(repos.workspaceRepo.softDelete).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.restoreWorkspace', () => {
  let harness: ReturnType<typeof makeArchiveHarness>;

  beforeEach(() => {
    harness = makeArchiveHarness();
  });

  it('reinstates an archived workspace for a superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(ARCHIVED_WORKSPACE);
    asMock(repos.workspaceRepo.restore).mockResolvedValueOnce(LIVE_WORKSPACE);

    const result = await service.restoreWorkspace('u1', 'w1');

    expect(result).toEqual(LIVE_WORKSPACE);
    expect(repos.workspaceRepo.restore).toHaveBeenCalledWith('w1');
  });

  it('rejects a non-superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(false);

    await expect(service.restoreWorkspace('u1', 'w1')).rejects.toBeInstanceOf(NotSuperadminError);
    expect(repos.workspaceRepo.restore).not.toHaveBeenCalled();
  });

  it('leaves a live workspace untouched', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(LIVE_WORKSPACE);

    const result = await service.restoreWorkspace('u1', 'w1');

    expect(result).toEqual(LIVE_WORKSPACE);
    expect(repos.workspaceRepo.restore).not.toHaveBeenCalled();
  });

  it('throws WorkspaceNotFoundError for an unknown id', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(undefined);

    await expect(service.restoreWorkspace('u1', 'nope')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe('WorkspaceService.isMember (soft-deleted workspaces)', () => {
  let harness: ReturnType<typeof makeArchiveHarness>;

  beforeEach(() => {
    harness = makeArchiveHarness();
  });

  it('returns false for a soft-deleted workspace even for a superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(ARCHIVED_WORKSPACE);

    const result = await service.isMember('u1', 'w1');

    expect(result).toBe(false);
    expect(repos.userWorkspaceRepo.findOne).not.toHaveBeenCalled();
  });

  it('returns false when the workspace row is missing entirely', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(undefined);

    expect(await service.isMember('u1', 'gone')).toBe(false);
  });
});

describe('WorkspaceService.isWorkspaceAdmin (soft-deleted workspaces)', () => {
  it('returns false for a soft-deleted workspace even for a superadmin', async () => {
    const { repos, service, actingAs } = makeArchiveHarness();
    actingAs(true);
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(ARCHIVED_WORKSPACE);

    expect(await service.isWorkspaceAdmin('u1', 'w1')).toBe(false);
  });
});

describe('WorkspaceService.findActiveWorkspaceBySlug', () => {
  let harness: ReturnType<typeof makeArchiveHarness>;

  beforeEach(() => {
    harness = makeArchiveHarness();
  });

  it('returns the workspace when it is live', async () => {
    const { repos, service } = harness;
    asMock(repos.workspaceRepo.findBySlug).mockResolvedValueOnce(LIVE_WORKSPACE);

    expect(await service.findActiveWorkspaceBySlug('w1')).toEqual(LIVE_WORKSPACE);
  });

  it('returns null for a soft-deleted slug', async () => {
    const { repos, service } = harness;
    asMock(repos.workspaceRepo.findBySlug).mockResolvedValueOnce(ARCHIVED_WORKSPACE);

    expect(await service.findActiveWorkspaceBySlug('w1')).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    const { repos, service } = harness;
    asMock(repos.workspaceRepo.findBySlug).mockResolvedValueOnce(undefined);

    expect(await service.findActiveWorkspaceBySlug('nope')).toBeNull();
  });
});

describe('WorkspaceService.isDeleted', () => {
  it('reports whether the workspace is archived', async () => {
    const { repos, service } = makeArchiveHarness();
    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(ARCHIVED_WORKSPACE);
    expect(await service.isDeleted('w1')).toBe(true);

    asMock(repos.workspaceRepo.findById).mockResolvedValueOnce(LIVE_WORKSPACE);
    expect(await service.isDeleted('w1')).toBe(false);
  });
});

describe('WorkspaceService.listWorkspaces', () => {
  it('lists live workspaces only', async () => {
    const { repos, service } = makeArchiveHarness();
    asMock(repos.workspaceRepo.findAll).mockResolvedValueOnce([LIVE_WORKSPACE]);

    expect(await service.listWorkspaces()).toEqual([LIVE_WORKSPACE]);
    expect(repos.workspaceRepo.findAllIncludingDeleted).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.listWorkspacesIncludingDeleted', () => {
  let harness: ReturnType<typeof makeArchiveHarness>;

  beforeEach(() => {
    harness = makeArchiveHarness();
  });

  it('returns archived rows to a superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(true);
    asMock(repos.workspaceRepo.findAllIncludingDeleted).mockResolvedValueOnce([
      LIVE_WORKSPACE,
      ARCHIVED_WORKSPACE,
    ]);

    expect(await service.listWorkspacesIncludingDeleted('u1')).toEqual([LIVE_WORKSPACE, ARCHIVED_WORKSPACE]);
  });

  it('rejects a non-superadmin', async () => {
    const { repos, service, actingAs } = harness;
    actingAs(false);

    await expect(service.listWorkspacesIncludingDeleted('u1')).rejects.toBeInstanceOf(NotSuperadminError);
    expect(repos.workspaceRepo.findAllIncludingDeleted).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.getAccessibleWorkspacesForUser (soft-deleted workspaces)', () => {
  it('never offers a soft-deleted workspace to a superadmin', async () => {
    const { repos, service, actingAs } = makeArchiveHarness();
    actingAs(true);
    asMock(repos.userWorkspaceRepo.findMembershipsForUser).mockResolvedValueOnce([]);
    // `findAll` is the live-only listing, so an archived row is simply absent
    // from the implicit-access half of the result.
    asMock(repos.workspaceRepo.findAll).mockResolvedValueOnce([
      { id: 'w2', name: 'W2', slug: 'w2', deleted_at: null },
    ]);

    const result = await service.getAccessibleWorkspacesForUser('u1');

    expect(result.map((m) => m.workspaceId)).toEqual(['w2']);
  });
});

describe('WorkspaceService.getPendingAutomation', () => {
  it('reads both toggles off the workspace row', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pending_auto_scan: true,
      pending_auto_drop_promote: true,
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(service.getPendingAutomation('w1')).resolves.toEqual({
      autoScan: true,
      autoDropPromote: true,
    });
  });

  it('defaults both off for an unknown workspace', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(service.getPendingAutomation('w1')).resolves.toEqual({
      autoScan: false,
      autoDropPromote: false,
    });
  });
});

describe('WorkspaceService.updatePendingAutomation', () => {
  it('never stores auto drop/promote on without auto-scan', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'w1',
      pending_auto_scan: false,
      pending_auto_drop_promote: false,
    });
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(
      service.updatePendingAutomation('w1', { autoScan: false, autoDropPromote: true }),
    ).resolves.toEqual({ autoScan: false, autoDropPromote: false });
    expect(repos.workspaceRepo.update).toHaveBeenCalledWith('w1', {
      pending_auto_scan: false,
      pending_auto_drop_promote: false,
    });
  });

  it('throws WorkspaceNotFoundError when no row was updated', async () => {
    const repos = makeRepoStubs();
    (repos.workspaceRepo.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const service = new WorkspaceService(repos.workspaceRepo, repos.userWorkspaceRepo, repos.roleRepo, repos.userRepo);

    await expect(
      service.updatePendingAutomation('w1', { autoScan: true, autoDropPromote: true }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});
