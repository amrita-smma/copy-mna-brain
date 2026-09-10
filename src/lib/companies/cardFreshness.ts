import type { Tables } from '@/lib/repositories';

/**
 * Company Card freshness / conflict resolution.
 *
 * A Company Card is a point-in-time research artefact: `company_analyses.created_at`
 * records when its content was produced (there is one row per company, and the
 * completion write re-stamps it on every run). A company's documents (deal
 * documents and matched Smart Files) each carry their own date. When a card is
 * regenerated — e.g. on a pipeline stage move — those two timelines can
 * disagree: a file uploaded after the card was written may contradict what the
 * card says, or the card may already reflect research that postdates an old
 * document.
 *
 * The rule this module encodes and hands to the agent is simply: **the more
 * recently dated source wins.** Documents dated after the card's timestamp
 * override the existing card; documents dated before it lose to the card's
 * existing content unless they add something the card never covered.
 *
 * The `generatedAt` argument threaded through this module is that timestamp —
 * named for the role it plays, not for the column it comes from.
 *
 * Everything here is pure so it can be unit-tested without a DB or an agent.
 */

/** The six narrative sections that make up a Company Card's content. */
const CARD_SECTION_KEYS = [
  'business_overview',
  'business_model_summary',
  'key_takeaways',
  'investment_highlights',
  'investment_risks',
  'diligence_priorities',
] as const;

/** The subset of a `company_analyses` row that carries card content. */
export type CardContent = Pick<
  Tables<'company_analyses'>,
  (typeof CARD_SECTION_KEYS)[number]
>;

/**
 * Whether a `company_analyses` row actually holds a card, i.e. at least one
 * populated section.
 *
 * The row's timestamp cannot answer this on its own: `created_at` defaults to
 * NOW() on the `status: 'processing'` insert that opens every run, so a first
 * run that failed leaves a dated row with no content at all. Treating that as a
 * prior card would inline an empty card into the next run's prompt and let its
 * processing-start timestamp win conflicts against genuinely older documents.
 */
export function hasCardContent(card: CardContent | null | undefined): boolean {
  if (!card) return false;
  return CARD_SECTION_KEYS.some((key) => card[key]?.trim());
}

/** Which table a source document came from. */
export type CardSourceKind = 'deal_document' | 'file';

/** A dated piece of source material a Company Card should be built from. */
export interface CardSourceDocument {
  kind: CardSourceKind;
  id: string;
  name: string;
  /**
   * The date the document's information is *as of*, ISO-8601. Null when the
   * document carries no usable date at all — such a document can never win a
   * conflict, because we cannot show it is newer.
   */
  date: string | null;
  /** Stage (deal documents) or file type (files); shown to the agent as context. */
  label: string | null;
  /** Extracted notes/content, already truncated for prompt use. */
  content: string | null;
}

/** Max characters of extracted content included per document in the prompt. */
export const MAX_SOURCE_CONTENT_CHARS = 4000;
/** Max documents listed in the prompt, newest first. */
export const MAX_SOURCES_IN_PROMPT = 25;

/** A bare calendar date with no time component, e.g. `files.file_date`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date as a comparable instant. A date-only value (`files.file_date` is a
 * `date` column) lands at midnight UTC — its best point estimate.
 *
 * This is the ordering clock: it ranks sources against each other. Using the
 * end of the day here would be wrong, because a file dated `2026-03-01` would
 * then outrank a deal document actually created at `2026-03-01T22:00Z`,
 * inverting "the later-dated source wins" among the company's own documents.
 */
function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * The latest instant a date could refer to: a date-only value covers its whole
 * day, so it resolves to that day's end.
 *
 * This is the clock for "could this document hold something the card doesn't?",
 * where an optimistic bound is the safe direction. A file dated today must not
 * lose to a card generated at 09:00 this morning just because a `date` column
 * has no time — the file was uploaded afterwards. Deciding it the other way
 * silently drops the newer document's information.
 */
function parseUpperBoundTime(value: string | null | undefined): number | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T23:59:59.999Z`).getTime();
  }
  return parseTime(value);
}

function truncate(value: string | null | undefined, max = MAX_SOURCE_CONTENT_CHARS): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}… [truncated]` : trimmed;
}

/**
 * A deal document as a card source. Deal documents only record `created_at`
 * (when they were attached), so that is their effective date.
 */
export function dealDocumentToSource(doc: Tables<'deal_documents'>): CardSourceDocument {
  return {
    kind: 'deal_document',
    id: doc.id,
    name: doc.file_name,
    date: doc.created_at ?? null,
    label: doc.stage ? `stage ${doc.stage}` : null,
    content: truncate(doc.structured_notes ?? doc.raw_notes),
  };
}

/**
 * A matched Smart File as a card source. `file_date` is the document's business
 * date (the "as of" date a banker's MoM or prospectus carries) and is the
 * correct thing to date-rank on; `created_at` (upload time) is the fallback
 * when the extractor found no date.
 */
export function fileToSource(file: Tables<'files'>): CardSourceDocument {
  return {
    kind: 'file',
    id: file.id,
    name: file.file_name,
    date: file.file_date ?? file.created_at ?? null,
    label: file.file_type || null,
    content: truncate(file.structured_notes ?? file.raw_notes),
  };
}

