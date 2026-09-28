import { describe, expect, it } from 'vitest';
import {
  formatInsightTemplateBlock,
  formatInsightTemplatePart,
  formatLargeHtmlAttachmentBlock,
  formatLargeInsightForChat,
  isHtmlAttachment,
  LARGE_DOCUMENT_OUTLINE_MAX_CHARS,
  largeTemplateHandoffInstruction,
  templatePartCount,
  WORKFORCE_TEMPLATE_PART_CHARS,
} from './largeDocument';
import {
  CHAT_INLINE_DOCUMENT_MAX_CHARS,
  isTooLargeInsightTemplateBlock,
  parseInsightTemplateBlock,
} from './templateAttachment';

const ID = '00000000-0000-0000-0000-00000000e001';

/** A keyed template document of at least `minChars` characters. */
function bigTemplate(minChars: number): string {
  const sections: string[] = [];
  let i = 0;
  let length = 0;
  while (length < minChars) {
    const section = `<section data-section="block-${i}"><h2>Heading ${i}</h2><table><thead><tr><th>Metric ${i}</th><th>Value</th></tr></thead><tbody><tr><td>Sample row ${i}</td><td>${'9'.repeat(400)}</td></tr></tbody></table><p>${'Sample paragraph text. '.repeat(20)}</p></section>`;
    sections.push(section);
    length += section.length;
    i += 1;
  }
  return `<!doctype html><html><head><style>body{color:#111}</style></head><body>${sections.join('')}</body></html>`;
}

describe('formatInsightTemplateBlock', () => {
  it('inlines the full HTML of a template at or under the chat cap, with the build rules', () => {
    const block = formatInsightTemplateBlock(
      { id: ID, name: 'Market Brief', description: 'Deal landscape' },
      '<section data-section="summary">Sample</section>',
    );

    expect(block.startsWith(`<insight_template id="${ID}" name="Market Brief">`)).toBe(true);
    expect(block).toContain('SAMPLE content');
    expect(block).toContain('Description: Deal landscape');
    expect(block).toContain('<template_html>\n<section data-section="summary">Sample</section>\n</template_html>');
    expect(block).toContain(
      `- When you create the insight, pass template_id ${ID} to propose_insight_create (or create_insight in a Workforce run), so the insight records which template it came from.`,
    );
    expect(block.endsWith('</insight_template>')).toBe(true);
    expect(isTooLargeInsightTemplateBlock(block)).toBe(false);
  });

  it('inlines a template exactly at the chat cap', () => {
    const html = 'x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS);
    const block = formatInsightTemplateBlock({ id: ID, name: 'T' }, html);

    expect(block).toContain(html);
    expect(isTooLargeInsightTemplateBlock(block)).toBe(false);
  });

  it('gives an outline and the handoff rule — and no HTML — for a template over the chat cap', () => {
    const html = bigTemplate(80_000);
    const block = formatInsightTemplateBlock({ id: ID, name: 'Huge' }, html);

    expect(isTooLargeInsightTemplateBlock(block)).toBe(true);
    expect(parseInsightTemplateBlock(block)).toEqual({ id: ID, name: 'Huge' });
    expect(block).toContain(`template_id ${ID}, ${html.length.toLocaleString('en-US')} characters`);
    expect(block).not.toContain('<template_html>');
    expect(block).not.toContain('<style>');
    expect(block).not.toContain('9'.repeat(400));
    for (const line of largeTemplateHandoffInstruction(ID)) expect(block).toContain(line);
    expect(block).toContain('Do NOT call propose_insight_create');
    expect(block).toContain(`put "template_id ${ID}" in the instruction`);
    // The outline keeps the section keys and headings.
    expect(block).toContain('<template_outline>');
    expect(block).toContain('block-0');
    expect(block).toContain('Heading 0');
    expect(block.endsWith('</insight_template>')).toBe(true);
  });

  it('keeps the outline within its budget and points the truncation note at the Workforce', () => {
    const html = bigTemplate(200_000);
    const block = formatInsightTemplateBlock({ id: ID, name: 'Huge' }, html);
    const outline = block.slice(
      block.indexOf('<template_outline>\n') + '<template_outline>\n'.length,
      block.indexOf('\n</template_outline>'),
    );

    expect(outline.length).toBeLessThanOrEqual(LARGE_DOCUMENT_OUTLINE_MAX_CHARS);
    expect(outline).toContain('[truncated:');
    expect(outline).toContain('The Workforce reads the full template with get_insight_template.');
    expect(outline).not.toContain('Call get_insight');
  });
});

