# User Management (admin portal)

`/admin-portal` renders a "User Management" section above the per-workspace
"Workspace Configuration" panel: a superadmin-only global directory of every
platform user, backed by `UserService` and `PATCH/DELETE /api/users/[id]`,
`POST /api/users/[id]/reactivate`, and `POST /api/users/[id]/send-reset-link`
(all session-gated superadmin routes, following the same `auth()` +
`workspaceService.isSuperadmin` gate as `POST /api/users` and
`/api/workspaces/[id]`).

Supported actions per user:
- **Add** — see "Account invite flow" above.
- **Change name / change email** — inline edit, `UserService.updateProfile`.
  A new email must not already belong to a different user.
- **Send password-reset link** — `UserService.sendResetLink` delegates to
  `AuthService.forgetPassword`, the same mechanism the self-service "Forgot
  password?" flow uses, just triggered by an admin instead of the user.
- **Deactivate / Reactivate** — soft delete, not a hard `DELETE FROM users`.

**Why deactivate instead of a hard delete.** `users.id` is referenced by
~40 foreign keys across the schema. A few (company-vote sessions/ballots)
are `onDelete: restrict`, so a real hard delete throws outright for any user
who has ever voted; most others are `onDelete: cascade` (workspace
memberships, chat history, consents, recent files, reset tokens), so a hard
delete would silently wipe them for everyone else. `users.deactivated_at`
(migration `20260916000000_add_users_deactivated_at.sql`) mirrors the
`workspaces.deleted_at` soft-delete pattern instead: a non-null value blocks
sign-in (checked in `AuthService.signIn` / `signInWithGoogleToken` /
`signInWithLauncherToken`, raised as `AccountDeactivatedError`) but the row,
its history, and every foreign key referencing it are left untouched, so a
superadmin can reactivate the account at any time. A superadmin cannot
deactivate their own account (`CannotDeactivateSelfError`) — that would lock
them out with no one left to reverse it.
