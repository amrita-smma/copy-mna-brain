-- meeting_intelligence_integration
-- The Copilot reads meeting recaps, action items and calendars from MoM AI
-- Intelligent through its MCP server, acting as the member who connected it
-- (OAuth 2.1 + PKCE, public client). Gated per workspace by the
-- MEETING_INTELLIGENCE_ENABLED feature flag (feature_flags rows; no schema).

-- The app's dynamically registered OAuth client, one per (server, redirect URI).
CREATE TABLE IF NOT EXISTS meeting_intelligence_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_url TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_intelligence_clients_server_redirect
  ON meeting_intelligence_clients (server_url, redirect_uri);

-- One member's connection. Tokens are AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS meeting_intelligence_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  external_name TEXT,
  external_email TEXT,
  refresh_lease_until TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_intelligence_connections_user
  ON meeting_intelligence_connections (user_id);
