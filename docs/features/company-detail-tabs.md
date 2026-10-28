# Company detail tabs (page + pipeline dialog)

A company is read in two places: the full page `CompanyDetail.tsx`
(`/companies/<id>` and `/pipeline/<dealId>`) and the pipeline dialog
`CompanyDetailDialog.tsx`. Both render the same six tabs, in the same order:

| Tab | What it holds |
|---|---|
| Overview | The read-only L0→L1 submission slide, from the AI Company Card. With no card yet it is a blank screen with one generate button (see [Overview before a card exists](#overview-before-a-card-exists)). |
| Additional Context | Context and Featured Slide, each in a collapsible section. |
| Timeline | Every dated event on the deal, plus all manual entry. |
| Details | Market Scanning Remarks (outbound), financials, Company Information, contact details ([company-contacts](company-contacts.md)), relationship graph, track variables, stage history, AI card. |
| Pre-pipeline Filters | AI screening results against each matched track's criteria — run in Pending Confirmation (Scan now, Auto-scan, or a row's Run AI Screening); results stay with the company after it moves to L0. Pipeline's AI Screening tab opens the dialog here. |
| Voting | The Investment-Committee round, beside a half-width Featured Slide preview — deck, recording or YouTube video (rules in a "How voting works" tooltip). |

The page mirrors its tab in `?tab=`, so each switch is a history entry and Back
returns to the tab you came from. `resolveTab()` in `CompanyDetail.tsx` also maps
the three retired values — `context` and `featured-slide` → `additional-context`,
`attachments` → `timeline` — so old links and bookmarks still land on the content
they were aimed at.

## Overview before a card exists

Until a company has an AI Company Card, the Overview is not an empty slide but
a blank screen with one button: **Company card not generated, press here to
generate** (`CompanyCardNotGenerated`). Pressing it queues a card run on the AI
Workforce (`POST /api/company-analysis`) and the button becomes a disabled
**Generating…** with a **View task in AI Workforce** link to that run.

The state lives on the server, not in the component. `useCompanyCardGeneration`
(shared by the page and the dialog) reads `GET /api/company-analysis/state`,
which returns the card row *and* the company's in-flight card run
(`CompanyAnalysisService.getGenerationState`). A queued run has no
`company_analyses` row yet, so the run is what keeps "Generating…" across a
reload, a reopened dialog, or a run someone else started. The hook polls that
endpoint for as long as the run is alive — no fixed timeout — and the slide
replaces the prompt once the card lands.

## Details

`CompanyDetailsTab` (`src/components/pipeline/CompanyDetailsTab.tsx`) is shared by
the page and the dialog, like the Timeline, so the two cannot drift apart. Each
parent supplies the data and callbacks; the tab owns the layout.

- **Company Information** edits through `useCompanyInformationEditor`, and the
  draft ↔ `PATCH /api/companies` mapping lives in
  `src/lib/companies/companyInfoForm.ts`, so both views save the same fields
  (including Company Focus, Comments, NBO Due Date, Live Process and Matched
  Tracks). The workspace's pipeline required fields sit in the amber box at the
  top; a save that moves a company into the pipeline without them toasts the
  missing labels.
- **Deal Status** (Active / Dropped) is an immediate action, not a form field:
  `useDealStatusToggle` opens the host's `DropDealDialog` to drop and restores
  (with the stage prompt) to reactivate. **Live Process** is the separate
  `is_live` override, saved with the form.

## Additional Context

`CollapsibleSection` (`src/components/pipeline/CollapsibleSection.tsx`) wraps each
half so neither pushes the other off screen:

- **Context** — `CompanyContextCard` with `chrome="bare"`, since the section
  already supplies the title, description and border. The card keeps its own
  edit/save behaviour; its text still feeds the AI Opinion, the company card and
  slide generation, and the agent read tools.
- **Featured Slide** — one highlighted item: a PDF / PPTX deck, a video or
  audio recording, or a YouTube video. Its upload / replace / remove / present
  actions, the YouTube-link form, and the `ExistingAttachmentPicker` (existing
  featurable uploads *and* YouTube links) live in `FeaturedSlideSection`, driven
  by the `useFeaturedSlide` hook (`src/components/pipeline/featured/`) — both
  the page and the dialog render that one component, and the Voting tab takes
  the hook's `slide` state. It always starts collapsed, and names the current
  slide in its header instead: the viewer is 70–75vh tall, and the documents it
  reads land after the tab first renders, so an `open` derived from them would
  pop the section open mid-read.

### What a featured slide can be

An upload is a `deal_documents` row with `is_featured`; a YouTube link is a
`deal_links` row with `is_featured`. Each table has a partial unique index (one
featured row per deal), and `DealDocumentService` / `DealLinkService` clear
**both** tables' flags before setting their own, so a deal has one featured item
overall. `DELETE /api/deal-documents/feature` unfeatures whichever holds it;
`POST /api/deal-links/feature` features an existing link, and
`POST /api/companies/:id/links` with `featured: true` adds and features one in a
single step. Featurable kinds are `isFeaturableFileKind` (`src/lib/fileType.ts`)
and `isYouTubeVideoUrl` (`src/lib/media/youtube.ts`); anything else is an
`UnsupportedFeaturedSlideError` → **400**.

Video and audio uploads skip the `deal_document_processing` job (stored as
`processing_status: 'skipped'`) — there is no text to extract, and the job
would load the whole recording into memory to find that out.

Rendering lives in `FileBody`, so every preview surface — this section, the
Voting panel, the Timeline, Smart Files, chat and the Presentation page — plays
the same kinds: a `<video>` / `<audio>` element for recordings, and a
`youtube-nocookie.com` embed for any YouTube video URL (detected from the URL,
not the file name). A YouTube preview's toolbar offers **Open on YouTube** in
place of Download, since there is no file to download.

## Timeline

`CompanyTimeline` (`src/components/pipeline/CompanyTimeline.tsx`) is shared by the
page and the dialog so the two cannot drift apart. It is a composer above two
panes: a narrow **vertical rail** of entries, newest at the top, beside a reading
pane for whichever entry is selected. Everything on the rail is built in the
browser from data the parents already hold — the only request it makes is the
signed preview URL for a selected attachment (through the parent's
`getDocumentPreviewUrl` / `getMatchedFilePreviewUrl`):

| Entry | Source |
|---|---|
| Stage change | `company_logs`, via `companyLogsToStageHistory` |
| Note | `deal_notes` |
| Upload | `deal_documents` (the featured one is badged) |
| Link | `deal_links` (a YouTube video link plays inline) |
| File reference | `files` rows whose `matched_companies` include this company |

Each rail card shows its kind, its date, and a paperclip or link glyph when the
entry carries one; the rail renders `PAGE_SIZE` entries and **Load more…**
extends the window. Selecting a card fills the reading pane: a note's full body,
a document's processing status, tags and AI insights, a link's URL (and an
inline player when it is a YouTube video), a Smart
File's AI insights and open-in-Smart-Files, or a stage change's label. A
document or Smart File previews **inline** below that, in a `FilePreview` with
its Present / Download toolbar — there is no Preview button or preview dialog. **Close** clears the selection and the pane returns to its empty
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

The composer is hidden behind a small **+** beside the rail's "N events"
header. Clicking it opens the composer in the right-hand reading pane in place
of the selected entry; selecting an entry on the rail (or the composer's **×**)
closes it, and a successful add hands the pane to the entry it just wrote.
Manual entry is the only place these actions now live: the textbox adds a note,
**Upload file** registers a `deal_document`, and **Add link** reveals the URL +
title form. Each one delegates to the parent's existing handler, which refetches
afterwards, so the new entry appears on the rail.

**This tab replaced the Attachments tab.** Documents, links and Smart File
references are timeline events now; there is no second surface listing them.
