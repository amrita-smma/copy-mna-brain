# Google SSO sign-in

Google is used for **authentication only** — a successful SSO flow proves the
caller owns the email, never grants access on its own. The user must already
exist in the `users` table; unknown emails are rejected with the message
*"Your user is not registered in the system, please contact the Investment Brain team"*.
No account is ever auto-provisioned. After sign-in the session is the identical
NextAuth JWT a password login produces, so the rest of the app is unchanged.

Both entry points below verify the same Google-issued ID token server-side
(`AuthService.signInWithGoogleToken` → `verifyGoogleIdToken`,
`src/lib/services/googleToken.ts`, backed by `google-auth-library`), extract the
verified email, and look the user up by email.

## Login-page button (`/login`)

The primary entry point. `GoogleSignInButton`
(`src/components/GoogleSignInButton.tsx`) renders the Google Identity Services
"Sign in with Google" button using `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. On success
Google hands the page an ID token (the GIS credential), and the login page:

1. POSTs the token to `POST /api/auth/google-signin` (public route). This
   verifies the token and confirms a local account exists, returning
   `{ data: { email } }`, or `403` with the exact "not registered" message, or
   `401` for an untrusted token. Its only job is to surface a precise,
   user-facing reason — the NextAuth provider collapses every failure into an
   opaque `CredentialsSignin` code.
2. On success calls `useAuth().signInWithGoogleToken(token)`, which triggers the
   `google-sso` Credentials provider in `src/auth.ts` to establish the session,
   then redirects to the post-login destination (see **Deeplink preservation**
   below — `/workspace` unless a deeplink was preserved).

The button is hidden when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is unset, leaving only
email/password sign-in.

The same client also backs the [Gmail integration](gmail.md), which additionally
needs `GOOGLE_CLIENT_SECRET` (sign-in itself does not).

## Deeplink preservation across login

A logged-out hit on a protected URL must come back to that URL after signing in,
otherwise every emailed or bookmarked deeplink effectively lands on the wrong
page. `src/lib/callbackUrl.ts` owns both halves of that round trip:

- `loginUrlWithCallback(pathAndSearch)` builds the `/login?callbackUrl=...` URL.
  Every gate that bounces to `/login` uses it: the `/w/` branch of `proxy.ts`
  (the main one), `src/app/w/[workspaceSlug]/layout.tsx`,
  `src/components/auth/ProtectedRoute.tsx` (session expiring mid-visit), and
  `src/lib/legacyWorkspaceRedirect.ts` (pre-migration flat URLs, which re-enter
  the bridge after login and forward on to their `/w/<slug>/...` equivalent).
- `sanitizeCallbackUrl(raw)` reads it back on the login page and in
  `/api/auth/sso`. The value comes from a user-controlled URL and ends up in a
  redirect `Location`, so it is validated in both directions: same-origin
  absolute paths only, rejecting protocol-relative `//host` and its `/\host`
  variant, embedded control characters, `/login` itself, and `/api/*`. The SSO
  `token` param is stripped so it can't be replayed.

The param name matches the one NextAuth appends when redirecting to
`pages.signIn`, so those bounces are preserved for free.

A preserved `/w/<slug>/...` deeplink skips the `/workspace` picker entirely — the
URL already names its workspace, and `/w/` routes resolve the workspace from the
URL slug rather than session state (see the layout's note on never calling
`switchWorkspace`). Membership is still enforced by `proxy.ts` and the layout, so
a deeplink into a workspace the user can't enter falls back to `/workspace`.

## Launcher token exchange (`/?from=launcher&token=eyJ...`)

The Brain Launcher embeds this app in an iframe and hands over the signed-in
user's identity as a **launcher-signed RS256 JWT** via `?token=` on the URL.
`proxy.ts` intercepts any request carrying `?token=` and routes it to
`GET /api/auth/sso`, which:

1. Verifies the JWT against the launcher's JWKS endpoint
   (`LAUNCHER_ORIGIN/.well-known/jwks.json`) via `jose` — signature, expiry,
   `iss` (must equal `LAUNCHER_ORIGIN`) and `aud` (must equal
   `NEXT_PUBLIC_APP_URL`) are all enforced.
2. Extracts the verified `email` claim and looks the user up in `users`.
   Unknown emails are rejected with `UserNotRegisteredError` — no account is
   auto-provisioned.
3. Establishes a standard NextAuth JWT session (`Set-Cookie`) and redirects to
   the clean callback URL with `token` stripped from the URL.

Set `LAUNCHER_ORIGIN` to the launcher's origin
(`https://brain.starcapital.co.id`, `https://brain-stg.starcapital.co.id`, or
`http://localhost:3000`) and `NEXT_PUBLIC_APP_URL` to this app's own origin so
the `aud` claim is enforced correctly. See `.env.example` for details.

## Today's Recap — daily pipeline pulse (`/api/dashboard/pulse`)

The dashboard's "Today's Recap" card is a daily pipeline pulse produced by the
existing **Analyst agent**:

- `src/lib/dashboard/dailyPulseNarrator.ts` builds a Managing-Partner prompt
  (today vs the prior day, with the exception triggers) and sends it to the
  stateless Analyst agent (`getStatelessAgentGraph()` in
  `src/lib/agents/analysis`). The agent gathers the numbers itself via its data
  tools (`query_companies` with `created_after`/`created_before`,
  `get_company_stats`, `analyze_stalled_deals`), computes the deltas, and returns
  the finished recap as markdown. It runs under the workspace's context
  (`runWithWorkforceWorkspaceId`) so its tools scope correctly, including from
  the session-less cron.
- `DailyPulseService` (`src/lib/services/dailyPulseService.ts`) is a thin
  wrapper: it returns the day's cached markdown or, on a miss, asks the agent and
  persists the result. The pulse is stored once per UTC day per workspace in the
  `daily_pulse` table (via `DailyPulseRepository`), and the card renders the
  markdown as-is.
- The `daily-pulse` Vercel cron (`/api/cron/daily-pulse`, `0 0 * * *`)
  precomputes each day's recap at 00:00 UTC, so dashboard loads read the stored
  payload instead of paying the LLM cost. The read endpoint
  (`GET /api/dashboard/pulse`) still generates and upserts on the fly if the cron
  hasn't run yet that day, and `?refresh=1` forces a regenerate (used by the cron
  / ops).
