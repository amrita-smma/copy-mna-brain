# Test Cases Reference (UI & API)

> **Purpose:** A future-proof reference so that when writing new test cases you only need
> to consult the relevant section here — not re-derive the whole project structure each time.
>
> **Scope:** UI and API tests only. Backend unit tests (`src/lib/**`) are
> intentionally out of scope for this document.

---

## 0. Before Writing Any Test — Check the Git Diff First

**Rule:** New test cases should only be written for changes that actually affect the **UI**
or **API**. Before creating or updating any test, inspect the commit/diff to decide whether a
test is warranted at all.

Recommended workflow:

```bash
# See what changed on the branch vs main
git diff --name-only main...HEAD

# Inspect a specific commit
git show <commit-sha> --stat
git diff <commit-sha>^ <commit-sha>
```

**Look only at the application source under `/src` (the frontend/app code).** Changes to the
`e2e/` automation folder itself are NOT a trigger — that folder is the test code, not the
product surface under test. Base the decision on what changed in `src/`.

Decide using this filter:

| Changed paths (under `src/`) | Needs UI/API test? |
|---|---|
| `src/app/**/page.tsx`, `src/app/**/*View*.tsx`, `src/components/**`, other UI-rendering code | ✅ UI test |
| `src/app/api/**/route.ts` | ✅ API test |
| `src/lib/**` (services, repositories, agents), `drizzle/**`, `terraform/**`, configs, docs | ❌ Skip — out of scope here |
| `e2e/**` (the automation suite itself) | ❌ Not a trigger — it's the test code, not the product |
| Pure refactors with no behavioral/contract change | ❌ Skip |

**Do not** add UI/API test cases for changes unrelated to the `src/` UI or API surfaces (e.g.
infra, migrations, internal lib refactors, or edits to the `e2e/` suite). If the diff only
touches non-UI/non-API code under `src/`, note it and move on without adding tests.

---

## 1. UI Test Cases (Playwright E2E)

> This section describes the **frontend UI source under `/src`** — the product surface that
> UI tests target. Use it to locate the page/view/components a change touches, then map that
> to the test that should cover it (§1.2). The test-code layout itself (specs/helpers) is
> covered briefly in §1.3.

### 1.1 Where the UI source lives (`/src`)

The app uses the Next.js App Router with a **page → view → components** pattern:

- **Pages** (`src/app/<route>/page.tsx`) — thin **server** wrappers. They resolve feature
  flags (`crmEnabled()`, `aiWorkforceEnabled()`, …) and auth guards, then render a View.
- **Views** (`src/views/<Feature>.tsx`, `'use client'`) — the interactive container holding
  state/hooks and composing components. This is the main thing a UI test exercises.
- **Components** (`src/components/<feature>/*.tsx`) — feature UI and shared primitives.

```
src/
  app/
    <route>/page.tsx        # server page: flags + auth guard, renders a View
    layout.tsx              # root layout (Providers, theme, service worker)
    api/                    # API routes — see §2, NOT UI
  views/                    # 'use client' feature containers (test target)
    Dashboard.tsx  Pipeline.tsx  Chat.tsx  CRM.tsx  MasterData.tsx
    SmartFiles.tsx  CompanyDetail.tsx  CompanySlides.tsx
    AIWorkforce/            # multi-tab feature (index.tsx + panels)
    crm/                    # CRM sub-components (dialogs, filters, types)
  components/
    ui/                     # ~50 shadcn primitives (button, table, dialog, …)
    layout/                 # DashboardLayout, AICopilotPane, MobileBottomNav
    chat/                   # ChatProvider, ChatWindow, message bubbles, AskAIButton
    pipeline/              # company tables, CompanyDetailDialog, screening dialogs
    auth/                   # GoogleSsoTokenGate, ProtectedRoute
    Files/  notifications/  common/
  hooks/                    # useAuth, useFeatureFlags, useLocalStorage, use-mobile, …
  lib/flags.ts             # feature flag definitions (gate routes/UI)
  lib/api/                 # client fetch helpers (client.ts, pipeline.ts, dashboard.ts)
```

**Naming conventions in `/src`:**
- Pages are folders with `page.tsx`; dynamic segments use `[param]` / `[[...slug]]`.
- Views are PascalCase `<Feature>.tsx` in `src/views/` (a folder when multi-part).
- Components: feature folders group related UI; `*Dialog.tsx` for modals,
  `*Provider.tsx`/`*Context.tsx` for context, `*Combobox.tsx` for select wrappers;
  `ui/` primitives are lowercase-hyphenated (shadcn).

### 1.2 Feature → source → test map (find the right target before writing)

For a UI change, locate the feature row, confirm which `/src` files changed, then edit the
matching spec. **Edit the existing spec** for that area rather than adding a new file; create a
new `{feature}.spec.ts` only for a genuinely new page/feature.

