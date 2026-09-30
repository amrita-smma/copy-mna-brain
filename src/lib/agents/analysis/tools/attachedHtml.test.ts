import { describe, expect, it } from 'vitest';
import {
  decodeHtml,
  describeRemoved,
  htmlAttachments,
  prepareAttachedHtml,
  resolveHtmlAttachment,
  turnAttachmentRefs,
} from './attachedHtml';
import type { RemovedCounts } from '@/lib/email/emailSafeHtml';

const PREFIX = 'chat-attachments/ws-1/';

function ref(fileName: string, contentType = 'text/html') {
  return { key: `${PREFIX}${fileName}`, fileName, contentType };
}

describe('turnAttachmentRefs', () => {
  it('returns [] when the runtime carries no attachments', () => {
    expect(turnAttachmentRefs(undefined)).toEqual([]);
    expect(turnAttachmentRefs({})).toEqual([]);
  });

  it("prefers this turn's attachments over the thread's earlier ones", () => {
    const now = ref('now.html');
    const before = ref('before.html');
    expect(turnAttachmentRefs({ attachments: [now], priorAttachments: [before] })).toEqual([
      now,
    ]);
  });

  it('falls back to a previous turn so a later "email it" still finds the file', () => {
    const before = ref('before.html');
    expect(turnAttachmentRefs({ attachments: [], priorAttachments: [before] })).toEqual([
      before,
    ]);
  });

  it('drops entries that are not attachment refs', () => {
    expect(turnAttachmentRefs({ attachments: [{ key: 'k' }, 'nope', null] })).toEqual([]);
  });
});

describe('htmlAttachments', () => {
  it('keeps HTML by content type or extension and drops everything else', () => {
    const html = ref('deck.html');
    const htm = ref('legacy.htm', 'application/octet-stream');
    const typed = ref('page', 'text/html; charset=utf-8');
    const pdf = ref('report.pdf', 'application/pdf');
    expect(htmlAttachments([html, htm, typed, pdf])).toEqual([html, htm, typed]);
  });
});

describe('resolveHtmlAttachment', () => {
  it('uses the only attached HTML file when no name is given', () => {
    const only = ref('deck.html');
    expect(resolveHtmlAttachment([only, ref('x.pdf', 'application/pdf')], {})).toEqual({
      ref: only,
      error: null,
    });
  });

  it('refuses to guess between several HTML files', () => {
    const result = resolveHtmlAttachment([ref('a.html'), ref('b.html')], {});
    expect(result.ref).toBeNull();
    expect(result.error).toContain('a.html, b.html');
    expect(result.error).toContain('file_name');
  });

  it('matches a requested name case-insensitively and ignoring any path', () => {
    const target = ref('Deck.html');
    expect(
      resolveHtmlAttachment([ref('other.html'), target], { file_name: 'C:\\docs\\DECK.HTML' }),
    ).toEqual({ ref: target, error: null });
  });

  it('takes the newest upload when the same name was attached twice', () => {
    const older = { ...ref('deck.html'), key: `${PREFIX}1-deck.html` };
    const newer = { ...ref('deck.html'), key: `${PREFIX}2-deck.html` };
    expect(resolveHtmlAttachment([older, newer], { file_name: 'deck.html' })).toEqual({
      ref: newer,
      error: null,
    });
  });

  it('reports what is attached when the requested name is not there', () => {
    const result = resolveHtmlAttachment([ref('deck.html')], { file_name: 'other.html' });
    expect(result.ref).toBeNull();
    expect(result.error).toContain('"other.html"');
    expect(result.error).toContain('deck.html');
  });

  it('tells the user to upload a file when none is attached', () => {
    const result = resolveHtmlAttachment([ref('report.pdf', 'application/pdf')], {});
    expect(result.ref).toBeNull();
    expect(result.error).toContain('no HTML file is attached');
  });
});

describe('decodeHtml', () => {
  it('decodes UTF-8 as-is', () => {
    const html = '<p>Ringkasan — Rp 1.250 miliar</p>';
    expect(decodeHtml(Buffer.from(html, 'utf-8'))).toBe(html);
  });

  it('strips a byte-order mark so it cannot show up in the mail client', () => {
    expect(decodeHtml(Buffer.from('\uFEFF<!doctype html>', 'utf-8'))).toBe('<!doctype html>');
  });
});

describe('prepareAttachedHtml', () => {
  const file = (html: string) => prepareAttachedHtml(Buffer.from(html, 'utf-8'), 'deck.html');

  it('returns the reformatted document and a note about what came out', () => {
    const result = file(
      '<html><body><h1>Q3 pipeline review</h1><p>Eleven targets advanced to L1.</p>' +
        '<script>draw();</script><img src="./logo.png"></body></html>',
    );

    expect(result.error).toBeNull();
    expect(result.html).toContain('Q3 pipeline review');
    expect(result.html).not.toContain('<script');
    expect(result.note).toBe('reformatted for email (removed 1 script and 1 image that could not load)');
  });

  it('says nothing about the rewrite when nothing had to come out', () => {
    const result = file('<html><body><h1>Q3 pipeline review</h1><p>Eleven targets advanced.</p></body></html>');
    expect(result.note).toBeNull();
  });

  it('refuses a JavaScript-rendered page, names the file and quotes what it shows', () => {
    const result = file(
      '<html><body><div id="root"><div>B</div><div>Unpacking...</div></div>' +
        '<script>mount();</script></body></html>',
    );

    expect(result.html).toBeNull();
    expect(result.error).toContain('"deck.html"');
    expect(result.error).toContain('builds its content with JavaScript');
    expect(result.error).toContain('B Unpacking...');
    expect(result.error).toContain('PDF');
  });

  it('refuses an empty file', () => {
    expect(file('   ').error).toContain('empty');
  });

  it('refuses a document that is empty of content without blaming JavaScript', () => {
    const result = file('<html><body><div class="wrapper"></div></body></html>');
    expect(result.html).toBeNull();
    expect(result.error).toContain('no content to send');
    expect(result.error).not.toContain('JavaScript');
  });
});

describe('describeRemoved', () => {
  const counts = (over: Partial<RemovedCounts>): RemovedCounts => ({
    scripts: 0,
    frames: 0,
    canvases: 0,
    unreachableImages: 0,
    stylesheets: 0,
    handlers: 0,
    ...over,
  });

  it('is null when the rewrite took nothing out', () => {
    // Event handlers alone are not worth reporting — the page still reads the same.
    expect(describeRemoved(counts({ handlers: 3 }))).toBeNull();
  });

  it('pluralises and joins what it lists', () => {
    expect(describeRemoved(counts({ scripts: 2 }))).toBe(
      'reformatted for email (removed 2 scripts)',
    );
    expect(describeRemoved(counts({ scripts: 1, canvases: 2, frames: 1 }))).toBe(
      'reformatted for email (removed 1 script, 2 chart canvases and 1 embedded frame)',
    );
  });
});
