-- add api keys and api chat conversations

CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "scopes" text[] DEFAULT '{}' NOT NULL,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "idx_api_keys_prefix" ON "api_keys" USING btree ("key_prefix");

CREATE TABLE "api_chat_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "api_key_id" uuid NOT NULL,
  "title" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_active_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "api_chat_conversations_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE cascade
);

CREATE INDEX "idx_api_chat_conversations_key_active" ON "api_chat_conversations" USING btree ("api_key_id","last_active_at" DESC);
