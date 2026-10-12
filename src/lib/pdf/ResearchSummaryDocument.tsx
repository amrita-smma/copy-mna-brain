/**
 * The research-summary document.
 *
 * One `<Page wrap>` holds every block; the layout engine decides where the
 * page breaks fall and each block declares its own break behaviour. The
 * running header and footer are `fixed`, which repeats them on every page the
 * content spills onto — including pages the author never knew would exist.
 *
 * Page 1 opens with a full-bleed navy cover band carrying the serif title,
 * which starts just below the running header rather than at the top of the
 * sheet — see `styles.coverBand` for why it does not displace the header.
 */
import { Document, Page, View, Text, Image } from '@react-pdf/renderer';
import { styles } from './theme';
import { normalizeTypography } from './fonts';
import type { ImageCache } from './assets';
import type { ResearchSummaryPdfInput, SectionBlock } from './types';
import { Block } from './blocks';
import { References } from './blocks/text';
import { SectionHeading } from './blocks/primitives';

/** The wordmark printed opposite the title, on the cover and in every header. */
const BRAND = 'Investment Brain';

export interface ResearchSummaryDocumentProps {
  input: ResearchSummaryPdfInput;
  images: ImageCache;
  /** App logo bytes for the running header; omitted when unavailable. */
  logo?: Buffer;
}

/**
 * Normalise every string a block carries.
 *
 * Done once here rather than inside each component so no block can forget: the
 * previous renderer routed some strings through `sanitizeForWinAnsi` and drew
 * others raw.
 */
function normalizeBlock(block: SectionBlock): SectionBlock {
  const t = normalizeTypography;
  switch (block.kind) {
    case 'heading':
      return { ...block, text: t(block.text) };
    case 'paragraph':
      return { ...block, text: t(block.text) };
    case 'bullets':
      return { ...block, items: block.items.map(t) };
    case 'kpi_cards':
      return {
        ...block,
        cards: block.cards.map((c) => ({
          ...c,
          label: t(c.label),
          value: t(c.value),
          hint: c.hint ? t(c.hint) : undefined,
        })),
      };
    case 'bar_chart':
      return {
        ...block,
        title: block.title ? t(block.title) : undefined,
        data: block.data.map((d) => ({ ...d, year: t(d.year) })),
      };
    case 'chart':
      return {
        ...block,
        title: block.title ? t(block.title) : undefined,
        categories: block.categories.map(t),
        series: block.series.map((s) => ({ ...s, name: t(s.name) })),
      };
    case 'callout':
      return {
        ...block,
        title: block.title ? t(block.title) : undefined,
        text: block.text ? t(block.text) : undefined,
        items: block.items?.map(t),
      };
    case 'image':
      return { ...block, caption: block.caption ? t(block.caption) : undefined };
    case 'gauges':
      return {
        ...block,
        gauges: block.gauges.map((g) => ({
          ...g,
          label: t(g.label),
          trendLabel: g.trendLabel ? t(g.trendLabel) : undefined,
        })),
      };
    case 'scorecard':
      return {
        ...block,
        rows: block.rows.map((r) => ({
          ...r,
          label: t(r.label),
          rationale: t(r.rationale),
          pill: { ...r.pill, label: t(r.pill.label) },
        })),
        overallPill: block.overallPill
          ? { ...block.overallPill, label: t(block.overallPill.label) }
          : undefined,
        overallNote: block.overallNote ? t(block.overallNote) : undefined,
      };
    case 'quadrants':
      return {
        ...block,
        quadrants: {
          ...block.quadrants,
          topLeft: block.quadrants.topLeft.map(t),
          topRight: block.quadrants.topRight.map(t),
          bottomLeft: block.quadrants.bottomLeft.map(t),
          bottomRight: block.quadrants.bottomRight.map(t),
        },
      };
    case 'priority_list':
      return {
        ...block,
        items: block.items.map((i) => ({
          ...i,
          description: t(i.description),
          meta: i.meta ? t(i.meta) : undefined,
          priority: { ...i.priority, label: t(i.priority.label) },
        })),
      };
    default:
      return block;
  }
}

export function ResearchSummaryDocument({ input, images, logo }: ResearchSummaryDocumentProps) {
  const title = normalizeTypography(input.title);
  const subtitle = input.subtitle ? normalizeTypography(input.subtitle) : undefined;
  const sections = (input.sections ?? []).map(normalizeBlock);

  return (
    <Document title={title} creator="Investment Brain" producer="Investment Brain">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              {logo ? <Image src={logo} style={styles.headerLogo} /> : null}
              <Text style={styles.headerTitle}>{title}</Text>
            </View>
            <Text style={styles.headerRight}>{BRAND}</Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{subtitle ?? ' '}</Text>
          <Text
            style={styles.footerPage}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>

        <View style={styles.coverBand}>
          <Text style={styles.coverTitle}>{title}</Text>
          {subtitle ? <Text style={styles.coverSubtitle}>{subtitle}</Text> : null}
          <View style={styles.coverRule} />
        </View>

        {sections.map((block, i) => (
          <Block key={`${block.kind}-${i}`} block={block} images={images} />
        ))}

        {input.references && input.references.length > 0 ? (
          <>
            <SectionHeading text="Sources" level="section" />
            <References
              references={input.references.map((r) => ({
                ...r,
                name: normalizeTypography(r.name),
              }))}
            />
          </>
        ) : null}
      </Page>
    </Document>
  );
}
