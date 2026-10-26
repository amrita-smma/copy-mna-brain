import { describe, expect, it } from 'vitest';
import {
  INSIGHT_CSP,
  INSIGHT_FRAME_READY_MESSAGE,
  INSIGHT_HEIGHT_MESSAGE,
  INSIGHT_SANDBOX,
  INSIGHT_SECTIONS_MESSAGE,
  INSIGHT_SELECT_MODE_MESSAGE,
  INSIGHT_PICK_MESSAGE,
  MAX_INSIGHT_BYTES,
  buildInsightDownloadDoc,
  buildInsightPrimerSrcDoc,
  buildInsightSrcDoc,
  isInsightFrameReadyMessage,
  isInsightHeightMessage,
  isInsightPickMessage,
  isInsightSectionsMessage,
} from './srcdoc';

const CSP = 'Content-Security-Policy';

describe('MAX_INSIGHT_BYTES', () => {
  it('fits a whole document, with its upload envelope, under the 4.5 MB request-body limit', () => {
    expect(MAX_INSIGHT_BYTES).toBe(4 * 1024 * 1024);
    // Vercel rejects a larger request body before the route runs.
    expect(MAX_INSIGHT_BYTES + 64 * 1024).toBeLessThan(4_500_000);
  });
});

describe('INSIGHT_SANDBOX', () => {
  it('grants scripts but never same-origin, navigation or popups', () => {
    expect(INSIGHT_SANDBOX).toContain('allow-scripts');
    // Same-origin would let the frame strip its own sandbox; the others let it move the user.
    for (const banned of ['allow-same-origin', 'allow-top-navigation', 'allow-popups']) {
      expect(INSIGHT_SANDBOX).not.toContain(banned);
    }
  });
});

describe('INSIGHT_CSP', () => {
  const directive = (name: string) => INSIGHT_CSP.split('; ').find((d) => d.startsWith(`${name} `));

  it('denies by default and closes the fetch/XHR and <img> beacon channels', () => {
    expect(INSIGHT_CSP.startsWith("default-src 'none'")).toBe(true);
    expect(INSIGHT_CSP).toContain("connect-src 'none'");
    expect(directive('img-src')).toBe('img-src data: blob:');
  });

  it('allows scripts only from the fixed CDN allowlist', () => {
    const scriptSrc = directive('script-src');
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
    // A wildcard would make any origin reachable and defeat connect-src.
    expect(scriptSrc).not.toContain('*');
    expect(scriptSrc).not.toContain("'self'");
  });
});

