/**
 * What the user is currently looking at in the center console, as the copilot
 * sees it.
 *
 * The client sends this with every chat turn (see `pageContextStore` and
 * `ChatProvider`'s transport body); the chat route sanitizes it and hands it to
 * the agent via LangGraph `configurable.pageContext`, where the
 * `read_page_context` tool reads it. Shared by both sides so the shape can't
 * drift — no server-only imports here.
 */
import { findTabBySlug } from '@/lib/navigation/consoleTabs';
import { isUuid } from '@/lib/uuid';

/** Cap on the view-supplied `detail` string, so a runaway view can't flood the prompt. */
export const MAX_PAGE_DETAIL_LENGTH = 1500;
/** Cap on `path`, which is URL-derived and therefore attacker-influenced. */
export const MAX_PAGE_PATH_LENGTH = 300;
/** Cap on each insight section key. */
export const MAX_INSIGHT_SECTION_KEY_LENGTH = 100;
/** Cap on how many sections or elements one selection may carry into the prompt. */
export const MAX_INSIGHT_SECTIONS = 20;
/** Maximum child index allowed in a section path. */
export const MAX_INSIGHT_SECTION_PATH_INDEX = 999;
/** Maximum child path depth allowed before truncation. */
export const MAX_INSIGHT_SECTION_PATH_DEPTH = 12;
/** Cap on one selected item's `content`, in characters. */
export const MAX_INSIGHT_SECTION_CONTENT_CHARS = 1000;
/** Cap on the `content` of a whole selection, across every item. */
export const MAX_INSIGHT_SELECTION_CONTENT_CHARS = 4000;

/** `element`: the user picked a whole element. `text`: they highlighted words in it. */
export type InsightSectionKind = 'element' | 'text';
/** The only shape a tag name may take — a closed vocabulary, quoted into the prompt. */
const SECTION_TAG_RE = /^[a-z][a-z0-9-]{0,20}$/;

/**
 * One thing the user picked in the open insight.
 *
 * `key` is the `data-section` of the nearest keyed ancestor — a literal string
 * the agent can find in the `get_insight` output. `path` narrows it to one
 * element inside that block: zero-based indices over ELEMENT children only,
 * outermost first. Absent or empty means the keyed block itself was picked.
 */
export interface InsightSectionRef {
  /**
   * The `data-section` of the nearest keyed ancestor. Absent when the document
   * has no keyed blocks at all — then `path` is rooted at `<body>` instead.
   * A key is the better address whenever one exists, because it is a literal
   * string the agent can find in the `get_insight` output.
   */
  key?: string;
  /**
   * Zero-based indices over ELEMENT children, outermost first, from the anchor
   * down to the picked element. The anchor is the keyed block when `key` is
   * set, otherwise `<body>`. Empty (or absent) means the keyed block itself.
   */
  path?: number[];
  /**
   * Lowercase tag name of the element each `path` step lands on, same length
   * and order as `path`.
   *
   * Without a key there is no anchor string to grep, so the agent would be
   * counting children blind through the whole document. The tags let it check
   * every step against the markup it is reading. They are markup structure from
   * a closed HTML vocabulary, never document prose, so this does not cross the
   * keys-only fence below.
   */
  tags?: string[];
  /**
   * What was picked, the address's counterpart: `element` (the default when
   * absent) or `text`, when the user highlighted words inside the element.
   */
  kind?: InsightSectionKind;
  /**
   * The document text the user pointed at — the highlighted words for a `text`
   * pick, the element's own text for an `element` pick — whitespace-collapsed
   * and capped. It is model-authored prose, so it travels ONLY in the selection
   * attachment, which the server quotes into the user's turn as labelled
   * document content. The page context drops it (see `sanitizePageContext`), so
   * `read_page_context` stays address-only.
   */
  content?: string;
  /** Set when `content` is an excerpt — cut at a cap, or dropped at the total. */
  contentTruncated?: true;
}

