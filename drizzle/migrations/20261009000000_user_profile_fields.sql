-- The fields behind Profile → Your Profile.
--
-- `users.name` and `users.email` already exist and back the rest of the app;
-- these are the additions the profile form edits. All nullable with no default:
-- an account created before this migration simply has none, and the form shows
-- them empty rather than inventing a value.
--
-- `how_brain_helps` is the user's own description of what they want out of the
-- product. It is NOT fed to the CoPilot as an instruction — memory is the
-- channel for that (see docs/features/copilot-memory.md); this is a profile
-- field the user writes for themselves and their workspace admins.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nickname text,
  ADD COLUMN IF NOT EXISTS phone_code text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS how_brain_helps text;
