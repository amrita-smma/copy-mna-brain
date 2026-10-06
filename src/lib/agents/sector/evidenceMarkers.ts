/**
 * The evidence-marker vocabulary shared by the agents' prompts, the CoPilot
 * chat renderer, the chat outline and the insight write tools (MB-542, MB-543,
 * MB-551, MB-556).
 *
 * A sector agent labels three kinds of statement so a reader can tell them
 * apart from a plain answer:
 *   - a **guardrail** — the request fell inside a declared data limit, so the
 *     agent states the limit instead of an estimate (MB-542);
 *   - an **Observed** / **Inferred** control-change finding (@dikti, MB-543);
 *   - a **Modelled** phase figure (@bangun, MB-542 AC5).
 *
 * Every agent (the general CoPilot included) also documents where each figure
 * in an insight came from, and marks the cells it could not fill:
 *   - a **source reference** `[S1]` right after a figure, resolving to an
 *     entry in the insight's **Sources** section (MB-551);
 *   - an **Unavailable** cell, carrying the reason, where the data sits behind
 *     a declared limit or no reachable source has it (MB-556).
 *
 * Each has a chat form (markdown, styled by the CoPilot renderer — see
 * `src/lib/chat/evidenceLabels.ts`) and an insight form (HTML). The insight
 * forms carry their own inline styles: an insight is static, self-contained
 * HTML that is exported, printed and shared outside the app frame, so a look
 * that depended on frame-injected CSS would be lost the moment it left.
 *
 * Deliberately import-free: the chat UI bundle, the insight service and the
 * agent prompts all import this, so it must not pull in LangChain, a parser or
 * the registry. The validator is a small start-tag scanner for that reason.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The attribute every insight evidence marker carries. */
export const EVIDENCE_ATTR = 'data-evidence';

export type EvidenceKind = 'data-limit' | 'observed' | 'inferred' | 'modelled' | 'unavailable';

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'data-limit',
  'observed',
  'inferred',
  'modelled',
  'unavailable',
];

/**
 * The only signals @dikti may call observed (US-04). The PRD's §4.1 limit
 * statement names three; US-04 adds the AHU filing, and US-04 governs.
 * `dikti/seed.ts` carries the same four as prose (`observedSignalTypes`);
 * a test pins the two lists to each other index for index.
 */
export const OBSERVED_SIGNAL_TYPES = ['decree', 'pddikti', 'newspaper', 'ahu'] as const;

export type ObservedSignalType = (typeof OBSERVED_SIGNAL_TYPES)[number];

export const OBSERVED_SIGNAL_TYPE_LABELS: Readonly<Record<ObservedSignalType, string>> = {
  decree: 'a ministerial decree',
  pddikti: 'a PDDikti badan penyelenggara field change',
  newspaper: 'a statutory newspaper announcement',
  ahu: 'an AHU filing',
};

