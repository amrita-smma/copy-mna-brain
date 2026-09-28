import { describe, expect, it } from 'vitest';
import {
  CHAT_INLINE_DOCUMENT_MAX_CHARS,
  formatMissingInsightTemplateBlock,
  formatTemplateTooLargeMessage,
  INSIGHT_TEMPLATE_MAX_CHARS,
  insightTemplateOpenTag,
  insightTemplatePart,
  isTooLargeForChat,
  isTooLargeInsightTemplateBlock,
  parseInsightTemplateBlock,
  readInsightTemplatePart,
  TOO_LARGE_FOR_CHAT_STATUS,
} from './templateAttachment';

const ID = '00000000-0000-0000-0000-00000000e001';

describe('readInsightTemplatePart', () => {
  it('reads the attached template from a message part list', () => {
    const parts = [{ type: 'text', text: 'create a BBCA insight' }, insightTemplatePart({ id: ID, name: 'Market Brief' })];

    expect(readInsightTemplatePart(parts)).toEqual({ id: ID, name: 'Market Brief' });
  });

  it('returns null when no template part is present', () => {
    expect(readInsightTemplatePart([{ type: 'text', text: 'hi' }])).toBeNull();
    expect(readInsightTemplatePart(undefined)).toBeNull();
  });

  it('rejects a part whose id is not a UUID', () => {
    const parts = [{ type: 'data-insight-template', data: { id: 'not-a-uuid', name: 'X' } }];

    expect(readInsightTemplatePart(parts)).toBeNull();
  });

  it('falls back to a generic name when the name is blank', () => {
    const parts = [{ type: 'data-insight-template', data: { id: ID, name: '   ' } }];

    expect(readInsightTemplatePart(parts)?.name).toBe('Insight template');
  });
});

describe('insightTemplateOpenTag', () => {
  it('escapes the id and name, and adds a status only when given', () => {
    expect(insightTemplateOpenTag({ id: ID, name: 'Q&A "Brief"' })).toBe(
      `<insight_template id="${ID}" name="Q&amp;A &quot;Brief&quot;">`,
    );
    expect(insightTemplateOpenTag({ id: ID, name: 'T' }, 'missing')).toBe(
      `<insight_template id="${ID}" name="T" status="missing">`,
    );
  });
});

describe('isTooLargeInsightTemplateBlock', () => {
  it('matches only a block whose opening tag carries the too-large status', () => {
    expect(isTooLargeInsightTemplateBlock(`${insightTemplateOpenTag({ id: ID, name: 'T' }, TOO_LARGE_FOR_CHAT_STATUS)}\n…`)).toBe(true);
    expect(isTooLargeInsightTemplateBlock(`${insightTemplateOpenTag({ id: ID, name: 'T' })}\n…`)).toBe(false);
    expect(isTooLargeInsightTemplateBlock(formatMissingInsightTemplateBlock({ id: ID, name: 'T' }))).toBe(false);
    // The status must be on the opening tag, not anywhere in the text.
    expect(isTooLargeInsightTemplateBlock(`hello status="${TOO_LARGE_FOR_CHAT_STATUS}"`)).toBe(false);
  });
});

describe('parseInsightTemplateBlock', () => {
  it('round-trips an opening tag, including a name that needs escaping', () => {
    const name = 'Q&A "Brief" <v2>';
    const block = `${insightTemplateOpenTag({ id: ID, name })}\n<template_html>\n<p>x</p>\n</template_html>\n</insight_template>`;

    expect(parseInsightTemplateBlock(block)).toEqual({ id: ID, name });
  });

  it('round-trips a too-large block', () => {
    const block = `${insightTemplateOpenTag({ id: ID, name: 'Huge' }, TOO_LARGE_FOR_CHAT_STATUS)}\n</insight_template>`;

    expect(parseInsightTemplateBlock(block)).toEqual({ id: ID, name: 'Huge' });
  });

  it('round-trips a missing-template block', () => {
    const block = formatMissingInsightTemplateBlock({ id: ID, name: 'Market Brief' });

    expect(block).toContain('status="missing"');
    expect(parseInsightTemplateBlock(block)).toEqual({ id: ID, name: 'Market Brief' });
  });

  it('ignores ordinary text', () => {
    expect(parseInsightTemplateBlock('create a BBCA insight')).toBeNull();
    expect(parseInsightTemplateBlock('Attached file "a.csv":\n\n1,2')).toBeNull();
  });
});

describe('size caps', () => {
  it('caps the library at 250,000 characters and chat inlining at 20,000', () => {
    expect(INSIGHT_TEMPLATE_MAX_CHARS).toBe(250_000);
    expect(CHAT_INLINE_DOCUMENT_MAX_CHARS).toBe(20_000);
  });

  it('treats a document as too large for chat only above the inline cap', () => {
    expect(isTooLargeForChat('x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS))).toBe(false);
    expect(isTooLargeForChat('x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS + 1))).toBe(true);
  });
});

describe('formatTemplateTooLargeMessage', () => {
  it('gives the real size and the cap, formatted with thousands separators', () => {
    expect(formatTemplateTooLargeMessage(285_000)).toBe(
      'Template is 285,000 characters; templates are limited to 250,000.',
    );
  });
});
