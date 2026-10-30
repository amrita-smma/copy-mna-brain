-- gmail_integration
-- The Copilot bots can search and read a member's own Gmail through Google's
-- Gmail API, acting as the member who connected it (OAuth 2.0 authorization
-- code + PKCE, read-only `gmail.readonly` scope). Gated per workspace by the
-- GMAIL_ENABLED feature flag (feature_flags rows; no schema).

-- One member's connection. Tokens are AES-256-GCM ciphertext. Per user, not
-- per workspace: the Google account is the person's and follows them.
CREATE TABLE IF NOT EXISTS gmail_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  google_email TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_connections_user
  ON gmail_connections (user_id);
