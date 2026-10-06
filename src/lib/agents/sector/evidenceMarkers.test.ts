import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_STYLES,
  INSIGHT_DATA_LIMIT_MARKER_GUIDE,
  INSIGHT_MODELLED_MARKER_GUIDE,
  INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE,
  MODELLED_MARKER_HTML,
  OBSERVED_SIGNAL_TYPES,
  OBSERVED_SIGNAL_TYPE_LABELS,
  dataLimitMarkerHtml,
  evidenceMarkerRefusal,
  findEvidenceMarkerProblems,
  inferredMarkerHtml,
  observedMarkerHtml,
  validatesEvidenceMarkers,
  INSIGHT_SOURCES_GUIDE,
  INSIGHT_UNAVAILABLE_GUIDE,
  OFFERED_SOURCE_KINDS,
  SOURCE_KINDS,
  SOURCE_STYLES,
  WORKFORCE_SOURCES_WRITE_ORDER,
  findInsightMarkerProblems,
  findSourceMarkerProblems,
  insightMarkerRefusal,
  isRetrievedDate,
  sourceEntryHtml,
  sourceRefHtml,
  sourcesSectionHtml,
  unavailableMarkerHtml,
  type SourceEntry,
} from './evidenceMarkers';
import { DIKTI_SEED } from '@/lib/agents/dikti/seed';

describe('OBSERVED_SIGNAL_TYPES', () => {
  it("equals US-04's four observed signal types, in the seed's order", () => {
    expect([...OBSERVED_SIGNAL_TYPES]).toEqual(['decree', 'pddikti', 'newspaper', 'ahu']);
    expect(OBSERVED_SIGNAL_TYPES.map((t) => OBSERVED_SIGNAL_TYPE_LABELS[t])).toEqual(
      DIKTI_SEED.observedSignalTypes,
    );
  });
});

