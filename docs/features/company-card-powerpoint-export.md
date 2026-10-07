# Company Card → PowerPoint (email export)

The "L0 → L1 Submission" Company Card — the Overview tab of `CompanyDetailDialog`
(`CompanyOverviewSlide.tsx`) — can be exported as a `.pptx` and emailed by the
Copilot. Ask it to "send me the company detail / company card for X as a PPTX"
and it calls `send_email` with the `company_card` attachment spec.

Layers:

- **`src/lib/pptx/pptxElements.ts`** — the shape-level IR (rects, text boxes with
  formatting runs, tables) in inches on a 13.33"×7.5" slide, plus the px→in/pt
  helpers. Types only, so importing it pulls in nothing.
- **`src/lib/pptx/companyCardSlides.ts`** — pure renderer. Turns company +
  analysis data into positioned shapes mirroring the on-screen card (header +
  stage track, the two meta/deal-status box rows, and the three-column body:
  Target Overview + Indicative Financials + Proposed Deal Structure |
  Investment Thesis | L1 scope of work + Kill criteria). No DB, no browser.
- **`src/lib/pptx/writePptx.ts`** — writes `PptxElement[]` into a `.pptx` via
  pptxgenjs. Depends on nothing else.
- **`src/lib/services/companyCardSlideService.ts`** — data assembly. Composes
  `CompanyService.findByIdDTO`, `CompanyAnalysisService`, the Track list (for the
  Deal Sponsor/Captain fallback), the surfaced track variables, and the workspace
  display currency. Registered in `container.ts` as `companyCardSlideService`.
- **`buildCompanyCardAttachment`** in
  `src/lib/agents/analysis/tools/emailArtifacts.ts` — renders one card per
  requested company into a single deck and returns it as an `EmailAttachment`.
  Companies are addressed by `company_ids` (the ids `query_companies` printed —
  exact, no fuzzy matching) or by `company_names` as a fallback; the two lists
  are deduplicated on card title so naming a company both ways renders it once.

**Why no headless browser.** `slideExportService.exportSlidesToPptx` lays HTML
out in Chromium via Playwright, which is the right tool for the AI slide deck at
`/pipeline/:id/slides` (arbitrary AI-authored markup genuinely needs a browser).
The Company Card computes all of its own geometry, so it emits shapes directly
and never touches Playwright.

That matters operationally: `@playwright/test` is a **devDependency** and the
browser binary is only ever installed by the e2e CI job
(`.github/workflows/e2e-preview.yml`), never in the `Dockerfile` or a Vercel
build. Any code path that reaches `exportSlidesToPptx` therefore fails at runtime
in a deployed environment with `browserType.launch: Executable doesn't exist`.
`/api/slides/export-pptx` has that constraint today; the Company Card path
deliberately does not. **Do not route new server-side PPTX work through the HTML
path unless you are also arranging for a browser binary at runtime.**

**Pagination ("condensed and non-overlapping").** A slide is a fixed 630px box:
anything taller would be clipped by the extractor or would overprint the boxes
below it. So every block's wrapped height is estimated up front (`linesFor`) and
packed into per-column budgets; content that does not fit flows onto
"… (cont. N)" slides rather than overflowing. The kill-criteria block gets a
reserved share of column 3 so it can never be squeezed off the first slide.

**Rich text.** Text boxes carry per-run `bold`/`italic`/`color`, so the card's
`**Label**: value` lead-ins survive into PowerPoint as real bold instead of being
flattened. `htmlToPptxElements` emits the same runs for leaves that mix
formatting, so the AI slide deck export benefits too.
