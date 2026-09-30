import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';

/**
 * Reformat an uploaded HTML document into something an email client will
 * actually render.
 *
 * A page that builds itself in the browser — a saved app export, a deck that
 * draws its charts with a CDN script — arrives as markup no mail client will
 * ever run: every major client strips `<script>`, and most strip `<iframe>`,
 * `<canvas>`, forms and external stylesheets too. Sent untouched, such a file
 * shows the recipient its `<noscript>` apology ("This page requires JavaScript
 * to display") and nothing else.
 *
 * So the document is reduced here to the static subset email understands:
 * scripts and the other inert-in-email elements are dropped, event handlers and
 * `javascript:` URLs with them, assets that cannot load are removed rather than
 * left as broken icons, and the document's own `<style>` rules are kept but
 * re-rooted so they style the document instead of repainting the whole email.
 *
 * Nothing here executes the page. When a document's content exists only after
 * its JavaScript runs, there is nothing to salvage — that is reported as an
 * error so the sender hears about it, instead of a colleague receiving a blank
 * page.
 */

/** Elements an email client drops, or that cannot mean anything without JS. */
const DROP_TAGS = new Set([
  'script',
  // Its content is the "you need JavaScript" apology — the very thing the
  // recipient must not be sent.
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  // Drawn by JavaScript; in a mail client it is a blank box.
  'canvas',
  'template',
  'dialog',
  'video',
  'audio',
  'source',
  'track',
  'input',
  'textarea',
  'select',
  'option',
  'optgroup',
  'button',
  'label',
  // External CSS never loads from a mail client, and a <base>/refresh <meta>
  // would only mislead.
  'link',
  'base',
  'meta',
  'title',
]);

/** Kept, but their tag is dropped and their children are spliced in. */
const UNWRAP_TAGS = new Set(['form', 'fieldset', 'legend', 'head']);

