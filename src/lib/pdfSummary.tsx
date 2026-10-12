/**
 * Research-summary PDF generation.
 *
 * This file is the public entrypoint only. The document is composed from a
 * flexible list of blocks (`SectionBlock`) and laid out by
 * `@react-pdf/renderer` under `src/lib/pdf/`:
 *
 *   - `pdf/types.ts`                  the block vocabulary (re-exported here)
 *   - `pdf/ResearchSummaryDocument`   page shell, running header/footer
 *   - `pdf/blocks/*`                  one component per block kind
 *   - `pdf/charts/*`                  pure chart geometry + its SVG renderer
 *
 * It previously drew onto `pdf-lib` pages at absolute coordinates with a single
 * downward cursor. Each block guessed its own height, several strings were
 * drawn with no wrapping at all, and fixed-width columns were never checked
 * against the text placed in them — which is why tables overlapped, labels ran
 * past the right margin, and KPI values were silently clipped to one line. A
 * real layout engine measures before it draws, so those failures are now
 * structurally unavailable rather than individually patched.
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { ResearchSummaryDocument } from './pdf/ResearchSummaryDocument';
import { registerFonts } from './pdf/fonts';
import { loadImages, loadLocalLogo } from './pdf/assets';
import { collectImageUrls, type ResearchSummaryPdfInput } from './pdf/types';

export type {
  PillTone,
  GaugeTone,
  PriorityTone,
  ChartAccent,
  ChartKind,
  HeadingLevel,
  PillInput,
  KpiInput,
  YearValueInput,
  GaugeInput,
  ScorecardRowInput,
  PriorityItemInput,
  QuadrantsInput,
  ChartSeriesInput,
  SectionBlock,
  ResearchSummaryPdfInput,
} from './pdf/types';

/**
 * Generate a research-summary PDF from a flexible list of section blocks and
 * return the raw bytes.
 *
 * Block kinds:
 *   - `heading` / `paragraph` / `bullets` — typography primitives
 *   - `kpi_cards`     — wrapping row of bordered tiles, optional per-card logo
 *   - `chart`         — bar / stacked_bar / line with axes and a legend, or
 *                       pie, drawn as a donut with the total in its hole and a
 *                       legend table of values, shares and proportional bars
 *   - `bar_chart`     — the older single-series bar block, folded onto `chart`
 *   - `callout`       — a boxed aside: an amber caveat or a navy takeaway panel
 *   - `image`         — a fetched image with an optional caption
 *   - `gauges`        — horizontal percentage bars with tone colour
 *   - `scorecard`     — table with pill verdicts and a repeating header row
 *   - `quadrants`     — generic 2x2 matrix with customisable axis labels
 *   - `priority_list` — coloured priority pill + description rows
 *
 * No section is mandatory; the caller composes whatever blocks fit the document
 * at hand. The same renderer drives M&A target evaluations, SWOT analyses,
 * daily market updates, sector deep-dives, geopolitical briefs, etc.
 *
 * Remote images are fetched once, up front and in parallel, before layout
 * begins — a slow or dead logo host costs that image, never the document.
 */
export async function generateResearchSummaryPdf(
  input: ResearchSummaryPdfInput,
): Promise<Buffer> {
  registerFonts();

  const images = await loadImages(collectImageUrls(input));
  const logo = loadLocalLogo();

  return renderToBuffer(
    <ResearchSummaryDocument input={input} images={images} logo={logo} />,
  );
}
