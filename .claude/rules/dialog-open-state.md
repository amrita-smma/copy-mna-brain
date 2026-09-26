# Detail Dialog Open State

Applies to any parent that renders a **record-scoped dialog** — a dialog whose content is
fetched per record and that can be opened for a different record next time.
`CompanyDetailDialog` is the canonical one, but the rule is general.

## The rule

Derive the dialog's `open` from the selected record, and clear the record on close:

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

This is the block in `Dashboard.tsx` and `SmartFiles.tsx` (`onUpdate` is `fetchPipelineData`
on Dashboard and an inline `refetchVisited` on Smart Files). Three things make it correct,
and all three are required:

1. **`{selectedRecord && ...}`** — the dialog is only mounted while a record is selected.
2. **`open={!!selectedRecord}`** — open is *derived*, never a second source of truth.
3. **`key={selectedRecord.id}`** — a different record always gets a fresh instance, even if
   the parent swaps records without closing first.

Null `activeRequestIdRef` on close only when the parent has one. Pipeline and Market
Screening pass the row they already hold and do not fetch, so their close handlers only
null the selection (and clear an edit-mode flag).

## Banned: a separate `open` boolean

```tsx
// ✗ WRONG — the bug this rule exists to prevent
const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
const [dialogOpen, setDialogOpen] = useState(false);
...
{selectedCompany && (
  <CompanyDetailDialog
    company={selectedCompany}
    open={dialogOpen}
    onOpenChange={setDialogOpen}
  />
)}
```

`setDialogOpen(false)` hides the dialog but leaves `selectedCompany` set, so the
`{selectedCompany && ...}` guard keeps the dialog **mounted**. `company` state is
initialized from the prop once and re-synced only in a `useEffect` on `companyProp.id`, so
the first paint of the next open still shows the previous company. `analysis` (including
`analysis.logo_url`), `notes`, `documents`, `screenings`, and `stageHistory` are separate
state filled by the effect on `[open, company.id]` — `refreshCompany()`, `fetchDetails()`,
and `fetchAnalysis()` — and stay stale until those requests return.

Symptom to recognize in a bug report: *"opening a card sometimes blips to the older card."*

## Guard every async open path

If the open handler fetches before setting state, a slow earlier response can land after a
newer click and open the wrong record. Track the latest requested id in a ref and drop
stale responses before any `setState` or user-visible error, and null the ref on close.

`SmartFiles.tsx` is the full form. The empty-result toast and the `catch` toast both check
the ref, so a superseded failure cannot toast over the company the user clicked next:

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

`Dashboard.tsx` `handleCompanyClick` uses the same ref. It returns before the fetch on
mobile (full-screen profile) and when the row is already in the cached `companies` list;
the ref is assigned before that cache hit, so an in-flight request for a different id is
invalidated. The fetch path checks the ref before `setSelectedCompany`. Its `catch` only
`console.error`s and does not set state, so a stale rejection cannot open a company, and it
does not consult the ref. Insights `openCompany` matches that fetch-and-log shape. Master
Data's `openCompanyDialog` checks the ref on the success path, the error toast, and
`setLoadingDialog(false)` in `finally`.

Do **not** skip the guard because the list is small or the endpoint is fast — the race is
about response ordering, not latency.

## Don't re-fetch what the dialog already fetches

`CompanyDetailDialog` pulls the authoritative DTO, company details, and analysis itself on
open (`CompanyDetailDialog.tsx`, the `useEffect` on `[open, company.id]`). Seed the dialog
with whatever the row or node already has and let that effect refresh — that is what
`CompanyGraph.handleNodeClick` documents. A second fetch started in the click handler and
left in flight alongside that effect races the dialog's own load.

Parents that do not already hold a full DTO still await **one** fetch before `setState`,
because the inline editor writes back from the prop. That is Smart Files (a chip is id +
name), Master Data, Insights, and Dashboard's uncached path (dropped companies are absent
from the cached list). Awaiting it before opening is not the race. Pipeline and Market
Screening already have the row, so they set state directly and do not fetch.

## Accepted variant

`CompanyGraph.tsx` keeps a separate `dialogOpen` but is safe **because** it has
`key={selectedCompany.id}` and never fetches before open. Do not copy the separate boolean
into new code; prefer the derived form above.

## Reviewing a diff

Reject a JSX diff that renders a record-scoped dialog and either:

- passes `open={someBoolean}` where the boolean is separate `useState` from the record, or
- omits `key={record.id}`, or
- has an `onOpenChange` close branch that does not null the record, or
- fetches the record in the click handler with no request-id guard.
