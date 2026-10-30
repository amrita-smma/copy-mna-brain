# Public Privacy Policy and Terms of Service

Two pages anyone can open **without signing in**: `/privacy` (Privacy Policy) and
`/terms` (Terms of Service). They exist so the Google OAuth consent screen — which
requires a public privacy policy, and a terms link — has somewhere to point, and so
members can read what the Gmail integration does with their mail.

## Where they are

| URL | Page |
|---|---|
| `/privacy` | `src/app/privacy/page.tsx` |
| `/terms` | `src/app/terms/page.tsx` |

Both render `LegalDocumentView` (`src/components/legal/LegalDocumentView.tsx`), a
standalone page with its own small header (brand, the other legal page, Sign in)
and a contents list — no app shell, so no `PageHeader`. The sign-in page links to
both from its footer.

They are public because the proxy only gates `/api/*` and `/w/*`; nothing else
needs configuring, and `src/proxy.test.ts` pins that neither path is in the
matcher. They are rendered per request (`force-dynamic`), so changing the
`LEGAL_*` settings below takes effect on the next request without a rebuild.

## Where the text lives

The wording is data, not JSX: `src/lib/legal/documents.ts` builds each document
(`privacyPolicy(config)`, `termsOfService(config)`), and `src/lib/legal/config.ts`
supplies who we are. That keeps it unit-tested:

- the Privacy Policy **lists the Gmail scopes from `src/lib/gmail/config.ts`**, so
  adding or removing a scope without updating the policy fails a test;
- it carries Google's **Limited Use** statement verbatim, which Google requires for
  restricted scopes, and a test pins it;
- its Gmail claims (reads on demand, drafts only, never sends, tokens encrypted,
  Disconnect deletes them) describe `docs/features/gmail.md`. **If the Gmail
  behaviour changes, change the policy and bump `LEGAL_EFFECTIVE_DATE`** in
  `config.ts`.

## Configuration

| Env var | Default | Printed as |
|---|---|---|
| `LEGAL_ENTITY_NAME` | `StarCapital` | The operating organization ("we"). |
| `LEGAL_CONTACT_EMAIL` | unset | The privacy / legal contact. Unset (or malformed): the page tells people to ask their workspace administrator instead — it never prints a placeholder address. |
| `LEGAL_GOVERNING_LAW` | unset | "governed by the laws of …". Unset: the Terms defer to the contract between the parties. |

## Using them with Google

On the OAuth consent screen (Google Auth Platform → Branding), set the **Privacy
policy link** to `https://<your-domain>/privacy` and the **Terms of service link**
to `https://<your-domain>/terms`. For verification, Google requires these on a
domain **you own and have verified** as an authorized domain. A `*.vercel.app`
address cannot be verified, so verification needs the production custom domain;
Testing mode (named test users) works without it.

## Not legal advice

The text is a plain-language working draft written from what the code does. It has
not been reviewed by a lawyer, and a few statements are commitments the operator
must be prepared to keep (for example that Gmail data is not used to train models).
Have counsel review both documents, and set the `LEGAL_*` values, before relying on
them or submitting for Google verification.
