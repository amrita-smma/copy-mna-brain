import { describe, expect, it } from 'vitest';
import {
  EMAIL_DOCUMENT_CLASS,
  meaningfulText,
  scriptByteCount,
  rewriteRootSelectors,
  toEmailSafeHtml,
} from './emailSafeHtml';

const page = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const PROSE =
  '<h1>Q3 pipeline review</h1><p>Eleven targets advanced to L1 this quarter, led by two coal logistics deals.</p>';

describe('toEmailSafeHtml', () => {
  it('keeps the static content and drops the scripts around it', () => {
    const result = toEmailSafeHtml(
      page(`${PROSE}<script>renderCharts();</script>`, '<script src="https://cdn/x.js"></script>'),
    );

    expect(result.failure).toBeNull();
    expect(result.html).toContain('Q3 pipeline review');
    expect(result.html).toContain('coal logistics');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('renderCharts');
    expect(result.removed.scripts).toBe(2);
  });

  it('wraps the content so the document can be styled without repainting the email', () => {
    const result = toEmailSafeHtml(page(PROSE));
    expect(result.html).toContain(`<div class="${EMAIL_DOCUMENT_CLASS}">`);
  });

  it('refuses a page whose content only exists once its JavaScript runs', () => {
    const result = toEmailSafeHtml(
      page(
        '<div id="root"></div><noscript>This page requires JavaScript to display.</noscript><script>mount(document.getElementById("root"));</script>',
      ),
    );

    expect(result.html).toBeNull();
    expect(result.failure).toBe('js-only');
  });

  it('never lets the noscript apology through as content', () => {
    const result = toEmailSafeHtml(
      page(`<noscript>This page requires JavaScript to display.</noscript>${PROSE}`),
    );
    expect(result.html).not.toContain('requires JavaScript');
    expect(result.html).toContain('Q3 pipeline review');
  });

  it('refuses a loading shell — the "B / Unpacking…" email', () => {
    const result = toEmailSafeHtml(
      page(
        '<div id="root"><div class="logo">B</div><div class="loader">Unpacking...</div></div>' +
          '<script src="/static/bundle.js"></script>',
      ),
    );

    expect(result.html).toBeNull();
    expect(result.failure).toBe('js-only');
    // Quoted back so the sender recognises what the recipient would have seen.
    expect(result.residue).toContain('Unpacking');
  });

  it('refuses a loading shell whose logo is artwork rather than a letter', () => {
    const result = toEmailSafeHtml(
      page(
        '<div id="root"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' +
          '<p>Loading…</p></div><script src="/app.js"></script>',
      ),
    );

    expect(result.failure).toBe('js-only');
  });

  it('refuses a bundle that renders a line or two, however it is worded', () => {
    // No spinner wording to key off — just a big file with almost nothing in it.
    const result = toEmailSafeHtml(
      page(
        `<div class="shell"><h1>Acme</h1><p>Report</p></div><script>${'x'.repeat(30_000)}</script>`,
      ),
    );

    expect(result.failure).toBe('js-only');
  });

  it('refuses a mount point left empty, even under a longer static header', () => {
    const result = toEmailSafeHtml(
      page(
        '<header><h1>Investment Brain</h1><p>Portfolio report, generated 30 September.</p></header>' +
          '<div id="app"></div><script src="/app.js"></script>',
      ),
    );

    expect(result.failure).toBe('js-only');
  });

  it('still sends a real document that happens to carry a script', () => {
    const result = toEmailSafeHtml(
      page(
        `${PROSE}<p>Coal logistics led the quarter, with two targets clearing L1 screening and a third pending NBO.</p><script>track();</script>`,
      ),
    );

    expect(result.failure).toBeNull();
    expect(result.html).toContain('Coal logistics');
  });

  it('sends a chart-only report even when an analytics snippet is present', () => {
    const result = toEmailSafeHtml(
      page('<img src="https://cdn.example.com/q3-chart.png" alt="Q3"><script>track();</script>'),
    );
    expect(result.failure).toBeNull();
    expect(result.html).toContain('q3-chart.png');
  });

  it('sends a short static memo that only carries analytics', () => {
    const result = toEmailSafeHtml(
      page('<h1>Approved</h1><p>Proceed to L1.</p><script>ga();</script>'),
    );
    expect(result.failure).toBeNull();
    expect(result.html).toContain('Approved');
  });

  it('refuses an Indonesian loading shell the same way as an English one', () => {
    const result = toEmailSafeHtml(
      page(
        '<div id="root"><img src="https://cdn.example.com/logo.png"><p>Memuat...</p></div>' +
          '<script src="/app.js"></script>',
      ),
    );
    expect(result.failure).toBe('js-only');
    expect(result.residue).toMatch(/Memuat/i);
  });

  it('refuses a wordless shell whose spinner is drawn in CSS', () => {
    // No spinner copy at all — the floor has to hold without recognising words.
    const result = toEmailSafeHtml(
      page(
        '<div class="shell"><div class="logo">B</div><div class="spinner"></div></div>' +
          '<script src="/app.js"></script>',
        '<style>.spinner{animation:spin 1s linear infinite}</style>',
      ),
    );

    expect(result.failure).toBe('js-only');
    expect(result.residue).toBe('B');
  });

  it('refuses a shell whose loading copy is in a language nobody listed', () => {
    const result = toEmailSafeHtml(
      page('<div id="root"><p>Caricamento…</p></div><script src="/app.js"></script>'),
    );

    expect(result.failure).toBe('js-only');
  });

  it('refuses a logo-only page that is mostly JavaScript', () => {
    const result = toEmailSafeHtml(
      page(
        `<img src="https://cdn.example.com/logo.png"><script>${'x'.repeat(25_000)}</script>`,
      ),
    );

    expect(result.failure).toBe('js-only');
  });

  it('sends a report that embeds a large image and carries a small script', () => {
    // The bundle test measures script bytes, not file size, so an inlined
    // picture does not make a document look like an app.
    const result = toEmailSafeHtml(
      page(
        `${PROSE}<p>Coal logistics led the quarter, with two targets clearing L1 screening.</p>` +
          `<img src="data:image/png;base64,${'A'.repeat(60_000)}"><script>track();</script>`,
      ),
    );

    expect(result.failure).toBeNull();
    expect(result.html).toContain('Coal logistics');
  });

  it('reports an empty document as empty, not as a JavaScript page', () => {
    expect(toEmailSafeHtml(page('<div></div>')).failure).toBe('empty');
    expect(toEmailSafeHtml('').failure).toBe('empty');
  });

  it('treats a chart-only page with no text as JavaScript-built', () => {
    const result = toEmailSafeHtml(
      page('<canvas id="c" width="600" height="300"></canvas><script>draw();</script>'),
    );
    expect(result.failure).toBe('js-only');
    expect(result.removed.canvases).toBe(1);
  });

  it('keeps a picture-only document — there is something to show', () => {
    const result = toEmailSafeHtml(page('<img src="https://cdn.example.com/chart.png" alt="chart">'));
    expect(result.failure).toBeNull();
    expect(result.html).toContain('chart.png');
  });

  it('strips event handlers and javascript: URLs', () => {
    const result = toEmailSafeHtml(
      page(`${PROSE}<a href="javascript:steal()" onclick="steal()">click</a>`),
    );
    expect(result.html).not.toContain('onclick');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).toContain('click');
    expect(result.removed.handlers).toBe(1);
  });

  it('neutralises javascript: and expression() in inline styles and style blocks', () => {
    const result = toEmailSafeHtml(
      page(
        `${PROSE}<p style="background:url(javascript:alert(1))">x</p>`,
        '<style>body { background:url(javascript:alert(1)); } .x { behavior:url(x.htc) }</style>',
      ),
    );
    expect(result.html).not.toMatch(/javascript:/i);
    expect(result.html).not.toContain('behavior:url');
    expect(result.html).toContain('Q3 pipeline review');
    // The emptied url() leaves no dangling quote behind, which would make the
    // declaration unparseable and could take the rest of the rule with it.
    expect(result.html).toContain('url()');
    expect(result.html).not.toMatch(/url\(['"]\)/);
  });

  it('allows a short static page that is still a real note', () => {
    const result = toEmailSafeHtml(page('<h1>Approved</h1><p>Proceed to L1.</p>'));
    expect(result.failure).toBeNull();
    expect(result.html).toContain('Approved');
  });

  it('drops images the recipient could never load and keeps the ones they can', () => {
    const result = toEmailSafeHtml(
      page(
        `${PROSE}<img src="./assets/logo.png"><img src="blob:https://app/x"><img src="data:image/png;base64,AAA"><img src="https://cdn.example.com/x.png">`,
      ),
    );
    expect(result.removed.unreachableImages).toBe(2);
    expect(result.html).toContain('data:image/png;base64,AAA');
    expect(result.html).toContain('https://cdn.example.com/x.png');
    expect(result.html).not.toContain('./assets/logo.png');
  });

  it('drops iframes, external stylesheets and form controls', () => {
    const result = toEmailSafeHtml(
      page(
        `<form action="/x"><input name="q"><button>Go</button>${PROSE}</form><iframe src="https://x"></iframe>`,
        '<link rel="stylesheet" href="https://cdn/app.css">',
      ),
    );
    expect(result.html).not.toContain('<iframe');
    expect(result.html).not.toContain('<input');
    expect(result.html).not.toContain('<button');
    expect(result.html).not.toContain('<form');
    // The form's prose survives the unwrap.
    expect(result.html).toContain('Q3 pipeline review');
    expect(result.removed.frames).toBe(1);
    expect(result.removed.stylesheets).toBe(1);
  });

  it("carries the document's own styles, re-rooted onto the wrapper", () => {
    const result = toEmailSafeHtml(
      page(PROSE, '<style>@import url(https://x/a.css); body { background:#111; } h1 { color:red }</style>'),
    );
    expect(result.html).toContain('<style>');
    expect(result.html).toContain(`.${EMAIL_DOCUMENT_CLASS} { background:#111; }`);
    expect(result.html).toContain('h1 { color:red }');
    expect(result.html).not.toContain('@import');
  });

  it('keeps a document that has prose around a JavaScript-drawn chart', () => {
    const result = toEmailSafeHtml(
      page(
        `${PROSE}<canvas id="ebitda"></canvas><table><tr><td>EBITDA</td><td>Rp 1.2t</td></tr></table><script src="https://cdn/chart.js"></script>`,
      ),
    );

    expect(result.failure).toBeNull();
    expect(result.html).toContain('EBITDA');
    expect(result.html).toContain('<table>');
    expect(result.html).not.toContain('<canvas');
    expect(result.removed.canvases).toBe(1);
    expect(result.removed.scripts).toBe(1);
  });

  it('drops comments, so nothing hidden in the source rides along', () => {
    const result = toEmailSafeHtml(page(`<!-- internal: do not send -->${PROSE}`));
    expect(result.html).not.toContain('do not send');
  });

  it('accepts a bare fragment with no html/body wrapper', () => {
    const result = toEmailSafeHtml(PROSE);
    expect(result.failure).toBeNull();
    expect(result.html).toContain('Q3 pipeline review');
  });
});

describe('rewriteRootSelectors', () => {
  it('re-roots html and body, including descendant and compound selectors', () => {
    expect(rewriteRootSelectors('html, body { margin:0 }')).toBe(
      `.${EMAIL_DOCUMENT_CLASS}, .${EMAIL_DOCUMENT_CLASS} { margin:0 }`,
    );
    expect(rewriteRootSelectors('body > .card { color:red }')).toBe(
      `.${EMAIL_DOCUMENT_CLASS} > .card { color:red }`,
    );
  });

  it('leaves other selectors alone, including ones that merely contain the word', () => {
    expect(rewriteRootSelectors('.bodyguard { color:red }')).toBe('.bodyguard { color:red }');
    expect(rewriteRootSelectors('#main .row { gap:8px }')).toBe('#main .row { gap:8px }');
  });
});

describe('meaningfulText', () => {
  it('discounts what a page says while it waits for its scripts', () => {
    expect(meaningfulText('B Unpacking...')).toBe('B');
    expect(meaningfulText('Loading… please wait')).toBe('');
    expect(meaningfulText('This page requires JavaScript to display.')).toBe('to display.');
  });

  it('leaves real prose alone', () => {
    expect(meaningfulText('Eleven targets advanced to L1 this quarter')).toBe(
      'Eleven targets advanced to L1 this quarter',
    );
  });

  it('keeps decimals and hyphenated words when stripping boilerplate', () => {
    expect(meaningfulText('Rp 1.2t from self-service exports')).toBe(
      'Rp 1.2t from self-service exports',
    );
  });
});

describe('scriptByteCount', () => {
  it('measures the script text a file carries, ignoring the rest', () => {
    expect(scriptByteCount('<p>hello</p>')).toBe(0);
    expect(scriptByteCount('<script>ab</script><p>x</p><script>c</script>')).toBe(
      '<script>ab</script>'.length + '<script>c</script>'.length,
    );
  });
});
