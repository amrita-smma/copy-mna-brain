import { describe, it, expect } from 'vitest';
import { detectLanguage, MIN_WORDS_FOR_DETECTION } from './rssLanguage';

/** Article-length English, so the stopword rate is representative. */
const ENGLISH = [
  'Aldergate Industrial has agreed to acquire Penvale Controls for $310m in cash.',
  'Penvale supplies process-control instrumentation into chemical and water-treatment end',
  'markets, filling a gap that Aldergate has flagged to its investors for several reporting',
  'periods. The companies said Penvale will continue to operate under its own brand, with',
  'integration limited to procurement and back-office functions for at least the first year.',
].join(' ');

describe('detectLanguage — script census', () => {
  it('detects Japanese from kana, even when kanji dominates by volume', () => {
    // Japanese prose is mostly kanji (Han) by character count, so a
    // share-ranked comparison across scripts would call this Chinese. Kana is
    // exclusive to Japanese and has to win outright.
    const result = detectLanguage(
      'ソフトバンクグループ、アーム株式の追加取得を発表',
      '同社は半導体設計会社アームの株式を追加で取得したと発表した。取得額は明らかにしていない。',
    );
    expect(result).toEqual({ language: 'ja', isEnglish: false });
  });

  it('detects Chinese from Han without kana', () => {
    const result = detectLanguage(
      '腾讯宣布收购游戏开发商股权',
      '该公司表示已完成对一家游戏开发商的股权收购，交易金额未予披露。',
    );
    expect(result).toEqual({ language: 'zh', isEnglish: false });
  });

  it('detects Korean from Hangul', () => {
    const result = detectLanguage(
      '삼성전자, 반도체 설비 투자 확대 발표',
      '회사는 올해 반도체 생산 설비에 대한 투자를 크게 늘리겠다고 밝혔다.',
    );
    expect(result).toEqual({ language: 'ko', isEnglish: false });
  });

  it('detects Russian from Cyrillic', () => {
    const result = detectLanguage(
      'Компания объявила о приобретении доли в производителе оборудования',
      'Сумма сделки не раскрывается, закрытие ожидается в следующем квартале.',
    );
    expect(result).toEqual({ language: 'ru', isEnglish: false });
  });

  it('still detects a foreign script through embedded Latin brand names and tickers', () => {
    // Real foreign-language copy is peppered with Latin-script names, which is
    // why NON_LATIN_SHARE is well below 50%.
    const result = detectLanguage(
      'ソフトバンク (SBG) が Arm Holdings plc の株式を取得、NASDAQ: ARM',
      'SBG は Arm の株式を追加取得したと発表した。取得額は非公開。',
    );
    expect(result.language).toBe('ja');
    expect(result.isEnglish).toBe(false);
  });
});

describe('detectLanguage — Latin-script stopwords', () => {
  it('calls article-length English English', () => {
    expect(detectLanguage(ENGLISH)).toEqual({ language: 'en', isEnglish: true });
  });

  it('detects German', () => {
    const result = detectLanguage(
      'Kestrel Materials sichert sich 145 Mio. USD Wachstumsfinanzierung',
      'Das Management erklärte, die Abnahme für die neue Linie sei bereits vor der Inbetriebnahme weitgehend vertraglich gesichert, was eine Bedingung des Fremdkapitalpakets gewesen sei.',
    );
    expect(result).toEqual({ language: 'de', isEnglish: false });
  });

  it('detects Spanish', () => {
    const result = detectLanguage(
      'La compañía anuncia la adquisición de una participación en el fabricante',
      'Según los términos del acuerdo, la operación se cerrará durante el próximo trimestre, pero las partes no han revelado el precio pagado por las acciones.',
    );
    expect(result).toEqual({ language: 'es', isEnglish: false });
  });

  it('detects French', () => {
    const result = detectLanguage(
      'Le groupe annonce une prise de participation dans le fabricant',
      "Selon les termes de l'accord, l'opération sera finalisée au cours du prochain trimestre, mais les parties n'ont pas révélé le prix payé pour les actions.",
    );
    expect(result).toEqual({ language: 'fr', isEnglish: false });
  });

  it('detects Indonesian', () => {
    const result = detectLanguage(
      'Perusahaan mengumumkan akuisisi saham pada produsen peralatan',
      'Dalam keterangannya, perusahaan menyatakan bahwa transaksi ini akan diselesaikan pada kuartal berikutnya dan nilai transaksi tidak diungkapkan kepada publik.',
    );
    expect(result).toEqual({ language: 'id', isEnglish: false });
  });
});

describe('detectLanguage — bias toward not spending a call', () => {
  it('reports English with a null language for text below the word floor', () => {
    // A bare headline has too few function words for the signal to mean
    // anything. Guessing here would either waste a Haiku call or round-trip
    // real English prose through a translator.
    const short = 'Acme buys Penvale for $310m';
    expect(short.split(/\s+/).length).toBeLessThan(MIN_WORDS_FOR_DETECTION);
    expect(detectLanguage(short)).toEqual({ language: null, isEnglish: true });
  });

  it('reports English with a null language for empty input', () => {
    expect(detectLanguage(null, undefined, '')).toEqual({ language: null, isEnglish: true });
  });

  it('does not let URLs and figures alone push a verdict', () => {
    // stripNoise removes both, leaving nothing to score.
    const result = detectLanguage('https://example.com/a/b/c 1,250,000 $310m 2026-09-03');
    expect(result).toEqual({ language: null, isEnglish: true });
  });

  it('keeps English text with foreign quotations and borrowings English', () => {
    // A narrow non-English lead is not enough — hence NON_ENGLISH_MARGIN.
    const result = detectLanguage(
      ENGLISH,
      'The chief executive described the structure as a de facto joint venture and said the parties had agreed to a Vorvertrag before the summer.',
    );
    expect(result.isEnglish).toBe(true);
  });

  it('concatenates fragments so a short headline is judged with its summary', () => {
    // The title alone is under the floor; title + summary clears it.
    const title = 'Übernahme angekündigt';
    expect(detectLanguage(title)).toEqual({ language: null, isEnglish: true });

    const result = detectLanguage(
      title,
      'Das Unternehmen erklärte, die Transaktion werde im nächsten Quartal abgeschlossen und der Kaufpreis werde nicht offengelegt, da die Parteien dies vertraglich vereinbart haben.',
    );
    expect(result).toEqual({ language: 'de', isEnglish: false });
  });
});
