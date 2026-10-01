/**
 * Wraps a CoPilot-authored insight document for rendering inside a sandboxed
 * iframe.
 *
 * An insight is arbitrary HTML — the author may write `<style>`, `<script>`,
 * inline SVG and whatever else it likes. Nothing is sanitized, because nothing
 * is injected into the app's origin: the document is handed to an iframe with
 * `sandbox="allow-scripts …"` and WITHOUT `allow-same-origin`, so it runs in an
 * opaque origin with no access to our cookies, storage, DOM or API.
 *
 * The sandbox stops the document reaching *us*. {@link INSIGHT_CSP} stops it
 * reaching *out* — which matters because an insight's content can be steered by
 * prompt injection in any source document the author read, and the numbers baked
 * into it are workspace data.
 */

import type { InsightSectionRef } from '@/lib/chat/pageContext';

/** Script/style origins an insight may load from. A fixed allowlist, so no
 *  attacker-controlled endpoint is ever reachable. */
export const INSIGHT_CDN_HOSTS = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const;

export const INSIGHT_FONT_STYLE_HOSTS = ['https://fonts.googleapis.com'] as const;
export const INSIGHT_FONT_HOSTS = ['https://fonts.gstatic.com'] as const;

/**
 * The policy enforced inside the frame, as a `<meta http-equiv>` injected ahead
 * of every byte the author wrote.
 *
 * `connect-src 'none'` and a remote-free `img-src` are the load-bearing parts:
 * together they close fetch/XHR/WebSocket and the `<img>`-beacon exfiltration
 * channels. Scripts and styles come only from the fixed CDN list above, whose
 * request logs an attacker cannot read — so an allowed request leaks nothing.
 *
 * A document may add its own `<meta>` policy; CSP policies intersect, so a
 * second one can only tighten this, never widen it.
 */
export const INSIGHT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${INSIGHT_CDN_HOSTS.join(' ')}`,
  `style-src 'unsafe-inline' ${[...INSIGHT_CDN_HOSTS, ...INSIGHT_FONT_STYLE_HOSTS].join(' ')}`,
  `font-src data: ${[...INSIGHT_CDN_HOSTS, ...INSIGHT_FONT_HOSTS].join(' ')}`,
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * The `sandbox` token list for the host iframe.
 *
 * `allow-same-origin` is deliberately absent and must stay absent: combined with
 * `allow-scripts` it would let the document reach `frameElement` and strip its
 * own sandbox attribute. `allow-top-navigation` and `allow-popups` are likewise
 * absent so the frame cannot navigate the user anywhere.
 */
export const INSIGHT_SANDBOX = 'allow-scripts allow-forms allow-modals';

/** Message an insight posts to the host so the frame can size to its content. */
export const INSIGHT_HEIGHT_MESSAGE = 'insight:height';

/** Message the primer document posts once its frame has a laid-out size. */
export const INSIGHT_FRAME_READY_MESSAGE = 'insight:frame-ready';

/** How long a host waits for {@link INSIGHT_FRAME_READY_MESSAGE} before loading
 *  the insight anyway, so a frame mounted in a zero-width container still renders. */
export const INSIGHT_PRIME_TIMEOUT_MS = 500;

/**
 * The document a sandboxed frame loads BEFORE the insight.
 *
 * Chrome runs an opaque-origin frame out of process, and the FIRST document it
 * parses there sees a 0×0 viewport: `innerWidth`, `clientWidth` and every
 * `offsetHeight` read 0 until layout arrives. An insight whose inline script
 * measures while parsing — a deck that paginates rows by `offsetHeight`, or
 * scales slides by `clientWidth` — then lays itself out for a zero-size page
 * (everything "fits" on one slide, scaled to nothing). A later navigation of the
 * same frame is sized from its first byte, so the host loads this primer, waits
 * for it to report a real width, and only then swaps in the insight.
 */
export function buildInsightPrimerSrcDoc(theme: InsightTheme = 'light'): string {
  const dark = theme === 'dark';
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">` +
    `<meta name="color-scheme" content="${dark ? 'dark' : 'light'}">` +
    // Same page colour as headPrelude, so the swap to the insight doesn't flash.
    `<style>html,body{margin:0;background:${dark ? '#0b0b0d' : '#ffffff'};}</style>` +
    `</head><body><script>(function(){
  var sent = false;
  function check() {
    if (sent || !(window.innerWidth > 0)) return;
    sent = true;
    parent.postMessage({ type: ${JSON.stringify(INSIGHT_FRAME_READY_MESSAGE)} }, '*');
  }
  window.addEventListener('resize', check);
  window.addEventListener('load', check);
  check();
})();</script></body></html>`
  );
}

/**
 * Message an insight posts to the host when its section selection changes, and
 * once on load to announce how many selectable blocks it has.
 *
 * Each ref is an address (key, path, tags) plus what it points at: `kind` and
 * `content`, the text the user picked or highlighted. The content is
 * model-authored, prompt-injectable prose, so the host keeps it out of the page
 * context and the system prompt — it reaches the model only inside the
 * selection attachment, quoted into the user's own turn as labelled document
 * content (see `selectionAttachment.ts`).
 */
