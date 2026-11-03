import { buildInsightSrcDoc } from './srcdoc';

export const INSIGHT_PRINT_DONE_MESSAGE = 'insight:print-done';

/** How long the print document waits after `load` and web fonts before printing,
 *  so charts drawn in a `load` handler (and any d3 transition) have finished. */
export const INSIGHT_PRINT_SETTLE_MS = 1200;

/** Print-only scale applied to the whole document, so an exported PDF fits more
 *  on each page. A `zoom` rather than a root `font-size`, because author CSS
 *  sizes text in `px` as often as `rem`; zoom shrinks both, and the layout with
 *  them, so proportions are unchanged. */
export const INSIGHT_PRINT_ZOOM = 0.8;

/**
 * Head markup for the print document, injected ahead of the author's scripts.
 *
 * Charts were printing empty because the print frame is a hidden,
 * opaque-origin (out-of-process) frame, and Chrome stops delivering
 * `requestAnimationFrame` to a cross-origin frame it considers not visible —
 * Chart.js and d3 both animate through it, so the canvas was printed at its
 * first, blank animation frame. This prelude:
 *
 * - backs every `requestAnimationFrame` callback with a timer, so it runs
 *   whether or not the browser delivers frames;
 * - turns Chart.js animation off the moment the UMD bundle assigns
 *   `window.Chart`, so a chart is fully drawn on its first render;
 * - zeroes CSS animations and transitions, so content that fades or grows in is
 *   printed in its final state;
 * - keeps background colours in print (CSS-drawn bars and legend swatches are
 *   backgrounds, which browsers drop by default) and stops a canvas sized for
 *   the frame from overflowing the narrower printed page;
 * - scales the printed page by {@link INSIGHT_PRINT_ZOOM} so more fits per page.
 */
const PRINT_PRELUDE = `<style>
*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition-delay:0s!important;transition-duration:0s!important;}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@media print{html{zoom:${INSIGHT_PRINT_ZOOM}!important;}canvas,img,svg{max-width:100%!important;}canvas{height:auto!important;}}
</style><script>(function(){
  var nativeRaf = window.requestAnimationFrame;
  var nativeCancel = window.cancelAnimationFrame;
  var nextId = 0;
  var pending = {};
  window.requestAnimationFrame = function(cb) {
    var id = ++nextId;
    var entry = { timer: 0, raf: 0 };
    function run() {
      if (!pending[id]) return;
      delete pending[id];
      clearTimeout(entry.timer);
      if (entry.raf && nativeCancel) nativeCancel.call(window, entry.raf);
      cb(performance.now());
    }
    pending[id] = entry;
    entry.timer = setTimeout(run, 16);
    if (nativeRaf) entry.raf = nativeRaf.call(window, run);
    return id;
  };
  window.cancelAnimationFrame = function(id) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    clearTimeout(entry.timer);
    if (entry.raf && nativeCancel) nativeCancel.call(window, entry.raf);
  };
  try {
    Object.defineProperty(window, 'Chart', {
      configurable: true,
      get: function() { return undefined; },
      set: function(value) {
        try {
          if (value && value.defaults) value.defaults.animation = false;
        } catch (_) {}
        Object.defineProperty(window, 'Chart', {
          configurable: true, writable: true, enumerable: true, value: value,
        });
      },
    });
  } catch (_) {}
})();</script>`;

/**
 * Inline script that triggers printing inside the sandboxed document and notifies
 * the parent window when printing is complete. It waits for `load`, then for web
 * fonts, then {@link INSIGHT_PRINT_SETTLE_MS}, so charts are drawn before the
 * page is snapshotted.
 *
 * The trigger must live INSIDE the document rather than being invoked from the
 * parent (e.g. `frame.contentWindow.print()`), because the frame runs with an
 * opaque origin (no `allow-same-origin` in its sandbox). Cross-origin frame
 * access throws a SecurityError in all modern browsers.
 */
const PRINT_TRIGGER_SCRIPT = `<script>(function(){
  var DONE = ${JSON.stringify(INSIGHT_PRINT_DONE_MESSAGE)};
  var posted = false;
  function notifyDone() {
    if (posted) return;
    posted = true;
    try {
      parent.postMessage({ type: DONE }, '*');
    } catch (_) {}
  }
  window.addEventListener('afterprint', notifyDone);
  function doPrint() {
    setTimeout(function() {
      try {
        window.print();
      } catch (_) {}
      notifyDone();
    }, ${INSIGHT_PRINT_SETTLE_MS});
  }
  function afterFonts() {
    var started = false;
    function go() {
      if (started) return;
      started = true;
      doPrint();
    }
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(go, go);
        setTimeout(go, 3000);
        return;
      }
    } catch (_) {}
    go();
  }
  if (document.readyState === 'complete') {
    afterFonts();
  } else {
    window.addEventListener('load', afterFonts);
  }
})();</script>`;

/**
 * Wraps an insight HTML document for printing in a sandboxed iframe.
 *
 * Always uses the 'light' theme regardless of app preferences because paper is white.
 *
 * The print trigger must live INSIDE the document itself: the iframe runs in an
 * opaque origin (due to sandbox restrictions without allow-same-origin), so if the
 * parent window attempts to call `frame.contentWindow.print()`, the browser throws
 * a SecurityError. Running `window.print()` from within the document and messaging
 * the parent via postMessage on completion avoids cross-origin script security errors.
 */
export function buildInsightPrintDoc(html: string): string {
  const baseDoc = buildInsightSrcDoc(html, { theme: 'light', headExtra: PRINT_PRELUDE });
  const closing = baseDoc.lastIndexOf('</body>');
  if (closing === -1) {
    return baseDoc + PRINT_TRIGGER_SCRIPT;
  }
  return baseDoc.slice(0, closing) + PRINT_TRIGGER_SCRIPT + baseDoc.slice(closing);
}

/**
 * Checks whether an incoming MessageEvent is a completion message from the
 * temporary print iframe.
 */
export function isInsightPrintDoneMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): boolean {
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as { type?: unknown } | null;
  return !!data && typeof data === 'object' && data.type === INSIGHT_PRINT_DONE_MESSAGE;
}
