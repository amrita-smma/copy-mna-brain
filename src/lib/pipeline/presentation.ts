/**
 * The Pipeline page's "Present" view: the companies the table is showing (its
 * stage tab, source, search and column filters, in its sort order), with the
 * columns the table has open — the same columns in the same order, as the user
 * arranged them; hidden columns and collapsed groups are left out. Laid out
 * as one table in the StarCapital slide template's table syntax.
 *
 * Client-safe and pure. The dialog renders `columns` + `rows` on screen; the
 * Download button posts the same `PipelinePresentation` to
 * `/api/pipeline/presentation/pptx`, which paginates it into slides
 * (`@/lib/pptx/pipelinePresentationPptx`). Cells are formatted here, once, so
 * the deck and the screen can never disagree.
 */
import { z } from 'zod';

export interface PresentationColumn {
  label: string;
  align: 'left' | 'right';
  /** Column width on the slide, in inches; the columns span `PRESENTATION_TABLE_WIDTH`. */
  width: number;
}

/** A table column as the Present view reads it: its header and its cell as text. */
export interface PresentationSourceColumn<C> {
  label: string;
  text: (row: C) => string;
  align?: 'left' | 'right';
}

/** The fields of a pipeline row the pinned Company column reads. */
export interface PresentationCompany {
  target: string;
  project_name: string | null;
}

export interface PipelinePresentation {
  title: string;
  /** What the table is scoped to, e.g. "L1 · Inbound · 24 companies". */
  subtitle: string;
  columns: PresentationColumn[];
  /** One row per company, one string per column. */
  rows: string[][];
}

/** The slide table's width, in inches: the template's content area. */
export const PRESENTATION_TABLE_WIDTH = 12.77;
/** The leading row-number column. */
const NO_WIDTH = 0.45;

const EMPTY = '—';

function companyName(c: PresentationCompany): string {
  const target = c.target.trim();
  const project = c.project_name?.trim();
  if (target && project && project !== target) return `${target} (${project})`;
  return target || project || 'Unknown';
}

/**
 * Relative width of a column, in characters, from how much it holds: its
 * typical long cell (75th-percentile length, so one long remark doesn't starve
 * the rest) or its header — counted short, since a header may wrap onto a
 * second line, but never narrower than its longest word in bold, so no word
 * breaks mid-way. Plus one character of padding.
 */
function columnWeight(label: string, cells: string[]): number {
  const lengths = cells.map((c) => c.length).sort((a, b) => a - b);
  const p75 = lengths.length ? lengths[Math.floor((lengths.length - 1) * 0.75)] : 0;
  const longestWord = Math.max(0, ...label.split(/\s+/).map((w) => w.length));
  const header = Math.max(Math.ceil(label.length * 0.7), Math.ceil(longestWord * 1.15));
  return Math.min(40, Math.max(5, header, p75)) + 1;
}

/**
 * Widths in inches for the given weights, filling the table after the row
 * number; rounded to hundredths with the remainder on the widest column.
 */
function columnWidths(weights: number[]): number[] {
  const room = PRESENTATION_TABLE_WIDTH - NO_WIDTH;
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const widths = weights.map((w) => Math.floor((room * w * 100) / total) / 100);
  const widest = widths.indexOf(Math.max(...widths));
  const rest = room - widths.reduce((s, w) => s + w, 0);
  if (widest >= 0) widths[widest] = Math.round((widths[widest] + rest) * 100) / 100;
  return [NO_WIDTH, ...widths];
}

/**
 * Build the deck: a row number, the pinned Company column, then `columns` —
 * the table's open columns in display order.
 */
export function buildPipelinePresentation<C extends PresentationCompany>(
  companies: readonly C[],
  columns: readonly PresentationSourceColumn<C>[],
  opts: { title?: string; subtitle: string },
): PipelinePresentation {
  const sources: PresentationSourceColumn<C>[] = [
    { label: 'Company', text: companyName },
    ...columns,
  ];
  const cells = companies.map((c) => sources.map((col) => col.text(c)?.trim() || EMPTY));
  const widths = columnWidths(
    sources.map((col, i) => columnWeight(col.label, cells.map((row) => row[i]))),
  );
  return {
    title: opts.title ?? 'Pipeline Companies',
    subtitle: opts.subtitle,
    columns: [
      { label: 'No', align: 'left', width: widths[0] },
      ...sources.map((col, i) => ({
        label: col.label,
        align: col.align ?? 'left',
        width: widths[i + 1],
      })),
    ],
    rows: cells.map((row, i) => [String(i + 1), ...row]),
  };
}

/** Single-line rows that fill one slide; taller rows (wrapped cells) fit fewer. */
export const PRESENTATION_ROWS_PER_SLIDE = 12;

/** A deck past this many rows is refused rather than built (≈84 slides). */
export const PRESENTATION_MAX_ROWS = 1000;

/** The Download request body, validated server-side. */
export const pipelinePresentationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().max(400),
    columns: z
      .array(
        z.object({
          label: z.string().max(100),
          align: z.enum(['left', 'right']),
          width: z.number().positive().max(PRESENTATION_TABLE_WIDTH),
        }),
      )
      .min(1)
      .max(40),
    rows: z.array(z.array(z.string().max(2000))).max(PRESENTATION_MAX_ROWS),
  })
  .superRefine((deck, ctx) => {
    const columns = deck.columns ?? [];
    const width = columns.reduce((s, c) => s + (c.width ?? 0), 0);
    if (width > PRESENTATION_TABLE_WIDTH + 0.05) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Columns are wider than the slide' });
    }
    (deck.rows ?? []).forEach((row, i) => {
      if (row.length !== columns.length) {
        ctx.addIssue({ code: 'custom', path: ['rows', i], message: 'Row does not match the columns' });
      }
    });
  });
