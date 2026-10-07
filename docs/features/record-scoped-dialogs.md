# Record-scoped dialogs (`CompanyDetailDialog` and friends)

`CompanyDetailDialog` is opened from seven places — Pipeline, Dashboard, Master
Data, Smart Files, Company Graph, the Insights module, and Market Screening
results. It is a *record-scoped* dialog: it fetches its own data per company, so
how the parent holds "which company is selected" decides whether the user sees
the right one.

**The parent derives `open` from the selection; it never keeps a second
boolean.**

```tsx
{selectedCompany && (
  <CompanyDetailDialog
    key={selectedCompany.id}
    company={selectedCompany}
    open={!!selectedCompany}
    onOpenChange={(open) => {
      if (!open) {
        activeCompanyRequestIdRef.current = null;
        setSelectedCompany(null);
      }
    }}
    onUpdate={fetchPipelineData}
  />
)}
```

That block is what Dashboard and Smart Files render (`onUpdate` refreshes the
parent's own list). Three parts are load-bearing: the `{selected && …}` guard
unmounts the dialog on close, `open={!!selected}` keeps one source of truth, and
`key={selected.id}` forces a fresh instance if a parent swaps records without
closing first. The `activeCompanyRequestIdRef` clear belongs only on parents
that fetch. Pipeline and Market Screening pass the row through, so they null the
selection and clear an edit-mode flag, and they have no request ref.

**Why a separate `open` boolean is a bug.** `setDialogOpen(false)` hides the
dialog but leaves `selectedCompany` set, so the dialog stays *mounted*. Internal
`company` state is seeded from the prop once and re-synced in a `useEffect` on
`companyProp.id`, one paint after the next open is already visible. `analysis`
(including its logo), `notes`, `documents`, `screenings`, and `stageHistory`
come from a second effect on `[open, company.id]` (`refreshCompany`,
`fetchDetails`, `fetchAnalysis`) and stay on screen until those requests
return. This was the "opening a company card sometimes blips to the older card"
report. It affected Dashboard, the Insights module, and Market Screening
results, which each kept a separate open boolean. Pipeline and Master Data
already derived `open`; they were missing only `key`. Smart Files already
unmounted on close.

**Async open paths need a staleness guard.** Smart Files chips carry id + name,
Master Data and Insights do not have the full row in hand, and Dashboard falls
back to `getCompanies({ id })` for companies missing from its cached list
(dropped companies). Each of those fetches is awaited before `setState`,
because the inline editor writes back from the prop. Dashboard skips the
fetch when the row is already in its cached list. Two clicks can resolve out of
order. Smart Files drops a late success, and both its empty-result toast and
its `catch` toast check the ref:

```tsx
const activeCompanyRequestIdRef = useRef<string | null>(null);

const openCompany = useCallback(async (companyId: string) => {
  activeCompanyRequestIdRef.current = companyId;
  try {
    const data = (await getCompanies({ id: companyId })) as CompanyData | null;
    if (activeCompanyRequestIdRef.current !== companyId) return;
    if (!data) {
      toast.error("Could not load company");
      return;
    }
    setSelectedCompany(data);
  } catch {
    if (activeCompanyRequestIdRef.current === companyId) {
      toast.error("Could not load company");
    }
  }
}, []);
```

Dashboard's `handleCompanyClick` and Insights' `openCompany` check the ref
before `setSelectedCompany` and null it on close. Their `catch` blocks only
`console.error` and do not set state, so a stale rejection cannot open a
company; they do not consult the ref before logging. Dashboard also returns
early for mobile (it navigates to the full-screen profile) and for a cache hit,
after assigning the ref. Master Data checks the ref before setting the company,
before the error toast, and before clearing its loading flag. Closing nulls the
ref on every parent that has one, so an in-flight success after close is
dropped.

**Don't double-fetch.** The dialog loads the DTO, details, and analysis itself
in the `[open, company.id]` effect. `CompanyGraph.handleNodeClick` seeds from
the graph node and does not fetch — a second in-flight fetch raced that effect
and flashed stale content, which the comment on that function records.
`CompanyGraph` is the one accepted variant of the open-state pattern: it keeps
a separate `dialogOpen`, and is safe because it has `key={selectedCompany.id}`
and never fetches before open. New code should use the derived form. The
awaited pre-open fetch above is the one fetch a partial record needs; it
finishes before the dialog mounts.

The rule, with a reviewer's checklist, lives in
`.claude/rules/dialog-open-state.md`; `/review-implementation` and `/pr-review`
both check diffs against it.
