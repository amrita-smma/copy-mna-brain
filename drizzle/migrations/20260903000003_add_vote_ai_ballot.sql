-- Migration: The AI Opinion votes as one participant
-- Purpose: A voting round counts the company's standing AI Opinion as one more
--          voter. Its ballot is derived from `companies.ai_opinion_verdict` when
--          the round closes (pass -> yes, fail -> no, anything else ->
--          inconclusive) and snapshotted here, so a later re-evaluation of the
--          company cannot retroactively change a recorded tally.

ALTER TABLE "company_vote_sessions"
  ADD COLUMN IF NOT EXISTS "ai_vote_choice" "vote_choice";
