-- track_must_pass_criteria
-- Per-track screening pass rule. A criterion marked `must_pass` has to pass
-- for its track to pass; the rest are optional, and the track's
-- `min_optional_criteria_pass` is how many of those optional criteria must
-- pass. NULL (and no must-pass criteria) keeps the original rule — at least 3
-- passes and at most 1 fail — so existing tracks don't change on deploy.
ALTER TABLE criterias
  ADD COLUMN IF NOT EXISTS must_pass boolean NOT NULL DEFAULT false;

ALTER TABLE investment_thesis
  ADD COLUMN IF NOT EXISTS min_optional_criteria_pass integer;
