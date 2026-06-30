-- Deal advisor: the banker engaged on a deal, chosen from the existing list of
-- banker names. A non-empty advisor marks the deal as "live".
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS advisor TEXT;
