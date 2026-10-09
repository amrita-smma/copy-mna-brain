/**
 * Reads back the geometry of a rendered PDF.
 *
 * The point of this module is that "the text does not overlap and does not run
 * off the page" is checkable rather than eyeballed. It extracts every drawn
 * text line with its bounding box via MuPDF's structured text, so the layout
 * regression tests can assert the two invariants the previous renderer broke:
 * everything inside the content box, and no two lines on top of each other.
 *
 * Used by tests only; it is kept beside the renderer rather than in a test file
 * because several test files assert against it.
 */
import * as mupdf from 'mupdf';
import { PAGE } from './theme';

export interface TextLine {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/**
 * Every text line drawn in the document, in page order.
 *
 * Built from MuPDF's character walk rather than its JSON line boxes, because a
 * line box includes the advance width of the space the line wrapped on — about
 * two points of invisible ink that would otherwise read as a margin overrun on
 * every wrapped line. Whitespace characters are skipped, so the box returned
 * here is the box of the visible glyphs.
 */
export function extractTextLines(pdf: Buffer): TextLine[] {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const out: TextLine[] = [];
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      let current: {
        chars: string[];
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        size: number;
      } | null = null;

      const flush = () => {
        if (!current) return;
        const text = current.chars.join('').trim();
        if (text) {
          out.push({
            page: i + 1,
            text,
            x: current.minX,
            y: current.minY,
            width: current.maxX - current.minX,
            height: current.maxY - current.minY,
            fontSize: current.size,
          });
        }
        current = null;
      };

      page.toStructuredText().walk({
        beginLine() {
          flush();
          current = {
            chars: [],
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
            size: 0,
          };
        },
        endLine: flush,
        onChar(char: string, _origin: unknown, _font: unknown, size: number, quad: number[]) {
          if (!current) return;
          current.chars.push(char);
          current.size = Math.max(current.size, size);
          if (/\s/.test(char)) return;
          // A quad is four corner points, x then y, in reading order.
          for (let k = 0; k < quad.length; k += 2) {
            current.minX = Math.min(current.minX, quad[k]);
            current.maxX = Math.max(current.maxX, quad[k]);
            current.minY = Math.min(current.minY, quad[k + 1]);
            current.maxY = Math.max(current.maxY, quad[k + 1]);
          }
        },
      });
      flush();
    }
  } finally {
    doc.destroy?.();
  }
  return out;
}

export function pageCount(pdf: Buffer): number {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  try {
    return doc.countPages();
  } finally {
    doc.destroy?.();
  }
}

/**
 * Lines whose box crosses the page's printable area.
 *
 * A half-point tolerance absorbs glyph side-bearings: a glyph's ink can sit a
 * hair outside its advance box without that being a layout defect.
 *
 * The vertical bound here is the physical page, because the running header and
 * footer legitimately sit outside the content band. Use
 * {@link linesOutsideBodyBand} for the stricter check on body content.
 */
export function linesOutsideContentBox(lines: TextLine[], tolerance = 0.5): TextLine[] {
  const left = PAGE.marginX - tolerance;
  const right = PAGE.width - PAGE.marginX + tolerance;
  return lines.filter(
    (line) =>
      line.x < left ||
      line.x + line.width > right ||
      line.y < 0 ||
      line.y + line.height > PAGE.height,
  );
}

/**
 * Body lines that intrude into the band reserved for the running header or
 * footer.
 *
 * The caller supplies the header/footer text so those lines can be excluded —
 * they are the only content allowed in those bands, and they are what a naive
 * margin check would mistake for a violation.
 */
export function linesOutsideBodyBand(
  lines: TextLine[],
  chromeText: Set<string>,
  tolerance = 0.5,
): TextLine[] {
  const top = PAGE.marginTop - tolerance;
  const bottom = PAGE.height - PAGE.marginBottom + tolerance;
  return lines.filter(
    (line) =>
      !chromeText.has(line.text) &&
      !/^\d+ \/ \d+$/.test(line.text) &&
      (line.y < top || line.y + line.height > bottom),
  );
}

export interface Collision {
  a: TextLine;
  b: TextLine;
}

/**
 * Pairs of lines that occupy the same space.
 *
 * Two lines collide when they share most of their vertical extent *and* their
 * horizontal extents intersect by more than a hairline. Sharing a baseline
 * across two table columns is not a collision — that is what the horizontal
 * test excludes — but a verdict pill printed through a notes column is.
 */
export function findCollisions(lines: TextLine[], minOverlap = 1): Collision[] {
  const collisions: Collision[] = [];
  const byPage = new Map<number, TextLine[]>();
  for (const line of lines) {
    const bucket = byPage.get(line.page);
    if (bucket) bucket.push(line);
    else byPage.set(line.page, [line]);
  }

  for (const pageLines of byPage.values()) {
    const sorted = [...pageLines].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        // Sorted by y, so once b starts below a's bottom nothing later can overlap.
        if (b.y >= a.y + a.height) break;
        const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (vertical < Math.min(a.height, b.height) * 0.5) continue;
        const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        if (horizontal > minOverlap) collisions.push({ a, b });
      }
    }
  }
  return collisions;
}

/** Compact one-line description of a line, for assertion messages. */
export function describe(line: TextLine): string {
  return `p${line.page} [${line.x.toFixed(1)},${line.y.toFixed(1)} ${line.width.toFixed(1)}x${line.height.toFixed(1)}] ${JSON.stringify(line.text.slice(0, 48))}`;
}
