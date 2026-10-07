# Admin routes (`/api/auth`)

Privileged, machine-to-machine **admin** endpoints live under `/api/auth/*` and
are protected by a single shared secret rather than a user session or a chat API
key. The `proxy.ts` middleware (Next.js 16 middleware) intercepts the matched
admin routes and rejects any request whose `X-Api-Secret` header does not match
the server's `ADMIN_SECRET` env var:

```ts
// src/proxy.ts
export const config = {
  matcher: ["/api/auth/signup", "/api/auth/api-keys", "/api/auth/api-keys/:path*"],
};
```

Every admin request must therefore send:

```
X-Api-Secret: <ADMIN_SECRET>
```

`src/lib/api/client.ts` (`apiRequest`) attaches this header automatically from
`ADMIN_SECRET` for server-side internal calls. Current admin routes:

- `/api/auth/signup` — M2M user creation (same invite-email flow as
  session-gated `POST /api/users`; see "Account invite flow" below)
- `/api/auth/api-keys`, `/api/auth/api-keys/:id` — chat API key management (above)

**Adding a new admin route:** place it under `src/app/api/auth/<route>/`, and add
its path to the `matcher` array in `src/proxy.ts` so the `X-Api-Secret` gate
applies. Do not add a per-handler session check — auth happens in the middleware.