describe('buildInsightSrcDoc', () => {
  it.each([
    ['as the first child of an existing <head>', '<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/x.js"></script></head><body>hi</body></html>', 'cdn.jsdelivr.net/x.js'],
    ['after <html> when the document has no <head>', '<html><body><p>bare</p></body></html>', '<p>bare</p>'],
    ['case-insensitively about the head tag', '<HTML><HEAD></HEAD><BODY>x</BODY></HTML>', '</HEAD>'],
  ])('injects the policy ahead of the author content %s', (_, html, marker) => {
    const out = buildInsightSrcDoc(html);
    expect(out.indexOf(CSP)).toBeGreaterThan(-1);
    // A policy declared after a <script> would not cover it.
    expect(out.indexOf(CSP)).toBeLessThan(out.indexOf(marker));
  });

  it('places headExtra after the policy and ahead of the author content', () => {
    const html = '<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/x.js"></script></head><body>hi</body></html>';
    const out = buildInsightSrcDoc(html, { headExtra: '<script>host()</script>' });
    const extra = out.indexOf('<script>host()</script>');
    expect(extra).toBeGreaterThan(out.indexOf(CSP));
    expect(extra).toBeLessThan(out.indexOf('cdn.jsdelivr.net/x.js'));
  });

  it.each([
    ['a <head> inside a leading comment', '<!-- <head> --><script>steal()</script><html><head></head><body>x</body></html>'],
    ['a <head> inside a script string', '<script>var s = "<head>"; steal()</script><html><head></head><body>x</body></html>'],
    ['a <head> inside an attribute value', '<div title="<head>"></div><script>steal()</script>'],
    ['a <html> inside a comment and no real head', '<!-- <html> --><script>steal()</script><p>x</p>'],
    ['a script ahead of the real <head>', '<!DOCTYPE html><script>steal()</script><html><head></head><body>x</body></html>'],
  ])('puts the policy ahead of every author byte when the document has %s', (_, html) => {
    const out = buildInsightSrcDoc(html);
    const policyAt = out.indexOf(CSP);
    expect(policyAt).toBeGreaterThan(-1);
    // The author's first byte comes straight after the host prelude closes.
    const preludeEnd = out.indexOf('</style>') + '</style>'.length;
    expect(policyAt).toBeLessThan(preludeEnd);
    expect(out.slice(preludeEnd).startsWith(html.slice(0, 16))).toBe(true);
    expect(policyAt).toBeLessThan(out.indexOf('steal()'));
  });

  it('opens with the host doctype and head even when the author wrote a full document', () => {
    const html = '<!DOCTYPE html><html lang="id"><head><title>T</title></head><body>x</body></html>';
    const out = buildInsightSrcDoc(html);
    expect(out.startsWith('<!DOCTYPE html><html><head><meta charset="utf-8">')).toBe(true);
    // The author's markup follows untouched; the parser merges it into the host's head.
    expect(out).toContain(html.slice(0, html.indexOf('</body>')));
  });

  it('wraps a bare fragment in a document with the policy and the picker', () => {
    const out = buildInsightSrcDoc('<p>fragment</p>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.indexOf(CSP)).toBeLessThan(out.indexOf('<p>fragment</p>'));
    expect(out).toContain(INSIGHT_SECTIONS_MESSAGE);
  });

  it('declares UTF-8 ahead of the author content, so an em-dash is not mojibake', () => {
    const out = buildInsightSrcDoc('<p>A — B</p>');
    const charsetAt = out.indexOf('charset="utf-8"');
    expect(charsetAt).toBeGreaterThan(-1);
    expect(charsetAt).toBeLessThan(out.indexOf('A — B'));
    // The spec requires the declaration inside the first 1024 bytes.
    expect(charsetAt).toBeLessThan(1024);
  });

  it('handles an empty document without throwing', () => {
    expect(buildInsightSrcDoc('')).toContain(CSP);
  });

  it('adds the height reporter and section picker after the author DOM, before </body>', () => {
    const out = buildInsightSrcDoc('<html><body><p>x</p></body></html>');
    const end = out.lastIndexOf('</body>');
    for (const msg of [INSIGHT_HEIGHT_MESSAGE, INSIGHT_SELECT_MODE_MESSAGE, INSIGHT_SECTIONS_MESSAGE]) {
      expect(out.indexOf(msg)).toBeGreaterThan(out.indexOf('<p>x</p>'));
      expect(out.indexOf(msg)).toBeLessThan(end);
    }
  });

  it('keeps the picker inside the policy it is subject to', () => {
    const out = buildInsightSrcDoc('<p>x</p>');
    expect(out.indexOf(INSIGHT_CSP)).toBeLessThan(out.indexOf(INSIGHT_SECTIONS_MESSAGE));
  });

  it("lets a plain click on the document's own controls through, and keeps a stray highlight from picking", () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    // Losing the control bail-out turns every insight read-only in selection mode.
    expect(out).toContain('if (!multi && isInteractive(target)) return;');
    expect(out).toContain('if (!multi && textSel && !textSel.isCollapsed) return;');
  });

  it('turns text highlighting off in selection mode, so a drag draws a rectangle instead', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    expect(out).toContain('user-select: none !important;');
    // A drag that starts on the document's own control stays that control's.
    expect(out).toContain('if (!multi && isInteractive(e.target)) return;');
    // The click a finished drag fires must not pick again.
    expect(out).toContain('if (suppressClick) {');
  });

  it('deselects everything on a plain click or fresh drag that lands on nothing', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    expect(out).toContain('if (!res) {\n      // A plain click on nothing selectable deselects everything');
    expect(out).toContain('      if (!multi) clearSelection();');
    expect(out).toContain('      if (!additive) clearSelection();');
  });

  it('dismisses a text ask — prompt box and selection — when the highlight goes away', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    // The host never sees a click inside the frame, so the frame must report it.
    expect(out).toContain('if (!sel || sel.isCollapsed) dismissTextAsk();');
    // Asking must not offer the button again for the same highlight.
    expect(out).toContain('if (activePick && activePick.range) return;');
    expect(out).toContain("selected = selected.filter(function (ref) { return ref.kind !== 'text'; });");
    // The host's echo of the new selection must not forget the text pick.
    expect(out).toContain('if (activePick && (armed ? !!activePick.range : !activePick.range)) activePick = null;');
  });

  it('offers to ask about highlighted text only while selection mode is off and askText is on', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    expect(out).toContain('askText = !!data.askText;');
    expect(out).toContain('if (armed || !askText) {');
  });

  it('starts a new pick session on a fresh click, drag or text ask — never on a Ctrl/Cmd extension', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    // The host keys the prompt box on this, so extending a selection must NOT bump it.
    expect(out).toContain('if (!clearing) session++;');
    expect(out).toContain('if (!additive) {\n      selected = [];\n      session++;');
    expect((out.match(/session\+\+/g) ?? []).length).toBe(3);
  });

  it('never paints the devtools-style address badge over the element', () => {
    expect(buildInsightSrcDoc('<p>hi</p>')).not.toContain('data-insight-chip');
  });

  it('paints an opaque background so the insight is never see-through', () => {
    expect(buildInsightSrcDoc('<p>x</p>')).toContain('background:#ffffff');
    expect(buildInsightSrcDoc('<p>x</p>', { theme: 'dark' })).toContain('background:#0b0b0d');
  });

  it('leaves the author markup byte-for-byte intact', () => {
    const authored = '<div class="chart" style="--x:1">A & B <script>1<2</script></div>';
    expect(buildInsightSrcDoc(authored)).toContain(authored);
  });
});

