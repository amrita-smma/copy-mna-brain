# Workspace soft delete (archive / reinstate)

A workspace can be **soft-deleted** (archived) instead of dropped: the row stays,
so nothing is destroyed and the slug stays reserved, but the workspace becomes
inaccessible to everyone.

- Persisted on `workspaces.deleted_at` (nullable `timestamptz`; non-null means
  archived; migration `20260915000000_add_workspaces_deleted_at`). The
  `workspaces_slug_key` unique constraint is deliberately left as a plain
  (non-partial) unique index — **an archived workspace keeps its slug**, so the
  slug can't be reused while the workspace could still come back.
- **Only a superadmin may archive or reinstate.** Enforced twice: the routes
  return 403, and `WorkspaceService.softDeleteWorkspace` / `restoreWorkspace`
  re-check `isSuperadmin` themselves and throw `NotSuperadminError`.
  `DELETE /api/workspaces/{id}` archives; `POST /api/workspaces/{id}/restore`
  reinstates. Both are idempotent.
- **It disappears from every listing.** `WorkspaceRepository.findAll` and
  `UserWorkspaceRepository.findMembershipsForUser` both filter on
  `deleted_at IS NULL`, so an archived workspace drops out of the `/workspace`
  picker, the nav switcher, `getAccessibleWorkspacesForUser`, the JWT's
  `workspaces` claim, and background sweeps (the vote-closing cron, graph sync,
  and synced-custodian-mailbox lookups) in one move. The single exception is
  `GET /api/workspaces?all=true` → `listWorkspacesIncludingDeleted`, which is
  superadmin-only and backs the admin portal's archived section.
- **It is inaccessible, not merely hidden.** Three layers:
  1. `proxy.ts` validates `/w/<slug>` against the JWT's `workspaces` claim —
     which no longer lists the archived workspace — and redirects members to
     `/workspace`. No DB access, so this is the cheap path.
  2. `src/app/w/[workspaceSlug]/layout.tsx` calls
     `workspaceService.findActiveWorkspaceBySlug(slug)` and redirects to
     `/workspace` when it returns null. This is the only gate with DB access and
     therefore the one that catches a **superadmin** (whom the proxy waves
     through every slug by design) and anyone holding a JWT issued before the
     archive.
  3. `WorkspaceService.isMember` / `isWorkspaceAdmin` return false for an
     archived workspace **even for a superadmin**, so the `update({ workspaceId })`
     session switch in `auth.ts` can't make one the active workspace.
- **Admin portal UI** (`/admin-portal`): live workspaces list as usual; archived
  ones sit in a collapsed **Deleted (n)** disclosure underneath, visible only to
  a superadmin. Selecting one replaces the settings tabs with an archived banner
  and a **Reinstate workspace** button; a live workspace gets a **Delete
  workspace** button with a confirmation dialog. Reinstating restores the
  workspace exactly as it was — data, members, slug and settings all intact.
