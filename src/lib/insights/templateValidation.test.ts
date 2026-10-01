import { describe, expect, it } from 'vitest';
import { TOO_DEEPLY_NESTED_MESSAGE } from '@/lib/insights/parseHtml';
import {
  INVALID_TEMPLATE_ICON_MESSAGE,
  TEMPLATE_HTML_REQUIRED_MESSAGE,
  TEMPLATE_NAME_REQUIRED_MESSAGE,
  isTemplateHtmlTooLarge,
  templateHtmlError,
  templateIconError,
  templateNameError,
} from './templateValidation';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/srcdoc';
import { INSIGHT_TEMPLATE_MAX_CHARS } from '@/lib/insights/templateAttachment';

describe('templateNameError', () => {
  it('passes a name within the cap, judged trimmed', () => {
    expect(templateNameError('  Sector Brief  ')).toBeNull();
    expect(templateNameError(`  ${'A'.repeat(MAX_INSIGHT_NAME_LENGTH)}  `)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('requires a name for %s', (_label, name) => {
    expect(templateNameError(name)).toBe(TEMPLATE_NAME_REQUIRED_MESSAGE);
  });

  it('rejects a name over the insight name cap', () => {
    expect(templateNameError('A'.repeat(MAX_INSIGHT_NAME_LENGTH + 1))).toBe(
      `Template name exceeds maximum length of ${MAX_INSIGHT_NAME_LENGTH} characters`,
    );
  });
});

describe('templateHtmlError', () => {
  it('passes html up to exactly the character cap', () => {
    expect(templateHtmlError('<p>Sample Co.</p>')).toBeNull();
    expect(templateHtmlError('x'.repeat(INSIGHT_TEMPLATE_MAX_CHARS))).toBeNull();
  });

  it('measures the cap in characters, not UTF-8 bytes', () => {
    expect(templateHtmlError('€'.repeat(INSIGHT_TEMPLATE_MAX_CHARS))).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '  \n '],
    ['a non-string', null],
  ])('requires html for %s', (_label, html) => {
    expect(templateHtmlError(html)).toBe(TEMPLATE_HTML_REQUIRED_MESSAGE);
  });

  it('returns the shared size message for html over the cap', () => {
    expect(templateHtmlError('x'.repeat(285_000))).toBe(
      'Template is 285,000 characters; templates are limited to 250,000.',
    );
  });
});

describe('templateHtmlError on deep nesting', () => {
  it('refuses template HTML nested too deeply for the outline to walk', () => {
    expect(templateHtmlError('<span>x'.repeat(1_000))).toBe(TOO_DEEPLY_NESTED_MESSAGE);
  });
});

describe('isTemplateHtmlTooLarge', () => {
  it('is true only for a string over the cap', () => {
    expect(isTemplateHtmlTooLarge('x'.repeat(INSIGHT_TEMPLATE_MAX_CHARS + 1))).toBe(true);
    expect(isTemplateHtmlTooLarge('x'.repeat(INSIGHT_TEMPLATE_MAX_CHARS))).toBe(false);
    expect(isTemplateHtmlTooLarge(undefined)).toBe(false);
  });
});

describe('templateIconError', () => {
  it.each([null, undefined, ''])('passes no icon (%s)', (icon) => {
    expect(templateIconError(icon)).toBeNull();
  });

  it('passes a known icon key', () => {
    expect(templateIconError('pie-chart')).toBeNull();
  });

  it.each(['rocket', 7, {}])('rejects %s', (icon) => {
    expect(templateIconError(icon)).toBe(INVALID_TEMPLATE_ICON_MESSAGE);
  });
});
