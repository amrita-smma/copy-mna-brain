/**
 * Dependency-free language detection for feed text.
 *
 * This exists purely as a **cost gate** in front of the Haiku translation
 * stage. The feed catalog is majority-English, so paying for a model call per
 * item just to be told "this is already English" would dominate the cost of
 * the stage. A local detector decides which items are worth a call.
 *
 * Two complementary signals, in order:
 *
 *   1. **Script census.** A meaningful share of non-Latin characters settles
 *      the question outright — nothing written in kana, Hangul or Cyrillic is
 *      English. This is exact, not statistical.
 *   2. **Stopword frequency.** For Latin-script text the script tells us
 *      nothing, so we score the token stream against small sets of the most
 *      distinctive function words per language. Function words are the right
 *      feature here: they are the highest-frequency tokens in any text, they
 *      are largely non-overlapping between languages, and unlike content
 *      words they do not drift with subject matter — an article about a
 *      German acquisition written in English still says "the" and "of".
 *
 * The bias throughout is toward answering "English" when unsure: a false
 * "English" costs a slightly-awkward reading pane, while a false
 * "non-English" costs a wasted Haiku call and, worse, round-trips real
 * English prose through a translator. Short text (a bare title on an item
 * whose content fetch failed) is therefore reported as English rather than
 * guessed at — see `MIN_WORDS_FOR_DETECTION`.
 *
 * Deliberately imports nothing, like `rssConstants.ts`: it is small enough to
 * be bundled into any Lambda without dragging a detection library along.
 */

export interface LanguageDetection {
  /**
   * ISO 639-1 code of the detected language, or `null` when the text was too
   * short or too ambiguous to call. Never guessed — a null here means "we do
   * not know", which callers must not record as a fact about the item.
   */
  language: string | null;
  /**
   * Whether the text should be treated as already-English and skipped by the
   * translation stage. True whenever `language` is `'en'` OR `null`.
   */
  isEnglish: boolean;
}

/**
 * Share of letters that must belong to one non-Latin script before it decides
 * the answer. Not 100% because real foreign-language articles are peppered
 * with Latin-script company names, tickers and quoted English, and a headline
 * like 「ソフトバンク、Arm株を追加取得」 is well under half kana/kanji by
 * character count.
 */
const NON_LATIN_SHARE = 0.15;

/**
 * Below this many word tokens, the stopword signal is noise — a six-word
 * headline can easily contain zero function words in any language. Such text
 * is reported as English (`language: null`) so the translation stage skips it
 * rather than spending a call on a coin flip.
 */
export const MIN_WORDS_FOR_DETECTION = 12;

/** Minimum stopword hit rate before a non-English verdict is credible at all. */
const NON_ENGLISH_FLOOR = 0.04;

/**
 * How decisively a non-English language must beat English to win. English
 * function words leak into other languages' text (quotations, brand names,
 * "de facto"-style borrowings), so a narrow lead is not enough to justify
 * translating.
 */
const NON_ENGLISH_MARGIN = 1.5;

/** Unicode ranges per script, in the order they are tested. */
const SCRIPT_RANGES: Array<{ script: string; pattern: RegExp }> = [
  { script: 'hiragana', pattern: /[぀-ゟ]/ },
  { script: 'katakana', pattern: /[゠-ヿㇰ-ㇿ]/ },
  { script: 'han', pattern: /[㐀-䶿一-鿿豈-﫿]/ },
  { script: 'hangul', pattern: /[ᄀ-ᇿ㄰-㆏가-힯]/ },
  { script: 'cyrillic', pattern: /[Ѐ-ӿԀ-ԯ]/ },
  { script: 'arabic', pattern: /[؀-ۿݐ-ݿࢠ-ࣿ]/ },
  { script: 'hebrew', pattern: /[֐-׿]/ },
  { script: 'devanagari', pattern: /[ऀ-ॿ]/ },
  { script: 'thai', pattern: /[฀-๿]/ },
  { script: 'greek', pattern: /[Ͱ-Ͽἀ-῿]/ },
  { script: 'latin', pattern: /[a-zÀ-ɏ]/i },
];

