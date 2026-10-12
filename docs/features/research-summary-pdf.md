# Research-summary PDF (email attachment)

The `research_summary` argument of the `send_email` agent tool attaches a
formatted PDF to the email. The analysis agent composes it from an ordered list
of typed blocks; all layout is on our side of the line.

| | |
|---|---|
| Agent schema | `src/lib/agents/analysis/tools/emailArtifacts.ts` (`researchSummarySpecSchema`) |
| Loaded | lazily — see "Keep the renderer import lazy" below |
| Entry point | `src/lib/pdfSummary.tsx` → `generateResearchSummaryPdf(input)` |
| Renderer | `src/lib/pdf/` — `@react-pdf/renderer` |
| Tool prompt | `src/lib/agents/analysis/tools/send_email.ts` |

## The block vocabulary

`sections` is an ordered array; each entry is one of:

| Kind | Shape |
|---|---|
| `heading` | `{ text, level?: 'section' \| 'subsection' }` |
| `paragraph` | `{ text }` |
| `bullets` | `{ items }` |
| `kpi_cards` | `{ cards: [{ label, value, hint?, tone?, logo_url? }] }` |
| `chart` | `{ type: 'bar' \| 'stacked_bar' \| 'line' \| 'pie', title?, unit?, categories, series: [{ name, values }] }` — `pie` is drawn as a donut |
| `bar_chart` | `{ title?, unit?, data: [{ year, value }], accent? }` — the pre-`chart` single-series form, folded onto `chart` by `toChartSpec` |
| `callout` | `{ tone?: 'warning' \| 'takeaway' \| 'info' \| 'positive', title?, text?, items? }` |
| `image` | `{ url, caption?, maxHeight? }` — https PNG/JPEG |
| `gauges` | `{ gauges: [{ label, valuePct, tone?, trendLabel? }] }` |
| `scorecard` | `{ rows: [{ label, pill, rationale, logo_url? }], columns?, overallPill?, overallNote? }` |
| `quadrants` | `{ quadrants: { topLeft, topRight, bottomLeft, bottomRight, xLabel*, yLabel* } }` |
| `priority_list` | `{ items: [{ priority: { label, tone }, description, meta? }] }` |

Nothing is mandatory and there is no required order — the same renderer produces
M&A target evaluations, SWOT grids, daily market updates and sector briefs.

The agent emits `logo_url` in snake_case; `mapSection` renames it to the
renderer's `logoUrl` and defaults a missing one to `null`.

Cross-field rules are enforced on the whole spec rather than per block, because
`z.discriminatedUnion` only accepts plain objects: every chart series must carry
exactly one value per category, and a `callout` must carry `text`, `items`, or
both. `sections`, `scorecard.rows` and `references` are bounded so one spec
cannot fan out to unlimited image fetches or an attachment too large for SES.

`kpi_cards` is one ruled grid, three cells to a row, with hairline rules
between the cells and a tinted alternate row — not a scatter of detached tiles.
Fewer cards than a full row share the width instead of leaving the frame blank,
and a short last row is padded so the column rules run the whole way down. A
card carrying a `tone` is a status rather than a quantity, so its value is set
as a pill instead of as a headline number; leave it unset for anything
measurable, because a figure set as a pill loses the size that made it
scannable.

A `callout` with neither body nor items renders nothing rather than an empty
box, which is why the schema rejects it: a block the agent believed it had
emitted should come back as an error it can act on, not vanish. `warning` (the
default) is the amber, left-ruled box for a caveat; `takeaway` is the filled
navy panel for a summary, and it is the one block allowed to break across a
page, so its fill has to survive the continuation.

`stacked_bar` stacks positive values only. A negative segment would walk the
running total back down, so the next segment would be drawn over the previous
one and the column would stop summing to the total the axis was scaled against;
a series of mixed signs wants a grouped `bar` chart instead.

## The layout contract

These are the properties the renderer guarantees, and `src/lib/pdf/layout.test.ts`
asserts them against the rendered bytes rather than against the React tree:

- **No text outside the printable area.** Every glyph box sits within the page
  margins, and body content additionally stays out of the bands reserved for the
  running header and footer.
- **No two lines of text on top of each other.**
- **Nothing is silently truncated.** Text wraps; it is never clipped to its first
  line. The one exception is a chart's category labels, which are ellipsized to
  their slot because the slot width is fixed by the number of bars.
- **A scorecard row never splits across a page**, and the table's header row
  repeats at the top of every page the table spans.
- **Every page carries the running header and a `N / M` footer.**
- **Text outside Latin-1 renders as itself.** Inter and Source Serif 4 are both
  embedded and subset; CJK is outside both faces and is the known gap.

`src/lib/pdf/layoutInspector.ts` is what makes these checkable: it walks MuPDF's
structured text and returns every drawn line with its exact ink box. Its
`colorAt` reads one rendered pixel, for the invariants text cannot see: a
takeaway callout is white-on-navy and may break across a page, so a
continuation that kept the text and lost the fill would print white on white;
and a KPI grid's rules and pills are fills with no text of their own.

## Keep the renderer import lazy

`buildResearchSummaryAttachment` reaches the renderer through
`await import('@/lib/pdfSummary')`, not a module-scope import. Do not hoist it.

The service container reaches this file transitively — `container` → routines →
workforce → `runAgent` → the analysis agent → its tool registry → `send_email` →
`emailArtifacts` — so a static import pulls pdfkit, fontkit and yoga into every
module that touches `createContainer`. `scripts/seed.ts` is one of them, and
under `tsx` that build fails outright: tsx transpiles `@react-pdf/textkit`
(ESM-only) through its CJS loader, so `import … from '@react-pdf/hyphenate/en-us'`
becomes a `require`, and that package's `exports` map declares an `import`
condition but no `require` one. The result is
`ERR_PACKAGE_PATH_NOT_EXPORTED: './en-us'`, which took down the `db:seed` step in
CI the first time the import was static.

