-- Connection/infra fail budget for vault-archive-poll (auth, poll, ZIP download).
-- Exhausted budget marks the export failed so start's window MAX_RETRIES can apply.
ALTER TABLE analytics.vault_exports
  ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN analytics.vault_exports.fail_count IS
  'Vault API / ZIP download connection failures for this export; abandoned at MAX_VAULT_POLL_FAIL_COUNT';