describe('insight marker snippets', () => {
  it('builds a data-limit aside naming the limit, with its own opaque inline style', () => {
    const html = dataLimitMarkerHtml('pddikti-api', 'The PDDikti API returns 401.');
    expect(html).toMatch(/^<aside data-evidence="data-limit" data-limit-id="pddikti-api" style="/);
    expect(html).toContain('<strong style="color:#78350f;font-weight:700">Data limit:</strong> The PDDikti API returns 401.');
    expect(html).toContain('background:#fffbeb');
    expect(html).toMatch(/<\/aside>$/);
  });

  it('builds an observed pill carrying its signal type', () => {
    for (const type of OBSERVED_SIGNAL_TYPES) {
      expect(observedMarkerHtml(type)).toBe(
        `<span data-evidence="observed" data-signal-type="${type}" style="${EVIDENCE_STYLES.observed}">Observed</span>`,
      );
    }
  });

  it('builds an inferred pill carrying what it was based on, escaped', () => {
    expect(inferredMarkerHtml('SK 12/2024 & "PDDikti" change')).toBe(
      `<span data-evidence="inferred" data-based-on="SK 12/2024 &amp; &quot;PDDikti&quot; change" style="${EVIDENCE_STYLES.inferred}">Inferred</span>`,
    );
  });

  it('builds a modelled pill', () => {
    expect(MODELLED_MARKER_HTML).toBe(
      `<span data-evidence="modelled" style="${EVIDENCE_STYLES.modelled}">Modelled</span>`,
    );
  });

  it('never paints a transparent background', () => {
    for (const style of Object.values(EVIDENCE_STYLES)) {
      expect(style).not.toMatch(/transparent|rgba|hsla/);
    }
    for (const key of ['data-limit', 'observed', 'inferred', 'modelled'] as const) {
      expect(EVIDENCE_STYLES[key]).toMatch(/background:#[0-9a-f]{6}/);
    }
  });

  it('teaches the snippets in the prompt fragments', () => {
    expect(INSIGHT_DATA_LIMIT_MARKER_GUIDE).toContain(dataLimitMarkerHtml('LIMIT_ID', 'STATEMENT'));
    expect(INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE).toContain(observedMarkerHtml('decree'));
    expect(INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE).toContain(inferredMarkerHtml('SIGNALS'));
    for (const type of OBSERVED_SIGNAL_TYPES) {
      expect(INSIGHT_OBSERVED_INFERRED_MARKER_GUIDE).toContain(`\`${type}\``);
    }
    expect(INSIGHT_MODELLED_MARKER_GUIDE).toContain(MODELLED_MARKER_HTML);
  });
});

describe('findEvidenceMarkerProblems', () => {
  const GOOD = `<section data-section="findings">
    <p>${observedMarkerHtml('decree')} SK Mendikbudristek 123/E/O/2024 approved the change of badan penyelenggara.</p>
    <p>${observedMarkerHtml('ahu')} ${observedMarkerHtml('pddikti')} ${observedMarkerHtml('newspaper')}</p>
    <p>${inferredMarkerHtml('SK 123/E/O/2024; PDDikti change 2024-03-01')} from: SK 123/E/O/2024 and the PDDikti change.</p>
    <p>${MODELLED_MARKER_HTML} ${dataLimitMarkerHtml('pddikti-api', 'The PDDikti API returns 401.')}</p>
  </section>`;

  it('accepts well-formed markers of every kind', () => {
    expect(findEvidenceMarkerProblems(GOOD)).toEqual([]);
  });

  it('accepts a document with no markers at all (a missing marker is undetectable)', () => {
    expect(findEvidenceMarkerProblems('<html><body><p>Observed: nothing.</p></body></html>')).toEqual([]);
  });

  it.each([
    ['<span data-evidence="observed">Observed</span>', 'data-signal-type'],
    ...['rumour', 'Decree', '', 'press release'].map((t) => [
      `<span data-evidence="observed" data-signal-type="${t}">Observed</span>`,
      'data-signal-type',
    ]),
    ['<span data-evidence="inferred">Inferred</span>', 'data-based-on'],
    ['<span data-evidence="inferred" data-based-on="  ">Inferred</span>', 'data-based-on'],
    ['<span data-evidence="observd" data-signal-type="ahu">x</span>', 'data-evidence must be one of'],
  ])('rejects %s', (html, reason) => {
    const problems = findEvidenceMarkerProblems(html);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toContain(reason);
  });

  it('rejects a snippet pasted with its placeholders unfilled', () => {
    const problems = findEvidenceMarkerProblems(
      `${inferredMarkerHtml('SIGNALS')} ${dataLimitMarkerHtml('LIMIT_ID', 'x')}`,
    );
    expect(problems.map((p) => p.reason)).toEqual([
      expect.stringContaining('replace the SIGNALS placeholder'),
      expect.stringContaining('replace the LIMIT_ID placeholder'),
    ]);
  });

  it('reports every malformed marker, and drops the inline style from the quoted tag', () => {
    const html = `<span data-evidence="observed" style="color:red">a</span><span data-evidence="inferred" style="color:red">b</span>`;
    const problems = findEvidenceMarkerProblems(html);
    expect(problems.map((p) => p.tag)).toEqual([
      '<span data-evidence="observed">',
      '<span data-evidence="inferred">',
    ]);
  });

  it("reads single-quoted and unquoted attributes, and quoted values containing '>'", () => {
    expect(
      findEvidenceMarkerProblems(
        `<span data-evidence='inferred' data-based-on='decree > rumour'>Inferred</span><span data-evidence=observed data-signal-type=ahu>Observed</span>`,
      ),
    ).toEqual([]);
  });

  it('ignores markers inside HTML comments', () => {
    expect(findEvidenceMarkerProblems('<!-- <span data-evidence="observed">x</span> -->')).toEqual([]);
  });
});

describe('evidenceMarkerRefusal', () => {
  const BAD = '<span data-evidence="observed" data-signal-type="rumour">Observed</span>';

  it('returns a correction message for a malformed @dikti write', () => {
    const out = evidenceMarkerRefusal(BAD, 'dikti');
    expect(out).toMatch(/^Rejection: 1 malformed evidence marker — nothing was written\./);
    expect(out).toContain('data-signal-type set to one of decree, pddikti, newspaper, ahu');
    expect(out).toContain(observedMarkerHtml('decree'));
  });

  it('lets a well-formed @dikti write through', () => {
    expect(evidenceMarkerRefusal(observedMarkerHtml('ahu'), 'dikti')).toBeNull();
  });

  it("does not validate other agents' writes", () => {
    for (const key of ['bangun', 'minerba', 'general', undefined, null, 42]) {
      expect(evidenceMarkerRefusal(BAD, key)).toBeNull();
      expect(validatesEvidenceMarkers(key)).toBe(false);
    }
    expect(validatesEvidenceMarkers('dikti')).toBe(true);
  });
});

const ENTRY: SourceEntry = {
  id: 'S1',
  kind: 'web',
  retrieved: '2026-09-01',
  feeds: 'FY2025 production volume',
  name: 'ESDM Minerba One Data',
  locator: 'https://modi.esdm.go.id/',
};

describe('source and unavailable snippets', () => {
  it('builds a reference that shows its id', () => {
    expect(sourceRefHtml('S1')).toBe(
      `<sup data-source-ref="S1" style="${SOURCE_STYLES.ref}">[S1]</sup>`,
    );
  });

  it('builds a Sources entry with its kind, date and feeds as attributes and visible text', () => {
    expect(sourceEntryHtml({ ...ENTRY, feeds: 'Output & "grade"' })).toBe(
      `<li data-source-id="S1" data-source-kind="web" data-retrieved="2026-09-01" data-feeds="Output &amp; &quot;grade&quot;" style="${SOURCE_STYLES.entry}"><strong>ESDM Minerba One Data</strong> — https://modi.esdm.go.id/ · retrieved 2026-09-01 · feeds: Output &amp; &quot;grade&quot;</li>`,
    );
  });

  it('builds the Sources section keyed "sources" with an h2 and an ordered list', () => {
    const html = sourcesSectionHtml([ENTRY]);
    expect(html).toMatch(/^<section data-section="sources" style="[^"]+"><h2 style="[^"]+">Sources<\/h2><ol style="[^"]+">/);
    expect(html).toContain(sourceEntryHtml(ENTRY));
    expect(html).toMatch(/<\/ol><\/section>$/);
  });

  it('builds an unavailable cell or span that reads exactly "Unavailable"', () => {
    expect(unavailableMarkerHtml('Not public')).toBe(
      `<td data-evidence="unavailable" data-reason="Not public" title="Not public" style="${SOURCE_STYLES.unavailableCell}">Unavailable</td>`,
    );
    expect(unavailableMarkerHtml('Not public', 'span')).toMatch(/^<span data-evidence="unavailable" data-reason="Not public"[^>]*>Unavailable<\/span>$/);
  });

  it('paints opaque surfaces only', () => {
    for (const style of Object.values(SOURCE_STYLES)) {
      expect(style).not.toMatch(/transparent|rgba|hsla/);
    }
    for (const key of ['section', 'unavailableCell', 'unavailableSpan'] as const) {
      expect(SOURCE_STYLES[key]).toMatch(/background:#[0-9a-f]{6}/);
    }
  });

  it('teaches the snippets in the prompt fragments', () => {
    expect(INSIGHT_SOURCES_GUIDE).toContain(sourceRefHtml('S1'));
    expect(INSIGHT_SOURCES_GUIDE).toContain('data-section="sources"');
    expect(INSIGHT_SOURCES_GUIDE).toContain('data-retrieved="YYYY-MM-DD" data-feeds="FEEDS"');
    for (const kind of OFFERED_SOURCE_KINDS)
      expect(INSIGHT_SOURCES_GUIDE).toContain(`\`${kind}\``);
    // Retired: still a valid stored kind, but never offered to the model.
    expect(SOURCE_KINDS).toContain('alphasense');
    expect(INSIGHT_SOURCES_GUIDE).not.toContain('alphasense');
    expect(INSIGHT_UNAVAILABLE_GUIDE).toContain(unavailableMarkerHtml('REASON'));
    expect(WORKFORCE_SOURCES_WRITE_ORDER).toContain('replace_insight_document');
  });
});

describe('isRetrievedDate', () => {
  it('accepts real YYYY-MM-DD dates only', () => {
    expect(isRetrievedDate('2026-09-01')).toBe(true);
    expect(isRetrievedDate('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-9-1', 'YYYY-MM-DD', '01/09/2026', '', null]) {
      expect(isRetrievedDate(bad), String(bad)).toBe(false);
    }
  });
});

describe('findSourceMarkerProblems', () => {
  const GOOD = `<html><body>
    <section data-section="output"><p>Output rose to 62.1 Mt${sourceRefHtml('S1')} and grade to 5,200 kcal${sourceRefHtml('S2')}${sourceRefHtml('S1')}.</p>
    <table><tr><th>Year</th><th>Quota</th></tr><tr><td>2025</td>${unavailableMarkerHtml('Quota letters are not public (data limit rkab-quota)')}</tr></table>
    <p>Holder: ${unavailableMarkerHtml('Not disclosed', 'span')}</p></section>
    ${sourcesSectionHtml([ENTRY, { ...ENTRY, id: 'S2', kind: 'valyu', locator: 'valyu_search: Adaro calorific value 2025' }, { ...ENTRY, id: 'S3', kind: 'internal' }])}
  </body></html>`;

  it('accepts references that resolve, well-formed entries and unavailable cells (an uncited entry is fine)', () => {
    expect(findSourceMarkerProblems(GOOD)).toEqual([]);
  });

  // AlphaSense is retired and no longer offered to the model, but insights
  // written while the subscription was live carry this kind — they must keep
  // validating, or the next write to any of them would be refused.
  it('still accepts the retired alphasense source kind on an existing document', () => {
    const html = `<p>Output rose to 62.1 Mt${sourceRefHtml('S1')}.</p>${sourcesSectionHtml([
      { ...ENTRY, kind: 'alphasense', locator: 'alphasense_search: Adaro FY2024 production' },
    ])}`;
    expect(findSourceMarkerProblems(html)).toEqual([]);
  });

  it('accepts a document with no source markers at all', () => {
    expect(findSourceMarkerProblems('<html><body><p>Revenue was $42M in FY2024.</p></body></html>')).toEqual([]);
  });

  it('refuses a dangling reference, once per id', () => {
    const problems = findSourceMarkerProblems(`<p>1${sourceRefHtml('S4')} 2${sourceRefHtml('S4')}</p>${sourcesSectionHtml([ENTRY])}`);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toContain('reference S4 matches no Sources entry');
    expect(problems[0].tag).toBe('<sup data-source-ref="S4">');
  });

  const entryWith = (over: Partial<SourceEntry>) => sourceEntryHtml({ ...ENTRY, ...over });
  const unavailable = (text: string, tag = 'td') =>
    `<${tag} data-evidence="unavailable" data-reason="Not public">${text}</${tag}>`;

  it.each([
    ['<sup data-source-ref="source-1">[1]</sup>', 'data-source-ref must name a source id'],
    [sourcesSectionHtml([ENTRY, { ...ENTRY, name: 'Other' }]), 'source id S1 is used by more than one Sources entry'],
    ...['2026-02-30', 'YYYY-MM-DD', 'yesterday'].map((retrieved) => [
      entryWith({ retrieved }),
      'data-retrieved must be the date the source was retrieved',
    ]),
    ['<li data-source-id="S1" data-source-kind="web" data-feeds="x">a</li>', 'data-retrieved must be'],
    [entryWith({ feeds: '' }), 'data-feeds must name the figures or sections'],
    [entryWith({ feeds: '   ' }), 'data-feeds must name the figures or sections'],
    [entryWith({ feeds: 'FEEDS' }), 'replace the FEEDS placeholder'],
    [
      '<li data-source-id="S1" data-source-kind="blog" data-retrieved="2026-09-01" data-feeds="x">a</li>',
      'data-source-kind must be one of web, valyu, inven, internal, insight',
    ],
    ['<td data-evidence="unavailable">Unavailable</td>', 'an unavailable cell needs data-reason'],
    ['<td data-evidence="unavailable" data-reason=" ">Unavailable</td>', 'an unavailable cell needs data-reason'],
    [unavailableMarkerHtml('REASON'), 'an unavailable cell needs data-reason'],
    ...['~12.5', 'Unavailable (est. 40%)', 'n/a 2025'].map((t) => [
      `<table><tr>${unavailable(t)}</tr></table>`,
      'with no digits — never put an estimate in it',
    ]),
    ...['N/A', 'unavailable', '', '<em>Unknown</em>'].map((t) => [
      unavailable(t, 'span'),
      'text must be exactly "Unavailable"',
    ]),
  ])('refuses %s', (html, reason) => {
    const problems = findSourceMarkerProblems(html);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toContain(reason);
  });

  it('accepts an unavailable cell whose text is the label wrapped in markup', () => {
    expect(findSourceMarkerProblems('<td data-evidence="unavailable" data-reason="x"><em> Unavailable </em></td>')).toEqual([]);
  });

  it('leaves reference resolution to the document check when checking a fragment', () => {
    const fragment = `<section data-section="output"><p>62.1 Mt${sourceRefHtml('S9')}</p></section>`;
    expect(findSourceMarkerProblems(fragment, 'fragment')).toEqual([]);
    expect(findSourceMarkerProblems(fragment, 'document')).toHaveLength(1);
    // Entry fields, duplicates and unavailable cells are still checked in a fragment.
    expect(findSourceMarkerProblems(sourcesSectionHtml([ENTRY, ENTRY]), 'fragment')).toHaveLength(1);
    expect(findSourceMarkerProblems('<td data-evidence="unavailable">3</td>', 'fragment')).toHaveLength(2);
  });

  it('ignores markers inside HTML comments', () => {
    expect(findSourceMarkerProblems(`<!-- ${sourceRefHtml('S7')} <td data-evidence="unavailable">9</td> -->`)).toEqual([]);
  });
});

describe('insightMarkerRefusal', () => {
  const DANGLING = `<p>62.1 Mt${sourceRefHtml('S2')}</p>`;

  it("refuses any agent's write with a malformed source marker", () => {
    for (const key of ['general', 'minerba', 'bangun', 'dikti', undefined, null]) {
      const out = insightMarkerRefusal(DANGLING, key);
      expect(out, String(key)).toMatch(/^Rejection: 1 malformed source or unavailable marker — nothing was written\./);
      expect(out).toContain('reference S2 matches no Sources entry');
      expect(out).toContain(sourceRefHtml('S1'));
    }
  });

  it('lets a well-formed or marker-free write through', () => {
    expect(insightMarkerRefusal(`<p>1${sourceRefHtml('S1')}</p>${sourcesSectionHtml([ENTRY])}`, 'general')).toBeNull();
    expect(insightMarkerRefusal('<p>Revenue $42M</p>', undefined)).toBeNull();
  });

  it('checks a fragment without resolving its references', () => {
    expect(insightMarkerRefusal(DANGLING, 'general', 'fragment')).toBeNull();
  });

  it('keeps the MB-543 evidence check for @dikti only, and reports both layers together', () => {
    const bad = `<span data-evidence="observed">Observed</span>${DANGLING}`;
    expect(findInsightMarkerProblems(bad, 'minerba').evidence).toEqual([]);
    const both = insightMarkerRefusal(bad, 'dikti');
    expect(both).toMatch(/^Rejection: 1 malformed evidence marker — nothing was written\./);
    expect(both).toContain('1 malformed source or unavailable marker');
  });

  it('accepts an unavailable cell in a @dikti write (a known evidence kind)', () => {
    expect(insightMarkerRefusal(unavailableMarkerHtml('Not public'), 'dikti')).toBeNull();
  });
});

describe('findInsightMarkerProblems on hostile documents', () => {
  it('reports a start tag too long to scan instead of overflowing the stack', () => {
    // An unterminated tag megabytes long overflowed the regex engine's stack.
    const html = '<a ' + 'b=c '.repeat(1_048_000);
    const problems = findInsightMarkerProblems(html, 'dikti');
    expect(problems.sources).toEqual([
      expect.objectContaining({ tag: '(document)', reason: expect.stringMatching(/too long to read/) }),
    ]);
    expect(problems.evidence).toEqual([
      expect.objectContaining({ tag: '(document)' }),
    ]);
  });

  it('checks many unclosed unavailable cells in linear time', () => {
    const html = '<td data-evidence="unavailable">x'.repeat(50_000);
    const started = performance.now();
    const problems = findInsightMarkerProblems(html, null);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(problems.sources.length).toBeGreaterThan(0);
  });
});