export const INSIGHT_SECTIONS_MESSAGE = 'insight:sections';

/**
 * Message the host posts INTO an insight to arm or disarm click-to-select, and
 * to restore the selection after the document reloads.
 *
 * The open insight arms it once and leaves it on — there is no mode to enter.
 * What keeps that survivable on an interactive document is the picker's
 * interactive-element bail-out: a plain click on a button, tab, input or link
 * reaches the insight's own handler untouched, and only Ctrl/Cmd-click selects
 * one of those. The flag stays on the wire because the previews that are NOT the
 * open insight — the approval cards and the version-history dialog — must stay
 * disarmed.
 */
export const INSIGHT_SELECT_MODE_MESSAGE = 'insight:select-mode';

/**
 * Message an insight posts to the host when the user picks an element to prompt
 * on, and with `ref: null` when dismissed.
 *
 * `count` is how many elements are selected in total, which is not the same as
 * "one": a Ctrl/Cmd-click adds to the selection, and the prompt box anchored at
 * `ref` speaks for all of them. `session` changes only when a plain click aims
 * the selection somewhere new, which is how the host knows to throw away a
 * half-typed instruction rather than carry it onto a different element.
 */
export const INSIGHT_PICK_MESSAGE = 'insight:pick';

/** The attribute a selectable block carries, e.g. `<section data-section="risk">`. */
export const INSIGHT_SECTION_ATTR = 'data-section';

/**
 * Largest document we accept, for every writer. Generous — inline CSS, JS and
 * data URIs add up, and an uploaded export routinely embeds its images. One
 * cap for all writers, so a large upload can still take later versions. It
 * sits under Vercel's 4.5 MB request-body limit with room for the multipart
 * envelope of `POST /api/insights/upload`.
 */
export const MAX_INSIGHT_BYTES = 4 * 1024 * 1024;

/** Longest insight (and template) name, in characters. */
export const MAX_INSIGHT_NAME_LENGTH = 120;

export type InsightTheme = 'light' | 'dark';

export interface BuildSrcDocOptions {
  /** Colour scheme hint for documents that honour `prefers-color-scheme`. */
  theme?: InsightTheme;
}

export interface InsightPickRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Reports the document's height to the host on load and whenever it changes, so
 * the iframe can grow with its content instead of scrolling inside a fixed box.
 */
const RESIZE_SCRIPT = `<script>(function(){
  var last = 0;
  function report() {
    var d = document.documentElement, b = document.body;
    if (!b) return;
    var h = Math.max(b.scrollHeight, b.offsetHeight, d.scrollHeight, d.offsetHeight);
    if (h === last) return;
    last = h;
    parent.postMessage({ type: ${JSON.stringify(INSIGHT_HEIGHT_MESSAGE)}, height: h }, '*');
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(report).observe(document.documentElement);
  }
  window.addEventListener('load', report);
  setTimeout(report, 0);
})();</script>`;

/**
 * Click-to-select for `[data-section]` blocks and nested elements, so the user
 * can point the copilot at part of an insight.
 *
 * Interaction contract, while selection mode is on (`armed`):
 *  - Hovering outlines what a click would select. Nothing outlines over a
 *    control the document owns, so an outline always means "this is selectable".
 *  - A plain click selects exactly that one element, replacing the selection;
 *    clicking the one already selected clears it.
 *  - Ctrl/Cmd-click adds to or removes from the selection, and is also the way
 *    to select one of the document's own controls.
 *  - Dragging draws a rectangle and selects the outermost elements lying wholly
 *    inside it (a table, not each of its cells), replacing the selection;
 *    Ctrl/Cmd-drag adds them. Text cannot be highlighted in this mode, so the
 *    two gestures never compete.
 *  - Escape clears everything.
 *
 * While it is off, the document reads normally, and when `askText` is on (the
 * open insight only) highlighting text offers an "Ask CoPilot" button. Asking
 * replaces the selection with the highlighted words, addressed by the element
 * they sit in.
 *
 * Every pick carries its `content` — the element's text, or the highlighted
 * words — cut one character past the host's cap so the host can tell an
 * excerpt.
 *
 * Lives in-frame because sandboxed opaque origin prevents host DOM access.
 *
 * The inbound listener is deliberately unauthenticated: within a sandboxed frame
 * the only reachable sender is the host, and the message toggles outlines and
 * nothing else.
 */
