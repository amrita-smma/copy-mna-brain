import { describe, expect, it } from 'vitest';
import { INSIGHT_CSP } from './srcdoc';
import {
  INSIGHT_PRINT_DONE_MESSAGE,
  INSIGHT_PRINT_SETTLE_MS,
  INSIGHT_PRINT_ZOOM,
  buildInsightPrintDoc,
  isInsightPrintDoneMessage,
} from './printDoc';

describe('buildInsightPrintDoc', () => {
  it('is the light-theme srcdoc with the print prelude in its head and the print trigger before </body> (never the dark theme)', () => {
    const html = '<section><h2>Metrics</h2><p>Content</p></section>';
    const printDoc = buildInsightPrintDoc(html);

    expect(printDoc).toContain(INSIGHT_CSP);
    expect(printDoc).toContain(':root{color-scheme:light;}');
    expect(printDoc).not.toContain(':root{color-scheme:dark;}');

    const bodyClose = printDoc.lastIndexOf('</body>');
    const trigger = printDoc.lastIndexOf('window.print()');
    expect(trigger).toBeGreaterThan(printDoc.indexOf(html));
    expect(trigger).toBeLessThan(bodyClose);
    expect(printDoc.lastIndexOf(INSIGHT_PRINT_DONE_MESSAGE)).toBeGreaterThan(printDoc.indexOf(html));
  });

  it('runs the print prelude after the CSP and before any author script', () => {
    const html =
      '<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script></head><body><canvas></canvas></body></html>';
    const printDoc = buildInsightPrintDoc(html);
    const prelude = printDoc.indexOf('window.requestAnimationFrame =');

    expect(prelude).toBeGreaterThan(printDoc.indexOf(INSIGHT_CSP));
    expect(prelude).toBeLessThan(printDoc.indexOf('chart.umd.min.js'));
  });

  it('keeps charts drawable in a hidden frame: timer-backed rAF, Chart.js animation off, CSS animation zeroed', () => {
    const printDoc = buildInsightPrintDoc('<canvas></canvas>');

    expect(printDoc).toContain('setTimeout(run, 16)');
    expect(printDoc).toContain('value.defaults.animation = false');
    expect(printDoc).toContain('animation-duration:0s!important');
    expect(printDoc).toContain('print-color-adjust:exact');
    expect(printDoc).toContain('canvas{height:auto!important;}');
  });

  it('scales the printed page down so more fits on each page, in print only', () => {
    const printDoc = buildInsightPrintDoc('<p>x</p>');

    expect(INSIGHT_PRINT_ZOOM).toBeLessThan(1);
    expect(printDoc).toContain(`@media print{html{zoom:${INSIGHT_PRINT_ZOOM}!important;}`);
  });

  it('waits for fonts and the settle delay before printing', () => {
    const printDoc = buildInsightPrintDoc('<p>x</p>');

    expect(printDoc).toContain('document.fonts.ready');
    expect(printDoc).toContain(`}, ${INSIGHT_PRINT_SETTLE_MS});`);
  });

  it('works for a fragment with no <html>/<body>', () => {
    const fragment = '<div class="card">Fragment without wrapper</div>';
    const out = buildInsightPrintDoc(fragment);
    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toContain(fragment);
    expect(out.indexOf('window.print()')).toBeGreaterThan(-1);
    expect(out.lastIndexOf('</body>')).toBeGreaterThan(out.indexOf('window.print()'));
  });
});

describe('isInsightPrintDoneMessage', () => {
  const contentWindow = {} as Window;
  const frame = { contentWindow } as HTMLIFrameElement;
  const ev = (source: unknown, data: unknown) => ({ source, data }) as unknown as MessageEvent;
  const done = { type: INSIGHT_PRINT_DONE_MESSAGE };

  it('returns true for matching source and type', () => {
    expect(isInsightPrintDoneMessage(ev(contentWindow, done), frame as never)).toBe(true);
  });

  it.each([
    ['wrong source', ev({}, done), frame],
    ['wrong type', ev(contentWindow, { type: 'other:message' }), frame],
    ['null data', ev(contentWindow, null), frame],
    ['null frame', ev(contentWindow, done), null],
  ])('returns false for %s', (_, event, f) => {
    expect(isInsightPrintDoneMessage(event, f as never)).toBe(false);
  });
});