/**
 * Script → ISO 639-1. Kana is exclusive to Japanese, so kana anywhere in a
 * CJK text settles Japanese vs. Chinese; bare Han is read as Chinese.
 */
const SCRIPT_LANGUAGE: Record<string, string> = {
  hiragana: 'ja',
  katakana: 'ja',
  han: 'zh',
  hangul: 'ko',
  cyrillic: 'ru',
  arabic: 'ar',
  hebrew: 'he',
  devanagari: 'hi',
  thai: 'th',
  greek: 'el',
};

/**
 * The most distinctive high-frequency function words per language.
 *
 * Chosen for discrimination rather than coverage: words shared across several
 * of these languages ("in", "a", "no", "se", "van") are mostly left out,
 * since a token that scores for three languages at once adds nothing. The
 * English set is the one that has to be reliable, so it is the longest.
 */
const STOPWORDS: Record<string, readonly string[]> = {
  en: [
    'the', 'and', 'of', 'to', 'in', 'that', 'is', 'for', 'with', 'as', 'was', 'on',
    'by', 'it', 'from', 'at', 'are', 'be', 'this', 'has', 'have', 'will', 'not',
    'but', 'an', 'or', 'which', 'said', 'after', 'more', 'its', 'their', 'been',
    'would', 'about', 'they', 'we', 'he', 'she',
  ],
  es: [
    'que', 'los', 'las', 'del', 'una', 'por', 'con', 'para', 'como', 'pero', 'sus',
    'este', 'esta', 'sobre', 'entre', 'desde', 'también', 'según', 'ha', 'su', 'al',
    'es', 'son', 'más',
  ],
  pt: [
    'que', 'não', 'uma', 'para', 'com', 'como', 'mas', 'dos', 'das', 'pelo', 'pela',
    'ainda', 'sobre', 'entre', 'também', 'segundo', 'está', 'são', 'foi', 'ao',
    'nos', 'seu', 'sua',
  ],
  fr: [
    'les', 'des', 'une', 'que', 'pour', 'dans', 'sur', 'avec', 'par', 'pas', 'plus',
    'aux', 'cette', 'ses', 'est', 'sont', 'été', 'ont', 'nous', 'leur', 'mais',
    'qui', 'où', 'du',
  ],
  de: [
    'der', 'die', 'das', 'und', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
    'ist', 'nicht', 'auch', 'mit', 'für', 'auf', 'von', 'sich', 'werden', 'wurde',
    'sind', 'aber', 'nach', 'über', 'bei', 'zum', 'zur',
  ],
  it: [
    'che', 'della', 'per', 'con', 'non', 'una', 'sono', 'nel', 'alla', 'dei', 'più',
    'anche', 'come', 'delle', 'gli', 'ma', 'sul', 'agli', 'stato', 'essere',
  ],
  nl: [
    'het', 'een', 'van', 'dat', 'niet', 'zijn', 'met', 'voor', 'aan', 'ook', 'maar',
    'door', 'worden', 'werd', 'naar', 'over', 'bij', 'wordt', 'deze', 'heeft',
  ],
  id: [
    'yang', 'dan', 'dengan', 'untuk', 'dari', 'ini', 'itu', 'pada', 'akan', 'tidak',
    'dalam', 'adalah', 'sebagai', 'juga', 'oleh', 'telah', 'karena', 'atau',
    'mereka', 'dapat',
  ],
  tr: [
    'için', 'olarak', 'daha', 'bir', 'ile', 'ancak', 'sonra', 'kadar', 'olan',
    'göre', 'yüzde', 'oldu', 'ise', 've', 'ya',
  ],
  pl: [
    'oraz', 'nie', 'jest', 'przez', 'dla', 'jako', 'który', 'która', 'które', 'tego',
    'tym', 'roku', 'będzie', 'także', 'ale', 'ich', 'się', 'do',
  ],
  vi: [
    'của', 'và', 'các', 'được', 'trong', 'cho', 'với', 'này', 'không', 'người',
    'những', 'đã', 'là', 'một', 'có', 'từ',
  ],
  sv: [
    'och', 'att', 'det', 'som', 'för', 'med', 'inte', 'har', 'den', 'till', 'är',
    'på', 'av', 'men', 'ett', 'kommer', 'under',
  ],
};