const contentWindow = {} as Window;
const frame = { contentWindow } as HTMLIFrameElement;
const ev = (data: unknown, source: Window = contentWindow) => ({ source, data }) as unknown as MessageEvent;
const RECT = { top: 10, left: 20, width: 100, height: 50 };
const sections = (extra: Record<string, unknown>) => ({ type: INSIGHT_SECTIONS_MESSAGE, available: 4, ...extra });
const pick = (extra: Record<string, unknown> = {}) => ({
  type: INSIGHT_PICK_MESSAGE,
  ref: { key: 'palette' },
  rect: RECT,
  label: 'palette',
  ...extra,
});

describe('message guards frame and window validation', () => {
  const guards = [
    { name: 'isInsightHeightMessage', guard: isInsightHeightMessage, data: { type: INSIGHT_HEIGHT_MESSAGE, height: 420 } },
    { name: 'isInsightFrameReadyMessage', guard: isInsightFrameReadyMessage, data: { type: INSIGHT_FRAME_READY_MESSAGE } },
    { name: 'isInsightSectionsMessage', guard: isInsightSectionsMessage, data: sections({ sections: [{ key: 'r' }] }) },
    { name: 'isInsightPickMessage', guard: isInsightPickMessage, data: pick() },
  ];

  it.each(guards)('$name accepts from its frame, rejects another frame or no frame', ({ guard, data }) => {
    expect(guard(ev(data), frame)).toBe(true);
    expect(guard(ev(data, {} as Window), frame)).toBe(false);
    expect(guard(ev(data), null)).toBe(false);
  });
});

describe('buildInsightPrimerSrcDoc', () => {
  it('reports readiness only once the frame has a real width', () => {
    const primer = buildInsightPrimerSrcDoc();
    expect(primer).toContain(JSON.stringify(INSIGHT_FRAME_READY_MESSAGE));
    expect(primer).toContain('window.innerWidth > 0');
    // A frame that starts at zero size gets its width later, via resize.
    expect(primer).toContain("addEventListener('resize'");
  });

  it('locks the primer down to its own inline script and style', () => {
    expect(buildInsightPrimerSrcDoc()).toContain(
      `http-equiv="${CSP}" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"`,
    );
  });

  it('paints the same page colour as the insight so the swap does not flash', () => {
    expect(buildInsightPrimerSrcDoc('light')).toContain('background:#ffffff');
    expect(buildInsightPrimerSrcDoc('dark')).toContain('background:#0b0b0d');
    expect(buildInsightPrimerSrcDoc('dark')).toContain('<meta name="color-scheme" content="dark">');
  });
});

