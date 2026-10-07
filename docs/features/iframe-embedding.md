# Iframe embedding (Brain Launcher)

This app can run standalone (`mna.sqe.co.id`) **or** be embedded as an `<iframe>`
inside the Brain Launcher (`https://brain.starcapital.co.id`, its staging peer,
and `http://localhost:3000`). Embedding is entirely env-gated so the standalone
deployment keeps its safe defaults.

**Config** (see `.env.example`, `src/lib/iframe.ts`):

- `IFRAME_EMBED_ENABLED` — master switch. When `true`, the CSP `frame-ancestors`
  header lists the launcher origins and NextAuth cookies become
  `SameSite=None; Secure; Partitioned` (CHIPS). When unset/`false`, framing is
  locked to `'self'` and cookies stay `SameSite=Lax`.
- `NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS` — whitespace/comma-separated origin
  allowlist, shared by the server CSP header (`next.config.ts`) and the
  client-side `postMessage` origin checks. Defaults to the launcher origins.

**Why these are needed** (all browser-enforced, brain-side):

1. **Framing.** A cross-origin frame is refused unless the framed app sends
   `Content-Security-Policy: frame-ancestors <launcher origins>` (and does *not*
   send `X-Frame-Options: DENY|SAMEORIGIN` — we never do; `frame-ancestors`
   supersedes it). Set in `next.config.ts`'s `headers()`.
2. **Cross-site cookies.** The session cookie is written from inside a
   cross-site frame, so it must be `SameSite=None; Secure; Partitioned` to be
   stored/sent under third-party-cookie partitioning. Set in `src/auth.config.ts`
   (secure cookie names preserved so `proxy.ts` still recognises them).
3. **Token staleness.** The `?token=<launcherJwt>` deeplink carried at `src`
   time (consumed once by `proxy.ts` → `/api/auth/sso`) expires (~5 minutes)
   while the frame stays mounted. Re-auth is handled by the launcher reloading
   the frame `src` with a fresh `?token`, triggered by the postMessage channel
   below.

**postMessage protocol** (`src/lib/iframe.ts`, `src/components/iframe/IframeBridge.tsx`).
Every message carries the single neutral `source: 'brain-portal'` tag — the
launcher is generic across all brains, so a brand-specific tag would be dropped.
Both sides validate `event.origin` against the allowlist and check the `source`
field; the brain never posts with `targetOrigin: '*'`. Tokens are **never** sent
over postMessage — re-auth happens via the launcher reloading the frame `src`.

- **Brain → Launcher** (`source: 'brain-portal'`):
  - `{ type: 'ready' }` — the embedded app has mounted.
  - `{ type: 'auth-expired' }` — a request 401'd or the session is gone; the
    launcher should reload the frame `src` with a fresh `?token`.
  - `{ type: 'signed-out' }` — user signed out inside the brain (ack after a
    launcher-initiated `logout`).
- **Launcher → Brain** (`source: 'brain-portal'`):
  - `{ type: 'logout' }` — propagate logout; the brain signs out and replies
    `signed-out`.
  - `{ type: 'navigate', path }` — same-origin, relative-path navigation.
  - The launcher does not drive these yet, so the brain's listeners are
    harmless no-ops until it does.

The launcher gives the iframe a **fixed, full-height pane** (it does not shrink
the frame to content), so the app renders to fill 100% height and there is no
content-resize message.

> The launcher must implement the matching side: embed us with a fresh
> `?token`, listen for `brain-portal` messages, and reload the frame `src` on
> `auth-expired`. Nothing the brain does can bypass the browser's framing or
> third-party-cookie policies — the launcher origins must be correct and served
> over HTTPS in production.
