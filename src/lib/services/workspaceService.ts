import type {
  MembershipDetail,
  RoleRepository,
  Tables,
  UserRepository,
  UserWorkspaceRepository,
  WorkspaceMemberDetail,
  WorkspaceRepository,
} from '@/lib/repositories';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import type { CopilotAgentType } from '@/lib/agents/analysis';

/** The AI Copilot flavors a workspace can be set to. Source of truth for
 *  validating the `copilot_agent` column and the PATCH payload. */
export const COPILOT_AGENTS: readonly CopilotAgentType[] = ['mna', 'investment'] as const;

/** Narrow an arbitrary string to a valid CopilotAgentType, defaulting to 'mna'. */
export function normalizeCopilotAgent(value: string | null | undefined): CopilotAgentType {
  return value === 'investment' ? 'investment' : 'mna';
}

/** Raised when a role name passed to addMember/setMemberRole isn't a seeded role. */
export class RoleNotFoundError extends Error {
  constructor(roleName: string) {
    super(`Unknown role: ${roleName}`);
    this.name = 'RoleNotFoundError';
  }
}

export class WorkspaceService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly userWorkspaceRepo: UserWorkspaceRepository,
    private readonly roleRepo: RoleRepository,
    private readonly userRepo: UserRepository,
  ) {}

  getMembershipsForUser(userId: string): Promise<MembershipDetail[]> {
    return this.userWorkspaceRepo.findMembershipsForUser(userId);
  }

  /**
   * A superadmin can switch into and read/write any workspace, explicit
   * `user_workspaces` row or not — that's the whole point of the flag being
   * global rather than per-workspace. Everyone else needs a real membership row.
   */
  async isMember(userId: string, workspaceId: string): Promise<boolean> {
    if (await this.isSuperadmin(userId)) return true;
    const row = await this.userWorkspaceRepo.findOne(userId, workspaceId);
    return Boolean(row);
  }

  /**
   * Workspaces this user can enter via the picker/switcher: their real
   * memberships (with their real role), plus — for a superadmin — every
   * other workspace too, labeled with a synthetic "superadmin" role since
   * there's no real user_workspaces row backing that access.
   */
  async getAccessibleWorkspacesForUser(userId: string): Promise<MembershipDetail[]> {
    const memberships = await this.userWorkspaceRepo.findMembershipsForUser(userId);
    if (!(await this.isSuperadmin(userId))) return memberships;

    const memberWorkspaceIds = new Set(memberships.map((m) => m.workspaceId));
    const allWorkspaces = await this.workspaceRepo.findAll();
    const implicitAccess: MembershipDetail[] = allWorkspaces
      .filter((w) => !memberWorkspaceIds.has(w.id))
      .map((w) => ({
        workspaceId: w.id,
        workspaceName: w.name,
        workspaceSlug: w.slug,
        roleId: '',
        roleName: 'superadmin',
        isEmailSynced: false,
      }));
    return [...memberships, ...implicitAccess];
  }

  /**
   * The workspace a user lands in right after sign-in: the platform workspace
   * if they're a member of it, otherwise their oldest membership, otherwise
   * null (a genuinely unassigned user — see getActiveWorkspaceId's
   * NO_ACTIVE_WORKSPACE_ID handling for what null means downstream).
   */
  async resolveDefaultWorkspaceId(userId: string): Promise<string | null> {
    const memberships = await this.userWorkspaceRepo.findMembershipsForUser(userId);
    if (memberships.length === 0) return null;
    const mna = memberships.find((m) => m.workspaceId === MNA_WORKSPACE_ID);
    return (mna ?? memberships[0]).workspaceId;
  }

  async isSuperadmin(userId: string): Promise<boolean> {
    const user = await this.userRepo.findById(userId);
    return user?.is_superadmin === true;
  }

  listWorkspaces(): Promise<Tables<'workspaces'>[]> {
    return this.workspaceRepo.findAll();
  }

  createWorkspace(input: { name: string; slug: string }): Promise<Tables<'workspaces'>> {
    return this.workspaceRepo.insert(input);
  }

  renameWorkspace(id: string, name: string): Promise<Tables<'workspaces'> | undefined> {
    return this.workspaceRepo.update(id, { name });
  }

  updateWorkspaceSlug(id: string, slug: string): Promise<Tables<'workspaces'> | undefined> {
    return this.workspaceRepo.update(id, { slug });
  }

  /**
   * The AI Copilot flavor this workspace uses. Defaults to 'mna' when unset or
   * holding an unexpected value, so callers can rely on a valid CopilotAgentType.
   */
  async getCopilotAgent(id: string): Promise<CopilotAgentType> {
    const ws = await this.workspaceRepo.findById(id);
    return normalizeCopilotAgent(ws?.copilot_agent);
  }

  updateCopilotAgent(
    id: string,
    agent: CopilotAgentType,
  ): Promise<Tables<'workspaces'> | undefined> {
    return this.workspaceRepo.update(id, { copilot_agent: agent });
  }

  listRoles(): Promise<Tables<'roles'>[]> {
    return this.roleRepo.findAll();
  }

  getMembersForWorkspace(workspaceId: string): Promise<WorkspaceMemberDetail[]> {
    return this.userWorkspaceRepo.findMembersForWorkspace(workspaceId);
  }

  private async resolveRoleId(roleName: string): Promise<string> {
    const role = await this.roleRepo.findByName(roleName);
    if (!role) throw new RoleNotFoundError(roleName);
    return role.id;
  }

  async addMember(input: { userId: string; workspaceId: string; roleName: string }): Promise<Tables<'user_workspaces'>> {
    const roleId = await this.resolveRoleId(input.roleName);
    return this.userWorkspaceRepo.insert({
      user_id: input.userId,
      workspace_id: input.workspaceId,
      role_id: roleId,
    });
  }

  async setMemberRole(userId: string, workspaceId: string, roleName: string): Promise<Tables<'user_workspaces'> | undefined> {
    const roleId = await this.resolveRoleId(roleName);
    return this.userWorkspaceRepo.updateRole(userId, workspaceId, roleId);
  }

  setMemberEmailSync(
    userId: string,
    workspaceId: string,
    isEmailSynced: boolean,
  ): Promise<Tables<'user_workspaces'> | undefined> {
    return this.userWorkspaceRepo.updateEmailSync(userId, workspaceId, isEmailSynced);
  }

  removeMember(userId: string, workspaceId: string): Promise<void> {
    return this.userWorkspaceRepo.delete(userId, workspaceId);
  }
}
