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

/** "profile updated May 2026" → May 2026: a date phrase that ends in a full date. */
function trailingDateOf(text: string): Date | null {
  const m = /(?:^|\s)((?:\d{1,2} )?[A-Za-z]{3,9}\.? (?:\d{1,2},? )?\d{4})$/.exec(text);
  return m && /[A-Za-z]/.test(text.slice(0, m.index)) ? parseSourceDate(m[1]) : null;
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
  const date = parseSourceDate(dateText) ?? trailingDateOf(dateText);
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

/** One source in a citation group, as the transcript draws it. */
export interface CitationSource {
  source: string;
  dateText: string;
  /** ISO date, or null when undated. A string so it survives the hast round trip. */
  date: string | null;
  url: string;
  /** The article's headline (the link's markdown title), else the URL's host. */
  title: string;
}

/** The hast property a citation group's sources travel in, as JSON. */
export const CITATION_GROUP_PROP = 'dataCitations';

/** A URL's host without "www.", or the URL itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Reads a citation group's sources back out of its hast property; [] when malformed. */
export function readCitationGroup(raw: unknown): CitationSource[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CitationSource[]) : [];
  } catch {
    return [];
  }
}

// Just the mdast shapes the grouping touches; the remark types are not a
// direct dependency.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

function textOf(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function citationOf(node: MdNode): CitationSource | null {
  if (node.type !== 'link' || !node.url) return null;
  const label = parseCitationLabel(textOf(node));
  if (!label) return null;
  return {
    source: label.source,
    dateText: label.dateText,
    date: label.date ? label.date.toISOString() : null,
    url: node.url,
    title: node.title?.trim() || hostOf(node.url),
  };
}

/** Text that may sit between two citations of one run: spaces, commas, semicolons, parentheses. */
const SEPARATOR_RE = /^[\s,;()]*$/;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * `[Claim text (Source, 12 Mar 2026)](url)` — the claim wrapped into the
 * citation link — splits into the claim as text and the citation as a link.
 */
function splitWrappedCitation(node: MdNode): MdNode[] {
  if (node.type !== 'link' || !node.url || node.children?.length !== 1 || node.children[0].type !== 'text') return [node];
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(node.children[0].value ?? '');
  if (!m || !parseCitationLabel(m[2])) return [node];
  return [
    { type: 'text', value: `${m[1]} ` },
    { ...node, children: [{ type: 'text', value: m[2] }] },
  ];
}

function groupRuns(parent: MdNode): void {
  if (!parent.children) return;
  const kids = parent.children.flatMap(splitWrappedCitation);
  const out: MdNode[] = [];
  let i = 0;
  while (i < kids.length) {
    const first = citationOf(kids[i]);
    if (!first) {
      groupRuns(kids[i]);
      out.push(kids[i]);
      i++;
      continue;
    }
    // Extend the run over further citations and the bare separators between them.
    const sources = [first];
    let last = i;
    let separators = '';
    let j = i + 1;
    while (j < kids.length) {
      const node = kids[j];
      const cite = citationOf(node);
      if (cite) {
        sources.push(cite);
        last = j;
      } else if (node.type === 'text' && SEPARATOR_RE.test(node.value ?? '')) {
        // Only separators between two citations belong to the run.
        if (citationOf(kids[j + 1] ?? { type: '' })) separators += node.value ?? '';
        else break;
      } else {
        break;
      }
      j++;
    }

    // "fact ([A](u))." → "fact" + group + ".": drop the parentheses that only
    // wrapped the run, never one that belongs to the prose.
    const prev = out[out.length - 1];
    const next = kids[last + 1];
    const opensBefore = prev?.type === 'text' && /\(\s*$/.test(prev.value ?? '');
    const balance = (opensBefore ? 1 : 0) + count(separators, '(') - count(separators, ')');
    if (opensBefore && balance === 1 && next?.type === 'text' && /^\s*\)/.test(next.value ?? '')) {
      prev.value = (prev.value ?? '').replace(/\s*\(\s*$/, '');
      next.value = (next.value ?? '').replace(/^\s*\)/, '');
    } else if (prev?.type === 'text') {
      prev.value = (prev.value ?? '').replace(/\s+$/, '');
    }

    const unique = sources.filter((s, k) => sources.findIndex((o) => o.url === s.url) === k);
    out.push({
      type: 'citationGroup',
      data: { hName: 'cite', hProperties: { [CITATION_GROUP_PROP]: JSON.stringify(unique) } },
    });
    i = last + 1;
  }
  parent.children = out;
}

/**
 * Remark plugin: each run of adjacent citation links — `([A, date](u1));
 * ([B, date](u2))` — becomes one `<cite>` carrying its sources as JSON, which
 * the transcript draws as a single source chip ("A +1") with a hover card.
 * Parentheses that only wrapped the run go with it. Ordinary links, and link
 * text that is not "Source, date", are left alone.
 */
export function remarkCitationGroups() {
  return (tree: MdNode) => groupRuns(tree);
}

/** A source for the "Sources" strip under an answer. */
export interface SourceRef {
  title: string;
  url: string;
  /** Publication date as "YYYY-MM-DD", when the citation gives one. */
  published?: string;
}

const MARKDOWN_LINK_RE = /\[([^[\]]+)\]\((\S+?)(?:\s+"([^"]*)")?\)/g;

/**
 * The sources an answer cites inline, in order and once each. Search tools
 * that run on Anthropic's side (web_search) never reach the transcript as tool
 * output, so for those turns the answer's own citations are the only list of
 * what it read.
 */
export function inlineCitationsOf(markdown: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const m of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const [, text, url, title] = m;
    // "[Claim (Source, date)](url)" cites its parenthetical, as the renderer reads it.
    const label = parseCitationLabel(text) ?? parseCitationLabel(/\(([^()]+)\)$/.exec(text)?.[1] ?? '');
    if (!label || out.some((s) => s.url === url)) continue;
    out.push({
      title: title?.trim() || hostOf(url),
      url,
      ...(label.date ? { published: label.date.toISOString().slice(0, 10) } : {}),
    });
  }
  return out;
}