/** Reverse index so each token is charged to its language(s) in one pass. */
const STOPWORD_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [language, words] of Object.entries(STOPWORDS)) {
    for (const word of words) {
      const owners = index.get(word);
      if (owners) owners.push(language);
      else index.set(word, [language]);
    }
  }
  return index;
})();

/**
 * Detect the language of one or more related text fragments (title, summary,
 * body). They are concatenated because each alone is often too short: a
 * headline rarely clears `MIN_WORDS_FOR_DETECTION`, but a headline plus a
 * summary usually does.
 */
export function detectLanguage(
  ...fragments: Array<string | null | undefined>
): LanguageDetection {
  const text = fragments
    .filter((fragment): fragment is string => typeof fragment === 'string')
    .join('\n');

  const cleaned = stripNoise(text);
  if (cleaned.trim().length === 0) return { language: null, isEnglish: true };

  const byScript = detectByScript(cleaned);
  if (byScript) return { language: byScript, isEnglish: false };

  return detectByStopwords(cleaned);
}

/**
 * Removes text that carries no language signal but does skew the script
 * census and the token count: URLs, email addresses and bare numbers are
 * Latin-script and language-neutral, so leaving them in would make a
 * Japanese item full of links look more Latin than it is.
 */
function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/[\d]+/g, ' ');
}

/**
 * Returns a language code when one non-Latin script holds at least
 * `NON_LATIN_SHARE` of the letters, else null (meaning "Latin script — ask
 * the stopwords"). Shares are computed over letters only, so punctuation and
 * whitespace do not dilute the census.
 */
function detectByScript(text: string): string | null {
  const counts = new Map<string, number>();
  let letters = 0;

  for (const char of text) {
    for (const { script, pattern } of SCRIPT_RANGES) {
      if (!pattern.test(char)) continue;
      counts.set(script, (counts.get(script) ?? 0) + 1);
      letters++;
      break;
    }
  }
  if (letters === 0) return null;

  // Kana first: it is the only script here that identifies a language on its
  // own, and Japanese text is mostly kanji (Han) by volume, so a share-ranked
  // comparison would call a Japanese article Chinese.
  const kana = (counts.get('hiragana') ?? 0) + (counts.get('katakana') ?? 0);
  if (kana / letters >= 0.05) return 'ja';

  let best: { script: string; count: number } | null = null;
  for (const [script, count] of counts) {
    if (script === 'latin') continue;
    if (!best || count > best.count) best = { script, count };
  }

  if (!best || best.count / letters < NON_LATIN_SHARE) return null;
  return SCRIPT_LANGUAGE[best.script] ?? null;
}

/**
 * Latin-script verdict from function-word frequency. Returns English whenever
 * English leads, whenever no language clears `NON_ENGLISH_FLOOR`, or whenever
 * the leader's margin over English is too thin to trust.
 */
function detectByStopwords(text: string): LanguageDetection {
  // Unicode-aware word split: `\p{L}` keeps accented and non-ASCII letters
  // together (`für`, `também`, `được`), which is exactly the signal that
  // separates these languages from English.
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (tokens.length < MIN_WORDS_FOR_DETECTION) return { language: null, isEnglish: true };

  const hits = new Map<string, number>();
  for (const token of tokens) {
    const owners = STOPWORD_INDEX.get(token);
    if (!owners) continue;
    for (const language of owners) hits.set(language, (hits.get(language) ?? 0) + 1);
  }

  const englishRate = (hits.get('en') ?? 0) / tokens.length;

  let best: { language: string; rate: number } | null = null;
  for (const [language, count] of hits) {
    if (language === 'en') continue;
    const rate = count / tokens.length;
    if (!best || rate > best.rate) best = { language, rate };
  }

  if (!best || best.rate < NON_ENGLISH_FLOOR) {
    // Nothing else is plausible. Call it English only if English itself shows
    // up at all; otherwise admit we don't know (still skipped by the caller).
    return englishRate > 0
      ? { language: 'en', isEnglish: true }
      : { language: null, isEnglish: true };
  }

  if (best.rate <= englishRate * NON_ENGLISH_MARGIN) {
    return { language: 'en', isEnglish: true };
  }

  return { language: best.language, isEnglish: false };
}
