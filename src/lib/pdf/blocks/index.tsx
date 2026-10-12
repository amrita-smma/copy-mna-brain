/**
 * Dispatch one `SectionBlock` onto its component.
 *
 * The switch is exhaustive over the union, so adding a block kind to
 * `types.ts` without rendering it is a type error rather than a silently blank
 * section.
 */
import { FIGURE_WIDTH } from '../theme';
import type { ImageCache } from '../assets';
import type { SectionBlock } from '../types';
import type { ChartSpec } from '../charts/geometry';
import { Chart } from '../charts/Chart';
import { Bullets, Paragraph } from './text';
import { SectionHeading } from './primitives';
import { KpiCards } from './KpiCards';
import { Gauges } from './Gauges';
import { Callout } from './Callout';
import { Scorecard } from './Scorecard';
import { Quadrants } from './Quadrants';
import { PriorityList } from './PriorityList';
import { ImageBlock } from './ImageBlock';

const CHART_HEIGHT = 160;
/**
 * The donut's box is square and claims only its share of the figure card —
 * the legend table beside it takes the rest. Stretching the ring to the full
 * width would only add white space around it.
 */
const DONUT_SIZE = 150;

/**
 * Normalise both chart block kinds onto one spec.
 *
 * `bar_chart` predates `chart` and is still in the agent's vocabulary; it is a
 * single-series bar chart whose `accent` chose between two fixed colours. That
 * maps onto series slot 0 or 1.
 */
export function toChartSpec(
  block: Extract<SectionBlock, { kind: 'bar_chart' | 'chart' }>,
): { spec: ChartSpec; accentOffset: number } {
  if (block.kind === 'chart') {
    return {
      spec: {
        type: block.type,
        categories: block.categories,
        series: block.series,
        unit: block.unit,
      },
      accentOffset: 0,
    };
  }
  return {
    spec: {
      type: 'bar',
      categories: block.data.map((d) => d.year),
      series: [{ name: block.title ?? 'Value', values: block.data.map((d) => d.value) }],
      unit: block.unit,
    },
    accentOffset: block.accent === 'secondary' ? 1 : 0,
  };
}

export function Block({ block, images }: { block: SectionBlock; images: ImageCache }) {
  switch (block.kind) {
    case 'heading':
      return <SectionHeading text={block.text} level={block.level ?? 'section'} />;
    case 'paragraph':
      return <Paragraph text={block.text} />;
    case 'bullets':
      return <Bullets items={block.items} />;
    case 'kpi_cards':
      return <KpiCards cards={block.cards} images={images} />;
    case 'bar_chart':
    case 'chart': {
      const { spec, accentOffset } = toChartSpec(block);
      const isPie = spec.type === 'pie';
      return (
        <Chart
          spec={spec}
          width={isPie ? DONUT_SIZE : FIGURE_WIDTH}
          height={isPie ? DONUT_SIZE : CHART_HEIGHT}
          title={block.title}
          colorOffset={accentOffset}
        />
      );
    }
    case 'callout':
      return (
        <Callout tone={block.tone} title={block.title} text={block.text} items={block.items} />
      );
    case 'image':
      return (
        <ImageBlock
          url={block.url}
          caption={block.caption}
          maxHeight={block.maxHeight}
          images={images}
        />
      );
    case 'gauges':
      return <Gauges gauges={block.gauges} />;
    case 'scorecard':
      return (
        <Scorecard
          rows={block.rows}
          overallPill={block.overallPill}
          overallNote={block.overallNote}
          columns={block.columns}
          images={images}
        />
      );
    case 'quadrants':
      return <Quadrants quadrants={block.quadrants} />;
    case 'priority_list':
      return <PriorityList items={block.items} />;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}
