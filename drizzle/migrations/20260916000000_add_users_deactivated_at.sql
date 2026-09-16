-- add_users_deactivated_at
--
-- Soft "deactivate" for users, mirroring workspaces.deleted_at. A non-null
-- deactivated_at blocks sign-in (AuthService.signIn / signInWithGoogleToken /
-- signInWithLauncherToken all reject it) but the row, its history, and every
-- foreign key referencing it are kept, so a superadmin can reactivate the
-- account at any time from the admin portal's User Management section.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamptz;

-- Listings that need to split active vs. deactivated users filter on this.
CREATE INDEX IF NOT EXISTS "idx_users_deactivated_at" ON "users" USING btree ("deactivated_at");
