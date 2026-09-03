/**
 * ISO 639-1 code → English language name.
 *
 * Used in two places that must agree: the translation prompt sent to Haiku
 * ("Translate the text below from Japanese…" reads better to a model, and
 * scores better, than a bare `ja`) and the Data Navigator's translation
 * banner ("Translated from Japanese").
 *
 * Backed by `Intl.DisplayNames` rather than a hand-maintained map — the ICU
 * data ships with Node and the browser, covers every code the detector can
 * emit, and cannot drift out of date. Falls back to the raw code if the
 * runtime lacks the locale data, so an unusual environment degrades to
 * "Translated from ja" instead of throwing.
 */

/** Constructing `DisplayNames` is not free; there is exactly one locale here. */
let displayNames: Intl.DisplayNames | null | undefined;

export function languageLabel(code: string | null | undefined): string | null {
  const trimmed = code?.trim();
  if (!trimmed) return null;

  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      displayNames = null;
    }
  }

  try {
    return displayNames?.of(trimmed) ?? trimmed;
  } catch {
    // `of()` throws on a structurally invalid tag (e.g. a stray punctuation
    // mark), which a detector bug or a hand-edited row could produce.
    return trimmed;
  }
}