| Feature | Route / Page | View (test target) | Key components | Spec file |
|---|---|---|---|---|
| Login | `/login` → `src/app/login/page.tsx` | (page is client) | `GoogleSignInButton` | `e2e/login.spec.ts` |
| Forgot/Reset password | `/reset-password` → `src/app/reset-password/page.tsx` | (page is client) | reset form | `e2e/forgot-password.spec.ts` |
| Dashboard | `/dashboard` | `src/views/Dashboard.tsx` | `DashboardLayout`, activity feed, `AskAIButton` | `e2e/dashboard.spec.ts` |
| Master data | `/master-data` | `src/views/MasterData.tsx` | criteria/settings forms | `e2e/master-data.spec.ts` |
| Pipeline | `/pipeline` (`[dealId]`, `/slides`) | `src/views/Pipeline.tsx`, `CompanyDetail.tsx`, `CompanySlides.tsx` | `Inbound/OutboundCompaniesTable`, `CompanyDetailDialog`, screening dialogs | `e2e/pipeline.spec.ts` |
| AI discovery | `/ai-discovery` (→ dashboard) | `src/views/AIDiscovery.tsx` | — | `e2e/ai-discovery.spec.ts` |
| AI workforce | `/ai-workforce/[[...slug]]` | `src/views/AIWorkforce/index.tsx` | `CoPilotPanel`, `WorkforceTasks`, `RoutineCanvas` | `e2e/ai-workforce.spec.ts` |
| Smart Files | `/smart-files` | `src/views/SmartFiles.tsx` | `HitlReviewDialog`, `FilePreview`, `MatchedCompanyCombobox` | `e2e/smart-files.spec.ts` |
| CRM | `/crm` (flag-gated) | `src/views/CRM.tsx` + `src/views/crm/*` | `EmployerCard`, `AddContactDialog`, filters | _(no spec yet — add one)_ |
| Chat | `/chat` | `src/views/Chat.tsx` | `ChatWindow`, `ChatSidebar`, `ChatProvider` | _(no spec yet — add one)_ |

