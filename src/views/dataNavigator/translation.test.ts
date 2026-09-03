import { describe, it, expect } from 'vitest';
import {
  displayBody,
  displaySummary,
  displayTitle,
  hasTranslation,
  type TranslatedFields,
} from './translation';

function item(overrides: Partial<TranslatedFields> = {}): TranslatedFields {
  return {
    title: 'ソフトバンク、Arm株を追加取得',
    summary: '同社は株式を追加取得したと発表した。',
    language: 'ja',
    translation_status: 'translated',
    title_en: 'SoftBank buys additional Arm shares',
    summary_en: 'The company said it acquired additional shares.',
    content_text: '本文が続きます。',
    content_text_en: 'The body continues.',
    ...overrides,
  };
}

/** An already-English item, as the translate stage records it. */
const english = (): TranslatedFields => ({
  title: 'Aldergate acquires Penvale Controls',
  summary: 'The acquisition closes a product gap.',
  language: 'en',
  translation_status: 'not_needed',
  title_en: null,
  summary_en: null,
  content_text: 'Full body.',
  content_text_en: null,
});

describe('hasTranslation', () => {
  it('is true for a translated item with an English title', () => {
    expect(hasTranslation(item())).toBe(true);
  });

  it('is false for an item the stage decided needed no translation', () => {
    expect(hasTranslation(english())).toBe(false);
  });

  it('is false for an item still queued or terminally failed', () => {
    expect(hasTranslation(item({ translation_status: 'none' }))).toBe(false);
    expect(hasTranslation(item({ translation_status: 'pending' }))).toBe(false);
    expect(hasTranslation(item({ translation_status: 'failed' }))).toBe(false);
  });

  it('is true for a search hit, whose title and title_en are the same English string', () => {
    // A hit carries only one headline — the service resolves it to English
    // server-side — so `DataNavigator` maps it into both fields. That is what
    // lets the card badge the item; leaving `title_en` null would silently
    // drop the badge from every search result.
    expect(
      hasTranslation(
        item({
          title: 'SoftBank buys additional Arm shares',
          title_en: 'SoftBank buys additional Arm shares',
        }),
      ),
    ).toBe(true);
  });

  it('is false when the status claims translated but the English title is missing', () => {
    // Rendering an empty headline is worse than rendering a foreign one, so
    // the title — not the status alone — defines "has a translation".
    expect(hasTranslation(item({ title_en: null }))).toBe(false);
    expect(hasTranslation(item({ title_en: '   ' }))).toBe(false);
  });
});

describe('displayTitle', () => {
  it('shows the English title by default', () => {
    expect(displayTitle(item())).toBe('SoftBank buys additional Arm shares');
  });

  it('shows the original when the toggle asks for it', () => {
    expect(displayTitle(item(), true)).toBe('ソフトバンク、Arm株を追加取得');
  });

  it('ignores the toggle for an item with no translation', () => {
    expect(displayTitle(english(), true)).toBe('Aldergate acquires Penvale Controls');
  });

  it('falls back to the original for a failed translation', () => {
    expect(displayTitle(item({ translation_status: 'failed', title_en: null }))).toBe(
      'ソフトバンク、Arm株を追加取得',
    );
  });
});

describe('displaySummary', () => {
  it('prefers the English summary, and the original when asked', () => {
    expect(displaySummary(item())).toBe('The company said it acquired additional shares.');
    expect(displaySummary(item(), true)).toBe('同社は株式を追加取得したと発表した。');
  });

  it('falls back to the original when only the summary went untranslated', () => {
    // Showing the original beats showing nothing.
    expect(displaySummary(item({ summary_en: null }))).toBe(
      '同社は株式を追加取得したと発表した。',
    );
  });

  it('is null when the item never carried a summary', () => {
    expect(displaySummary(item({ summary: null, summary_en: null }))).toBeNull();
  });
});

describe('displayBody', () => {
  it('prefers the English body, and the original when asked', () => {
    expect(displayBody(item())).toBe('The body continues.');
    expect(displayBody(item(), true)).toBe('本文が続きます。');
  });

  it('falls back to the original body when the translation has none', () => {
    expect(displayBody(item({ content_text_en: null }))).toBe('本文が続きます。');
  });

  it('is null when no body was ever extracted', () => {
    expect(displayBody(item({ content_text: null, content_text_en: null }))).toBeNull();
  });

  it('is null on the list projection, which omits both body columns', () => {
    const { content_text: _a, content_text_en: _b, ...listRow } = item();
    expect(displayBody(listRow)).toBeNull();
  });
});
