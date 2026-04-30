## Terraform Modules (`terraform/`)

Each module under `terraform/` (e.g. `bootstrap`, `iam`, `rds`, `s3`, `ses`, `vpc`) must have a `Makefile` with `init-staging` and `init-production` targets. Copy the pattern from any existing module's `Makefile` when adding a new one.

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
