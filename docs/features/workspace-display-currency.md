# Workspace display currency (USD / IDR / CNY)

Each workspace has a **display currency** that relabels all money shown in the UI
— Fund Management figures and the company/pipeline Revenue / EBITDA / EV columns.

- **Relabel only, no FX conversion.** Only the currency prefix changes
  (`$` → `Rp` / `¥`, or the `USD` code → `IDR` / `CNY`). Stored values are
  untouched — company financials remain USD (`*_usd_mn`) and each fund keeps its
  own `base_currency`; the display just uses the workspace currency's symbol.
- Persisted on `workspaces.default_currency` (text column, default `'USD'`;
  migration `20260721000000_add_workspace_default_currency`).
- A superadmin picks it from the **Display Currency** dropdown in the workspace
  configuration panel (`/admin-portal`), which `PATCH`es `/api/workspaces/{id}`
  with `{ default_currency }`.
- `WorkspaceService.getDefaultCurrency` / `updateDefaultCurrency` read and write
  it; `WORKSPACE_CURRENCIES` (in `workspaceService.ts`) validates the payload.
- `src/lib/currency.ts` is the shared source of truth for the `Currency` type,
  `CURRENCY_SYMBOL`, `normalizeCurrency`, and the `formatMoneyMn` display helper
  (used by the company/pipeline views). The `/w/[workspaceSlug]` layout resolves
  the value and provides it via `WorkspaceCurrencyProvider`; client views read it
  with `useWorkspaceCurrency()` (Fund Management binds it through `useFundMoney()`).
- Every currency **picker** in the app (the Fund Management `CurrencyInput`
  dropdown, the transaction Price-per-share select, and the Smart Files review
  currency picker) is locked to the workspace currency: it defaults to that
  currency and the other codes are shown disabled with
  `(currency not selected in the workspace)`. The `/admin-portal` Display
  Currency selector is the one exception — that is where the workspace currency
  is chosen, so all three remain selectable there.