export function isObservedSignalType(value: unknown): value is ObservedSignalType {
  return typeof value === 'string' && (OBSERVED_SIGNAL_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Chat (markdown) forms
// ---------------------------------------------------------------------------

/** The bold lead a guardrail paragraph opens with: `**Data limit:** …`. */
export const CHAT_DATA_LIMIT_LEAD = 'Data limit:';

/** The bold labels, exactly as written: `**Observed**`, `**Inferred**`, `**Modelled**`. */
export const CHAT_EVIDENCE_LABELS = {
  observed: 'Observed',
  inferred: 'Inferred',
  modelled: 'Modelled',
} as const;

export type ChatEvidenceLabel = keyof typeof CHAT_EVIDENCE_LABELS;

// ---------------------------------------------------------------------------
// Insight (HTML) forms
// ---------------------------------------------------------------------------

/*
 * Colours: each marker paints an opaque background with its own dark text, so
 * it reads the same on a light or a dark insight — nothing is transparent and
 * nothing inherits the document's text colour. Amber = limit, green = observed,
 * violet = inferred, blue = modelled.
 */
const PILL_BASE =
  'display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.75em;font-weight:600;line-height:1.5;letter-spacing:0.02em;white-space:nowrap;vertical-align:baseline';

export const EVIDENCE_STYLES = {
  'data-limit':
    'display:block;margin:12px 0;padding:10px 14px;border:1px solid #d97706;border-left:4px solid #d97706;border-radius:6px;background:#fffbeb;color:#78350f;font-size:0.95em;line-height:1.5',
  'data-limit-lead': 'color:#78350f;font-weight:700',
  observed: `${PILL_BASE};border:1px solid #15803d;background:#dcfce7;color:#14532d`,
  inferred: `${PILL_BASE};border:1px solid #6d28d9;background:#ede9fe;color:#4c1d95`,
  modelled: `${PILL_BASE};border:1px solid #1d4ed8;background:#dbeafe;color:#1e3a8a`,
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A guardrail block: `<aside data-evidence="data-limit" data-limit-id="…">`. */
export function dataLimitMarkerHtml(limitId: string, statement: string): string {
  return `<aside data-evidence="data-limit" data-limit-id="${escapeHtml(limitId)}" style="${EVIDENCE_STYLES['data-limit']}"><strong style="${EVIDENCE_STYLES['data-limit-lead']}">Data limit:</strong> ${escapeHtml(statement)}</aside>`;
}

/** An Observed pill naming which of the four signal types it is. */
export function observedMarkerHtml(signalType: ObservedSignalType): string {
  return `<span data-evidence="observed" data-signal-type="${signalType}" style="${EVIDENCE_STYLES.observed}">Observed</span>`;
}

/** An Inferred pill carrying the observed signals it was built from. */
export function inferredMarkerHtml(basedOn: string): string {
  return `<span data-evidence="inferred" data-based-on="${escapeHtml(basedOn)}" style="${EVIDENCE_STYLES.inferred}">Inferred</span>`;
}

/** A Modelled pill. */
export const MODELLED_MARKER_HTML = `<span data-evidence="modelled" style="${EVIDENCE_STYLES.modelled}">Modelled</span>`;

// ---------------------------------------------------------------------------
// Prompt fragments (teach the insight forms; the chat wording lives in the
// sector prompts themselves)
// ---------------------------------------------------------------------------

// The placeholders the prompt snippets carry. A snippet pasted without filling
// them in is malformed: an Inferred pill "based on SIGNALS" names nothing.
const BASED_ON_PLACEHOLDER = 'SIGNALS';
const LIMIT_ID_PLACEHOLDER = 'LIMIT_ID';

const SIGNAL_TYPE_CODES = OBSERVED_SIGNAL_TYPES.map(
  (t) => `\`${t}\` (${OBSERVED_SIGNAL_TYPE_LABELS[t]})`,
).join(', ');

/** For every sector agent, appended to the declared-data-limits rules. */
export const INSIGHT_DATA_LIMIT_MARKER_GUIDE = `Inside an insight, write a guardrail as this block — copy it exactly, styles included, so it stays distinct from an answer when the insight is exported or shared — with the limit's id from the list above and its statement:

\`\`\`html
${dataLimitMarkerHtml(LIMIT_ID_PLACEHOLDER, 'STATEMENT')}
\`\`\``;

/** For @dikti, appended to the observed-versus-inferred rule. */
export const INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE = `Inside an insight, write each label as one of these pills — copy them exactly, styles included — next to the finding it classifies:

\`\`\`html
${observedMarkerHtml('decree')}
${inferredMarkerHtml(BASED_ON_PLACEHOLDER)} from: ${BASED_ON_PLACEHOLDER}
\`\`\`

- \`data-signal-type\` must be one of ${SIGNAL_TYPE_CODES}. A signal that is none of these is not observed.
- \`data-based-on\` names the observed signals the inference was built from (e.g. the decree number and the PDDikti change date), and the same signals follow the pill as visible text after "from:". Never leave it empty, and never put a double quote inside it.
- An insight write with a malformed pill is refused and nothing is written; fix the pill and write again.`;

/** For @bangun, appended to the modelled-phase rule. */
export const INSIGHT_MODELLED_MARKER_GUIDE = `Inside an insight, put this pill next to every modelled phase figure — copy it exactly, styles included:

\`\`\`html
${MODELLED_MARKER_HTML}
\`\`\`

An observed phase figure carries its source citation (the filing, disclosure or deal it came from) instead of a pill.`;

// ---------------------------------------------------------------------------
// Sources and unavailable cells (MB-551, MB-556) — every agent
// ---------------------------------------------------------------------------

/** The attribute on a figure's reference: `<sup data-source-ref="S1">`. */
export const SOURCE_REF_ATTR = 'data-source-ref';
/** The attribute on a Sources entry: `<li data-source-id="S1">`. */
export const SOURCE_ID_ATTR = 'data-source-id';
/** The `data-section` key of the Sources section. */
export const SOURCES_SECTION_KEY = 'sources';

/**
 * What a source is: the open web, one of the research tools, the internal
 * record, or another insight.
 *
 * `alphasense` stays accepted even though AlphaSense is retired and no agent
 * can call it any more — insights written while the subscription was live
 * carry `data-source-kind="alphasense"`, and dropping it would make every one
 * of those documents fail validation on the next write. It is not offered to
 * the model: see `OFFERED_SOURCE_KINDS`.
 */
export const SOURCE_KINDS = ['web', 'alphasense', 'valyu', 'inven', 'internal', 'insight'] as const;

/**
 * The kinds the sources guide advertises — `SOURCE_KINDS` minus the retired
 * ones. Validation accepts the full list; the prompt names only these.
 */
export const OFFERED_SOURCE_KINDS = SOURCE_KINDS.filter((k) => k !== 'alphasense');

export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

/** A source id: `S` and a number from 1, e.g. `S1`, `S12`. */
const SOURCE_ID_RE = /^S[1-9]\d{0,3}$/;

export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ID_RE.test(value);
}

/** The only visible text an unavailable cell may carry. */
export const UNAVAILABLE_LABEL = 'Unavailable';

/*
 * Styles. The reference is text (a blue superscript), the Sources section and
 * the unavailable cell are surfaces with their own opaque background and dark
 * text, so they read the same on a light or a dark insight.
 */
export const SOURCE_STYLES = {
  ref: 'font-size:0.7em;line-height:0;vertical-align:super;font-weight:600;color:#1d4ed8;white-space:nowrap',
  section:
    'display:block;margin:24px 0 0;padding:12px 16px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;color:#0f172a;font-size:0.9em;line-height:1.5',
  heading: 'margin:0 0 8px;font-size:1.1em;font-weight:700;color:#0f172a',
  list: 'margin:0;padding-left:1.5em',
  entry: 'margin:4px 0',
  unavailableCell:
    'background:#f1f5f9;color:#475569;font-style:italic;font-weight:600;border:1px dashed #94a3b8',
  unavailableSpan: `${PILL_BASE};border:1px dashed #94a3b8;background:#f1f5f9;color:#475569;font-style:italic`,
} as const;

export interface SourceEntry {
  id: string;
  kind: SourceKind;
  /** YYYY-MM-DD. */
  retrieved: string;
  /** What the source feeds: the figures or sections that cite it. */
  feeds: string;
  /** The source's name, e.g. "ESDM Minerba One Data Indonesia". */
  name: string;
  /** Its URL, or the tool and the query run, e.g. "valyu_search: Adaro 2025 coal output". */
  locator: string;
}

/** A figure's reference, placed right after the figure. */
export function sourceRefHtml(id: string): string {
  return `<sup data-source-ref="${escapeHtml(id)}" style="${SOURCE_STYLES.ref}">[${escapeHtml(id)}]</sup>`;
}

/** One entry of the Sources section's list. */
export function sourceEntryHtml(entry: SourceEntry): string {
  return `<li data-source-id="${escapeHtml(entry.id)}" data-source-kind="${entry.kind}" data-retrieved="${escapeHtml(entry.retrieved)}" data-feeds="${escapeHtml(entry.feeds)}" style="${SOURCE_STYLES.entry}"><strong>${escapeHtml(entry.name)}</strong> — ${escapeHtml(entry.locator)} · retrieved ${escapeHtml(entry.retrieved)} · feeds: ${escapeHtml(entry.feeds)}</li>`;
}

/** The Sources section, placed at the end of the document. */
export function sourcesSectionHtml(entries: readonly SourceEntry[]): string {
  return `<section data-section="${SOURCES_SECTION_KEY}" style="${SOURCE_STYLES.section}"><h2 style="${SOURCE_STYLES.heading}">Sources</h2><ol style="${SOURCE_STYLES.list}">
${entries.map(sourceEntryHtml).join('\n')}
</ol></section>`;
}

/**
 * A cell the agent could not fill, with the reason. The visible text is
 * always exactly "Unavailable"; the reason travels in `data-reason` (and in
 * `title`, so a reader can hover it).
 */
export function unavailableMarkerHtml(reason: string, tag: 'td' | 'span' = 'td'): string {
  const style = tag === 'td' ? SOURCE_STYLES.unavailableCell : SOURCE_STYLES.unavailableSpan;
  return `<${tag} data-evidence="unavailable" data-reason="${escapeHtml(reason)}" title="${escapeHtml(reason)}" style="${style}">${UNAVAILABLE_LABEL}</${tag}>`;
}

// The placeholders the snippets carry; a snippet pasted unfilled is malformed.
const FEEDS_PLACEHOLDER = 'FEEDS';
const REASON_PLACEHOLDER = 'REASON';
const RETRIEVED_PLACEHOLDER = 'YYYY-MM-DD';

const SOURCE_KIND_CODES = OFFERED_SOURCE_KINDS.map((k) => `\`${k}\``).join(', ');

/**
 * For every agent's insight authoring guide (chat and workforce): document
 * each figure's source, and mark what could not be obtained.
 */
export const INSIGHT_SOURCES_GUIDE = `### Sources

Every figure you write into an insight names its source. Put a reference right after the figure — copy it exactly, styles included:

\`\`\`html
${sourceRefHtml('S1')}
\`\`\`

and document each source once, as an entry in a Sources section at the end of the document:

\`\`\`html
${sourcesSectionHtml([
  {
    id: 'S1',
    kind: 'web',
    retrieved: RETRIEVED_PLACEHOLDER,
    feeds: FEEDS_PLACEHOLDER,
    name: 'SOURCE NAME',
    locator: 'URL',
  },
])}
\`\`\`

- \`data-source-id\` is \`S\` and a number, unique in the document, and every \`data-source-ref\` must match one. Reuse the id when another figure comes from the same source.
- \`data-source-kind\` is one of ${SOURCE_KIND_CODES}. For a web source write its URL; for a tool (Valyu, Inven, the internal record) write the tool and the query you ran; for another insight, its name and version.
- \`data-retrieved\` is the date you retrieved the source (YYYY-MM-DD) and \`data-feeds\` names the figures or sections it feeds. Neither may be empty, and the same date and feeds follow as visible text.
- A figure you could not verify says **unverified** next to it — never drop it, and never give it a source it did not come from. Where the data sits behind a declared data limit, point at the limit instead of a source you did not use.
- An insight write with a reference that matches no entry, or with a malformed entry, is refused and nothing is written; fix it and write again. A document with no references at all is not refused (nothing can tell a figure from any other number), so keeping every figure referenced is your job.`;

/** For every agent's insight authoring guide: the unavailable cell (MB-556). */
export const INSIGHT_UNAVAILABLE_GUIDE = `### Data you could not obtain

When an instruction needs data inside a declared data limit, or data no source you can reach has, still make the structural change it asks for — add the column, row or section — and mark each cell you cannot fill, copying this exactly:

\`\`\`html
${unavailableMarkerHtml(REASON_PLACEHOLDER)}
\`\`\`

Outside a table use a \`<span>\` with the same attributes. \`data-reason\` (and \`title\`) says why the value is missing, naming the limit when there is one. The visible text is exactly "Unavailable": never estimate, interpolate or carry an old number into an unavailable cell. A write with a digit in an unavailable cell, or without a reason, is refused.`;

/** For the workforce authoring guide only: incremental writes must add a source before citing it. */
export const WORKFORCE_SOURCES_WRITE_ORDER = `**Write order for sources:** each insight write is checked on its own, so a Sources entry must exist before — or in the same write as — the first figure that cites it. Put an empty Sources section (\`<section data-section="sources">\` with its heading and an empty \`<ol>\`) in the skeleton, and before you fill a section, update the Sources section with the entries it will cite (one write can add the entries for several sections). \`edit_insight_section\` can only replace a section that already exists: when an existing insight has no Sources section, add it with \`replace_insight_document\` before citing anything.`;

// ---------------------------------------------------------------------------
// Validation (MB-543 AC4, the enforceable part)
// ---------------------------------------------------------------------------

/**
 * Agents whose insight writes are checked for malformed markers. Only @dikti:
 * its classification is the hard rule of US-04. Other agents' markers render
 * the same way but aren't validated.
 */
const VALIDATED_AGENT_KEYS: ReadonlySet<string> = new Set(['dikti']);

export function validatesEvidenceMarkers(agentKey: unknown): boolean {
  return typeof agentKey === 'string' && VALIDATED_AGENT_KEYS.has(agentKey);
}

export interface EvidenceMarkerProblem {
  /** The offending start tag, trimmed to a readable length. */
  tag: string;
  reason: string;
}

// A start tag whose quoted attribute values may contain '>'.
const START_TAG_RE =
  /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function readAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Reported when a start tag is too long to scan, so its markers can't be checked. */
const UNREADABLE_TAG_PROBLEM: EvidenceMarkerProblem = {
  tag: '(document)',
  reason:
    'a tag is too long to read, usually a "<" whose tag never ends with ">". Close or remove it so its markers can be checked.',
};

/**
 * START_TAG_RE's matches in `source`. A single start tag megabytes long (an
 * unterminated `<a b=c b=c …`) overflows the regex engine's stack. That stops
 * the scan, and the document is reported unreadable rather than throwing.
 */
function startTagMatches(source: string): { matches: RegExpExecArray[]; unreadable: boolean } {
  const matches: RegExpExecArray[] = [];
  try {
    for (const match of source.matchAll(START_TAG_RE)) matches.push(match);
  } catch (err) {
    if (err instanceof RangeError) return { matches, unreadable: true };
    throw err;
  }
  return { matches, unreadable: false };
}

function shortTag(tag: string): string {
  // Drop the long inline style so the correction message shows what matters.
  const compact = tag.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i, '');
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

/**
 * Every malformed evidence marker in `html`: an unknown `data-evidence` value,
 * an Observed pill without one of the four signal types, or an Inferred pill
 * that doesn't name what it was built from. A marker that is simply missing
 * can't be detected and isn't reported.
 */
export function findEvidenceMarkerProblems(html: string): EvidenceMarkerProblem[] {
  const problems: EvidenceMarkerProblem[] = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const { matches, unreadable } = startTagMatches(source);
  if (unreadable) problems.push(UNREADABLE_TAG_PROBLEM);
  for (const match of matches) {
    const attrs = readAttributes(match[2]);
    if (!attrs.has(EVIDENCE_ATTR)) continue;
    const tag = shortTag(match[0]);
    const kind = attrs.get(EVIDENCE_ATTR)?.trim() ?? '';
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      problems.push({
        tag,
        reason: `data-evidence must be one of ${EVIDENCE_KINDS.join(', ')}.`,
      });
      continue;
    }
    if (kind === 'observed' && !isObservedSignalType(attrs.get('data-signal-type')?.trim())) {
      problems.push({
        tag,
        reason: `an Observed marker needs data-signal-type set to one of ${OBSERVED_SIGNAL_TYPES.join(', ')}. A signal that is none of these is Inferred, not Observed.`,
      });
    }
    const basedOn = attrs.get('data-based-on')?.trim() ?? '';
    if (kind === 'inferred' && (!basedOn || basedOn === BASED_ON_PLACEHOLDER)) {
      problems.push({
        tag,
        reason: `an Inferred marker needs data-based-on naming the observed signals it was built from${basedOn ? ` — replace the ${BASED_ON_PLACEHOLDER} placeholder` : ''}.`,
      });
    }
    if (kind === 'data-limit' && attrs.get('data-limit-id')?.trim() === LIMIT_ID_PLACEHOLDER) {
      problems.push({
        tag,
        reason: `data-limit-id must be the id of the declared limit you are stating — replace the ${LIMIT_ID_PLACEHOLDER} placeholder.`,
      });
    }
  }
  return problems;
}

/**
 * What is wrong and how to fix it, for the agent (the tools prefix it with
 * "Rejection:") or an HTTP 400 body.
 */
export function evidenceMarkerCorrection(problems: EvidenceMarkerProblem[]): string {
  const lines = problems.map((p) => `- \`${p.tag}\` — ${p.reason}`);
  return `${problems.length} malformed evidence marker${problems.length === 1 ? '' : 's'} — nothing was written. Fix ${problems.length === 1 ? 'it' : 'each one'} and write again:
${lines.join('\n')}

Well-formed markers:
${observedMarkerHtml('decree')}
${inferredMarkerHtml('SK 123/E/O/2024; PDDikti change 2024-03-01')}`;
}

/**
 * The refusal for an insight write, or null to let it through. Only writes by
 * an agent in {@link VALIDATED_AGENT_KEYS} are checked; `agentKey` comes from
 * the run's `configurable.agent_key` (or the chat's pinned agent), never from
 * a tool argument.
 */
export function evidenceMarkerRefusal(html: string, agentKey: unknown): string | null {
  if (!validatesEvidenceMarkers(agentKey)) return null;
  const problems = findEvidenceMarkerProblems(html);
  return problems.length > 0 ? `Rejection: ${evidenceMarkerCorrection(problems)}` : null;
}

// ---------------------------------------------------------------------------
// Validation of sources and unavailable cells (MB-551, MB-556) — every agent
// ---------------------------------------------------------------------------

/**
 * What a write is checked as:
 *   - `document`: a whole insight — every reference must resolve to an entry
 *     in the same document, and ids are unique across it;
 *   - `fragment`: one section being spliced in (`edit_insight_section`) — its
 *     references may resolve to entries elsewhere in the document, so they
 *     are left to the whole-document check the service runs after the splice.
 */
export type MarkerScope = 'document' | 'fragment';

/** A real calendar date written YYYY-MM-DD. */
export function isRetrievedDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
  );
}