const SELECT_SCRIPT = `<script>(function(){
  var ARM = ${JSON.stringify(INSIGHT_SELECT_MODE_MESSAGE)};
  var REPORT = ${JSON.stringify(INSIGHT_SECTIONS_MESSAGE)};
  var PICK = ${JSON.stringify(INSIGHT_PICK_MESSAGE)};
  var ATTR = ${JSON.stringify(INSIGHT_SECTION_ATTR)};
  var SELECTOR = '[' + ATTR + ']';
  /** The one blue every outline is drawn in — the hover box, its fill, and the
   *  ring left on a selected element. Hoisted so the two can never drift. */
  var HL = '#3b82f6';
  var HL_FILL = 'rgba(59, 130, 246, 0.12)';
  /** Controls the DOCUMENT owns. Selection is armed the whole time the insight
   *  is open, so a plain click on one of these has to reach the insight or its
   *  tabs, toggles and checkboxes would be dead. Hold Ctrl/Cmd to select one
   *  anyway. */
  var INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, option,'
    + ' [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"],'
    + ' [role="link"], [role="menuitem"], [contenteditable=""], [contenteditable="true"]';
  var armed = false;
  var askText = false;
  var MAX_PICKS = 20;
  var MAX_CONTENT = 1001;
  var DRAG_THRESHOLD = 5;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, HEAD: 1 };
  var drag = null;
  var marquee = null;
  var suppressClick = false;
  var askButton = null;
  var pendingText = null;
  var selected = [];
  var sheet = null;
  var overlay = null;
  var pendingHoverRaf = null;
  var lastMouseX = 0;
  var lastMouseY = 0;
  var modifier = false;
  var hoveredEl = null;
  var descendantStack = [];
  var activePick = null;
  var pendingPickRaf = null;
  // Bumped only when a plain click starts a FRESH selection. The host keys the
  // prompt box on it, so extending the selection with Ctrl/Cmd keeps whatever
  // the reader has already typed, while aiming somewhere new clears it.
  var session = 0;

  function blocks() {
    return Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  }
  function keyOf(el) { return el.getAttribute(ATTR) || ''; }

  function isInteractive(el) {
    return !!(el && typeof el.closest === 'function' && el.closest(INTERACTIVE));
  }

  // Mirrors insightSectionRefId on the host: highlighted words are told apart
  // from each other, and from a pick of the element they sit in, by the words.
  function refId(ref) {
    if (!ref) return '';
    var anchor = ref.key || 'body';
    var id = (ref.path && ref.path.length > 0)
      ? anchor + ':' + ref.path.join('.')
      : anchor;
    return ref.kind === 'text' ? id + '~text:' + (ref.content || '') : id;
  }

  function textOf(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_CONTENT);
  }

  /** A picked element's ref, with the element's own text as its content. */
  function picked(res) {
    var ref = Object.assign({}, res.ref);
    var text = textOf(res.element.innerText || res.element.textContent);
    if (text) ref.content = text;
    return ref;
  }

  function indexOfRef(id) {
    for (var i = 0; i < selected.length; i++) {
      if (refId(selected[i]) === id) return i;
    }
    return -1;
  }

  function refFor(el) {
    if (!el || typeof el.closest !== 'function') return null;
    // A keyed ancestor is the better anchor — its key is a literal string the
    // agent can grep. Without one, fall back to addressing from <body>, which
    // is the only address a keyless document can offer.
    var root = el.closest(SELECTOR);
    var key = root ? keyOf(root) : '';
    if (!key) {
      root = document.body;
      key = '';
    }
    if (!root || el === root) {
      if (!key) return null;
    }

    var chain = [];
    var curr = el;
    while (curr && curr !== root) {
      chain.unshift(curr);
      curr = curr.parentElement;
    }
    if (curr !== root) return null;

    // Cap path at 12 levels deep: address 12th-level ancestor instead.
    if (chain.length > 12) {
      chain = chain.slice(0, 12);
    }

    var target = chain.length > 0 ? chain[chain.length - 1] : root;
    var path = [];
    var tags = [];
    var parent = root;
    for (var i = 0; i < chain.length; i++) {
      var stepEl = chain[i];
      var children = parent.children;
      var idx = Array.prototype.indexOf.call(children, stepEl);
      if (idx === -1) return null;
      path.push(idx);
      tags.push(stepEl.tagName.toLowerCase());
      parent = stepEl;
    }

    // Accessible name for the picked element.
    var label = target.tagName ? target.tagName.toLowerCase() : 'element';

    var ref = key ? { key: key, path: path, tags: tags } : { path: path, tags: tags };
    return { ref: ref, element: target, label: label };
  }

  function elementForRef(ref) {
    if (!ref) return null;
    var root = null;
    if (typeof ref.key === 'string' && ref.key) {
      var blks = blocks();
      for (var i = 0; i < blks.length; i++) {
        if (keyOf(blks[i]) === ref.key) {
          root = blks[i];
          break;
        }
      }
    } else {
      root = document.body;
    }
    if (!root) return null;
    if (!ref.path || ref.path.length === 0) return root;
    var curr = root;
    for (var j = 0; j < ref.path.length; j++) {
      var idx = ref.path[j];
      var children = curr.children;
      if (!children || idx < 0 || idx >= children.length) return null;
      curr = children[idx];
    }
    return curr;
  }

  function sortSelected() {
    var blks = blocks();
    var blockKeys = blks.map(keyOf);
    selected.sort(function (a, b) {
      // Keyless refs all hang off <body>, so their paths alone order them.
      var aBlockIdx = a.key ? blockKeys.indexOf(a.key) : -2;
      var bBlockIdx = b.key ? blockKeys.indexOf(b.key) : -2;
      if (aBlockIdx !== bBlockIdx) {
        if (aBlockIdx === -1) return 1;
        if (bBlockIdx === -1) return -1;
        return aBlockIdx - bBlockIdx;
      }
      var aPath = a.path || [];
      var bPath = b.path || [];
      var len = Math.min(aPath.length, bPath.length);
      for (var k = 0; k < len; k++) {
        if (aPath[k] !== bPath[k]) {
          return aPath[k] - bPath[k];
        }
      }
      return aPath.length - bPath.length;
    });
  }

  function paint() {
    if (!sheet) {
      sheet = document.createElement('style');
      (document.head || document.documentElement).appendChild(sheet);
    }
    // A crosshair everywhere selection reaches, but the document's own controls
    // keep a pointer: their cursor is the hint that a plain click still works
    // them rather than selecting them.
    // No text highlighting in selection mode: a drag there draws a rectangle.
    sheet.textContent = (armed
      ? 'body, body * { cursor: crosshair; -webkit-user-select: none !important; user-select: none !important; } '
        + INTERACTIVE + ' { cursor: pointer; }'
      : '')
      + '[data-insight-selected]{outline:2px solid ' + HL + ' !important;outline-offset:2px !important;}';

    var prev = document.querySelectorAll('[data-insight-selected]');
    for (var p = 0; p < prev.length; p++) {
      prev[p].removeAttribute('data-insight-selected');
    }

    for (var s = 0; s < selected.length; s++) {
      // Highlighted words keep the browser's own highlight; ringing the whole
      // paragraph would claim more than was picked.
      if (selected[s].kind === 'text') continue;
      var el = elementForRef(selected[s]);
      if (el) el.setAttribute('data-insight-selected', '');
    }
  }

  function ensureOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-insight-overlay', '');
      overlay.style.position = 'fixed';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '2147483647';
      overlay.style.border = '2px solid ' + HL;
      overlay.style.backgroundColor = HL_FILL;
      overlay.style.boxSizing = 'border-box';
      overlay.style.display = 'none';
    }
  }

  function showOverlay(el) {
    if (!armed || !el) {
      hideOverlay();
      return;
    }
    ensureOverlay();
    var bcr = el.getBoundingClientRect();
    overlay.style.top = bcr.top + 'px';
    overlay.style.left = bcr.left + 'px';
    overlay.style.width = bcr.width + 'px';
    overlay.style.height = bcr.height + 'px';
    overlay.style.display = 'block';

    if (!overlay.parentNode) {
      (document.body || document.documentElement).appendChild(overlay);
    }
  }

  function hideOverlay() {
    if (overlay) {
      overlay.style.display = 'none';
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }
  }

  function announce(sections) {
    // How many selectable things the document offers. A keyed document counts
    // its blocks; a keyless one is addressed from <body>, so every top-level
    // element is selectable and the host must not disable the toggle.
    var keyed = blocks().length;
    var available = keyed > 0
      ? keyed
      : (document.body && document.body.children ? document.body.children.length : 0);
    parent.postMessage({ type: REPORT, sections: sections, available: available }, '*');
  }

  function clearHover() {
    hideOverlay();
    hoveredEl = null;
    descendantStack = [];
  }

  function updateHover() {
    pendingHoverRaf = null;
    if (!armed) {
      clearHover();
      return;
    }
    var target = document.elementFromPoint(lastMouseX, lastMouseY);
    if (!target || (overlay && (target === overlay || overlay.contains(target)))) {
      clearHover();
      return;
    }
    // Nothing is outlined over a control a plain click would work instead of
    // select, so "outlined" always means "clicking here selects this".
    if (!modifier && isInteractive(target)) {
      clearHover();
      return;
    }
    var res = refFor(target);
    if (!res) {
      clearHover();
      return;
    }
    if (hoveredEl !== res.element) {
      hoveredEl = res.element;
      descendantStack = [];
    }
    showOverlay(res.element);
  }

  function queueHover() {
    if (!pendingHoverRaf) {
      pendingHoverRaf = requestAnimationFrame(updateHover);
    }
  }

  function ensureMarquee() {
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.setAttribute('data-insight-marquee', '');
      marquee.style.position = 'fixed';
      marquee.style.pointerEvents = 'none';
      marquee.style.zIndex = '2147483647';
      marquee.style.border = '1px dashed ' + HL;
      marquee.style.backgroundColor = HL_FILL;
      marquee.style.boxSizing = 'border-box';
    }
    if (!marquee.parentNode) {
      (document.body || document.documentElement).appendChild(marquee);
    }
  }

  function removeMarquee() {
    if (marquee && marquee.parentNode) marquee.parentNode.removeChild(marquee);
  }

  function dragRect(e) {
    return {
      left: Math.min(drag.x, e.clientX),
      top: Math.min(drag.y, e.clientY),
      right: Math.max(drag.x, e.clientX),
      bottom: Math.max(drag.y, e.clientY)
    };
  }

  function drawMarquee(r) {
    ensureMarquee();
    marquee.style.left = r.left + 'px';
    marquee.style.top = r.top + 'px';
    marquee.style.width = (r.right - r.left) + 'px';
    marquee.style.height = (r.bottom - r.top) + 'px';
  }

  // The outermost elements lying wholly inside the rectangle. An element the
  // rectangle only crosses is searched for children that fit instead.
  function elementsIn(r) {
    var out = [];
    function walk(node) {
      var kids = node.children;
      for (var i = 0; i < kids.length && out.length < MAX_PICKS; i++) {
        var el = kids[i];
        if (SKIP_TAGS[el.tagName] || el === overlay || el === marquee || el === askButton) continue;
        var b = el.getBoundingClientRect();
        if (b.right < r.left || b.left > r.right || b.bottom < r.top || b.top > r.bottom) continue;
        var inside = b.width > 0 && b.height > 0
          && b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom;
        if (inside) {
          var res = refFor(el);
          if (res) {
            out.push(res);
            continue;
          }
        }
        walk(el);
      }
    }
    if (document.body) walk(document.body);
    return out;
  }

  /** Drops every pick and closes the prompt box — Escape, or a click on nothing. */
  function clearSelection() {
    activePick = null;
    if (selected.length > 0) {
      selected = [];
      paint();
      announce([]);
    }
    postPick();
  }

  function finishDrag(e) {
    var r = dragRect(e);
    var additive = drag.additive;
    drag = null;
    removeMarquee();
    var hits = elementsIn(r);
    if (hits.length === 0) {
      // A fresh drag round empty space replaces the selection with nothing.
      if (!additive) clearSelection();
      return;
    }
    if (!additive) {
      selected = [];
      session++;
    }
    for (var i = 0; i < hits.length && selected.length < MAX_PICKS; i++) {
      var ref = picked(hits[i]);
      if (indexOfRef(refId(ref)) === -1) selected.push(ref);
    }
    sortSelected();
    paint();
    announce(selected.slice());
    // The prompt box anchors on the last element in document order.
    var lastRef = selected[selected.length - 1];
    var lastEl = elementForRef(lastRef);
    activePick = lastEl
      ? { element: lastEl, ref: lastRef, label: lastEl.tagName.toLowerCase() }
      : null;
    postPick();
  }

  document.addEventListener('mousedown', function (e) {
    if (!armed || e.button !== 0) return;
    var multi = !!(e.ctrlKey || e.metaKey);
    // A drag that starts on the document's own control belongs to it.
    if (!multi && isInteractive(e.target)) return;
    drag = { x: e.clientX, y: e.clientY, additive: multi, active: false };
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!drag) return;
    if (!drag.active) {
      drag = null;
      return;
    }
    finishDrag(e);
    // The click this mouseup is about to fire would otherwise pick again.
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!armed) return;
    if (drag) {
      if (e.buttons === 0) {
        // The button came up outside the frame, where no mouseup reaches us.
        if (drag.active) finishDrag(e);
        else drag = null;
      } else {
        if (!drag.active
          && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > DRAG_THRESHOLD) {
          drag.active = true;
          clearHover();
          var dragSel = window.getSelection && window.getSelection();
          if (dragSel) dragSel.removeAllRanges();
        }
        if (drag.active) {
          drawMarquee(dragRect(e));
          return;
        }
      }
    }
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // Read off the event rather than keydown: the frame does not have to hold
    // focus for the pointer to tell us whether Ctrl/Cmd is down.
    modifier = !!(e.ctrlKey || e.metaKey);
    queueHover();
  });

  document.addEventListener('mouseleave', function () {
    if (pendingHoverRaf) {
      cancelAnimationFrame(pendingHoverRaf);
      pendingHoverRaf = null;
    }
    clearHover();
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Control' || e.key === 'Meta') {
      modifier = false;
      queueHover();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!armed) {
      if (e.key === 'Escape' && (pendingText || (activePick && activePick.range))) {
        var escSel = window.getSelection && window.getSelection();
        if (escSel) escSel.removeAllRanges();
        dismissTextAsk();
      }
      return;
    }
    if (e.key === 'Control' || e.key === 'Meta') {
      modifier = true;
      queueHover();
      return;
    }
    if (e.key === 'Escape') {
      clearHover();
      if (drag) {
        drag = null;
        removeMarquee();
      }
      clearSelection();
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!hoveredEl) return;
      var root = hoveredEl.closest(SELECTOR);
      if (!root || hoveredEl === root) return;
      var parentEl = hoveredEl.parentElement;
      if (!parentEl) return;
      e.preventDefault();
      descendantStack.push(hoveredEl);
      var res = refFor(parentEl);
      if (!res) return;
      hoveredEl = res.element;
      showOverlay(res.element);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (!hoveredEl || descendantStack.length === 0) return;
      var next = descendantStack.pop();
      if (!next || !hoveredEl.contains(next)) return;
      e.preventDefault();
      var resDown = refFor(next);
      if (!resDown) return;
      hoveredEl = resDown.element;
      showOverlay(resDown.element);
      return;
    }
  });

  document.addEventListener('click', function (e) {
    if (!armed) return;
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var multi = !!(e.ctrlKey || e.metaKey);
    var target = e.target;
    // The document's own control, clicked without a modifier: let it through
    // untouched. This is what makes always-armed selection survivable on an
    // interactive insight.
    if (!multi && isInteractive(target)) return;

    // A drag that highlighted text is someone reading and copying, not picking.
    // Without this the prompt box opens on top of the words they just selected.
    var textSel = window.getSelection && window.getSelection();
    if (!multi && textSel && !textSel.isCollapsed) return;

    var res = refFor(target);
    if (!res) {
      // A plain click on nothing selectable deselects everything, the way a
      // click on empty space does in any editor. Ctrl/Cmd-click keeps it.
      if (!multi) clearSelection();
      return;
    }

    // Capture phase + stop: this click picks an element instead of reaching the
    // insight's own handlers.
    e.preventDefault();
    e.stopPropagation();

    var ref = picked(res);
    var id = refId(ref);
    var at = indexOfRef(id);

    if (!multi) {
      // A plain click is a fresh, single selection — and clicking the element
      // that is already the only one selected clears it.
      var clearing = at !== -1 && selected.length === 1;
      selected = clearing ? [] : [ref];
      if (!clearing) session++;
    } else if (at === -1) {
      if (selected.length < MAX_PICKS) selected.push(ref);
    } else {
      selected.splice(at, 1);
    }

    sortSelected();
    paint();
    announce(selected.slice());

    if (indexOfRef(id) !== -1) {
      activePick = { element: res.element, ref: ref, label: res.label };
    } else if (selected.length > 0) {
      // The anchor was just removed but others remain: re-anchor on the last of
      // them so the prompt box does not vanish mid multi-select.
      var lastRef = selected[selected.length - 1];
      var lastEl = elementForRef(lastRef);
      activePick = lastEl
        ? { element: lastEl, ref: lastRef, label: lastEl.tagName.toLowerCase() }
        : null;
    } else {
      activePick = null;
    }
    postPick();
  }, true);

  function postPick() {
    if (!activePick
      || !activePick.element
      || !document.documentElement.contains(activePick.element)) {
      activePick = null;
      parent.postMessage(
        {
          type: PICK,
          ref: null,
          rect: null,
          label: '',
          count: selected.length,
          session: session
        },
        '*'
      );
      return;
    }
    // Highlighted words anchor the prompt box on the words, not their paragraph.
    var bcr = activePick.range
      ? activePick.range.getBoundingClientRect()
      : activePick.element.getBoundingClientRect();
    parent.postMessage({
      type: PICK,
      ref: activePick.ref,
      rect: {
        top: bcr.top,
        left: bcr.left,
        width: bcr.width,
        height: bcr.height
      },
      label: activePick.label,
      count: selected.length,
      session: session
    }, '*');
  }

  function queuePickRectUpdate() {
    if (!activePick) return;
    if (!pendingPickRaf) {
      pendingPickRaf = requestAnimationFrame(function () {
        pendingPickRaf = null;
        postPick();
      });
    }
  }

  function ensureAskButton() {
    if (!askButton) {
      askButton = document.createElement('button');
      askButton.type = 'button';
      askButton.setAttribute('data-insight-ask', '');
      askButton.textContent = 'Ask CoPilot';
      var st = askButton.style;
      st.position = 'fixed';
      st.zIndex = '2147483647';
      st.padding = '4px 10px';
      st.border = 'none';
      st.borderRadius = '6px';
      st.background = HL;
      st.color = '#ffffff';
      st.font = '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      st.cursor = 'pointer';
      st.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
      // A mousedown here would otherwise collapse the highlight it asks about,
      // and its mouseup would offer the button again for the same highlight.
      askButton.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
      askButton.addEventListener('mouseup', function (e) {
        e.stopPropagation();
      });
      askButton.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        askAboutText();
      });
    }
    if (!askButton.parentNode) {
      (document.body || document.documentElement).appendChild(askButton);
    }
  }

  function hideAsk() {
    pendingText = null;
    if (askButton && askButton.parentNode) askButton.parentNode.removeChild(askButton);
  }

  function elementOf(node) {
    return node && (node.nodeType === 1 ? node : node.parentElement);
  }

  // The highlighted words and the element that addresses them: the one the
  // whole highlight sits in, or — for a highlight spanning top-level blocks of
  // a keyless document, which lands on <body>, no address — the one it starts in.
  function textSelection() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var text = textOf(sel.toString());
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var common = elementOf(range.commonAncestorContainer);
    var res = common ? refFor(common) : null;
    if (!res) {
      var start = elementOf(range.startContainer);
      res = start ? refFor(start) : null;
    }
    return res ? { res: res, text: text, range: range } : null;
  }

  function offerAsk() {
    if (armed || !askText) {
      hideAsk();
      return;
    }
    // Already asked about this highlight; a new one collapses it first, which
    // dismisses the ask and lets the next highlight be offered.
    if (activePick && activePick.range) return;
    var found = textSelection();
    if (!found) {
      hideAsk();
      return;
    }
    pendingText = found;
    ensureAskButton();
    var rects = found.range.getClientRects();
    var b = rects.length ? rects[rects.length - 1] : found.range.getBoundingClientRect();
    var w = askButton.offsetWidth || 96;
    var h = askButton.offsetHeight || 26;
    var top = b.bottom + 6;
    if (top + h > window.innerHeight) top = Math.max(4, b.top - h - 6);
    askButton.style.left = Math.max(4, Math.min(b.right - w, window.innerWidth - w - 4)) + 'px';
    askButton.style.top = top + 'px';
  }

  function askAboutText() {
    var found = pendingText;
    hideAsk();
    if (!found) return;
    var ref = Object.assign({}, found.res.ref, { kind: 'text', content: found.text });
    // Asking about highlighted words replaces whatever was selected before: the
    // next turn is about these words, not an element picked earlier.
    selected = [ref];
    session++;
    paint();
    announce(selected.slice());
    activePick = { element: found.res.element, ref: ref, label: 'text', range: found.range };
    postPick();
  }

  document.addEventListener('mouseup', function () {
    if (armed || !askText) return;
    // Once the browser has settled the selection this mouseup made.
    setTimeout(offerAsk, 0);
  });

  // The highlight going away — a click elsewhere in the document, a new drag,
  // Escape — takes the ask with it: the button, and once asked, the prompt box
  // and the selection the words became. The host cannot see a click in here,
  // so this is the only place that knows.
  function dismissTextAsk() {
    hideAsk();
    if (!activePick || !activePick.range) return;
    activePick = null;
    selected = selected.filter(function (ref) { return ref.kind !== 'text'; });
    paint();
    announce(selected.slice());
    postPick();
  }

  document.addEventListener('selectionchange', function () {
    if (armed) return;
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) dismissTextAsk();
  });

  window.addEventListener('scroll', queuePickRectUpdate, true);
  window.addEventListener('resize', queuePickRectUpdate);

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || data.type !== ARM) return;
    armed = !!data.active;
    askText = !!data.askText;
    if (armed || !askText) hideAsk();
    selected = Array.isArray(data.selected)
      ? data.selected.filter(function (item) {
          if (typeof item === 'string') return true;
          if (!item) return false;
          // Either anchor is valid: a key, or a path rooted at <body>.
          return typeof item.key === 'string' || Array.isArray(item.path);
        }).map(function (item) {
          if (typeof item === 'string') return { key: item, path: [] };
          var out = { path: Array.isArray(item.path) ? item.path : [] };
          if (typeof item.key === 'string' && item.key) out.key = item.key;
          if (Array.isArray(item.tags)) out.tags = item.tags;
          if (item.kind === 'text') out.kind = 'text';
          if (typeof item.content === 'string') out.content = item.content;
          if (item.contentTruncated === true) out.contentTruncated = true;
          return out;
        })
      : [];
    // The host echoes every selection change back, so this runs right after an
    // ask too. Only a pick of the other mode is stale: an element pick once
    // selection mode is off, a text pick once it is on.
    if (!armed) clearHover();
    if (activePick && (armed ? !!activePick.range : !activePick.range)) activePick = null;
    paint();
  });

  // A null sections list is an announcement, not a selection report: it tells the
  // host how many blocks exist (so it can hide the toggle on a document with
  // none) without clearing a selection the host is still holding.
  function ready() { announce(null); }
  window.addEventListener('load', ready);
  setTimeout(ready, 0);
})();</script>`;