Deferring it also keeps the renderer out of every request that attaches no PDF.

A `tsx` script that genuinely needs to render a PDF will hit the same resolution
failure; run it through `vitest` (as `src/lib/pdf/render.test.ts` does) rather
than `tsx`.

## Assets

- **Fonts.** Two families from `public/fonts`, registered once per process in
  `src/lib/pdf/fonts.ts`: Inter Regular/SemiBold/Bold for body text, and Source
  Serif 4 for the cover title and section headings. They reach the deployed
  function through Next's output tracing (`outputFileTracingIncludes` in
  `next.config.ts` pins them explicitly); if they are ever missing the renderer
  falls back to Helvetica and Times under the same family names and logs loudly.

  The serif carries fewer glyphs than Inter, so every serif style sets
  `fontFamily: SERIF_STACK` — the serif followed by Inter. `@react-pdf/layout`
  loads both and substitutes per glyph, so a heading containing something
  outside the serif renders in Inter rather than as a blank box. SVG text is
  drawn outside that substitution pass, which is why the donut's centre total —
  the one serif string inside an `<Svg>` — is machine-formatted and names the
  family directly.
- **Images.** Every remote URL in the document is fetched up front and
  de-duplicated, six at a time, under a 4s timeout and a 512KB streamed cap, to
  a ceiling of 32 images per document (`src/lib/pdf/assets.ts`). A failure
  resolves to `undefined` and the block renders without the image — a dead logo
  host costs a figure, never the email.

  Those URLs come from a language model and the fetch runs server-side, so the
  address is checked before the request and again after every redirect:
  loopback, link-local (including cloud instance metadata), RFC1918, CGNAT and
  internal-sounding hostname suffixes are refused, and redirects are followed by
  hand so a public URL cannot bounce into the private network. DNS rebinding is
  the acknowledged gap — closing it needs the socket pinned to a vetted IP,
  which `fetch` does not expose.
- **Size.** The finished PDF is checked against `PPTX_MAX_EMAIL_BYTES`, the same
  SES budget the PowerPoint path uses; over it, `send_email` returns an error
  and sends nothing.

## Charts

`src/lib/pdf/charts/geometry.ts` is pure: data in, pixel coordinates out, no
React and no PDF. `Chart.tsx` only turns those numbers into `<Svg>` primitives.
That split is what lets tick spacing, stacking, and direct-label collision be
unit-tested without rendering a document.

Every chart is framed in a `figureCard`, so a figure is bounded by something
other than white space.

Series colours come from `SERIES` in `src/lib/pdf/theme.ts` — a fixed, never
cycled, CVD-validated order whose first two slots are the brand navy and the
brand orange, so a one- or two-series chart is drawn in the same colours as the
cover band. One of the eight slots sits below 3:1 contrast on white, and every
multi-series chart ships a text legend and direct value labels regardless;
colour never carries identity alone.

A direct value label is set bold in the navy ink and emitted only where it
clears the next label along: the budget is the category slot for a single
series and the bar itself for a grouped one. `LABEL_FONT` is handed to
`buildChartGeometry` and is the size the label is drawn at — measuring at one
size and inking at another lets geometry admit a label that then collides, and
the unit tests would agree with the arithmetic rather than with the page. That suppression is why a
twelve-point chart no longer prints numbers on top of each other, and the slot
rule is why a two-bar chart no longer drops labels it had room for.

A `pie` spec is drawn as a **donut**: the ring on the left with the total in its
hole, and a legend table on the right carrying each slice's label, value, share
and a proportional bar. The hole is the only place the total can be printed, and
a share-of-whole chart whose whole is not stated makes the reader derive it from
the legend; the bars are the ring's geometry unrolled onto a common baseline,
which is the comparison the angles only imply.

## Working on it

```bash
pnpm vitest run src/lib/pdf                 # geometry, formatting, assets, layout invariants
pnpm vitest run src/lib/pdfSummary.test.ts  # the public entry point
```

To look at the output, render the fixtures in `src/lib/pdf/testFixtures.ts` and
rasterize with the `mupdf` dependency:

```ts
const page = mupdf.Document.openDocument(pdf, 'application/pdf').loadPage(0);
fs.writeFileSync('page1.png', page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true).asPNG());
```

### Two upstream traps worth knowing

Both cost real debugging time and are commented at the point of use:

1. **`lineHeight` is always a multiplier**, resolved against `fontSize` on the
   *same* style object (falling back to 18 when that object declares none).
   Writing the product instead produces leading taller than the page and the
   paginator spins forever. Always spread `typeStyle(size, multiple)`.
2. **An absolutely positioned node with a `render` prop cannot be measured.**
   The page-number footer is one, so it is anchored by `top` rather than
   `bottom` and must not use `alignItems: 'center'`; either produces a garbage
   coordinate that pdfkit rejects with "unsupported number".
3. **A `render`-prop subtree draws text and nothing else.** A `<Text>` inside
   one is dropped entirely if it declares a `lineHeight` — as a multiplier or
   as an absolute `'9.1pt'` — and an `<Image>` or a border in one never draws
   at all. Nothing fails loudly; the element is simply missing. This is why the
   running header is static and the page-1 cover band starts *below* it rather
   than suppressing it: the obvious `render={({pageNumber}) => pageNumber === 1
   ? null : <header/>}` costs the header its logo and its rule on every other
   page. Painting the band over the header instead is equally wrong — the text
   stays in the page's text layer, so selecting or searching page 1 turns up a
   title nobody can see.