/** Stable identity for a ref — the React key, and how a chip removes one. */
export function insightSectionRefId(ref: InsightSectionRef): string {
  // `body:` prefixes the keyless form so a root path can never collide with a
  // `data-section` key that happens to read the same way.
  const anchor = ref.key ?? 'body';
  const path = ref.path && ref.path.length > 0 ? `:${ref.path.join('.')}` : '';
  // Two highlights in one paragraph share its address, and so does a pick of
  // the paragraph itself; the words are what tell them apart.
  const text = ref.kind === 'text' ? `~text:${ref.content ?? ''}` : '';
  return `${anchor}${path}${text}`;
}

/** Formats a ref's child path and tags into a child-step string (e.g. "child 1 <tag> › child 2"). */
export function formatInsightChildSteps(ref: InsightSectionRef): string {
  if (!ref.path || ref.path.length === 0) return '';
  return ref.path
    .map((idx, i) => (ref.tags?.[i] ? `child ${idx + 1} <${ref.tags[i]}>` : `child ${idx + 1}`))
    .join(' › ');
}

/**
 * What a picked element is, in the words a user would use. Tags come from the
 * closed `SECTION_TAG_RE` vocabulary; anything unlisted is just an "Element".
 */
const ELEMENT_KIND_BY_TAG: Record<string, string> = {
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading',
  p: 'Paragraph',
  table: 'Table', thead: 'Table', tbody: 'Table', tfoot: 'Table',
  tr: 'Table row', td: 'Table cell', th: 'Table cell', caption: 'Caption', figcaption: 'Caption',
  ul: 'List', ol: 'List', dl: 'List', li: 'List item',
  img: 'Image', picture: 'Image', svg: 'Graphic', canvas: 'Chart', figure: 'Figure',
  a: 'Link', button: 'Button', blockquote: 'Quote', pre: 'Code', code: 'Code', hr: 'Divider',
  span: 'Text', strong: 'Text', b: 'Text', em: 'Text', i: 'Text', small: 'Text', mark: 'Text', label: 'Text',
  header: 'Header', footer: 'Footer',
  div: 'Block', section: 'Block', article: 'Block', main: 'Block', aside: 'Block', nav: 'Block',
};

function describeElementTag(tag: string | undefined): string {
  return (tag && ELEMENT_KIND_BY_TAG[tag]) || 'Element';
}

