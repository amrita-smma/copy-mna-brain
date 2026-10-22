/**
 * Inline citations in bot replies. The bots are told to cite each external
 * fact right after it as a markdown link whose text is the source and its
 * publication date — `([Reuters, 12 Mar 2026](https://…))` — or "undated"
 * when the source gives none. The transcript turns such links into source
 * pills and flags a source older than `STALE_SOURCE_MONTHS`.
 *
 * Pure and client-safe.
 */

/**
 * How old a source may be before it is flagged as dated.
 * PENDING: the threshold is Nur's call (MB product decision); 12 months is a
 * placeholder until then. Changing it changes the bot prompt (re-pin
 * `src/lib/bots/prompt.test.ts`).
 */
export const STALE_SOURCE_MONTHS = 12;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface CitationLabel {
  source: string;
  /** The date as written ("12 Mar 2026"), or "undated". */
  dateText: string;
  /** The publication date (first of the month/year when that is all it gives); null when undated. */
  date: Date | null;
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

/** A written date → UTC date: "12 Mar 2026", "Mar 12, 2026", "Mar 2026", "2026-03-12", "2026". */
export function parseSourceDate(text: string): Date | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
  m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(t);
  if (m && monthIndex(m[2]) >= 0) return new Date(Date.UTC(Number(m[3]), monthIndex(m[2]), Number(m[1])));
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (m && monthIndex(m[1]) >= 0) return new Date(Date.UTC(Number(m[3]), monthIndex(m[1]), Number(m[2])));
  m = /^([A-Za-z]{3,9})\.? (\d{4})$/.exec(t);
  if (m && monthIndex(m[1]) >= 0) return new Date(Date.UTC(Number(m[2]), monthIndex(m[1]), 1));
  m = /^(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[1]), 0, 1));
  return null;
}

/**
 * A citation link's text split into source and date, or null when the link is
 * not a citation (ordinary links render as they always did). The date is
 * whatever follows the last comma; a trailing "· dated" from the model is
 * ignored — staleness is computed here, not trusted from the text.
 */
export function parseCitationLabel(text: string): CitationLabel | null {
  const cleaned = text.replace(/\s*·\s*dated\s*$/i, '').trim();
  const comma = cleaned.lastIndexOf(',');
  if (comma <= 0) return null;
  const source = cleaned.slice(0, comma).trim();
  const dateText = cleaned.slice(comma + 1).trim();
  if (!source || !dateText) return null;
  if (/^undated$/i.test(dateText)) return { source, dateText: 'undated', date: null };
  // "Reuters, Mar 12, 2026" has a comma inside its date: try the last two
  // segments together first, so the bare "2026" is not taken for the date.
  const prev = cleaned.lastIndexOf(',', comma - 1);
  if (prev > 0) {
    const wider = cleaned.slice(prev + 1).trim();
    const widerDate = parseSourceDate(wider);
    if (widerDate) return { source: cleaned.slice(0, prev).trim(), dateText: wider, date: widerDate };
  }
  const date = parseSourceDate(dateText);
  if (!date) return null;
  // "Smith, 2024" prose is not a dated citation; "Annual report, 2024" is.
  if (/^\d{4}$/.test(dateText) && !/[\s,]/.test(source)) return null;
  return { source, dateText, date };
}

/** Whether a source dated `date` is older than `months` at `now`. */
export function isStaleSource(date: Date, now: Date = new Date(), months: number = STALE_SOURCE_MONTHS): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return date.getTime() < cutoff.getTime();
}

/** A search result's raw publication date ("2026-03-12", an ISO timestamp…) as a label and a date. */
export function readPublishedDate(raw: string | null | undefined): { label: string; date: Date } | null {
  if (!raw) return null;
  const date = parseSourceDate(raw.slice(0, 10)) ?? (Number.isNaN(Date.parse(raw)) ? null : new Date(raw));
  if (!date) return null;
  const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { label, date };
}