/** Host-supplied head prelude: baseline security headers, viewport, and theme styling. */
function headPrelude(theme: InsightTheme): string {
  return (
    // Charset first, and always: a srcdoc document does not reliably inherit the
    // host page's encoding, and without this an em-dash renders as "â€"".
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${INSIGHT_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="${theme === 'dark' ? 'dark light' : 'light dark'}">` +
    `<style>` +
    `:root{color-scheme:${theme === 'dark' ? 'dark' : 'light'};}` +
    `html,body{margin:0;padding:0;` +
    `background:${theme === 'dark' ? '#0b0b0d' : '#ffffff'};` +
    `color:${theme === 'dark' ? '#e8e8ea' : '#111827'};` +
    `font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}` +
    `</style>`
  );
}

/** Any sign the author wrote a whole document rather than a body fragment. */
const DOCUMENT_SHAPE_RE = /<!doctype\b|<html\b|<head\b|<body\b/i;

/**
 * Builds the `srcdoc` for an insight.
 *
 * The prelude is the very first thing the parser sees, ahead of every byte the
 * author wrote. That ordering is what makes the CSP binding: a policy declared
 * after a `<script>` would not cover it. The author's document is never
 * searched for its own `<head>` to inject into — a `<head>` inside a comment,
 * a script string or an attribute would land the policy in inert text and
 * leave the document with none. Instead the host opens the document itself,
 * and the HTML parser folds the author's markup into it: a second doctype and
 * `<head>` are dropped, `<html>` attributes (`lang`, `class`) merge onto the
 * root, and head content (`<style>`, `<link>`, `<script>`) joins the host's
 * head after the policy.
 */
export function buildInsightSrcDoc(
  html: string,
  { theme = 'light' }: BuildSrcDocOptions = {},
): string {
  const doc = html ?? '';
  const opening = `<!DOCTYPE html><html><head>${headPrelude(theme)}`;

  if (DOCUMENT_SHAPE_RE.test(doc)) {
    return withHostScripts(opening + doc);
  }

  return withHostScripts(`${opening}</head><body>${doc}</body></html>`);
}

/**
 * The file "Download HTML" saves: the author's document opened, like the
 * srcdoc, with a head that declares UTF-8 and the insight CSP first. A
 * downloaded insight is opened from disk outside the sandbox, so without the
 * policy its scripts could reach the network. With it, fetch and image beacons
 * stay blocked and only the CDN allowlist loads. The theme styles and the
 * host's resizer and picker scripts are left out: they serve the app's frame,
 * not a page opened on its own.
 */
export function buildInsightDownloadDoc(html: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${INSIGHT_CSP}">` +
    (html ?? '')
  );
}

/** Appends the host's own scripts — the resizer and the section picker — at the
 *  end of the author's body, where the DOM they operate on already exists. */
function withHostScripts(doc: string): string {
  const scripts = RESIZE_SCRIPT + SELECT_SCRIPT;
  const closing = doc.lastIndexOf('</body>');
  if (closing === -1) return doc + scripts;
  return doc.slice(0, closing) + scripts + doc.slice(closing);
}

/** True when `value` is a height report from `frame`'s document. */
export function isInsightHeightMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): event is MessageEvent<{ type: string; height: number }> {
  // The frame has an opaque origin, so `event.origin` is the string "null" for
  // every sandboxed frame on the page — identity has to come from the source
  // window instead.
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as { type?: unknown; height?: unknown } | null;
  return (
    !!data &&
    data.type === INSIGHT_HEIGHT_MESSAGE &&
    typeof data.height === 'number' &&
    Number.isFinite(data.height)
  );
}