describe('formatInsightTemplatePart', () => {
  const template = { id: ID, name: 'Huge' };

  it('reads a template under one part size whole, as part 1 of 1', () => {
    const html = '<section data-section="a">A</section>';
    const out = formatInsightTemplatePart(template, html, 1);

    expect(out).toContain(`part 1 of 1, chars 1–${html.length} of ${html.length}; this is the whole template.`);
    expect(out).toContain(`<template_html part="1" of="1">\n${html}\n</template_html>`);
    expect(out).toContain(`Pass template_id ${ID} to create_insight`);
  });

  it('cuts the HTML into consecutive parts at the part boundary', () => {
    const html = 'a'.repeat(WORKFORCE_TEMPLATE_PART_CHARS) + 'b'.repeat(WORKFORCE_TEMPLATE_PART_CHARS) + 'c'.repeat(5);
    expect(templatePartCount(html.length)).toBe(3);

    const first = formatInsightTemplatePart(template, html, 1);
    const second = formatInsightTemplatePart(template, html, 2);
    const last = formatInsightTemplatePart(template, html, 3);

    expect(first).toContain('part 1 of 3, chars 1–60,000 of 120,005; call again with part 2 until 3.');
    expect(first).toContain('Read EVERY part (1 to 3) before you build anything');
    expect(first).toContain(`<template_html part="1" of="3">\n${'a'.repeat(WORKFORCE_TEMPLATE_PART_CHARS)}\n</template_html>`);

    expect(second).toContain('part 2 of 3, chars 60,001–120,000 of 120,005; call again with part 3 until 3.');
    expect(second).toContain(`\n${'b'.repeat(WORKFORCE_TEMPLATE_PART_CHARS)}\n`);
    expect(second).not.toContain('a'.repeat(10));
    // The build rules ride on part 1 only.
    expect(second).not.toContain('Read EVERY part');

    expect(last).toContain('part 3 of 3, chars 120,001–120,005 of 120,005; this is the last part — you now have the whole template.');
    expect(last).toContain(`<template_html part="3" of="3">\nccccc\n</template_html>`);
  });

  it('never emits a part larger than the part size', () => {
    const html = 'z'.repeat(WORKFORCE_TEMPLATE_PART_CHARS * 2);
    const out = formatInsightTemplatePart(template, html, 2);
    const body = out.slice(out.indexOf('of="2">\n') + 'of="2">\n'.length, out.indexOf('\n</template_html>'));

    expect(body.length).toBe(WORKFORCE_TEMPLATE_PART_CHARS);
    expect(out).toContain('this is the last part');
  });

  it.each([0, 3, 1.5, -1])('refuses part %s, naming the valid range', (part) => {
    const html = 'a'.repeat(WORKFORCE_TEMPLATE_PART_CHARS + 1);
    const out = formatInsightTemplatePart(template, html, part);

    expect(out).toContain(`Part ${part} is out of range`);
    expect(out).toContain('has 2 parts');
    expect(out).toContain('a part from 1 to 2');
    expect(out).not.toContain('<template_html');
  });

  it('counts an empty template as one part', () => {
    expect(templatePartCount(0)).toBe(1);
  });
});

describe('isHtmlAttachment', () => {
  it.each([
    ['text/html', 'x.txt', true],
    ['text/html; charset=utf-8', 'x', true],
    ['application/octet-stream', 'Report.HTML', true],
    ['', 'page.htm', true],
    ['text/plain', 'notes.txt', false],
    ['text/csv', 'data.csv', false],
  ])('%s / %s → %s', (contentType, fileName, expected) => {
    expect(isHtmlAttachment(contentType, fileName)).toBe(expected);
  });
});

describe('formatLargeHtmlAttachmentBlock', () => {
  it('keeps the attached-file prefix, and gives an outline and the handoff rule instead of the text', () => {
    const html = bigTemplate(80_000);
    const block = formatLargeHtmlAttachmentBlock('brief.html', html);

    expect(block.startsWith('Attached file "brief.html":\n\n')).toBe(true);
    expect(block).toContain(`chars="${html.length}" status="too-large-for-chat"`);
    expect(block).toContain('propose_workforce_handoff');
    expect(block).toContain('refer to the attached file "brief.html" by name');
    expect(block).toContain('The file travels with the handoff');
    expect(block).toContain('Do NOT call propose_insight_create');
    expect(block).toContain('block-0');
    expect(block).not.toContain('<style>');
    expect(block).not.toContain('9'.repeat(400));
  });
});

describe('formatLargeInsightForChat', () => {
  const html = bigTemplate(CHAT_INLINE_DOCUMENT_MAX_CHARS * 2);
  const block = formatLargeInsightForChat({ id: ID, name: 'Capital deployment', html });

  it('states the size against the chat cap and withholds the HTML', () => {
    expect(block).toContain(`${html.length.toLocaleString('en-US')} characters`);
    expect(block).toContain('too large to edit in chat');
    expect(block).not.toContain('<table>');
    expect(block).not.toContain('body{color:#111}');
  });

  it('forbids propose_insight_edit and hands the edit to the Workforce with the insight id and the selection', () => {
    expect(block).toContain('Do NOT call propose_insight_edit');
    expect(block).toContain('Call propose_workforce_handoff');
    expect(block).toContain(`insight_id ${ID}`);
    expect(block).toContain('section key or element path');
    expect(block).toContain('previous version stays in the insight');
  });

  it('carries a bounded outline of the sections', () => {
    const outline = block.slice(block.indexOf('<insight_outline>'), block.indexOf('</insight_outline>'));
    expect(outline).toContain('block-0');
    expect(outline.length).toBeLessThanOrEqual(LARGE_DOCUMENT_OUTLINE_MAX_CHARS + '<insight_outline>\n'.length);
  });
});
