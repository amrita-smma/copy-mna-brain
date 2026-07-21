-- "Today's Recap" daily pipeline pulse cache. One row per workspace per UTC day
-- holds the assembled pulse (the Analyst agent's markdown output) so only the
-- first request of the day pays the LLM cost; an explicit refresh upserts the
-- same day's row. Read/written via DailyPulseRepository.
CREATE TABLE IF NOT EXISTS daily_pulse (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pulse_date    DATE NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_pulse_pkey PRIMARY KEY (workspace_id, pulse_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_pulse_workspace_id ON daily_pulse (workspace_id);

CREATE TRIGGER update_daily_pulse_updated_at
  BEFORE UPDATE ON daily_pulse
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