/** The visible text between a start tag and the first close tag of the same name. */
/**
 * How far past an unavailable cell's start tag its closing tag is looked for.
 * The cell holds one word; an unbounded search per cell is quadratic on a
 * document of unclosed cells.
 */
const INNER_TEXT_WINDOW = 4096;

function innerText(source: string, tagName: string, from: number): string {
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
  const rest = source.slice(from, from + INNER_TEXT_WINDOW);
  const close = closeRe.exec(rest);
  const inner = close ? rest.slice(0, close.index) : '';
  return inner
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every malformed source reference, Sources entry or unavailable cell in
 * `html`. Only markers that are present are checked: a figure without a
 * reference can't be told from any other number, so a document with no
 * source markers at all passes. An entry nothing cites is allowed (a source
 * is written before the figures that cite it).
 */
export function findSourceMarkerProblems(
  html: string,
  scope: MarkerScope = 'document',
): EvidenceMarkerProblem[] {
  const problems: EvidenceMarkerProblem[] = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const refs: { id: string; tag: string }[] = [];
  const ids = new Set<string>();
  const reportedDuplicates = new Set<string>();

  const { matches, unreadable } = startTagMatches(source);
  if (unreadable) problems.push(UNREADABLE_TAG_PROBLEM);
  for (const match of matches) {
    const attrs = readAttributes(match[2]);
    const hasRef = attrs.has(SOURCE_REF_ATTR);
    const hasId = attrs.has(SOURCE_ID_ATTR);
    const unavailable = attrs.get(EVIDENCE_ATTR)?.trim() === 'unavailable';
    if (!hasRef && !hasId && !unavailable) continue;
    const tag = shortTag(match[0]);

    if (hasRef) {
      const id = attrs.get(SOURCE_REF_ATTR)?.trim() ?? '';
      if (!isSourceId(id)) {
        problems.push({
          tag,
          reason: 'data-source-ref must name a source id: S and a number, e.g. S1.',
        });
      } else {
        refs.push({ id, tag });
      }
    }

    if (hasId) {
      const id = attrs.get(SOURCE_ID_ATTR)?.trim() ?? '';
      if (!isSourceId(id)) {
        problems.push({
          tag,
          reason: 'data-source-id must be S and a number, e.g. S1.',
        });
      } else if (ids.has(id)) {
        if (!reportedDuplicates.has(id)) {
          reportedDuplicates.add(id);
          problems.push({
            tag,
            reason: `source id ${id} is used by more than one Sources entry — give each source its own id.`,
          });
        }
      } else {
        ids.add(id);
      }
      const kind = attrs.get('data-source-kind')?.trim();
      if (!isSourceKind(kind)) {
        problems.push({
          tag,
          reason: `data-source-kind must be one of ${OFFERED_SOURCE_KINDS.join(', ')}.`,
        });
      }
      const retrieved = attrs.get('data-retrieved')?.trim() ?? '';
      if (!isRetrievedDate(retrieved)) {
        problems.push({
          tag,
          reason: `data-retrieved must be the date the source was retrieved, as a real YYYY-MM-DD date${retrieved ? ` (got "${retrieved.slice(0, 40)}")` : ''}.`,
        });
      }
      const feeds = attrs.get('data-feeds')?.trim() ?? '';
      if (!feeds || feeds === FEEDS_PLACEHOLDER) {
        problems.push({
          tag,
          reason: `data-feeds must name the figures or sections this source feeds${feeds ? ` — replace the ${FEEDS_PLACEHOLDER} placeholder` : ''}.`,
        });
      }
    }

    if (unavailable) {
      const reason = attrs.get('data-reason')?.trim() ?? '';
      if (!reason || reason === REASON_PLACEHOLDER) {
        problems.push({
          tag,
          reason: `an unavailable cell needs data-reason saying why the value could not be obtained${reason ? ` — replace the ${REASON_PLACEHOLDER} placeholder` : ''}.`,
        });
      }
      const tagName = match[1].toLowerCase();
      const text = innerText(source, tagName, (match.index ?? 0) + match[0].length);
      if (/\d/.test(text)) {
        problems.push({
          tag,
          reason: `an unavailable cell holds no value: its text must be exactly "${UNAVAILABLE_LABEL}", with no digits — never put an estimate in it (got "${text.slice(0, 40)}").`,
        });
      } else if (text !== UNAVAILABLE_LABEL) {
        problems.push({
          tag,
          reason: `an unavailable cell's text must be exactly "${UNAVAILABLE_LABEL}"${text ? ` (got "${text.slice(0, 40)}")` : ''}.`,
        });
      }
    }
  }

  if (scope === 'document') {
    const dangling = new Set<string>();
    for (const ref of refs) {
      if (ids.has(ref.id) || dangling.has(ref.id)) continue;
      dangling.add(ref.id);
      problems.push({
        tag: ref.tag,
        reason: `reference ${ref.id} matches no Sources entry — add <li data-source-id="${ref.id}" …> to the Sources section (before or in the same write as the figure citing it), or cite an existing source.`,
      });
    }
  }

  return problems;
}

/** What is wrong with the sources and unavailable cells, and how to fix it. */
export function sourceMarkerCorrection(problems: EvidenceMarkerProblem[]): string {
  const lines = problems.map((p) => `- \`${p.tag}\` — ${p.reason}`);
  return `${problems.length} malformed source or unavailable marker${problems.length === 1 ? '' : 's'} — nothing was written. Fix ${problems.length === 1 ? 'it' : 'each one'} and write again:
${lines.join('\n')}

Well-formed markers:
${sourceRefHtml('S1')}
${sourceEntryHtml({ id: 'S1', kind: 'web', retrieved: '2026-09-01', feeds: 'FY2025 production volume', name: 'ESDM Minerba One Data Indonesia', locator: 'https://modi.esdm.go.id/' })}
${unavailableMarkerHtml('Behind the PDDikti data limit: not public')}`;
}

export interface InsightMarkerProblems {
  /** MB-543 evidence markers — only for an agent that is validated (@dikti). */
  evidence: EvidenceMarkerProblem[];
  /** Sources and unavailable cells — for every writer. */
  sources: EvidenceMarkerProblem[];
}

/**
 * Both layers of the insight marker check: the MB-543 evidence markers when
 * `agentKey` is validated (@dikti), and the sources and unavailable cells
 * always. `agentKey` comes from the run's `configurable.agent_key` or the
 * chat's pinned agent, never from a tool argument.
 */
export function findInsightMarkerProblems(
  html: string,
  agentKey: unknown,
  scope: MarkerScope = 'document',
): InsightMarkerProblems {
  return {
    evidence: validatesEvidenceMarkers(agentKey) ? findEvidenceMarkerProblems(html) : [],
    sources: findSourceMarkerProblems(html, scope),
  };
}

export function hasInsightMarkerProblems(problems: InsightMarkerProblems): boolean {
  return problems.evidence.length > 0 || problems.sources.length > 0;
}

/** The correction for either layer or both, for the agent or an HTTP 400 body. */
export function insightMarkerCorrection(problems: InsightMarkerProblems): string {
  const parts: string[] = [];
  if (problems.evidence.length > 0) parts.push(evidenceMarkerCorrection(problems.evidence));
  if (problems.sources.length > 0) parts.push(sourceMarkerCorrection(problems.sources));
  return parts.join('\n\n');
}

/**
 * The refusal for any agent's insight write, or null to let it through: the
 * write tools return it as-is (it starts "Rejection:").
 */
export function insightMarkerRefusal(
  html: string,
  agentKey: unknown,
  scope: MarkerScope = 'document',
): string | null {
  const problems = findInsightMarkerProblems(html, agentKey, scope);
  return hasInsightMarkerProblems(problems)
    ? `Rejection: ${insightMarkerCorrection(problems)}`
    : null;
}
