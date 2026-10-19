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
import {
  DEFAULT_PENDING_AUTOMATION,
  normalizePendingAutomation,
  type PendingAutomation,
} from '@/lib/sourcing/pendingAutomation';
import {
  COPILOT_AGENT_KEYS,
  DEFAULT_COPILOT_AGENT,
  isCopilotAgentType,
  type CopilotAgentType,
} from '@/lib/agents/analysis/flavors/keys';
import { CURRENCIES, normalizeCurrency, type Currency } from '@/lib/currency';
import {
  isDefaultPipelineRequiredFieldConfiguration,
  normalizePipelineRequiredFieldKeys,
  type PipelineFieldKey,
} from '@/lib/pipeline/requiredFields';
import {
  resolvePipelineHeading,
  type PipelineHeading,
  type PipelineHeadingInput,
} from '@/lib/pipeline/heading';

/** The AI Copilot flavors a workspace can be set to — the agent's own flavor
 *  registry (`src/lib/agents/analysis/flavors`), which is what actually runs.
 *  Imported from `flavors/keys`, a dependency-free module, so validating a
 *  column here never pulls the LangChain agent stack into a route. */
export const COPILOT_AGENTS: readonly CopilotAgentType[] = COPILOT_AGENT_KEYS;

/** The display currencies a workspace can be set to. Source of truth for
 *  validating the `default_currency` column and the PATCH payload. */
export const WORKSPACE_CURRENCIES: readonly Currency[] = CURRENCIES;

/** Narrow an arbitrary string to a valid CopilotAgentType, defaulting to 'mna'. */
export function normalizeCopilotAgent(value: string | null | undefined): CopilotAgentType {
  return isCopilotAgentType(value) ? value : DEFAULT_COPILOT_AGENT;
}

/** Raised when a role name passed to addMember/setMemberRole isn't a seeded role. */
export class RoleNotFoundError extends Error {
  constructor(roleName: string) {
    super(`Unknown role: ${roleName}`);
    this.name = 'RoleNotFoundError';
  }
}

/** Raised when a non-superadmin tries to archive or reinstate a workspace. */
export class NotSuperadminError extends Error {
  constructor() {
    super('Only a superadmin may archive or reinstate a workspace');
    this.name = 'NotSuperadminError';
  }
}

