# Fund Management page (`/fund-management`)

The portfolio view over the fund ledger (`fl_*` tables). The whole read model
loads in one batched request (`GET /api/fund-ledger/portfolio`), so every table
renders all of its rows at once — there is no pagination.

## Layout and search

- The page is full width, the same as the Ledger page. `PageHeader` has no
  inner width cap, and the body only gets `px-5` padding.
- The search box above the Portfolio card filters the active tab on the client
  (`matchesSearch` / `normalizeSearch` in `src/views/fundManagement/calc.ts`):
  - **Asset**: asset name, English and legal name, Action Items text, and holder
    names. When grouped, a group whose own name matches keeps every row;
    otherwise only matching rows stay, and empty groups are hidden.
  - **Fund**: fund name, or the name of any holding in the fund.
  - **Investor**: entity name, English name, and investor group.
  - **Source of fund**: source name.

## Grouping

The Asset tab's **Group:** pills choose No grouping, by Fund Type, by Investor,
by Source of Fund, or by Investment Type.

- Groups of groups (an investor group's entities, on the Investment Entity tab
  and in the Asset tab's "by Investor" view) render as collapsible section
  heading rows (`GroupSectionRow` in `parts.tsx`), the same dropdown pattern as
  the Fund Vehicles sections. Ungrouped entities sit under "Other entities".

## Investment types ("by Investment Type")

`fl_investment_types` is a per-workspace list (`name`, `sort_order`; names are
unique ignoring case). Each asset may point at one through
`fl_assets.investment_type_id` (`ON DELETE SET NULL`).

- The migration gives every existing workspace the defaults
  (`DEFAULT_INVESTMENT_TYPES` in `flInvestmentTypeService.ts`): Realized Funds,
  Venture Capital, Private Equity, Private Credit, Others, Realized and
  Partially Realized, Unrealized. `scripts/seed.ts` seeds the same list.
  New workspaces start with none until someone adds them.
- **Configure groupings** (shown while grouping by Investment Type) opens
  `InvestmentTypesDialog` to add, rename and delete types. Deleting a type
  unassigns its assets.
- An asset row's ⋮ menu → **Investment type** submenu assigns the asset
  (`PUT /api/fund-ledger/assets/:id/investment-type`, `null` unassigns).
- The grouping is by whole asset (a co-invested asset appears once), in the
  configured order, with **Unassigned** last.
- API: `GET/POST /api/fund-ledger/investment-types`,
  `PATCH/DELETE /api/fund-ledger/investment-types/:id`, all through
  `FlInvestmentTypeService`.

## Action Items

`fl_assets.action_items` is free text, nullable. It is edited inline in the
Asset table's **Action Items** column (`InlineEdit`, textarea) and saved with
`PATCH /api/fund-ledger/assets/:id { action_items }`. A blank value clears it.
Fund-of-funds targets and display-only rows have no `fl_assets` row and show
"—".

## Delete asset (hard delete)

The row menu offers **Delete asset** next to Close/Reopen holding. Its
confirmation (`TypeToConfirmDialog`) stays disabled until the asset's name is
typed exactly.

`DELETE /api/fund-ledger/assets/:id` → `FlLedgerService.deleteAssetWithLedger`
runs in one transaction:

1. Refuses system cash assets.
2. Collects every business event with a leg on, or a counterparty of, one of the
   asset's positions.
3. Expands that set to events containing entries derived from it
   (`source_ledger_entry_id`), repeating until nothing new is added.
4. Deletes those events' ledger entries, derived entries first because the
   self-FK is `RESTRICT`; funding allocations cascade. Then deletes the events
   themselves; revisions cascade.
5. Deletes the asset. Positions, valuations, corporate actions and ownership
   changes cascade.

Deleting **whole events** is deliberate. Removing only the asset's legs would
leave the matching cash legs behind and unbalance cash.

## Upload a fund update from a ledger-entry dialog

The Ledger page's **Post an entry** dialog and the asset's **Add transaction**
dialog both contain an **Upload File** drop zone
(`src/components/ledger/FundUpdateUploadDrop.tsx`).

- A file dropped there goes through the normal Smart Files upload
  (`uploadSmartFile` in `src/lib/api/files.ts`) with
  `file_type_override: 'fund_updates'`. That sends it to the existing
  fund-update extraction: the deterministic parser, the `fund_update_extraction`
  job, or `processFundUpdateContent`.
- The user is then redirected to `/smart-files/fund_updates?file=<id>`.
- Smart Files polls `GET /api/smart-files/:id` until the file settles:
  - `awaiting_review` opens the review dialog.
  - `completed` opens the parsed view.
  - `failed` shows a toast.
