-- Person in charge ("PIC") for an investment thesis / Track.
ALTER TABLE investment_thesis
  ADD COLUMN IF NOT EXISTS pic TEXT;
