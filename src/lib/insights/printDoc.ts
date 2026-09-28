import { buildInsightSrcDoc } from './srcdoc';

export const INSIGHT_PRINT_DONE_MESSAGE = 'insight:print-done';

/**
 * Inline script that triggers printing inside the sandboxed document and notifies
 * the parent window when printing is complete.
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
    }, 500);
  }
  if (document.readyState === 'complete') {
    doPrint();
  } else {
    window.addEventListener('load', doPrint);
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
  const baseDoc = buildInsightSrcDoc(html, { theme: 'light' });
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
