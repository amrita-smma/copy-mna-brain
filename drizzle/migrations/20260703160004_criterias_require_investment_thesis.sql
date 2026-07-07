-- MB-337 follow-up (PR #308 review): criterias should be a normal derived
-- child of investment_thesis, not a table with its own workspace_id.
-- Requires investment_thesis_id to always be set so it can be scoped by
-- joining to investment_thesis (which already carries workspace_id) instead.
-- Any pre-existing criterion with no Track is orphaned/unscopable and is
-- deleted rather than backfilled to a guessed Track.
--
-- WARNING: criterias.id has an ON DELETE CASCADE from screenings
-- (screenings_criteria_id_fkey), so this also deletes every screening that
-- was run against a track-less criterion. investment_thesis_id was added
-- nullable with no backfill in 20260626000002, so any prod criterion
-- created before that date (or via the old API path that defaulted it to
-- null) is null today and will take its screenings with it.

DELETE FROM criterias WHERE investment_thesis_id IS NULL;

ALTER TABLE criterias ALTER COLUMN investment_thesis_id SET NOT NULL;
