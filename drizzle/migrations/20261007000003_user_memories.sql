-- The CoPilot's long-term memory store (mem0), persisted here rather than in
-- mem0's own self-provisioned Postgres: one table, read and written only
-- through `UserMemoryRepository`, so it uses the app's pooled connection and
-- goes through the same layering as every other table.
--
-- Scoped to the USER, not to a workspace. What the CoPilot learns about
-- someone — what they cover, how they want to be answered, who they work with
-- — is about the person, so it follows them into every workspace they belong
-- to. `workspace_id` is kept as provenance only (where the memory was formed);
-- it is never part of a read or delete predicate, which is why it is nullable
-- and `ON DELETE SET NULL` rather than `CASCADE`: deleting a workspace must
-- not delete what a user learned while working in it.
--
-- `payload` is mem0's own record (`data`, `hash`, `textLemmatized`,
-- `createdAt`, `updatedAt`, plus whatever metadata the caller attached).
-- `memory` and `user_id` are denormalized out of it so the Profile listing and
-- the per-user scoping are indexable columns rather than JSONB probes. The
-- repository writes both in one statement; `payload` stays the source of truth
-- for anything mem0 reads back.
--
-- `collection` separates mem0's two logical stores: `memories` (the facts a
-- user sees on Profile → Memory) and `memories_entities` (mem0's entity-link
-- index, an internal detail the UI filters out).
--
-- 1024 dimensions = Amazon Titan Embed Text v2, the same model and dimension
-- `rss.item_chunks` uses (see src/lib/bedrock.ts), so both vector stores share
-- one embedding model.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS user_memories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Provenance only: which workspace the memory was formed in. Never filtered
  -- on; see the note above.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  collection text NOT NULL DEFAULT 'memories',
  memory text NOT NULL,
  embedding vector(1024) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The listing read: one user's memories, newest first.
CREATE INDEX IF NOT EXISTS idx_user_memories_scope
  ON user_memories (user_id, collection, created_at DESC);

-- The recall read. Cosine distance (`<=>`), matching the operator class the
-- repository's ORDER BY uses.
CREATE INDEX IF NOT EXISTS idx_user_memories_embedding
  ON user_memories USING hnsw (embedding vector_cosine_ops);
