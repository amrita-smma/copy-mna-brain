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
page and the dialog so the two cannot drift apart. It is a horizontal rail,
oldest event on the left, built in the browser from data the parents already hold
— it adds no request of its own:

| Marker | Source |
|---|---|
| Stage change | `company_logs`, via `companyLogsToStageHistory` |
| Note | `deal_notes` |
| Upload | `deal_documents` (the featured one is badged) |
| Link | `deal_links` |
| File reference | `files` rows whose `matched_companies` include this company |

Clicking a marker expands that event into the panel beneath the rail: a note's
full text and delete, a document's processing status, tags, AI insights,
preview / download / delete, a link's URL, or a Smart File's preview / download /
open-in-Smart-Files. Clicking the selected marker again collapses it. The caret
that points back at the marker is positioned from the fixed `ITEM_WIDTH` and the
rail's `scrollLeft`, and is clipped at the card's edges.

Manual entry sits above the rail and is the only place these actions now live:
a textbox adds a note, **Upload file** registers a `deal_document`, and **Add
link** reveals the URL + title form. Each one delegates to the parent's existing
handler, which refetches afterwards, so the new entry appears on the rail.

**This tab replaced the Attachments tab.** Documents, links and Smart File
references are timeline events now; there is no second surface listing them.