/** URL schemes a link or image may keep. */
const SAFE_URL_RE = /^(https?:|mailto:|tel:|#)/i;

/** What the rewriter took out, for the line the tool reports back. */
export interface RemovedCounts {
  scripts: number;
  frames: number;
  canvases: number;
  /** Images whose src could not survive the trip (relative paths, blob:, …). */
  unreachableImages: number;
  stylesheets: number;
  handlers: number;
}

export type EmailSafeFailure = 'js-only' | 'empty';

export interface EmailSafeHtml {
  /** A body-level fragment ready to drop into the branded email shell. */
  html: string | null;
  /** Why the document cannot be emailed, or null. */
  failure: EmailSafeFailure | null;
  removed: RemovedCounts;
  /** Characters of visible text left after the rewrite. */
  textLength: number;
  /**
   * The start of that visible text, when the document was refused — the
   * "B Unpacking…" a loading shell shows before its scripts run. Quoting it
   * back is what makes the refusal recognisable to whoever uploaded the file.
   */
  residue: string | null;
}

/**
 * A document that carries scripts and less real text than this is the shell of
 * a page, not a page: a logo, a spinner and a word. A real static document has
 * at least a heading and the start of a sentence.
 */
const MIN_STATIC_TEXT_CHARS = 40;

/**
 * Carrying this much JavaScript while rendering almost no text makes a file a
 * bundle with a loading screen stapled to the front — the shape of every
 * "B / Unpacking…" email. Measured on the script text rather than the file, so
 * a real document that embeds a large `data:` image is not mistaken for one.
 */
const BUNDLE_SCRIPT_BYTES = 20_000;
const BUNDLE_MIN_TEXT_CHARS = 200;

/**
 * Below this, a scripted page is not a short document — it is a logo and a
 * word. It is the floor that does not depend on recognising the spinner's
 * wording, which no list of phrases can cover in every language.
 */
const SHELL_MAX_TEXT_CHARS = 15;

/** The bytes of `<script>` the file carries, read before the tree is rewritten. */
const SCRIPT_BLOCK_RE = /<script\b[\s\S]*?<\/script\s*>/gi;

export function scriptByteCount(html: string): number {
  const blocks: string[] = html.match(SCRIPT_BLOCK_RE) || [];
  let total = 0;
  for (const block of blocks) total += block.length;
  return total;
}

/** Text a page shows *instead of* its content, which therefore is not content. */
const LOADING_BOILERPLATE_RE = new RegExp(
  [
    'unpacking',
    'loading',
    'please wait',
    'one moment',
    'preparing',
    'initiali[sz]ing',
    'rendering',
    'memuat',
    'sedang memuat',
    'mohon tunggu',
    'harap tunggu',
    '加载中?',
    '请稍候',
    '正在加载',
    'we are sorry[^.]*',
    "we're sorry[^.]*",
    '(this )?(page|app|application|report)[^.]{0,40}(requires|needs)[^.]{0,20}javascript',
    '(enable|turn on)[^.]{0,20}javascript',
    'javascript is (required|disabled|not enabled)',
    'your browser[^.]{0,40}javascript',
  ].join('|'),
  'gi',
);

/** Containers a single-page app mounts into; empty until its scripts run. */
const APP_ROOT_SELECTORS = [
  '#root',
  '#app',
  '#__next',
  '#main',
  '[data-reactroot]',
  '[ng-app]',
  '[data-vue-root]',
];

/**
 * The visible text with the loading boilerplate taken out — what the document
 * says on its own, rather than what it says while waiting for its scripts.
 */
/** True when visible text is mostly loading/apology copy rather than document body. */
export function hadLoadingBoilerplate(visible: string): boolean {
  const before = collapse(visible);
  if (!before) return false;
  return collapse(visible.replace(LOADING_BOILERPLATE_RE, ' ')).length < before.length;
}

export function meaningfulText(text: string): string {
  return collapse(
    text
      .replace(LOADING_BOILERPLATE_RE, ' ')
      // Ellipsis/em-dash only — keep '.' and '-' so decimals and hyphenated words stay intact.
      .replace(/[…·|—–\u2013\u2014]+/g, ' ')
      // Spinner copy often trails "..." after the boilerplate word is stripped.
      .replace(/\.{2,}/g, ' '),
  );
}

/** The class the document's content is wrapped in, and its re-rooted styles. */
export const EMAIL_DOCUMENT_CLASS = 'brain-doc';

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function tagOf(el: HTMLElement): string {
  return (el.rawTagName || '').toLowerCase();
}

/**
 * Re-root a style block so it cannot repaint the email around it: a bare
 * `html`/`body` selector becomes the document's own wrapper. Selectors are
 * split on commas outside parentheses so `:is(a, b)` survives intact.
 */
export function rewriteRootSelectors(css: string): string {
  return css.replace(/(^|\})([^{}@]+)\{/g, (match, brace: string, selector: string) => {
    if (!selector.trim()) return match;
    const rewritten = splitSelectorList(selector)
      .map((one) => one.replace(/(^|\s|>|\+|~)(html|body)\b/gi, `$1.${EMAIL_DOCUMENT_CLASS}`))
      .join(',');
    return `${brace}${rewritten}{`;
  });
}

function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of selector) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Strip CSS constructs mail clients must not execute or fetch. */
function neutralizeDangerousCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    // Emptied rather than half-rewritten: leaving the opening quote behind
    // (`url(')`) makes the declaration unparseable, and a mail client that
    // chokes on it may drop the rest of the rule with it.
    .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, 'url()')
    .replace(/url\s*\(\s*['"]?\s*vbscript:[^)]*\)/gi, 'url()')
    .replace(/behavior\s*:\s*url\s*\([^)]*\)/gi, 'behavior:none')
    .replace(/-moz-binding\s*:[^;}]*/gi, '');
}

/** Drop rules a mail client would ignore anyway, and any remote CSS import. */
function sanitizeCss(css: string): string {
  return rewriteRootSelectors(neutralizeDangerousCss(css)).trim();
}

function stripDangerousAttributes(el: HTMLElement, removed: RemovedCounts): void {
  for (const name of Object.keys(el.attributes)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) {
      el.removeAttribute(name);
      removed.handlers += 1;
      continue;
    }
    if (lower === 'style') {
      const value = (el.getAttribute(name) ?? '').trim();
      if (!value) continue;
      const sanitized = neutralizeDangerousCss(value).trim();
      if (!sanitized) el.removeAttribute(name);
      else if (sanitized !== value) el.setAttribute('style', sanitized);
      continue;
    }
    if (lower === 'href' || lower === 'src' || lower === 'xlink:href' || lower === 'action') {
      const value = (el.getAttribute(name) ?? '').trim();
      if (value && !SAFE_URL_RE.test(value) && !value.toLowerCase().startsWith('data:image/')) {
        el.removeAttribute(name);
      }
    }
  }
}

/**
 * The document's static content as an email-safe fragment, or the reason it
 * has none. `html` is the fragment; it never contains a `<script>`, an event
 * handler or a reference the recipient's client cannot resolve.
 */