/** True when `value` is the primer in `frame` reporting that the frame is sized. */
export function isInsightFrameReadyMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): boolean {
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as { type?: unknown } | null;
  return !!data && typeof data === 'object' && data.type === INSIGHT_FRAME_READY_MESSAGE;
}

function isValidRef(ref: unknown): ref is InsightSectionRef {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as {
    key?: unknown;
    path?: unknown;
    tags?: unknown;
    kind?: unknown;
    content?: unknown;
  };
  // Shape only. The host clamps `content` (sanitizeInsightSections) before it
  // is stored, so a document posting a huge string cannot bloat every turn.
  if (r.kind !== undefined && r.kind !== 'element' && r.kind !== 'text') return false;
  if (r.content !== undefined && typeof r.content !== 'string') return false;
  const hasKey = typeof r.key === 'string' && r.key.length > 0;
  if (r.key !== undefined && typeof r.key !== 'string') return false;
  if (r.path !== undefined && !Array.isArray(r.path)) return false;
  const path = Array.isArray(r.path) ? r.path : [];
  if (!path.every((n) => Number.isInteger(n) && n >= 0)) {
    return false;
  }
  // A keyless ref is addressed from <body>, so it is only an address with a path.
  if (!hasKey && path.length === 0) return false;
  if (r.tags !== undefined) {
    if (!Array.isArray(r.tags)) return false;
    if (!r.tags.every((t) => typeof t === 'string')) return false;
  }
  return true;
}

