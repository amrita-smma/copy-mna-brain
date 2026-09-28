import { describe, expect, it } from 'vitest';
import {
  INSIGHT_CSP,
  INSIGHT_HEIGHT_MESSAGE,
  INSIGHT_SANDBOX,
  INSIGHT_SECTIONS_MESSAGE,
  INSIGHT_SELECT_MODE_MESSAGE,
  INSIGHT_PICK_MESSAGE,
  buildInsightSrcDoc,
  isInsightHeightMessage,
  isInsightPickMessage,
  isInsightSectionsMessage,
} from './srcdoc';

const CSP = 'Content-Security-Policy';

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

  it("lets a plain click on the document's own controls or a text drag through, so an always-armed insight still works", () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    // Losing either bail-out turns every insight read-only / makes reading a pick.
    expect(out).toContain('if (!multi && isInteractive(target)) return;');
    expect(out).toContain('if (!multi && textSel && !textSel.isCollapsed) return;');
  });

  it('bumps the pick session only when a plain click aims somewhere new', () => {
    const out = buildInsightSrcDoc('<p>hi</p>');
    // The host keys the prompt box on this, so a Ctrl/Cmd-click must NOT bump it.
    expect(out).toContain('if (!clearing) session++;');
    expect((out.match(/session\+\+/g) ?? []).length).toBe(1);
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
    { name: 'isInsightSectionsMessage', guard: isInsightSectionsMessage, data: sections({ sections: [{ key: 'r' }] }) },
    { name: 'isInsightPickMessage', guard: isInsightPickMessage, data: pick() },
  ];

  it.each(guards)('$name accepts from its frame, rejects another frame or no frame', ({ guard, data }) => {
    expect(guard(ev(data), frame)).toBe(true);
    expect(guard(ev(data, {} as Window), frame)).toBe(false);
    expect(guard(ev(data), null)).toBe(false);
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
    ['a null sections list, which is the load-time announcement', sections({ sections: null, available: 0 })],
  ])('accepts %s', (_, data) => {
    expect(isInsightSectionsMessage(ev(data), frame)).toBe(true);
  });

  it.each([
    ['raw strings instead of refs', sections({ sections: ['r'] })],
    ['a non-string key', sections({ sections: [{ key: 123 }] })],
    ['a negative path index', sections({ sections: [{ key: 'r', path: [-1] }] })],
    ['a fractional path index', sections({ sections: [{ key: 'r', path: [1.5] }] })],
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
