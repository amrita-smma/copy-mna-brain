/**
 * Font registration for the research-summary PDF.
 *
 * The previous renderer drew with `StandardFonts.Helvetica`, a WinAnsi-only
 * face, so it had to replace every codepoint above U+00FF with a literal `?`.
 * Inter is embedded and subset by fontkit instead, which covers Latin,
 * Latin Extended, the typographic punctuation the agent actually emits
 * (– — ' " … · • → ≥ ×), currency symbols and arrows — roughly 2,850
 * codepoints. CJK is still outside the face; see `normalizeTypography`.
 *
 * Registration is memoised because `@react-pdf/renderer` keeps one global font
 * store per process: re-registering the family on every render would discard
 * the parsed face a warm lambda has already paid for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Font } from '@react-pdf/renderer';

/**
 * The family name every stylesheet in `theme.ts` asks for.
 *
 * The fallback path registers Helvetica's faces *under this same name*, so a
 * missing font file changes the glyphs on the page and nothing else — no style
 * has to know which branch was taken.
 */
export const FONT_FAMILY = 'Inter';

const FACES: Array<{ file: string; fontWeight: 400 | 600 | 700 }> = [
  { file: 'Inter-Regular.ttf', fontWeight: 400 },
  { file: 'Inter-SemiBold.ttf', fontWeight: 600 },
  { file: 'Inter-Bold.ttf', fontWeight: 700 },
];

let registered: string | null = null;

/**
 * Register Inter and return the family name to render with.
 *
 * The files reach the deployed function through Next's output tracing, helped
 * along by an explicit `outputFileTracingIncludes` entry in `next.config.ts`.
 * If that ever regresses they are simply absent, so a missing face degrades to
 * Helvetica rather than failing the email. Helvetica cannot draw non-Latin-1
 * text, which is why the fallback is logged loudly.
 */
export function registerFonts(): string {
  if (registered) return registered;

  const dir = path.join(process.cwd(), 'public', 'fonts');
  try {
    // `Font.register` takes a path and opens it lazily inside the layout pass,
    // so a missing file would otherwise surface as a render-time throw that
    // loses the whole email. Probe first and fall back here instead.
    for (const face of FACES) {
      fs.accessSync(path.join(dir, face.file), fs.constants.R_OK);
    }
    Font.register({
      family: FONT_FAMILY,
      fonts: FACES.map((face) => ({
        src: path.join(dir, face.file),
        fontWeight: face.fontWeight,
      })),
    });
    // Inter ships no hyphenation dictionary; react-pdf's default callback
    // breaks words at unhelpful points inside tight table columns, so words
    // wrap whole and only an over-long one is broken by the layout engine's
    // own character fallback.
    Font.registerHyphenationCallback((word) => [word]);
    registered = FONT_FAMILY;
  } catch (err) {
    console.error(
      '[pdf] Inter not readable in public/fonts — falling back to Helvetica under the same family name. Non-Latin-1 text will not render.',
      err,
    );
    Font.register({
      family: FONT_FAMILY,
      fonts: [
        { src: 'Helvetica', fontWeight: 400 },
        { src: 'Helvetica-Bold', fontWeight: 600 },
        { src: 'Helvetica-Bold', fontWeight: 700 },
      ],
    });
    registered = FONT_FAMILY;
  }

  return registered;
}

/** Test seam: forget the memoised registration. */
export function resetFontsForTests(): void {
  registered = null;
}

const TYPOGRAPHY_REPLACEMENTS: Array<[RegExp, string]> = [
  // Normalise the several dash and quote codepoints an LLM mixes within one
  // document down to one each, so a table column does not change texture
  // row to row.
  [/[‘‚‛]/g, '’'],
  [/[„‟]/g, '“'],
  [/―/g, '—'],
  // Zero-width and bidi controls: invisible, but they survive into the PDF and
  // break text extraction and search.
  [/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ''],
  // Normalise newline variants; react-pdf honours \n inside <Text>.
  [/\r\n?/g, '\n'],
];

/**
 * Light-touch text normalisation.
 *
 * Unlike the `sanitizeForWinAnsi` it replaces, this deliberately does NOT
 * transliterate — Inter can draw the characters, so `é`, `—`, `≥` and `₹`
 * reach the page as themselves. Codepoints outside Inter (notably CJK) render
 * as blank; that is a font-coverage limitation, not something to paper over by
 * substituting `?`.
 */
export function normalizeTypography(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TYPOGRAPHY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}
