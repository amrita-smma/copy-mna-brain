# Workspace table layouts (column order / hidden / groups)

The managed data tables — Pipeline inbound & outbound (`pipeline-inbound:<view>`,
`pipeline-outbound:<view>`), Master Data (`master-data`), Smart Files
(`smart-files`), and Market Screening results (`market-screening-results`) — let
users reorder columns, hide them, and gather contiguous columns into collapsible
groups. That arrangement is a **workspace setting, not a per-user preference**:
one member rearranging a table changes it for everyone in the workspace, and the
arrangement follows them to any browser or device.

- **Storage (database)** — one row per (workspace, table) in
  `workspace_table_layouts`, primary-keyed on `(workspace_id, table_id)`
  (migration `20260811000000_workspace_table_layouts`). `layout` is a jsonb
  `ColumnLayoutState` blob (`{ order, hidden, groups }`) — see
  `src/lib/table/columnLayout.ts` for the pure ordering/hiding/grouping logic.
  This replaces the previous `mna:table-layout:v1:*` localStorage persistence,
  which was per-browser.
- **Backend** — `WorkspaceTableLayoutRepository` (workspace-scoped data access) →
  `TableLayoutService` (validates the incoming blob with
  `parseColumnLayoutState`, dropping unknown keys, and constrains `tableId` by
  shape) → `/api/table-layouts` (`GET` all layouts for the active workspace,
  `PUT` one, `DELETE ?tableId=` to reset). The workspace always comes from the
  request context, never from the body: reads use `getActiveWorkspaceId()`,
  writes use `getActiveWorkspaceIdOrThrow()` so they fail closed with a 403
  rather than stamping the no-active-workspace sentinel onto a row.
- **Authorization** — any signed-in **member** of the workspace may read *and*
  write. That is deliberate (a shared table everyone can arrange) and is looser
  than `default_currency`, which is superadmin-only; the trade-off is
  last-write-wins with no in-app audit surface. `updated_by`/`updated_at` are
  recorded on every write if that ever needs surfacing.
- **Frontend** — `TableLayoutProvider` (mounted in the `/w/[workspaceSlug]`
  layout, **keyed by slug** so switching workspace remounts and refetches)
  fetches every layout in a **single** request, so N tables never mean N
  requests. `useColumnLayout(tableId, columns)` reads its table's layout from
  that store, reconciles it against the live column set (`initLayout` appends
  new columns and drops removed ones), and writes back — debounced 400ms and
  optimistic — only on real user edits, tagged with the `tableId` the edit was
  made against. Specifically:
  - Hydration never writes, so merely opening a table cannot overwrite the
    workspace's layout.
  - Writes are suppressed until the initial `GET` **succeeds**, so a failed read
    can't be followed by a save that overwrites a layout that never loaded.
  - Pending debounced writes are flushed on unmount rather than dropped.
  - **Reset** deletes the stored row rather than saving today's defaults, so the
    table keeps following future changes to its declared columns.