describe('isInsightFrameReadyMessage', () => {
  it.each([
    ['an unrelated message type', { type: INSIGHT_HEIGHT_MESSAGE, height: 1 }],
    ['a non-object payload', INSIGHT_FRAME_READY_MESSAGE],
    ['a null payload', null],
  ])('rejects %s', (_, data) => {
    expect(isInsightFrameReadyMessage(ev(data), frame)).toBe(false);
  });
});

describe('isInsightHeightMessage', () => {
  it.each([
    ['a non-numeric height', { type: INSIGHT_HEIGHT_MESSAGE, height: 'tall' }],
    ['an unrelated message type', { type: 'something:else', height: 1 }],
  ])('rejects %s', (_, data) => {
    expect(isInsightHeightMessage(ev(data), frame)).toBe(false);
  });
});

describe('isInsightSectionsMessage', () => {
  it.each([
    ['a ref with path', sections({ sections: [{ key: 'r', path: [0, 1] }] })],
    ['a highlighted-text ref with its words', sections({ sections: [{ key: 'r', path: [0], kind: 'text', content: 'hot' }] })],
    ['a null sections list, which is the load-time announcement', sections({ sections: null, available: 0 })],
  ])('accepts %s', (_, data) => {
    expect(isInsightSectionsMessage(ev(data), frame)).toBe(true);
  });

  it.each([
    ['raw strings instead of refs', sections({ sections: ['r'] })],
    ['a non-string key', sections({ sections: [{ key: 123 }] })],
    ['a negative path index', sections({ sections: [{ key: 'r', path: [-1] }] })],
    ['a fractional path index', sections({ sections: [{ key: 'r', path: [1.5] }] })],
    ['an unknown kind', sections({ sections: [{ key: 'r', kind: 'html' }] })],
    ['non-string content', sections({ sections: [{ key: 'r', content: { evil: true } }] })],
    ['a missing available count', { type: INSIGHT_SECTIONS_MESSAGE, sections: [] }],
    ['a NaN available count', sections({ sections: [], available: NaN })],
    ['a height report, so one handler can tell them apart', { type: INSIGHT_HEIGHT_MESSAGE, height: 100 }],
  ])('rejects %s', (_, data) => {
    expect(isInsightSectionsMessage(ev(data), frame)).toBe(false);
  });
});

describe('isInsightPickMessage', () => {
  it.each([
    ['a pick with a path and a count for the whole selection', pick({ ref: { key: 'palette', path: [0, 1] }, count: 3 })],
    ['ref: null with rect: null when a pick is dismissed', pick({ ref: null, rect: null, label: '' })],
  ])('accepts %s', (_, data) => {
    expect(isInsightPickMessage(ev(data), frame)).toBe(true);
  });

  it.each([
    ['a NaN rect number', pick({ rect: { ...RECT, top: NaN } })],
    ['an Infinity rect number', pick({ rect: { ...RECT, left: Infinity } })],
    ['a non-string label', pick({ label: 123 })],
    ['a null rect when ref is present', pick({ rect: null })],
    ['a negative session token', pick({ session: -1 })],
    ['a negative count', pick({ count: -1 })],
    ['a fractional count', pick({ count: 1.5 })],
    ['a string count', pick({ count: '2' })],
  ])('rejects %s', (_, data) => {
    expect(isInsightPickMessage(ev(data), frame)).toBe(false);
  });
});

describe('buildInsightDownloadDoc', () => {
  it('opens the saved file with UTF-8 and the insight CSP ahead of every author byte', () => {
    const html = '<!-- <head> --><script>steal()</script><html><body>x</body></html>';
    const out = buildInsightDownloadDoc(html);
    expect(out.startsWith('<!DOCTYPE html><html><head><meta charset="utf-8">')).toBe(true);
    expect(out.indexOf(INSIGHT_CSP)).toBeLessThan(out.indexOf('steal()'));
    expect(out.endsWith(html)).toBe(true);
  });

  it("leaves out the frame's theme styles and host scripts", () => {
    const out = buildInsightDownloadDoc('<p>x</p>');
    expect(out).not.toContain(INSIGHT_HEIGHT_MESSAGE);
    expect(out).not.toContain(INSIGHT_SECTIONS_MESSAGE);
    expect(out).not.toContain('<style>');
  });
});