/** `seven-day_forecast` → `Seven day forecast`. Keys are `SECTION_KEY_RE`-shaped. */
function humanizeSectionKey(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * A ref as a user-facing label for a chip: `Summary section`, `Heading in
 * Summary`, or just `Heading` for a pick in a document with no section keys;
 * highlighted words read `“A hot, humid week…” in Summary`.
 * The model never sees this — it gets the exact address (`formatPageContext`,
 * `formatInsightSelectionBlock`).
 */
export function formatInsightSectionLabel(ref: InsightSectionRef): string {
  const section = ref.key ? humanizeSectionKey(ref.key) : null;
  // Highlighted words are named by the words themselves.
  if (ref.kind === 'text') {
    const quote = ref.content ? `“${shortQuote(ref.content)}”` : 'Selected text';
    return section ? `${quote} in ${section}` : quote;
  }
  const hasPath = Boolean(ref.path && ref.path.length > 0);
  // The last tag is the picked element itself; a step with no tag is unknown.
  const kind = describeElementTag(hasPath ? ref.tags?.[ref.tags.length - 1] : undefined);
  if (!section) return kind;
  return hasPath ? `${kind} in ${section}` : `${section} section`;
}

const SHORT_QUOTE_CHARS = 32;

/** The first few words of a quote, cut on a word boundary where one is near. */
function shortQuote(text: string): string {
  if (text.length <= SHORT_QUOTE_CHARS) return text;
  const cut = text.slice(0, SHORT_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > SHORT_QUOTE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The only shape a section key may take. Keys reach us from a document the
 *  copilot wrote, so they are quoted into the prompt only if they are inert. */
const SECTION_KEY_RE = /^[A-Za-z0-9_-]+$/;

export interface PageContext {
  /** Console tab slug, or `null` when the user is in the full-screen chat. */
  tabSlug: string | null;
  /** Workspace-relative path, e.g. `/pipeline/8f2c…`. */
  path: string;
  /**
   * Optional free-text enrichment supplied by the view itself via
   * `useSetPageDetail` — the record on screen, active filters, row counts.
   */
  detail?: string;
  /**
   * The `companies.id` of the deal the user has open, when one is open —
   * supplied by the view via `useSetPageCompanyId`.
   *
   * Carried as its own field rather than buried in `detail` prose so the agent
   * can hand it straight to a company_id-taking tool. That matters most for
   * companies whose names are near-identical (or non-Latin): resolving by name
   * can land on a sibling record, and the id can't.
   */
  companyId?: string;
  /**
   * The `insights.id` of the insight the user has open, when one is open.
   */
  insightId?: string;
  /**
   * The `data-section` keys and optional child paths the user has clicked in
   * the open insight, in document order — "ask about THIS part".
   *
   * Keys and child paths only, never the sections' text — this field is a
   * browser-supplied address, and a path is a list of integers, which is why
   * the selection is addressable without shipping content. The document's
   * content does reach the prompt, but server-side and whole (MB-550): the chat
   * route reads the insight's current version itself and appends its outline
   * (`src/lib/insights/chatOutline.ts`), stripped of markup, bounded, and fenced
   * as data rather than instructions, since model-authored prose can carry
   * prompt injection from whatever its author read.
   */
  insightSections?: InsightSectionRef[];
}

function rawObjectFlag(entry: unknown, name: string): unknown {
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[name] : undefined;
}

/** Whitespace-collapsed, control-character-free document text. */
function normalizeContent(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ');
}

/**
 * Validates a browser-supplied list of insight section refs. Anything not an
 * inert address (key shape, path bounds, tags aligned with the path) is
 * dropped, duplicates collapse, and the list is capped at
 * `MAX_INSIGHT_SECTIONS`. Returns `undefined` when nothing survives.
 *
 * Addresses only by default. `withContent` also keeps each ref's `kind` and
 * `content` — for the selection attachment, never for the page context — with
 * `content` capped per item and across the list, and `contentTruncated` set
 * wherever it was cut. A `text` ref with no words is not a selection, and is
 * dropped.
 */
export function sanitizeInsightSections(
  raw: unknown,
  { withContent = false }: { withContent?: boolean } = {},
): InsightSectionRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const validSections: InsightSectionRef[] = [];
  let contentBudget = MAX_INSIGHT_SELECTION_CONTENT_CHARS;
  for (const rawEntry of raw) {
    let rawKey: unknown;
    let rawPath: unknown;
    let rawTags: unknown;
    let rawKind: unknown;
    let rawContent: unknown;

    if (typeof rawEntry === 'string') {
      rawKey = rawEntry;
      rawPath = undefined;
    } else if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
      const obj = rawEntry as Record<string, unknown>;
      rawKey = obj.key;
      rawPath = obj.path;
      rawTags = obj.tags;
      rawKind = obj.kind;
      rawContent = obj.content;
    } else {
      continue;
    }

    // A keyless ref addresses from <body>, so it is only meaningful with a
    // path; a ref with neither is not an address at all.
    let key: string | undefined;
    if (rawKey !== undefined && rawKey !== null) {
      if (typeof rawKey !== 'string') continue;
      const trimmed = rawKey.trim().slice(0, MAX_INSIGHT_SECTION_KEY_LENGTH);
      if (!SECTION_KEY_RE.test(trimmed)) continue;
      key = trimmed;
    }

    let path: number[] | undefined;
    if (rawPath !== undefined) {
      if (!Array.isArray(rawPath)) {
        continue;
      }
      if (rawPath.length > 0) {
        const isValid = rawPath.every(
          (item) =>
            typeof item === 'number' &&
            Number.isInteger(item) &&
            item >= 0 &&
            item < MAX_INSIGHT_SECTION_PATH_INDEX,
        );
        if (!isValid) {
          continue;
        }
        path = (rawPath as number[]).slice(0, MAX_INSIGHT_SECTION_PATH_DEPTH);
      }
    }

    if (key === undefined && (!path || path.length === 0)) continue;

    // Tags ride alongside the path and must line up with it exactly; a
    // mismatched or malformed list is dropped rather than half-trusted.
    let tags: string[] | undefined;
    if (rawTags !== undefined && path && path.length > 0) {
      // A deep path is truncated above, so truncate tags the same way before
      // demanding they line up.
      const candidate = Array.isArray(rawTags)
        ? rawTags.slice(0, MAX_INSIGHT_SECTION_PATH_DEPTH)
        : null;
      if (
        candidate &&
        candidate.length === path.length &&
        candidate.every((t) => typeof t === 'string' && SECTION_TAG_RE.test(t))
      ) {
        tags = candidate as string[];
      }
    }

    let kind: InsightSectionKind | undefined;
    let content: string | undefined;
    let contentTruncated = false;
    if (withContent) {
      kind = rawKind === 'text' ? 'text' : 'element';
      const full = typeof rawContent === 'string' ? normalizeContent(rawContent) : '';
      if (kind === 'text' && !full) continue;
      const cap = Math.min(MAX_INSIGHT_SECTION_CONTENT_CHARS, contentBudget);
      content = full.slice(0, cap);
      // A ref restored from the store may already hold an excerpt.
      contentTruncated =
        full.length > content.length || rawObjectFlag(rawEntry, 'contentTruncated') === true;
      contentBudget -= content.length;
    }

    const ref: InsightSectionRef = {
      ...(key !== undefined ? { key } : {}),
      ...(path && path.length > 0 ? { path } : {}),
      ...(tags ? { tags } : {}),
      ...(kind === 'text' ? { kind } : {}),
      ...(content ? { content } : {}),
      ...(contentTruncated ? { contentTruncated: true as const } : {}),
    };
    const id = insightSectionRefId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    validSections.push(ref);
    if (validSections.length === MAX_INSIGHT_SECTIONS) break;
  }
  return validSections.length > 0 ? validSections : undefined;
}

/**
 * Normalizes a `page_context` payload straight off the wire.
 *
 * Everything here arrives from the browser, so nothing is trusted: `tabSlug`
 * must name a real console tab (otherwise it's dropped to `null`), `path` must
 * be a workspace-relative path, and `detail` is length-clamped. Returns `null`
 * when there's nothing usable, which the tool reports as "not on a page".
 */
export function sanitizePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const rawPath = typeof input.path === 'string' ? stripControlChars(input.path) : '';
  // A leading slash is the whole contract: it keeps an absolute URL (which
  // would leak an arbitrary host into the prompt) out of the payload. Backticks
  // would close the `Path: \`…\`` fence in formatPageContext.
  const path =
    rawPath.startsWith('/') && !rawPath.startsWith('//')
      ? rawPath.replace(/`/g, '').slice(0, MAX_PAGE_PATH_LENGTH)
      : '';
  if (!path) return null;

  const rawSlug = typeof input.tabSlug === 'string' ? input.tabSlug.trim() : '';
  const tabSlug = findTabBySlug(rawSlug) ? rawSlug : null;

  const rawDetail = typeof input.detail === 'string' ? stripControlChars(input.detail) : '';
  const detail = rawDetail ? rawDetail.slice(0, MAX_PAGE_DETAIL_LENGTH) : undefined;

  // Only a well-formed UUID survives: the value is quoted into the prompt as an
  // id the agent will pass to write tools, so anything else is dropped rather
  // than forwarded.
  const rawCompanyId = typeof input.companyId === 'string' ? input.companyId.trim() : '';
  const companyId = isUuid(rawCompanyId) ? rawCompanyId : undefined;

  const rawInsightId = typeof input.insightId === 'string' ? input.insightId.trim() : '';
  const insightId = isUuid(rawInsightId) ? rawInsightId : undefined;

  const insightSections = sanitizeInsightSections(input.insightSections);

  return {
    tabSlug,
    path,
    ...(detail ? { detail } : {}),
    ...(companyId ? { companyId } : {}),
    ...(insightId ? { insightId } : {}),
    ...(insightSections ? { insightSections } : {}),
  };
}

/**
 * Collapses control characters (including newlines) to single spaces.
 *
 * `detail` is rendered into the model's view of the page inside a labelled
 * block. Left alone, a value carrying newlines could close that block and write
 * what looks like fresh instructions — the user's own prompt injecting into
 * their own conversation, but a boundary worth keeping tight regardless. Keeping
 * `detail` to one line is what makes the block unambiguous.
 */
export function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

function formatInsightSectionRef(ref: InsightSectionRef): string {
  const anchor = ref.key ? `\`${ref.key}\`` : '`<body>`';
  if (!ref.path || ref.path.length === 0) {
    return anchor;
  }
  // One-based in the rendered text, because that is how a person and a model
  // count children, even though we store zero-based.
  const childSteps = ref.path
    .map((idx, i) => {
      const tag = ref.tags?.[i];
      return tag ? `child ${idx + 1} (\`<${tag}>\`)` : `child ${idx + 1}`;
    })
    .join(' › ');
  return `${anchor} › ${childSteps}`;
}

/** Renders a sanitized context as the markdown the `read_page_context` tool returns. */
export function formatPageContext(context: PageContext): string {
  const tab = context.tabSlug ? findTabBySlug(context.tabSlug) : undefined;
  const lines = [
    tab
      ? `The user is on the **${tab.label}** page (${tab.purpose})`
      : `The user is in the full-screen chat, not on a specific page`,
    `Path: \`${context.path}\``,
  ];
  if (context.detail) {
    lines.push('', 'What is on screen:', context.detail);
  }
  if (context.companyId) {
    lines.push(
      '',
      `Open company: \`company_id ${context.companyId}\``,
      'Pass this id VERBATIM to any tool that takes a company_id (get_company_details, update_company_card_section, …).',
      'Do NOT re-resolve this company by name — near-identical names resolve to the wrong record.',
    );
  }
  if (context.insightId) {
    const sections = context.insightSections ?? [];
    lines.push('', `Open insight: \`insight_id ${context.insightId}\``);
    if (sections.length > 0) {
      lines.push(
        sections.length === 1
          ? `Selected section: ${formatInsightSectionRef(sections[0])}`
          : `Selected sections: ${sections.map(formatInsightSectionRef).join(', ')}`,
        'The user pointed at this part of the insight — read the whole document with get_insight and find the block by its data-section attribute.',
        'When they ask for a change, edit ONLY the selected section and leave the rest of the document byte-identical.',
      );
      if (sections.some((s) => s.path && s.path.length > 0)) {
        lines.push(
          'A child path narrows the selection to a single element inside its anchor, counting ELEMENT children only and starting at 1. Where a step names a tag, the element you land on MUST have that tag — if it does not, you have miscounted, so re-walk it rather than editing what you landed on.',
        );
      }
      if (sections.some((s) => !s.key)) {
        lines.push(
          'A selection anchored at `<body>` means the document has no `data-section` keys, so the path is the only address there is: walk it from the document body. Once you have found the element, add a `data-section` key to the block that contains it as part of your edit, so the user can point at it by name next time.',
        );
      }
    }
  }
  return lines.join('\n');
}