> **Flag-gated features** (CRM, AI workforce): the route is only mounted when its flag is on
> (`src/lib/flags.ts`). UI tests must enable the flag (env var on the server, or a workspace
> override in the admin portal's Features tab) for the page to render.

### 1.3 Where the UI test code lives (`e2e/`)

The tests that exercise the `/src` UI above live in the `e2e/` automation folder:

```
e2e/
  *.spec.ts              # one spec file per feature/page (see §1.2)
  helpers/
    auth.ts              # sign-in / session mocking
    layout.ts            # layout utilities (collapse copilot pane)
    credentials.ts       # env-aware test credentials
    companies.ts         # company fixtures + provisioning
playwright.config.ts     # test runner config (see §1.5)
```

### 1.4 Reusable helpers (prefer these over re-implementing)

| Helper | Location | Purpose |
|---|---|---|
| `signIn(page)` | `e2e/helpers/auth.ts` | Real NextAuth login via the login form |
| `mockAuthSession(page, user?)` | `e2e/helpers/auth.ts` | Stub `/api/auth/session` (offline/logged-in) |
| `mockNextAuthSignIn(page, opts)` | `e2e/helpers/auth.ts` | Stub credentials flow incl. error simulation |
| `MOCK_USER` | `e2e/helpers/auth.ts` | Default mock user object |
| `collapseCopilot(page)` | `e2e/helpers/layout.ts` | Collapse AI sidebar via localStorage init script |
| `getTestCredentials()` | `e2e/helpers/credentials.ts` | Load env-specific test user credentials |
| `getTestEnv()` | `e2e/helpers/credentials.ts` | Resolve `TEST_ENV` → `local\|staging\|production` |
| `baseCompany(overrides)` | `e2e/helpers/companies.ts` | Factory for company fixtures |
| `provisionCompanies(page, companies)` | `e2e/helpers/companies.ts` | Seed companies (mock/real) with cleanup |

### 1.5 Conventions to follow

- **Naming:** spec files `{feature}.spec.ts`; helpers `{concern}.ts`.
- **Regression IDs:** embed codes in comments (e.g. `REG-MD-04`, `REG-FP-01`).
- **Test names:** imperative behavior, not implementation (e.g. `"User signs in"`,
  `"Form disabled while submitting"`).
- **Selectors (in order of preference):**
  1. Role-based — `page.getByRole('button', { name: 'Sign In' })`
  2. Placeholder — `page.getByPlaceholder(...)`
  3. ID — `page.locator('#signin-email')`
  4. CSS (last resort) — `page.locator('button.text-primary')`
  - Scope with `.filter()`, `.first()`, `.nth(i)`.
- **Auth:** use `mockAuthSession` for offline/fast UI tests; use `signIn` for true integration.
- **Data mode (`E2E_DATA_MODE`, default `mock`):**
  - `mock` → `page.route()` intercepts API and serves fixtures in memory.
  - `real` → POST fixtures to real API, use server IDs, **clean up in `afterEach`**.
  - Real mode adds a unique name suffix so seeded rows are isolatable.
- **Request mocking:** `page.route(pattern, handler)` + `route.fulfill()` / `route.continue()`
  / `route.fallback()`; assert with `page.waitForResponse(predicate)`.
- **Layout:** call `collapseCopilot(page)` before navigation to avoid AI-pane layout flake.
- **Waiting/assertions:** `page.waitForURL(...)`, `expect(...).toBeVisible()` (15s timeout),
  `expect(page).toHaveURL(/regex/)`, `expect(el).toHaveCount(0)` for non-existence.
- **Isolation & determinism:** each test cleans up after itself; mock external APIs; reserve
  `real` mode for integration validation.

### 1.6 Playwright config quick facts (`playwright.config.ts`)

- `testDir: './e2e'`, `fullyParallel: true`
- `expect.timeout: 15_000` (NextAuth spinners are slow)
- `retries`: 2 in CI, 0 locally; `workers`: 1 in CI, parallel locally
- `trace: 'on-first-retry'`
- Project: `chromium` (Desktop Chrome)
- `webServer` (local only): `pnpm build && pnpm start`, 240s timeout,
  env `NEXT_DISABLE_STANDALONE=1`, `PORT=3000`, `AUTH_TRUST_HOST=true`
- **Env switches:** `TEST_ENV=local|staging|production`, `E2E_DATA_MODE=mock|real`

### 1.7 Running UI tests

```bash
pnpm test:e2e                 # local
pnpm test:e2e:ui              # local, UI mode
pnpm test:e2e:staging         # against staging
pnpm test:e2e:production      # against production
```

---

## 2. API Test Cases

### 2.1 Where API routes live

```
src/app/api/<segment>/[id]/<action>/route.ts   # Next.js App Router handlers
```

Method handlers are exported per file: `export async function GET/POST/DELETE(...)`.
Dynamic segments use `[id]` → `params.id`.

### 2.2 API endpoint groups (check the matching one before writing)

| Group | Notes |
|---|---|
| `/api/auth/*` | NextAuth, sign-in, password reset, google-signin, **admin** API-key mgmt (gated by `X-Api-Secret`) |
| `/api/companies/*` | Master data CRUD: list, get, delete, promote, filter |
| `/api/dashboard/*` | Activity feeds, statistics |
| `/api/copilot/*` | Chat persistence and forking |
| `/api/crm/*` | CRM employer data, contacts, topics |
| `/api/workforce-queue/*` | AI workforce queue: decision, retry, cancel, message |
| `/api/screenings/*` | Investment screening workflows |
| `/api/routines/*` | Scheduled automation routines |
| `/api/ai-*` | AI features: screening, discovery |
| `/api/smart-files/*` | Smart Files ingest: list, counts, upload-url, review, approve, reprocess, download |
| `/api/chat/*`, `/api/v1/chat/*` | Chat + cache management (versioned) |

### 2.3 What to assert in an API test

Cover, at minimum:

- **Happy path** — correct status + `NextResponse.json({ data: ... })` shape.
- **Validation errors** — bad/missing input → `400` with `{ error }`.
- **Auth/authorization** — admin routes require `X-Api-Secret`; session routes require a session.
- **Error path** — unexpected failure → `500` with `{ error: 'Internal server error' }`.
- **Side effects** — e.g. a job/worker is dispatched when expected.

> **Contract reminder (from project rules):** handlers always return
> `NextResponse.json({ data })` on success and `NextResponse.json({ error }, { status })` on
> failure — assert against this shape, never raw objects.

### 2.4 How API routes are currently tested

Today, route handlers are tested with **Vitest unit tests colocated as `route.test.ts`**
next to the handler. Pattern:

```ts
// describe per route
describe('POST /api/auth/google-signin', () => {
  // vi.hoisted() for mocks needed before vi.mock()
  // vi.mock('@/lib/server/db', ...) etc.
  it('returns 400 when validation fails', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});
```

- Use `vi.hoisted(() => ({...}))` + `vi.mock(...)`.
- Factory helpers for inputs (`makeRequest`, `makeParams`, `makeRow`).
- `beforeEach` to reset mocks.
- Assert status codes, JSON body shape, and mock call counts.
- Keep tests free of real I/O (no network, no real DB).

> If true end-to-end API coverage is needed (real HTTP), prefer driving it through the
> Playwright suite in `real` data mode rather than adding a new integration harness.

### 2.5 Running API/unit tests

```bash
pnpm test          # vitest run (one-shot)
pnpm test:watch    # vitest watch
```

---

## 3. Quick Decision Flow

```
1. git diff --name-only main...HEAD   (focus on changes under src/)
2. Does the diff touch src/ UI (pages/views/components) or src/ API (route.ts)?
      NO  → out of scope, do not add UI/API tests (ignore e2e/ changes too).
      YES → continue.
3. UI change?  → locate the feature in the src→spec map (§1.2). Edit that spec,
                 reuse helpers (§1.4), follow conventions (§1.5).
4. API change? → find matching group (§2.2). Add/extend route.test.ts (§2.4),
                 assert the contract (§2.3).
5. New page/feature with no existing spec/test → create one following the conventions above.
```
