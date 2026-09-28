import { describe, expect, it } from 'vitest';
import {
  INSIGHT_LAYOUT_WARNING_LEAD,
  checkInsightLayout,
  insightLayoutNote,
} from './layoutCheck';

/** A full document with `css` in its head and `body` as its body. */
const doc = (css: string, body = '<div class="deck"><h1>Title</h1><p>Body</p></div>') =>
  `<!DOCTYPE html><html><head><style>${css}</style></head><body>${body}</body></html>`;

describe('checkInsightLayout', () => {
  it.each([
    ['aspect-ratio with overflow:auto', '.deck{width:96vw;aspect-ratio:16/9;overflow:auto}'],
    ['a vh height with overflow:hidden', '.deck{height:100vh;overflow:hidden}'],
    ['a px max-height with overflow-y:scroll', '.deck{max-height:720px;overflow-y:scroll}'],
    ['a calc() vh height with overflow:clip', '.deck{height:calc(100dvh - 40px);overflow:clip}'],
    ['the two-value shorthand clipping y', '.deck{aspect-ratio:16/9;overflow:visible hidden}'],
    ['a rule inside @media', '@media (min-width:800px){.deck{aspect-ratio:16/9;overflow:auto}}'],
    ['the cap and the overflow in separate rules', '.deck{aspect-ratio:16/9}.deck{overflow:auto}'],
    ['a compound selector', 'div.deck{aspect-ratio:16/9;overflow:auto}'],
    ['a descendant selector ending at the container', 'body .deck{aspect-ratio:16/9;overflow:auto}'],
    ['!important declarations', '.deck{aspect-ratio:16/9 !important;overflow:auto !important}'],
  ])('flags %s on a page-level container', (_, css) => {
    const warning = checkInsightLayout(doc(css));
    expect(warning).toMatch(new RegExp(`^${INSIGHT_LAYOUT_WARNING_LEAD}:`));
    expect(warning).toContain('`.deck`');
  });

  it('flags body capped to the viewport with its overflow hidden', () => {
    expect(checkInsightLayout(doc('html,body{height:100%}body{overflow:hidden}'))).toContain('`body`');
  });

  it('flags an inline style on a page-level container', () => {
    const body = '<main id="page" style="height:100vh;overflow:auto"><p>x</p></main>';
    expect(checkInsightLayout(doc('', body))).toContain('`#page`');
  });

  it('follows a single-child wrapper chain down to the container', () => {
    const body = '<main><div class="deck"><p>a</p><p>b</p></div></main>';
    expect(checkInsightLayout(doc('.deck{aspect-ratio:16/9;overflow:auto}', body))).toContain('`.deck`');
  });

  it('checks a bare fragment with no <body>', () => {
    expect(
      checkInsightLayout('<style>.deck{height:90vh;overflow:auto}</style><div class="deck">x</div>'),
    ).toContain('`.deck`');
  });

  it.each([
    ['aspect-ratio without overflow, which grows past its ratio', '.deck{aspect-ratio:16/9}'],
    ['min-height with overflow, which never caps the box', '.deck{min-height:100vh;overflow:auto}'],
    ['a horizontal-only scroller', '.deck{height:100vh;overflow-x:auto}'],
    ['overflow:visible', '.deck{aspect-ratio:16/9;overflow:visible}'],
    ['a later rule restoring visible overflow', '.deck{aspect-ratio:16/9;overflow:auto}.deck{overflow:visible}'],
    ['a percentage height below body, which resolves against auto', '.deck{height:100%;overflow:auto}'],
    ['a rule inside @keyframes', '@keyframes f{from{height:100vh;overflow:hidden}}'],
    ['a selector with a pseudo-class', '.deck:hover{aspect-ratio:16/9;overflow:auto}'],
  ])('passes %s', (_, css) => {
    expect(checkInsightLayout(doc(css))).toBeNull();
  });

  it('passes an inner scroller nested below the page-level containers', () => {
    const body =
      '<div class="page"><header>Head</header><section class="table-wrap"><table></table></section></div><footer>f</footer>';
    expect(checkInsightLayout(doc('.table-wrap{max-height:400px;overflow:auto}', body))).toBeNull();
  });

  it('passes a scripted deck whose fixed-size slides are built at runtime', () => {
    // The slides are not in the source, so their clipping box is not page-level.
    const css = '.slide{width:1280px;height:720px;overflow:hidden}';
    const body = '<div id="deck"></div><script>/* builds .slide elements */</script>';
    expect(checkInsightLayout(doc(css, body))).toBeNull();
  });

  it('ignores commented-out rules', () => {
    expect(checkInsightLayout(doc('/* .deck{aspect-ratio:16/9;overflow:auto} */'))).toBeNull();
  });

  it('names every offender once, in a plural sentence', () => {
    const body = '<div class="a">x</div><div class="b">y</div>';
    const warning = checkInsightLayout(doc('.a,.b{height:100vh;overflow:auto}', body))!;
    expect(warning).toContain('`.a`, `.b` are page-level containers');
  });

  it('returns null for an empty document', () => {
    expect(checkInsightLayout('')).toBeNull();
  });
});

describe('insightLayoutNote', () => {
  const trapped = doc('.deck{aspect-ratio:16/9;overflow:auto}');
  const clean = doc('.deck{aspect-ratio:16/9}');

  it('returns null when the layout lets the page grow', () => {
    expect(insightLayoutNote(clean, 'workforce-document')).toBeNull();
  });

  it('tells a chat proposal to propose a corrected version', () => {
    expect(insightLayoutNote(trapped, 'edit-proposal')).toContain('Propose a corrected version');
    expect(insightLayoutNote(trapped, 'create-proposal')).toContain('Propose a corrected version');
  });

  it('tells a Workforce write to fix it with replace_insight_document', () => {
    expect(insightLayoutNote(trapped, 'workforce-create')).toContain('replace_insight_document');
    expect(insightLayoutNote(trapped, 'workforce-document')).toContain('replace_insight_document');
  });

  it('warns on a section edit only when the edit introduced the pattern', () => {
    expect(insightLayoutNote(trapped, 'workforce-section', clean)).toContain('outside this section');
    // Already there before the edit: the section cannot reach the <style>, so stay quiet.
    expect(insightLayoutNote(trapped, 'workforce-section', trapped)).toBeNull();
  });
});
