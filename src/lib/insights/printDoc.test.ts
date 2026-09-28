import { describe, expect, it } from 'vitest';
import { INSIGHT_CSP, buildInsightSrcDoc } from './srcdoc';
import {
  INSIGHT_PRINT_DONE_MESSAGE,
  buildInsightPrintDoc,
  isInsightPrintDoneMessage,
} from './printDoc';

describe('buildInsightPrintDoc', () => {
  it('equals the light-theme srcdoc plus the print trigger before </body> (never the dark theme)', () => {
    const html = '<section><h2>Metrics</h2><p>Content</p></section>';
    const printDoc = buildInsightPrintDoc(html);
    const lightDoc = buildInsightSrcDoc(html, { theme: 'light' });

    expect(printDoc).toContain(INSIGHT_CSP);
    expect(printDoc).toContain(':root{color-scheme:light;}');
    expect(printDoc).not.toContain(':root{color-scheme:dark;}');

    const bodyClose = lightDoc.lastIndexOf('</body>');
    const beforeBody = lightDoc.slice(0, bodyClose);
    const afterBody = lightDoc.slice(bodyClose);
    expect(printDoc.startsWith(beforeBody)).toBe(true);
    expect(printDoc.endsWith(afterBody)).toBe(true);
    const inserted = printDoc.slice(beforeBody.length, printDoc.length - afterBody.length);
    expect(inserted).toContain('window.print()');
    expect(inserted).toContain(INSIGHT_PRINT_DONE_MESSAGE);
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
