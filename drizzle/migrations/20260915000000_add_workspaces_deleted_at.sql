-- add_workspaces_deleted_at
--
-- Soft delete for workspaces. A non-null `deleted_at` archives the workspace:
-- it is hidden from every listing and `/w/<slug>/...` becomes unreachable,
-- but the row (and therefore the slug's uniqueness) is preserved so a
-- superadmin can reinstate it later. `workspaces_slug_key` is intentionally
-- left as a plain unique constraint — a deleted workspace keeps its slug.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

-- Every listing query filters on `deleted_at IS NULL`.
CREATE INDEX IF NOT EXISTS "idx_workspaces_deleted_at" ON "workspaces" USING btree ("deleted_at");
