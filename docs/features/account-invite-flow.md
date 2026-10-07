# Account invite flow (admin-created users)

The admin portal's User Management section (`/admin-portal`, above the
per-workspace panel → "Add user") provisions a brand-new account via
session-gated `POST /api/users` (superadmin-only).
Machine callers that already hold `ADMIN_SECRET` can use the equivalent
`POST /api/auth/signup` instead. Both go through `AuthService.signUp`. The
admin supplies only a name and email — no password is ever collected from or
chosen by the admin:

1. `AuthService.signUp` creates the `users` row with a random, hashed,
   never-communicated password (so the account cannot be signed into until
   the invite link below is used).
2. It mints a token in `reset_password_tokens` (7-day TTL — longer than the
   1h forgot-password TTL, since a new user may not check email right away)
   and publishes an `account_invite` message to the same `send-email` topic
   used by the forgot-password flow.
3. The consumer route renders the `account_invite` template
   (`EmailService.sendAccountInviteEmail` /
   `renderAccountInviteEmail`) and emails a link to
   `/reset-password?token=<token>` — the exact same page and
   `/api/auth/reset-password` endpoint the forgot-password flow uses.
4. If the invite email never arrives (queue outage, wrong inbox, expired
   link), the user has an ordinary escape hatch: "Forgot password?" on the
   login page re-issues a fresh reset link for the same account.

Reusing `reset_password_tokens` and `/reset-password` instead of a
dedicated invite-token table/page keeps "set a password for the first time"
and "reset a forgotten password" as one mechanism with two entry points.
