import { describe, it, expect } from 'vitest';
import {
  EMPTY_INSIGHT_UPLOAD_MESSAGE,
  INVALID_INSIGHT_UPLOAD_TYPE_MESSAGE,
  checkInsightUploadHtml,
  insightUploadTooLargeMessage,
  isValidInsightUploadExtension,
  readInsightUploadFile,
  suggestInsightUploadName,
} from './upload';
import { MAX_INSIGHT_BYTES, MAX_INSIGHT_NAME_LENGTH } from './srcdoc';
import { TOO_DEEPLY_NESTED_MESSAGE } from './parseHtml';

const DOC = '<!DOCTYPE html><html><head><title>T</title></head><body><p>x</p></body></html>';

describe('isValidInsightUploadExtension', () => {
  it.each([
    ['report.html', true],
    ['REPORT.HTM', true],
    ['report.html.txt', false],
    ['report', false],
  ])('%s → %s', (name, ok) => {
    expect(isValidInsightUploadExtension(name)).toBe(ok);
  });
});

describe('insightUploadTooLargeMessage', () => {
  it('states both sizes in megabytes', () => {
    expect(insightUploadTooLargeMessage(5.5 * 1024 * 1024)).toBe(
      'The file is 5.5 MB; insights are limited to 4 MB.',
    );
  });

  it('says "just over" for a file that rounds to the cap', () => {
    expect(insightUploadTooLargeMessage(MAX_INSIGHT_BYTES + 10)).toBe(
      'The file is just over 4 MB; insights are limited to 4 MB.',
    );
  });
});

describe('checkInsightUploadHtml', () => {
  it('passes a complete self-contained document with no errors or warnings', () => {
    const html = `<!DOCTYPE html><html><head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      </head><body><img src="data:image/png;base64,AAAA" alt="logo"><p>x</p></body></html>`;
    expect(checkInsightUploadHtml(html)).toEqual({ errors: [], warnings: [] });
  });

  it('refuses an empty file', () => {
    expect(checkInsightUploadHtml(' \n ')).toEqual({ errors: [EMPTY_INSIGHT_UPLOAD_MESSAGE], warnings: [] });
  });

  it('refuses a file over the cap, measured in UTF-8 bytes, not characters', () => {
    // 3 bytes per "—": under the cap in characters, over it in bytes.
    const html = '—'.repeat(Math.ceil(MAX_INSIGHT_BYTES / 3) + 1);
    expect(html.length).toBeLessThan(MAX_INSIGHT_BYTES);
    expect(checkInsightUploadHtml(html).errors).toEqual([
      expect.stringMatching(/insights are limited to 4 MB/),
    ]);
  });

  it('warns that scripts and stylesheets off the allowlist will be blocked, naming their hosts', () => {
    const html = `<html><head>
      <script src="https://evil.example.com/a.js"></script>
      <script src="/relative.js"></script>
      <link rel="stylesheet" href="https://styles.example.org/s.css">
      <link rel="icon" href="https://icons.example.net/i.png">
      </head><body><p>x</p></body></html>`;
    const [warning] = checkInsightUploadHtml(html).warnings;
    expect(warning).toContain('https://evil.example.com');
    expect(warning).toContain('/relative.js');
    expect(warning).toContain('https://styles.example.org');
    // An icon link is not a stylesheet.
    expect(warning).not.toContain('icons.example.net');
    expect(warning).toContain('https://cdn.jsdelivr.net');
  });

  it('warns that linked images will not show, but not embedded ones', () => {
    const html = '<p><img src="https://x.example.com/a.png"><img src="b.png"><img src="data:image/gif;base64,R0"></p>';
    expect(checkInsightUploadHtml(html).warnings).toEqual([
      "2 images load from a link and won't show. Only images embedded in the file (data: URLs) render.",
    ]);
  });

  it('refuses a file nested too deeply, quickly, instead of freezing the tab', () => {
    const started = performance.now();
    expect(checkInsightUploadHtml(('<div>' + '<i>x</i>'.repeat(200)).repeat(600))).toEqual({
      errors: [TOO_DEEPLY_NESTED_MESSAGE],
      warnings: [],
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('carries the cut-off structure warnings', () => {
    expect(checkInsightUploadHtml('<html><body><p>x</p>').warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/<body> tag is never closed/)]),
    );
  });
});

describe('readInsightUploadFile', () => {
  it('returns the text of a valid HTML file', async () => {
    expect(await readInsightUploadFile(new File([DOC], 'a.html'))).toEqual({ ok: true, html: DOC });
  });

  it.each([
    ['a non-HTML file', new File([DOC], 'a.pdf'), INVALID_INSIGHT_UPLOAD_TYPE_MESSAGE],
    ['an empty file', new File([], 'a.html'), EMPTY_INSIGHT_UPLOAD_MESSAGE],
  ])('refuses %s', async (_label, file, error) => {
    expect(await readInsightUploadFile(file)).toEqual({ ok: false, error });
  });

  it('refuses a file over the cap without reading it', async () => {
    const file = new File([new Uint8Array(MAX_INSIGHT_BYTES + 1)], 'big.html');
    const result = await readInsightUploadFile(file);
    expect(result).toEqual({ ok: false, error: insightUploadTooLargeMessage(MAX_INSIGHT_BYTES + 1) });
  });
});

describe('suggestInsightUploadName', () => {
  it("uses the document's <title>, with whitespace collapsed", () => {
    expect(suggestInsightUploadName('file.html', '<title>  Q3\n  Review </title><p>x</p>')).toBe('Q3 Review');
  });

  it('falls back to the file name without its extension', () => {
    expect(suggestInsightUploadName('Board pack.v2.html', '<p>x</p>')).toBe('Board pack.v2');
  });

  it('trims a long title to the name cap', () => {
    const name = suggestInsightUploadName('f.html', `<title>${'a'.repeat(300)}</title>`);
    expect(name).toHaveLength(MAX_INSIGHT_NAME_LENGTH);
  });

  it('falls back to the file name for a document too deep to read the title from', () => {
    expect(suggestInsightUploadName('deep.html', '<title>T</title>' + '<div>'.repeat(100_000))).toBe('deep');
  });

  it('never returns an empty name', () => {
    expect(suggestInsightUploadName('.html', '<title> </title>')).toBe('Uploaded insight');
  });
});
