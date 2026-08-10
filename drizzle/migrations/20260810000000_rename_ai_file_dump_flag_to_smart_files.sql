-- rename_ai_file_dump_flag_to_smart_files
--
-- The "AI File Dump" feature was renamed to "Smart Files", which changes its
-- catalog key (`src/lib/features/catalog.ts`) from AI_FILE_DUMP_ENABLED to
-- SMART_FILES_ENABLED. Carry each workspace's existing per-workspace override
-- across to the new key so admin toggles survive the rename; without this the
-- override row is orphaned and the feature silently falls back to its default.
--
-- PK is (workspace_id, feature_key), so a workspace that somehow already has a
-- SMART_FILES_ENABLED row would collide. Delete the stale legacy row in that
-- case (the new key already holds the intended state) and rename the rest.

DELETE FROM feature_flags legacy
WHERE legacy.feature_key = 'AI_FILE_DUMP_ENABLED'
  AND EXISTS (
    SELECT 1
    FROM feature_flags current
    WHERE current.workspace_id = legacy.workspace_id
      AND current.feature_key = 'SMART_FILES_ENABLED'
  );

UPDATE feature_flags
SET feature_key = 'SMART_FILES_ENABLED'
WHERE feature_key = 'AI_FILE_DUMP_ENABLED';