/** Sources sorted newest-dated first; undated documents sort last. */
export function sortSourcesByDateDesc(sources: CardSourceDocument[]): CardSourceDocument[] {
  return [...sources].sort((a, b) => {
    const at = parseTime(a.date);
    const bt = parseTime(b.date);
    if (at === bt) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  });
}

/** The most recent date across all sources, or null when none are dated. */
export function latestSourceDate(sources: CardSourceDocument[]): string | null {
  let best: { time: number; date: string } | null = null;
  for (const source of sources) {
    const time = parseTime(source.date);
    if (time === null) continue;
    if (!best || time > best.time) best = { time, date: source.date as string };
  }
  return best?.date ?? null;
}

/** Sources dated strictly after `generatedAt`. With no card yet, every dated
 * source counts as newer — there is nothing for it to lose a conflict to. */
export function sourcesNewerThanCard(
  sources: CardSourceDocument[],
  generatedAt: string | null | undefined,
): CardSourceDocument[] {
  const cardTime = parseTime(generatedAt);
  if (cardTime === null) return sources.filter((s) => parseTime(s.date) !== null);
  // Upper bound against the card only — see parseUpperBoundTime.
  return sources.filter((s) => {
    const time = parseUpperBoundTime(s.date);
    return time !== null && time > cardTime;
  });
}

/**
 * Whether the card's content predates at least one of the company's documents,
 * i.e. regeneration could genuinely change the card. A company with no card at
 * all is stale by definition.
 */
export function isCardStale(
  sources: CardSourceDocument[],
  generatedAt: string | null | undefined,
): boolean {
  if (!parseTime(generatedAt)) return true;
  return sourcesNewerThanCard(sources, generatedAt).length > 0;
}

function formatDate(date: string | null): string {
  const time = parseTime(date);
  if (time === null) return 'undated';
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The prompt block that tells the agent what the previous card said, how old it
 * is, which documents postdate it, and how to break a conflict. Returns an
 * empty string when there is neither a previous card nor any source document,
 * so a first-time generation prompt stays unchanged.
 */
export function buildSourceFreshnessContext(input: {
  sources: CardSourceDocument[];
  generatedAt: string | null | undefined;
  previousCard?: CardContent | null;
}): string {
  const sources = sortSourcesByDateDesc(input.sources).slice(0, MAX_SOURCES_IN_PROMPT);
  const generatedAt = input.generatedAt ?? null;
  const hasCard = parseTime(generatedAt) !== null;

  if (!hasCard && sources.length === 0) return '';

  const newer = new Set(sourcesNewerThanCard(sources, generatedAt).map((s) => s.id));
  const lines: string[] = [];

  lines.push('## Existing Card & Source Freshness');
  lines.push('');

  if (hasCard) {
    lines.push(
      `The existing Company Card content was generated on **${formatDate(generatedAt)}** (\`${generatedAt}\`).`,
    );
  } else {
    lines.push('There is no previously generated Company Card content for this company.');
  }
  lines.push('');

  lines.push('### Conflict resolution rule (strict)');
  lines.push(
    '- Every source below is dated. **When two sources disagree on a fact, the one with the later date wins** — treat its value as current and the older one as superseded.',
  );
  if (hasCard) {
    lines.push(
      `- The existing card's date is **${formatDate(generatedAt)}**. A document dated AFTER that date overrides what the card says. A document dated BEFORE it does not — keep the card's version of that fact, and use the older document only for points the card does not cover.`,
    );
  }
  lines.push(
    '- An **undated** document can never win a conflict: use it only for facts no dated source contradicts.',
  );
  lines.push(
    '- When a superseded figure still matters (e.g. a revised revenue number), state the current value and note that it was revised, with both dates.',
  );
  lines.push(
    '- Carry forward anything in the existing card that no newer source contradicts. Regeneration must not silently drop still-valid findings.',
  );
  lines.push('');

  if (sources.length > 0) {
    lines.push('### Company documents (newest first)');
    lines.push('');
    for (const source of sources) {
      const kind = source.kind === 'deal_document' ? 'Deal document' : 'File';
      const label = source.label ? `, ${source.label}` : '';
      const recency = hasCard
        ? newer.has(source.id)
          ? ' — **NEWER than the existing card: overrides it on conflict**'
          : ' — older than the existing card: the card wins on conflict'
        : '';
      lines.push(`#### ${kind}: ${source.name} (${formatDate(source.date)}${label})${recency}`);
      lines.push(source.content ?? '_No extracted content available; treat as a pointer only._');
      lines.push('');
    }
  } else {
    lines.push('### Company documents');
    lines.push('No deal documents or matched files are on record for this company.');
    lines.push('');
  }

  const card = input.previousCard;
  if (hasCard && card) {
    const sections: Array<[string, string | null]> = [
      ['Business Overview', card.business_overview],
      ['Business Model & Value Chain Summary', card.business_model_summary],
      ['Key Takeaways', card.key_takeaways],
      ['Investment Highlights', card.investment_highlights],
      ['Investment Risks', card.investment_risks],
      ['Diligence Priorities', card.diligence_priorities],
    ];

    const populated = sections.filter(([, value]) => value?.trim());
    if (populated.length > 0) {
      lines.push(`### Existing card content (as of ${formatDate(generatedAt)})`);
      lines.push('');
      for (const [title, value] of populated) {
        lines.push(`#### ${title}`);
        lines.push(truncate(value) ?? '');
        lines.push('');
      }
    }
  }

  return lines.join('\n').trimEnd();
}
