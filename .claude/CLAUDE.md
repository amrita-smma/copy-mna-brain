## Pull Request Naming

PR titles must begin with a Jira ticket prefix in the form `[MB-xx]`, where `xx` is the issue number (e.g., `[MB-123] add user authentication`). Never omit the prefix or use a different bracket style.

## Admin Routes (`/api/auth`)

Privileged machine-to-machine **admin** endpoints live under `src/app/api/auth/*` and are gated by a shared secret, NOT by a NextAuth session or a chat API key. The `proxy.ts` middleware compares the request's `X-Api-Secret` header against the `ADMIN_SECRET` env var for every path listed in its `matcher`.

Rules when adding or moving an admin route:

- Place the route under `src/app/api/auth/<route>/route.ts`.
- Add its path (and a `:path*` entry for any dynamic segments) to the `matcher` array in `src/proxy.ts` so the `X-Api-Secret` gate applies.
- Do NOT add a per-handler session check (`auth()`); authentication happens in the middleware. The handler should go straight to `createDb()` / `createContainer(db)`.
- Callers must send `X-Api-Secret: <ADMIN_SECRET>`. Server-side internal calls via `src/lib/api/client.ts` (`apiRequest`) attach this header automatically.
- Existing admin routes: `/api/auth/signup`, `/api/auth/api-keys`, `/api/auth/api-keys/:id`.

## Test Files (`**/*.test.ts`)

Test files live next to their source files as `<name>.test.ts`. Rules when writing or editing tests:

- Use **vitest** exclusively — import `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` from `'vitest'`. Never use Jest APIs.
- Use `vi.hoisted(() => ({ ... }))` for mock functions that must exist before module-level `vi.mock(...)` calls run.
- Use `vi.mock('@/lib/...')` to stub module dependencies. Prefer class-based mocks for repositories (instantiate a class that exposes the hoisted mock functions as methods).
- Reset mocks in `beforeEach` with `.mockReset()` (or `.mockClear()` when only call counts matter). Add `afterEach(() => vi.clearAllMocks())` when not using `beforeEach`.
- Describe blocks: `describe('ClassName.methodName', ...)` or `describe('functionName', ...)`. Test names state the expected behaviour, not the implementation (e.g., `'returns [] without hitting the DB when the id list is empty'`).
- For **repository tests**: construct the class with a typed `db as never` mock that stubs `.select/.insert/.update/.delete` chains via `vi.fn().mockReturnThis()`.
- For **agent tool tests**: mock `@/lib/server/db` and any repository modules before importing the tool, then test via `tool.invoke({ ... })`. Assert on the string/object returned.
- Keep tests fast and free of real I/O — no network calls, no real database connections.

## Terraform Modules

App-infrastructure modules live under `terraform/` (e.g. `bootstrap`, `iam`, `rds`, `s3`, `ses`, `vpc`). The data-pipeline compute module lives at `data-pipeline/terraform/pipeline-compute/` (co-located with the package it serves).

Each module must have a `Makefile` with `init-staging` and `init-production` targets. Copy the pattern from any existing module's `Makefile` when adding a new one.

## Package Manager

This project uses **pnpm** instead of npm. All Claude Code commands should use pnpm:
- `pnpm install` (not `npm install`)
- `pnpm add <package>` (not `npm install <package>`)
- `pnpm run <script>` (not `npm run <script>`)
- `pnpm test` (not `npm test`)

**Exception:** For the dev server, use `vercel dev` instead of `pnpm run dev` (we use Vercel's built-in tooling).

## Overview

Use Typescript Strict mode.
When processing asynchronous tasks, put them in the jobs table and store state changes in job_logs.
Update the README.md when an architecture change happens.
Unit tests should be added for every change to the backend side of the project, which is in src/lib

## Database Migrations

When adding a new Drizzle migration file under `drizzle/migrations/`, you must also register it in `drizzle/migrations/meta/_journal.json`. Add an entry to the `entries` array with the correct `idx`, `when` (Unix ms timestamp), `tag` (matching the migration filename without `.sql`), and `breakpoints: true`. Failing to update the journal will cause Drizzle to ignore the migration.

## Agent Design Pattern (`src/lib/agents`)

Each agent lives in its own folder under `src/lib/agents`, named after the agent. The folder structure must be:

```
src/lib/agents/<agent_name>/
  index.ts                      # Main agent entrypoint — must use `createAgent` and stream
  tools/
    index.ts                    # Registers all tools for the agent
    <tool_name>.ts              # One file per tool (one tool per file)
    <tool_name>.test.ts         # Unit tests for the tool
```

Rules:
- Each agent's `index.ts` is the main entrypoint and must use `createAgent`.
- Each agent must be streaming.
- Each tool gets its own dedicated file under `tools/`.
- `tools/index.ts` is responsible for registering all tools.
- Every tool must have unit tests.

## Feature Flags

Feature flags live in `src/lib/flags.ts` (e.g. `crmEnabled`, `aiWorkforceEnabled`).

**Server components (Next.js pages)** — fetch flags with `await` and pass as boolean props:

```ts
// src/app/some-page/page.tsx
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function SomePage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return <SomeView showCrm={showCrm} showAiWorkforce={showAiWorkforce} />;
}
```

**Views** — accept flags as boolean props, pass them to `DashboardLayout`:

```ts
interface SomeViewProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function SomeView({ showCrm = false, showAiWorkforce = false }: SomeViewProps) {
  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      ...
    </DashboardLayout>
  );
}
```

**`DashboardLayout`** — filters `baseNavigation` based on the boolean props. Do NOT use `useFeatureFlags` inside `DashboardLayout` or any view; all flag resolution happens server-side in the page file.

When adding a new feature-flagged nav item:
1. Add the flag function to `src/lib/flags.ts`
2. Add a `show<FeatureName>` prop to `DashboardLayoutProps` (default `false`)
3. Add the filter in `DashboardLayout`'s `filteredNavigation`
4. Thread the prop through every page file and view
