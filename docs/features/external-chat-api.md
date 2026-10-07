# External Chat API (`/api/v1/chat`)

Authorized external applications can talk to the same analysis agent that powers
the in-app Copilot, over a versioned, machine-to-machine API. Unlike the
cookie/session-authenticated in-app `/api/chat`, these endpoints authenticate
with an **API key** and expose a stable contract decoupled from the AI SDK's
internal message format.

## Authentication

Requests carry an API key as a bearer token, and must hold the `chat:write`
scope:

```
Authorization: Bearer mna_<secret>
```

Keys are minted out-of-band and the raw token is shown **once** — only a scrypt
hash (`src/lib/services/password.ts`) plus a short non-secret lookup prefix are
stored in the `api_keys` table. Verification (`ApiKeyService.verify`) looks up
non-revoked rows by prefix, then `timingSafeEqual`-compares the hash, checks the
required scope, and refreshes `last_used_at`. Revoke a key by setting
`revoked_at` (`ApiKeyService.revoke`).

Mint a key from the CLI:

```bash
pnpm tsx scripts/issue-api-key.ts "Acme Integration"            # default: chat:write
pnpm tsx scripts/issue-api-key.ts "Read-only bot" chat:read     # custom scopes
```

## Key management (`/api/auth/api-keys`)

Keys can also be managed over HTTP. These are **admin** endpoints, so they live
under `/api/auth/*` and are gated by the shared-secret `proxy.ts` middleware:
every request must carry an `X-Api-Secret` header matching the server's
`ADMIN_SECRET` env var (see [Admin routes](admin-routes.md)). They
are **not** gated by a NextAuth session and **not** by a chat API key. Secrets
are never returned by read endpoints — the raw token is surfaced only once, in
the `POST` create response.

- `GET    /api/auth/api-keys`      — list all keys (metadata only)
- `POST   /api/auth/api-keys`      — mint a key; response `data` includes the raw `token` once
- `GET    /api/auth/api-keys/:id`  — fetch one key's metadata
- `PATCH  /api/auth/api-keys/:id`  — update `name` and/or `scopes`
- `DELETE /api/auth/api-keys/:id`  — revoke (soft delete via `revoked_at`)

```bash
# create
curl -X POST https://<host>/api/auth/api-keys \
  -H 'Content-Type: application/json' \
  -H "X-Api-Secret: $ADMIN_SECRET" \
  -d '{"name":"Acme Integration","scopes":["chat:write"]}'
# → { "data": { "id": "...", "name": "Acme Integration", "token": "mna_...", ... } }
```

## Endpoints

- `POST /api/v1/chat` — non-streaming; returns the assistant's full reply as JSON.
- `POST /api/v1/chat/stream` — streaming; emits Server-Sent Events.

Request body (identical for both):

```jsonc
{
  "conversation_id": "uuid",   // optional — omit to start a new conversation
  "messages": [
    { "role": "user", "content": "Compare ACME to our past acquisitions" }
  ]
}
```

When `conversation_id` is provided, only the latest user turn is sent to the
agent — prior state is rehydrated from the checkpointer by `thread_id`. When it
is omitted, a new conversation is created and the full `messages` array is used
as history (so stateless callers keep their context). The new id is returned in
the `X-Conversation-Id` header and in the response/`done` event.

Conversations are owned by the minting API key (`api_chat_conversations`,
scoped by `api_key_id`); a client can never read or resume another client's
conversation — an unowned id is indistinguishable from a missing one (404).

Non-streaming response:

```jsonc
{ "data": { "conversation_id": "uuid",
            "message": { "role": "assistant", "content": "...", "tool_calls": [] } } }
```

Streaming response is a documented SSE protocol (not the AI SDK's UIMessage
stream), so it is stable across `ai` SDK upgrades:

```
event: delta        data: {"text":"..."}
event: tool_call    data: {"name":"query_companies","args":{...}}
event: done         data: {"conversation_id":"uuid"}
event: error        data: {"code":"stream_error","message":"..."}
```

Layering follows the project's handler → service → repository convention:
`src/app/api/v1/chat/**` (handlers) → `ApiKeyService` / `ApiChatConversationService`
→ `ApiKeyRepository` / `ApiChatConversationRepository`, with shared HTTP glue in
`src/lib/server/apiChatSupport.ts`.

> **Not yet included:** per-key rate limiting. Add Vercel WAF rate rules or an
> Upstash-backed limiter before exposing this to untrusted clients.
