---
name: add-feature-flag
description: Add a feature flag to this repo. Use when the user asks to "add a feature flag", "gate X behind a flag", "create a flag for Y", or runs `/add-feature-flag <name>`. Covers both nav-level flags (add a new sidebar entry) and in-page flags (show/hide UI within an existing page).
---

# Add Feature Flag

Add a typed, server-side feature flag. Flags are resolved in-house by `booleanFlag` in `src/lib/flags.ts`: a per-workspace admin override (`feature_flags` table, admin portal → Features) wins, else the env var, else the catalog's `defaultEnabled`. There is no Vercel Flags SDK — do not add `flags`/`@flags-sdk/*`.

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

Add an entry to `FEATURE_CATALOG` in `src/lib/features/catalog.ts` (key, label, description, `defaultEnabled: false`, `navItem`), then append a named export using the existing pattern:

```ts
// src/lib/flags.ts
export const myFeatureEnabled = booleanFlag("MY_FEATURE_ENABLED");
```

Rules:
- `key` must be SCREAMING_SNAKE_CASE and match the env var and the catalog entry.
- `defaultEnabled` in the catalog must be `false` (opt-in) unless it's a navigation feature that's already live.
- The camelCase export name should be `<featureName>Enabled` (or a descriptive verb phrase for non-boolean gates).

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
import { companyGraphEnabled, myFeatureEnabled } from '@/lib/flags';

export default async function SomePage() {
  const [showCompanyGraph, showMyFeature] = await Promise.all([
    companyGraphEnabled().then(Boolean),
    myFeatureEnabled().then(Boolean),
  ]);
  return <SomeView showCompanyGraph={showCompanyGraph} showMyFeature={showMyFeature} />;
}
```

**View file** (`src/views/<View>.tsx`) — accept as a boolean prop (default `false`) and pass to `DashboardLayout`:

```ts
interface SomeViewProps {
  showCompanyGraph?: boolean;
  showMyFeature?: boolean;    // add here
}

export default function SomeView({ showCompanyGraph = false, showMyFeature = false }: SomeViewProps) {
  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
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
  showCompanyGraph?: boolean;
  showMyFeature?: boolean;    // add
}

export default function DashboardLayout({ children, showCompanyGraph = false, showMyFeature = false }: DashboardLayoutProps) {
  const filteredNavigation = baseNavigation.filter((item) => {
    if (item.href === '/graph') return showCompanyGraph;
    if (item.href === '/my-feature') return showMyFeature;   // add
    return true;
  });
  ...
}
```

### 2. Thread through every page that uses `DashboardLayout`

Run `grep -rl "DashboardLayout\|showCompanyGraph" src/app --include="*.tsx"` to find all affected pages. For each one, add the flag to the `Promise.all` call and forward it as a prop to the view. The view must then pass it through to `<DashboardLayout>`.

Current pages that need updating (as of writing):
- `src/app/dashboard/page.tsx`
- `src/app/pipeline/page.tsx`
- `src/app/pipeline/[dealId]/page.tsx`
- `src/app/pipeline/[dealId]/slides/page.tsx`
- `src/app/chat/page.tsx`
- `src/app/smart-files/[[...tab]]/page.tsx`
- `src/app/master-data/page.tsx`
- `src/app/crm/page.tsx`
- `src/app/ai-workforce/[[...slug]]/page.tsx`

> **Why every page?** The sidebar is rendered inside `DashboardLayout` on every route, so every page that renders the layout must resolve the flag server-side and pass it down. A view with multiple render branches (loading/error/empty) must forward the flag to **every** `<DashboardLayout>` it renders, or the nav item flickers across states. Client-side flag resolution is banned in this codebase.

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
- Don't add a Drizzle migration or schema change for a flag — overrides already live in the generic `feature_flags` table; a new flag only needs a catalog entry and a `booleanFlag` export.
- Don't use `useSearchParams`, cookies, or headers to fake flag values in client components. Resolve the flag server-side only.
