# Runtime feature toggles

Features can be turned on/off **per workspace** at runtime by a superadmin from
the **Features** tab of the workspace configuration panel (`/admin-portal`).
This covers both code-consumed flags (Company Graph, Insights Dashboard, Fund
Management, Task Notifications, CRM Google Vault Sync, Chat Cache) and the main
sidebar sections (Dashboard, Pipeline, Master Data, CRM, Smart Files,
Presentation, AI Workforce). Each workspace has its own set of toggles.

How it's wired:

- **Catalog** — `src/lib/features/catalog.ts` is the single source of feature
  metadata (key, label, description) and each feature's `defaultEnabled`.
  `featureEnvDefault(key)` resolves the baseline: the env var when explicitly
  set, otherwise `defaultEnabled` (nav sections default ON so the app is
  unchanged until an admin turns one off; opt-in flags default OFF).
- **Storage (database)** — overrides live in the dedicated `feature_flags` table
  (`workspace_id`, `feature_key`, `enabled`, `updated_at`, `updated_by`; PK
  `(workspace_id, feature_key)`), accessed via `FeatureFlagRepository`. One row
  per (workspace, feature).
- **Service / API** — `FeatureFlagsService`
  (`src/lib/services/featureFlagsService.ts`) merges stored rows with catalog
  defaults. The **Features** tab loads state via `GET /api/workspaces/{id}/features`
  and toggles via `PUT /api/workspaces/{id}/features` (both superadmin-gated).
- **Code-flag resolution** — `src/lib/features/overrides.ts` exposes
  `resolveFeatureOverride`, which `flags.ts` consults first. It resolves the
  request's active workspace via `getActiveWorkspaceId()` (driven by the
  `X-Workspace-Slug` header `proxy.ts` sets on `/w/<slug>/…` requests) and reads
  that workspace's rows. An override wins over the env/Vercel default, so toggles
  take effect across every existing flag consumer without consumer changes.
- **Tab gating** — the workspace layout (`src/app/w/[workspaceSlug]/layout.tsx`)
  resolves the full per-workspace flag map once via `resolveWorkspaceFeatureFlags`
  and provides it through `FeatureFlagsProvider`
  (`src/components/layout/FeatureFlagsContext.tsx`). `SidebarPagesNav` reads the
  context and hides any page whose `flag` is disabled — no per-page prop
  threading. `AppShell` consults the same map when deciding which page to open,
  and the copilot's `navigate_page` tool refuses a destination the workspace has
  switched off.