function isValidRect(rect: unknown): rect is InsightPickRect {
  if (!rect || typeof rect !== 'object') return false;
  const r = rect as Record<string, unknown>;
  return ['top', 'left', 'width', 'height'].every((k) => Number.isFinite(r[k]));
}

/** True when `value` is a section report from `frame`'s document. */
export function isInsightSectionsMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): event is MessageEvent<{
  type: string;
  sections: InsightSectionRef[] | null;
  available: number;
}> {
  // Identity comes from the source window, never the origin. Every sandboxed
  // frame reports origin "null", and an approval card in the chat transcript
  // renders a PROPOSED insight on the same page as the open one — an origin
  // check would let that untrusted document post selections for this one.
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as {
    type?: unknown;
    sections?: unknown;
    available?: unknown;
  } | null;
  if (!data || data.type !== INSIGHT_SECTIONS_MESSAGE) return false;
  if (typeof data.available !== 'number' || !Number.isFinite(data.available)) return false;
  if (data.sections === null) return true;
  return Array.isArray(data.sections) && data.sections.every(isValidRef);
}

/** True when `value` is an element pick report from `frame`'s document. */
export function isInsightPickMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): event is MessageEvent<{
  type: string;
  ref: InsightSectionRef | null;
  rect: InsightPickRect | null;
  label: string;
  count?: number;
  session?: number;
}> {
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as {
    type?: unknown;
    ref?: unknown;
    rect?: unknown;
    label?: unknown;
    count?: unknown;
    session?: unknown;
  } | null;
  if (!data || data.type !== INSIGHT_PICK_MESSAGE) return false;
  if (typeof data.label !== 'string') return false;
  // Optional non-negative integers.
  for (const n of [data.count, data.session]) {
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return false;
  }

  if (data.ref === null) {
    return data.rect === null || isValidRect(data.rect);
  }

  return isValidRef(data.ref) && isValidRect(data.rect);
}