export function toEmailSafeHtml(rawHtml: string): EmailSafeHtml {
  const removed: RemovedCounts = {
    scripts: 0,
    frames: 0,
    canvases: 0,
    unreachableImages: 0,
    stylesheets: 0,
    handlers: 0,
  };

  const root = parse(rawHtml, {
    comment: false,
    // Keep <style> text (it is carried over); the rest are removed whole, so
    // their contents are of no interest.
    blockTextElements: { script: false, noscript: false, style: true, pre: true },
  });

  const styles: string[] = [];
  walk(root, styles, removed);

  const body = root.querySelector('body');
  const scope = body ?? root;
  const content = scope.innerHTML.trim();
  // `structuredText`, not `text`: it breaks between block elements, so the
  // logo and the spinner below it read as "B Unpacking…" rather than
  // "BUnpacking…" — both when quoting the residue and when matching the
  // loading boilerplate, which would otherwise run words together.
  const visible = collapse(scope.structuredText);
  const textLength = visible.length;
  const hasVisual =
    scope.querySelectorAll('img').length > 0 || scope.querySelectorAll('svg').length > 0;
  // "B Unpacking…" is text, but it is not the document — it is what the page
  // shows while its bundle boots. Every gate below judges what is left once
  // that boilerplate is discounted.
  const meaningful = meaningfulText(visible);
  const scripted = removed.scripts > 0 || removed.canvases > 0;
  const refuse = (failure: EmailSafeFailure): EmailSafeHtml => ({
    html: null,
    failure,
    removed,
    textLength,
    residue: visible.slice(0, 120) || null,
  });

  const pictureOnly = hasVisual && meaningful.length === 0 && textLength === 0;

  // Nothing the document says is its own — only a spinner, an apology, or
  // nothing at all. A picture with no caption is still a document; a picture
  // under "Unpacking…", or beside a bundle that will never run, is not.
  if (meaningful.length === 0 && (!hasVisual || textLength > 0)) {
    return refuse(scripted ? 'js-only' : 'empty');
  }

  if (scripted) {
    if (!pictureOnly) {
      // A shell: logo + spinner wording, not a short memo that happens to
      // carry analytics.
      if (meaningful.length < MIN_STATIC_TEXT_CHARS && hadLoadingBoilerplate(visible)) {
        return refuse('js-only');
      }
      // The wording-independent floor: a word or two beside a script is a
      // shell whatever language its spinner speaks — or whether it has one at
      // all, since plenty animate a CSS ring and write nothing.
      if (meaningful.length < SHELL_MAX_TEXT_CHARS) return refuse('js-only');
    }
    // Mostly JavaScript, rendering a couple of lines: a bundle, not a
    // document. A logo does not rescue it, so this runs for a picture-only
    // file too.
    if (
      scriptByteCount(rawHtml) > BUNDLE_SCRIPT_BYTES &&
      meaningful.length < BUNDLE_MIN_TEXT_CHARS
    ) {
      return refuse('js-only');
    }
    // An app container still waiting to be mounted into.
    if (meaningful.length < BUNDLE_MIN_TEXT_CHARS && hasEmptyAppRoot(scope)) {
      return refuse('js-only');
    }
  }

  const styleBlock = styles.length > 0 ? `<style>${styles.join('\n')}</style>\n` : '';
  return {
    html: `${styleBlock}<div class="${EMAIL_DOCUMENT_CLASS}">${content}</div>`,
    failure: null,
    removed,
    textLength,
    residue: null,
  };
}

/** True when the document has a single-page-app mount point with nothing in it. */
function hasEmptyAppRoot(scope: HTMLElement): boolean {
  return APP_ROOT_SELECTORS.some((selector) =>
    scope.querySelectorAll(selector).some((el) => collapse(el.structuredText).length === 0),
  );
}

/** Depth-first rewrite. Children are walked on a copy, since the list mutates. */
function walk(node: HTMLElement, styles: string[], removed: RemovedCounts): void {
  for (const child of [...node.childNodes]) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);

    if (tag === 'style') {
      const css = sanitizeCss(child.rawText ?? '');
      if (css) styles.push(css);
      child.remove();
      continue;
    }

    if (DROP_TAGS.has(tag)) {
      if (tag === 'script') removed.scripts += 1;
      else if (tag === 'iframe' || tag === 'frame' || tag === 'frameset') removed.frames += 1;
      else if (tag === 'canvas') removed.canvases += 1;
      else if (tag === 'link') {
        const rel = (child.getAttribute('rel') ?? '').toLowerCase();
        if (rel.includes('stylesheet')) removed.stylesheets += 1;
      }
      child.remove();
      continue;
    }

    stripDangerousAttributes(child, removed);

    if (tag === 'img') {
      const src = (child.getAttribute('src') ?? '').trim();
      // A relative path points at an asset folder that does not travel with
      // the file; a blob:/filesystem: URL died with the page's tab. Either way
      // the recipient would get a broken-image icon.
      if (!src || !(SAFE_URL_RE.test(src) || src.toLowerCase().startsWith('data:image/'))) {
        removed.unreachableImages += 1;
        child.remove();
        continue;
      }
    }

    walk(child, styles, removed);

    if (UNWRAP_TAGS.has(tag)) {
      child.replaceWith(...child.childNodes);
    }
  }
}
