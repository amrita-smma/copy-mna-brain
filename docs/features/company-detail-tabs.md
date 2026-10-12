# Company detail tabs (page + pipeline dialog)

A company is read in two places: the full page `CompanyDetail.tsx`
(`/companies/<id>` and `/pipeline/<dealId>`) and the pipeline dialog
`CompanyDetailDialog.tsx`. Both render the same six tabs, in the same order:

| Tab | What it holds |
|---|---|
| Overview | The read-only L0→L1 submission slide, from the AI Company Card. |
| Additional Context | Context and Featured Slide, each in a collapsible section. |
| Timeline | Every dated event on the deal, plus all manual entry. |
| Details | Company Information, track variables, AI card, stage history. |
| L1 Screening / L1 Filters | Screening criteria results. |
| Voting | The Investment-Committee round. |

The page mirrors its tab in `?tab=`, so each switch is a history entry and Back
returns to the tab you came from. `resolveTab()` in `CompanyDetail.tsx` also maps
the three retired values — `context` and `featured-slide` → `additional-context`,
`attachments` → `timeline` — so old links and bookmarks still land on the content
they were aimed at.

## Additional Context

`CollapsibleSection` (`src/components/pipeline/CollapsibleSection.tsx`) wraps each
half so neither pushes the other off screen:

- **Context** — `CompanyContextCard` with `chrome="bare"`, since the section
  already supplies the title, description and border. The card keeps its own
  edit/save behaviour; its text still feeds the AI Opinion, the company card and
  slide generation, and the agent read tools.
- **Featured Slide** — the highlighted PDF/PPTX one-pager, its upload / replace /
  remove / present actions, and the `ExistingAttachmentPicker`. It always starts
  collapsed, and names the current slide in its header instead: the viewer is
  70–75vh tall, and the documents it reads land after the tab first renders, so
  an `open` derived from them would pop the section open mid-read.

## Timeline

`CompanyTimeline` (`src/components/pipeline/CompanyTimeline.tsx`) is shared by the
page and the dialog so the two cannot drift apart. It is a composer above two
panes: a narrow **vertical rail** of entries, newest at the top, beside a reading
pane for whichever entry is selected. Everything on the rail is built in the
browser from data the parents already hold — it adds no request of its own:

| Entry | Source |
|---|---|
| Stage change | `company_logs`, via `companyLogsToStageHistory` |
| Note | `deal_notes` |
| Upload | `deal_documents` (the featured one is badged) |
| Link | `deal_links` |
| File reference | `files` rows whose `matched_companies` include this company |

Each rail card shows its kind, its date, and a paperclip or link glyph when the
entry carries one; the rail renders `PAGE_SIZE` entries and **Load more…**
extends the window. Selecting a card fills the reading pane: a note's full body,
a document's processing status, tags, AI insights and preview / download, a
link's URL, a Smart File's preview / download / open-in-Smart-Files, or a stage
change's label. **Close** clears the selection and the pane returns to its empty
state. A selection that scrolls past the window after a refetch extends the
window rather than disappearing.

Notes can be **edited** in place from the reading pane (`PATCH /api/deal-notes/:id`
→ `DealNoteService.update`, which trims the body and rejects a blank one). Notes,
links and uploads can be **deleted**, always behind a confirmation dialog —
stage changes and Smart File references are not the timeline's to delete.

### Backdating

An entry is stamped with the moment it was added. Overriding that is the
exception, so the date + time pill sits behind an **Override note time** toggle;
with the toggle off the composer sends no `createdAt` at all and the column
default stamps the row. Opening the toggle re-seeds the pill to now, after which
it is left alone, so an author stamping several entries to the same past moment
picks it once.

The pill's value rides along as `createdAt` on all three create paths — note,
link and upload — and every one of them normalises it through
`normalizeOccurredAt` (`src/lib/timeline/occurredAt.ts`), which maps "not
supplied" to `undefined` and throws `InvalidOccurredAtError` → **400** on an
unparseable value, so a bad string can never silently become "now". The composer
blocks its own submits while the override is on and its date is empty, for the
same reason.

Manual entry is the only place these actions now live: the textbox adds a note,
**Upload file** registers a `deal_document`, and **Add link** reveals the URL +
title form. Each one delegates to the parent's existing handler, which refetches
afterwards, so the new entry appears on the rail.

**This tab replaced the Attachments tab.** Documents, links and Smart File
references are timeline events now; there is no second surface listing them.
