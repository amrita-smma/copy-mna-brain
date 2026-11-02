# Pipeline "Present" (table deck in the StarCapital table syntax)

The Pipeline page has a **Present** button next to **Add Company**. It opens a
dialog, laid out like Fund Management's Present report, showing the table as
the user has it:

- **Rows:** every row the stage tab, source, Pipeline Status, search, sector,
  track, screening and column filters let through, across all pages, in the
  table's sort order.
- **Columns:** a row number, the pinned Company column, then exactly the
  table's open columns in their display order. Hidden columns and the columns
  of a collapsed group are left out. Rearrange the table and the deck follows.

**Download PPTX** saves the same rows and columns as a .pptx. Its slide
branding follows the workspace's PowerPoint Template setting (see below).

## How the columns get there

Every managed column of `InboundCompaniesTable` and `OutboundCompaniesTable`
declares `text` (on `ColumnDef`, `src/components/table/types.ts`): its cell as
plain text. Examples: "Pass: Strong margins…" for AI Opinion (`aiOpinionText`),
"$312.50M (2025)" for Revenue, and the resolved Deal Lead. Each table writes
its open columns (`mgr.visibleColumns`) into an `openColumnsRef` that the page
passes down. When Present is clicked, `Pipeline.tsx` snapshots the rows and
those columns into a deck. The dialog is modal, so nothing it reflects can
change while it is open.

## One model, two renderings

`src/lib/pipeline/presentation.ts` (client-safe, pure):
`buildPipelinePresentation(companies, columns, { subtitle })` returns a
`PipelinePresentation`: a title, a subtitle naming the scope, the columns with
alignment and slide widths, and one formatted string per cell (empty cells
become "—").

Widths fill the 12.77" content area in proportion to what each column holds:
its 75th-percentile cell length, or its header. A column is never narrower than
its longest header word, so headers don't break mid-word.

- **Screen:** `PipelinePresentationDialog` draws the model as one long table.
- **Deck:** the dialog posts the model to `POST /api/pipeline/presentation/pptx`
  (validated by `pipelinePresentationSchema`: rows must match the columns, the
  columns must fit the slide, at most 1,000 rows). The route reads only the
  workspace's PowerPoint Template setting, and renders what it is sent with
  `src/lib/pptx/pipelinePresentationPptx.ts`.

## The slide

The slide branding follows the workspace's **PowerPoint Template** (admin
portal; see [PowerPoint templates](powerpoint-templates.md)):

- **StarCapital:** every slide sits on the StarCapital master, with its logo,
  confidentiality line, page tab and page number.
- **Default:** plain white slides with a small grey page number, and no logo or
  branding of any kind.

Either way the content uses the StarCapital "1_Content 1 Section" layout:
the title (22pt navy), the subtitle, the three-dot marker and a section title
("Companies 13–24 of 40 (2/4)"). The table follows the template's "Sample table" slide: a #1A3F65
header row in bold white Arial, unfilled Arial body rows with a #D0CECE rule
under each, and no vertical borders.

A cell is never clipped: text wraps within its column, so a row shows its full
content. Wrapped lines are estimated with per-character Arial widths
(`wrappedLineCount`), each row's height follows its tallest cell, and rows are
paginated by that height (`paginateByHeight`) — 12 single-line rows fit a
slide, fewer when cells wrap. A table of more than 10 columns is set one point
smaller, and a single row too tall for one slide steps the body type down
(to 7pt) rather than being cut.

## The Inbound table's default layout

Until a workspace saves its own arrangement (and again after **Reset** in the
column gear), the Inbound / All Sources table opens with Stage, Pipeline
Status, Created At, AI Opinion, Deal Lead (Deal Sponsor before the captain
stages) and Sector. Revenue, EBITDA, Valuation, % Stake, Deal Type and
Additional Remarks sit in one collapsed group behind a "+", and every other
column is hidden in the gear. The layout is `INBOUND_DEFAULT_LAYOUT`
(`src/lib/pipeline/inboundTableLayout.ts`), passed to `useColumnLayout` as its
`defaultLayout`. A saved workspace layout always wins over it.
