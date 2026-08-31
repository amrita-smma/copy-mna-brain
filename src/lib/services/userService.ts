import type { UserRepository } from '@/lib/repositories';

export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly workspaceId: string,
  ) {}

  /**
   * Users selectable in this workspace. Scoped to workspace membership — the
   * pickers this backs (Entered by, Deal Sponsor, Deal Captain) must not
   * offer users from other workspaces.
   */
  list() {
    return this.userRepo.findAllInWorkspace(this.workspaceId);
  }

  /**
   * The whole user directory, ignoring workspace membership. Only for the
   * superadmin admin portal, which needs to offer non-members when adding
   * someone to a workspace. Never use this to populate an in-app picker.
   */
  listAll() {
    return this.userRepo.findAll();
  }
}
