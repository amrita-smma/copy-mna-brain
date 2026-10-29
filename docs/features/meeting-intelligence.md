# Meeting Intelligence (MoM AI Intelligent) integration

The Copilot can read meeting recaps, action items and calendars from Meeting
Intelligence (`https://meeting-intelligence.starcapital.co.id`) through that
system's MCP server. It is **read-only**, and every call acts **as one member**,
so the Copilot sees only what that member can see there.

## Turning it on

Two gates, both required:

1. **Workspace** — the `MEETING_INTELLIGENCE_ENABLED` feature flag, **off by
   default**. A superadmin turns it on per workspace in Admin Portal → Features
   ("Meeting Intelligence"). It is a normal catalog flag
   (`src/lib/features/catalog.ts`), so the env var of the same name sets the
   deployment default.
2. **Member** — each person connects their own account: the **Connect Apps**
   button at the bottom of the sidebar (above the name / tasks / bell row) opens
   Profile → **Connected apps** (`?tab=apps`), where MoM Intelligent has a
   **Connect** button. With the workspace flag off the row is still listed but
   reads "Not enabled". Gmail, Google Drive, Google Calendar, Outlook and Slack
   are listed there as Coming Soon (UI only — no integration behind them yet).
   There are no API keys or service accounts: the server requires a person to
   approve the connection in a browser.

The server must also have whitelisted this app's redirect domain (the domain of
`/api/integrations/meeting-intelligence/callback`). Until it has, Connect comes
back with "This app's address isn't approved by Meeting Intelligence yet"
(`invalid_redirect_uri`). `http://localhost` is accepted for local dev.

## How connecting works

OAuth 2.1 authorization code + PKCE (S256), public client, scope `mcp:read`.

```
Connected apps ─▶ GET /api/integrations/meeting-intelligence/connect?returnTo=…
                 │ dynamic client registration on first use (per origin)
                 │ PKCE + state sealed into the httpOnly `mi_oauth_state` cookie
                 ▼
              Meeting Intelligence sign-in (Google) + Allow   (≤ 10 min)
                 ▼
              GET /api/integrations/meeting-intelligence/callback?code&state
                 │ verify state + user, exchange code, whoami, store tokens
                 ▼
              returnTo?meetingIntelligence=connected|error  (toasted by the tab)
```

- **Client registration** (`meeting_intelligence_clients`) is per
  (server URL, redirect URI). A connect from a new origin registers a new
  client; an `invalid_client` on exchange deletes the row so the next connect
  re-registers.
- **Connections** (`meeting_intelligence_connections`) are one row per user,
  not per workspace — the account is the person's and follows them, like
  CoPilot memory. Whether a workspace may *use* it is the flag.
- **Tokens are AES-256-GCM ciphertext** (`src/lib/crypto/tokenCipher.ts`), keyed
  by HKDF from `AUTH_SECRET`. Rotating `AUTH_SECRET` makes them undecryptable;
  the service then deletes the row and the member reconnects.

## Token lifecycle

Access tokens last 1 hour; refresh tokens rotate on every refresh, and
**presenting an old refresh token disconnects the member** on the server side.
`MeetingIntelligenceService` therefore:

- refreshes when the access token has < 60 s left, and once more on a 401;
- lets only one request refresh at a time: `claimRefreshLease` is a single
  conditional `UPDATE … WHERE refresh_lease_until IS NULL OR < now()`. Losers
  poll the row and reuse the winner's new token instead of rotating again;
- deletes the connection on `invalid_grant` / `invalid_client`, or when a
  freshly refreshed token still gets a 401 (the member lost access). The
  server also caps a connection at 90 days, after which the member approves
  again.

Disconnect (Connected apps tab, `DELETE /api/integrations/meeting-intelligence`)
revokes the refresh token best-effort and deletes the row. It works even with
the workspace flag off, so a member can always withdraw access.

## The Copilot tool

`meeting_intelligence` (`src/lib/agents/analysis/tools/meeting_intelligence.ts`)
is in the bot `meetings` skill, so every Copilot bot has it. It takes
`{ tool, arguments }`, where `tool` is one of the server's tools: `whoami`,
`list_meetings`, `search_meetings`, `get_meeting`, `list_action_items`,
`get_my_action_items`, `lookup_my_calendar`, `lookup_member_calendar` (the two
calendar tools only work when calendar integration is on server-side).

- The user comes from the turn's `configurable.userId`, never a tool argument.
- Flag off, or the user not connected / expired → a message telling the model
  how the user fixes it (no throw).
- A wrong argument (JSON-RPC error or `isError` result) → the error plus that
  tool's input schema from `tools/list`, so the model can retry correctly.
- 429 → "rate limited, try again in Ns" (limit: 120 calls/min per connection);
  404 → the integration is off on their side.
- Results are the server's `structuredContent` as JSON, capped at 40k chars.

## Configuration

| Env var | Default | |
|---|---|---|
| `MEETING_INTELLIGENCE_ENABLED` | `false` | Deployment default for the flag; per-workspace overrides win. |
| `MEETING_INTELLIGENCE_BASE_URL` | `https://meeting-intelligence.starcapital.co.id` | Point at a staging server. |
| `AUTH_SECRET` | — | Already required; the token-encryption key is derived from it. |
