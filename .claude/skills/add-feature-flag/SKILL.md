---
name: add-feature-flag
description: Add a Vercel feature flag to this repo. Use when the user asks to "add a feature flag", "gate X behind a flag", "create a flag for Y", or runs `/add-feature-flag <name>`. Covers both nav-level flags (add a new sidebar entry) and in-page flags (show/hide UI within an existing page).
---

# Add Feature Flag

Add a typed, server-side feature flag using the Vercel Flags SDK (`flags/next` + `@flags-sdk/vercel`).

## Inputs

- **Flag name** (required). Snake-case env-var style, e.g. `REPORTS_ENABLED` or `CRM_GOOGLE_VAULT_SYNC`. If the user didn't provide one, ask before proceeding.
- **Flag kind** (required). Classify before touching any code:
  - **Nav flag** — gates a new sidebar link in `DashboardLayout`. Must be threaded through every page.
  - **In-page flag** — gates UI *within* an existing page/view. Threads only through the relevant page(s).

---

## Step 0 — classify the flag

Read the user's intent and decide which kind applies. If uncertain, ask:
> Is this a new top-level navigation item, or a feature toggle within an existing page?

---

## Step 1 — define the flag in `src/lib/flags.ts`

Append a named export using the existing pattern:

```ts
// src/lib/flags.ts
export const myFeatureEnabled = flag<boolean>({
  key: "MY_FEATURE_ENABLED",         // must match the env-var name exactly
  defaultValue: process.env.MY_FEATURE_ENABLED === "true",
  adapter: vercelAdapter(),
});
```

Rules:
- `key` must be SCREAMING_SNAKE_CASE and match the env var.
- `defaultValue` must be `process.env.KEY === "true"` — never hard-code `true`.
- The camelCase export name should be `<featureName>Enabled` (or a descriptive verb phrase for non-boolean gates).
- Do not add `describe` or `origin` metadata unless the user specifically asks for a Vercel Toolbar override.

---

## Step 2 — add to `.env.example`

```
MY_FEATURE_ENABLED=false
```

Default must be `false` (flags are opt-in).

---

## Step 3a — in-page flag (most common)

Only wire this flag into the pages and views where the feature appears.

**Page file** (`src/app/<route>/page.tsx`) — add the flag to the `Promise.all` array and pass the result as a boolean prop:

```ts
import { crmEnabled, aiWorkforceEnabled, myFeatureEnabled } from '@/lib/flags';

export default async function SomePage() {
  const [showCrm, showAiWorkforce, showMyFeature] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
    myFeatureEnabled().then(Boolean),
  ]);
  return <SomeView showCrm={showCrm} showAiWorkforce={showAiWorkforce} showMyFeature={showMyFeature} />;
}
```

**View file** (`src/views/<View>.tsx`) — accept as a boolean prop (default `false`) and pass to `DashboardLayout`:

```ts
interface SomeViewProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
  showMyFeature?: boolean;    // add here
}

export default function SomeView({ showCrm = false, showAiWorkforce = false, showMyFeature = false }: SomeViewProps) {
  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      {showMyFeature && <MyFeatureComponent />}
    </DashboardLayout>
  );
}
```

> **Note:** `showMyFeature` does NOT go into `DashboardLayout` unless it gates a nav item. Pass it only to the view; use it with a simple `{showMyFeature && ...}` guard inside the view's JSX.

---

## Step 3b — nav flag (new sidebar link)

This involves more files because every page that renders `DashboardLayout` must resolve and forward all nav flags.

### 1. Add to `DashboardLayoutProps` and `filteredNavigation`

```ts
// src/components/layout/DashboardLayout.tsx
interface DashboardLayoutProps {
  children: React.ReactNode;
  showCrm?: boolean;
  showAiWorkforce?: boolean;
  showMyFeature?: boolean;    // add
}

export default function DashboardLayout({ children, showCrm = false, showAiWorkforce = false, showMyFeature = false }: DashboardLayoutProps) {
  const filteredNavigation = baseNavigation.filter((item) => {
    if (item.href === '/crm') return showCrm;
    if (item.href === '/ai-workforce') return showAiWorkforce;
    if (item.href === '/my-feature') return showMyFeature;   // add
    return true;
  });
  ...
}
```

### 2. Thread through every page that uses `DashboardLayout`

Run `grep -rl "DashboardLayout\|showCrm" src/app --include="*.tsx"` to find all affected pages. For each one, add the flag to the `Promise.all` call and forward it as a prop to the view. The view must then pass it through to `<DashboardLayout>`.

Current pages that need updating (as of writing):
- `src/app/dashboard/page.tsx`
- `src/app/pipeline/page.tsx`
- `src/app/pipeline/[dealId]/page.tsx`
- `src/app/pipeline/[dealId]/slides/page.tsx`
- `src/app/ai-discovery/page.tsx`
- `src/app/ai-file-dump/page.tsx`
- `src/app/master-data/page.tsx`
- `src/app/crm/page.tsx`
- `src/app/ai-workforce/[[...slug]]/page.tsx`

> **Why every page?** The sidebar is rendered inside `DashboardLayout` on every route, so every page that renders the layout must resolve the flag server-side and pass it down. Client-side flag resolution (`useFeatureFlags`) is explicitly banned in this codebase.

---

## Step 4 — verify

```bash
pnpm tsc --noEmit
```

No new type errors should appear. In particular confirm:
- The flag export is used in at least one page.
- Props flow all the way from `page.tsx` → `View.tsx` → `DashboardLayout` (for nav flags).
- No `process.env` reads outside `flags.ts` for this flag.

---

## What NOT to do

- Never call the flag function (`myFeatureEnabled()`) inside a client component or `useEffect`. All flag resolution is server-side.
- Never pass the raw flag function as a prop — always resolve it (`await myFeatureEnabled()`) in the page, then pass the boolean.
- Never default to `true` in the flag definition.
- Don't add a Drizzle migration or schema change for a flag — flags live in env vars and the Vercel dashboard, not the database.
- Don't use `useSearchParams`, cookies, or headers to fake flag values in client components. Use the server-side `flag()` API only.

---

## Vercel Dashboard wiring (one-time setup, if not present)

For flags to appear in the Vercel Flags dashboard and Toolbar, a discovery endpoint must exist. Check if `src/app/.well-known/vercel/flags/route.ts` exists. If it does not:

```ts
// src/app/.well-known/vercel/flags/route.ts
import { createFlagsDiscoveryEndpoint } from 'flags/next';
import * as flags from '@/lib/flags';

export const GET = createFlagsDiscoveryEndpoint(Object.values(flags));
```

This is a one-time file. Once it exists, every flag exported from `src/lib/flags.ts` is automatically registered with the Vercel dashboard — no per-flag changes needed to this file.