/** Raised when the workspace id passed to archive/reinstate doesn't exist. */
export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Unknown workspace: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
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
   *
   * A soft-deleted workspace is nobody's — not even a superadmin's. This is
   * the check behind the session-switch guard in `auth.ts`, so an archived
   * workspace can never become a session's active workspace, however stale
   * the caller's membership list is.
   */
  async isMember(userId: string, workspaceId: string): Promise<boolean> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace || workspace.deleted_at !== null) return false;
    if (await this.isSuperadmin(userId)) return true;
    const row = await this.userWorkspaceRepo.findOne(userId, workspaceId);
    return Boolean(row);
  }

  /**
   * Workspaces this user can enter via the picker/switcher: their real
   * memberships (with their real role), plus — for a superadmin — every
   * other workspace too, labeled with a synthetic "superadmin" role since
   * there's no real user_workspaces row backing that access.
   *
   * Soft-deleted workspaces appear in neither half: `findMembershipsForUser`
   * filters them out and `findAll` lists live rows only. That's what makes an
   * archived workspace vanish from the picker and from the JWT's `workspaces`
   * claim, which is in turn what makes `proxy.ts` bounce a member's
   * `/w/<slug>` request to `/workspace` with no DB access of its own.
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

  /**
   * Whether the user may perform workspace-admin-only actions in the given
   * workspace: a platform superadmin (global access) or a member holding the
   * `admin` role there. Used to gate privileged mutations such as combining
   * companies in the relationship graph.
   */
  async isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
    // Archived workspaces admit no one — same rule as `isMember`, so a
    // privileged mutation can't slip through on a stale session either.
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace || workspace.deleted_at !== null) return false;
    if (await this.isSuperadmin(userId)) return true;
    const memberships = await this.userWorkspaceRepo.findMembershipsForUser(userId);
    return memberships.some(
      (m) => m.workspaceId === workspaceId && m.roleName === 'admin',
    );
  }

  /** Live workspaces only. */
  listWorkspaces(): Promise<Tables<'workspaces'>[]> {
    return this.workspaceRepo.findAll();
  }

  /**
   * Every workspace, archived ones included, for the admin portal's listing.
   * Superadmin-only: the caller is re-checked here rather than trusted, so
   * the "deleted workspaces are visible to superadmins only" rule holds even
   * if a future route forgets its own gate.
   */
  async listWorkspacesIncludingDeleted(actorUserId: string): Promise<Tables<'workspaces'>[]> {
    if (!(await this.isSuperadmin(actorUserId))) throw new NotSuperadminError();
    return this.workspaceRepo.findAllIncludingDeleted();
  }

  /**
   * The live workspace behind a URL slug, or null when the slug is unknown
   * OR names a soft-deleted workspace. The `/w/[workspaceSlug]` layout uses
   * this to bounce to `/workspace`: it's the only gate that sees the DB, and
   * therefore the only one that can catch a superadmin (whom `proxy.ts` waves
   * through every slug) or a user holding a JWT issued before the archive.
   */
  async findActiveWorkspaceBySlug(slug: string): Promise<Tables<'workspaces'> | null> {
    const workspace = await this.workspaceRepo.findBySlug(slug);
    if (!workspace || workspace.deleted_at !== null) return null;
    return workspace;
  }

  /** Whether this workspace exists and is archived. */
  async isDeleted(id: string): Promise<boolean> {
    const workspace = await this.workspaceRepo.findById(id);
    return workspace?.deleted_at != null;
  }

  /**
   * Archive a workspace. Superadmin-only, and idempotent — re-archiving an
   * already-archived workspace returns it unchanged rather than overwriting
   * when it was archived. Nothing is erased: memberships, slug and data all
   * stay put so `restoreWorkspace` brings it back exactly as it was.
   */
  async softDeleteWorkspace(actorUserId: string, id: string): Promise<Tables<'workspaces'>> {
    if (!(await this.isSuperadmin(actorUserId))) throw new NotSuperadminError();
    const existing = await this.workspaceRepo.findById(id);
    if (!existing) throw new WorkspaceNotFoundError(id);
    if (existing.deleted_at !== null) return existing;
    const row = await this.workspaceRepo.softDelete(id);
    return row ?? existing;
  }

  /**
   * Reinstate an archived workspace. Superadmin-only; a workspace that isn't
   * archived is returned unchanged.
   */
  async restoreWorkspace(actorUserId: string, id: string): Promise<Tables<'workspaces'>> {
    if (!(await this.isSuperadmin(actorUserId))) throw new NotSuperadminError();
    const existing = await this.workspaceRepo.findById(id);
    if (!existing) throw new WorkspaceNotFoundError(id);
    if (existing.deleted_at === null) return existing;
    const row = await this.workspaceRepo.restore(id);
    return row ?? existing;
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

  /**
   * The workspace-wide display currency. Defaults to 'USD' when unset or
   * holding an unexpected value, so callers can rely on a valid Currency.
   */
  async getDefaultCurrency(id: string): Promise<Currency> {
    const ws = await this.workspaceRepo.findById(id);
    return normalizeCurrency(ws?.default_currency);
  }

  updateDefaultCurrency(
    id: string,
    currency: Currency,
  ): Promise<Tables<'workspaces'> | undefined> {
    return this.workspaceRepo.update(id, { default_currency: currency });
  }

  /**
   * The Deal Pipeline page heading for this workspace, already resolved: a
   * workspace that has never renamed it (or has cleared a field) reads back the
   * product default rather than null, so callers never render a blank heading.
   */
  async getPipelineHeading(id: string): Promise<PipelineHeading> {
    const ws = await this.workspaceRepo.findById(id);
    return resolvePipelineHeading(ws?.pipeline_title, ws?.pipeline_subtitle);
  }

  /**
   * Rename the pipeline heading for the whole workspace. `null` on a field
   * stores "use the default" — which is how clearing the input in the edit
   * dialog restores the original copy. Returns the resolved heading so the
   * caller can paint the result without a second read.
   */
  async updatePipelineHeading(
    id: string,
    input: PipelineHeadingInput,
  ): Promise<PipelineHeading> {
    const row = await this.workspaceRepo.update(id, {
      pipeline_title: input.title,
      pipeline_subtitle: input.subtitle,
    });
    if (!row) throw new WorkspaceNotFoundError(id);
    return resolvePipelineHeading(row.pipeline_title, row.pipeline_subtitle);
  }

  /** Sourcing → Pending Confirmation auto-scan / auto-promote / auto-drop toggles. */
  async getPendingAutomation(id: string): Promise<PendingAutomation> {
    const ws = await this.workspaceRepo.findById(id);
    if (!ws) return DEFAULT_PENDING_AUTOMATION;
    return normalizePendingAutomation({
      autoScan: ws.pending_auto_scan,
      autoPromote: ws.pending_auto_promote,
      autoDrop: ws.pending_auto_drop,
    });
  }

  async updatePendingAutomation(
    id: string,
    input: PendingAutomation,
  ): Promise<PendingAutomation> {
    const next = normalizePendingAutomation(input);
    const row = await this.workspaceRepo.update(id, {
      pending_auto_scan: next.autoScan,
      pending_auto_promote: next.autoPromote,
      pending_auto_drop: next.autoDrop,
    });
    if (!row) throw new WorkspaceNotFoundError(id);
    return normalizePendingAutomation({
      autoScan: row.pending_auto_scan,
      autoPromote: row.pending_auto_promote,
      autoDrop: row.pending_auto_drop,
    });
  }

  /**
   * Pipeline Settings → Required Fields: the keys a company must satisfy to
   * enter the pipeline. An unconfigured workspace gets the default (every field).
   */
  async getPipelineRequiredFields(id: string): Promise<PipelineFieldKey[]> {
    const ws = await this.workspaceRepo.findById(id);
    return normalizePipelineRequiredFieldKeys(ws?.pipeline_required_fields ?? null);
  }

  async updatePipelineRequiredFields(
    id: string,
    requiredFields: readonly PipelineFieldKey[],
  ): Promise<PipelineFieldKey[]> {
    const normalized = normalizePipelineRequiredFieldKeys(requiredFields);
    // NULL = "product default" so a future required field ships required here without
    // every workspace that left all toggles on needing a re-save.
    const stored = isDefaultPipelineRequiredFieldConfiguration(normalized) ? null : normalized;
    const row = await this.workspaceRepo.update(id, {
      pipeline_required_fields: stored,
    });
    if (!row) throw new WorkspaceNotFoundError(id);
    return normalizePipelineRequiredFieldKeys(row.pipeline_required_fields);
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
