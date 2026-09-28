import { describe, expect, it } from 'vitest';
import {
  DIFF_HIGHLIGHT_ATTR,
  MAX_FIGURE_CHANGES,
  diffInsightVersions,
  formatDiffSummary,
  highlightPreviewHtml,
} from './versionDiff';
import {
  sourceRefHtml,
  sourcesSectionHtml,
  unavailableMarkerHtml,
} from '@/lib/agents/sector/evidenceMarkers';

const doc = (body: string) =>
  `<!DOCTYPE html><html><head><style>body{font-family:sans-serif}</style></head><body>${body}</body></html>`;

const section = (key: string, inner: string, attrs = '') =>
  `<section data-section="${key}"${attrs}>${inner}</section>`;

const statuses = (html1: string, html2: string) =>
  diffInsightVersions(html1, html2).sections.map((s) => `${s.key ?? s.heading}:${s.status}`);

describe('diffInsightVersions — sections', () => {
  it('reports added, removed, changed and unchanged sections by data-section key', () => {
    const before = doc(
      section('summary', '<h2>Summary</h2><p>Revenue grew to $5.2bn.</p>') +
        section('risks', '<h2>Risks</h2><p>FX exposure.</p>') +
        section('peers', '<h2>Peers</h2><p>Four peers.</p>'),
    );
    const after = doc(
      section('summary', '<h2>Summary</h2><p>Revenue grew to $5.4bn.</p>') +
        section('peers', '<h2>Peers</h2><p>Four peers.</p>') +
        section('outlook', '<h2>Outlook</h2><p>Stable.</p>'),
    );

    const diff = diffInsightVersions(before, after);

    expect(diff.sections).toEqual([
      expect.objectContaining({ key: 'summary', heading: 'Summary', status: 'changed' }),
      expect.objectContaining({ key: 'risks', heading: 'Risks', status: 'removed' }),
      expect.objectContaining({ key: 'peers', heading: 'Peers', status: 'unchanged' }),
      expect.objectContaining({ key: 'outlook', heading: 'Outlook', status: 'added' }),
    ]);
    expect(diff.summary).toMatchObject({
      sectionsChanged: 1,
      sectionsAdded: 1,
      sectionsRemoved: 1,
      sectionsUnchanged: 1,
      hasChanges: true,
    });
  });

  it('treats a style-only change as unchanged: class, style, attribute order, whitespace, <style>', () => {
    const before = doc(
      section('kpis', '<h2>KPIs</h2><p class="a" id="x">Revenue   $5.2bn</p>', ' class="card"'),
    );
    const after =
      '<html><head><style>body{color:red}</style></head><body>' +
      `<section class="card wide" style="padding:8px"   data-section="kpis">\n  <h2 style="color:blue">KPIs</h2>\n  <p id="y" class="b">Revenue <span style="font-weight:700">$5.2bn</span></p>\n</section>` +
      '</body></html>';

    const diff = diffInsightVersions(before, after);

    expect(diff.sections).toEqual([
      expect.objectContaining({ key: 'kpis', status: 'unchanged' }),
    ]);
    expect(diff.figures).toEqual([]);
    expect(diff.summary.hasChanges).toBe(false);
    expect(formatDiffSummary(diff.summary)).toBe(
      'No content changes — only styling or markup differs',
    );
  });

  it('falls back to top-level block order for blocks without a key', () => {
    const before = doc('<h1>Title</h1><p>Intro text.</p><p>Revenue was 10%.</p><p>Closing.</p>');
    const after = doc(
      '<h1>Title</h1><p>New paragraph.</p><p>Intro text.</p><p>Revenue was 12%.</p><p>Closing.</p>',
    );

    expect(statuses(before, after)).toEqual([
      'Title:unchanged',
      'New paragraph.:added',
      'Intro text.:unchanged',
      'Revenue was 12%.:changed',
      'Closing.:unchanged',
    ]);
  });

  it('unwraps a lone wrapper element to find the top-level blocks', () => {
    const before = '<div class="page"><main><p>One</p><p>Two 5%</p></main></div>';
    const after = '<div class="page"><main><p>One</p><p>Two 6%</p></main></div>';

    expect(statuses(before, after)).toEqual(['One:unchanged', 'Two 6%:changed']);
  });

  it('treats a nested keyed section as its own section', () => {
    const before = doc(
      section('overview', '<h2>Overview</h2>' + section('chart', '<h3>Chart</h3><p>Sales 10</p>')),
    );
    const after = doc(
      section('overview', '<h2>Overview</h2>' + section('chart', '<h3>Chart</h3><p>Sales 11</p>')),
    );

    expect(statuses(before, after)).toEqual(['overview:unchanged', 'chart:changed']);
  });

  it('marks everything added against an empty current version', () => {
    const diff = diffInsightVersions('', doc(section('a', '<h2>A</h2><p>1.5x</p>')));
    expect(diff.sections).toEqual([expect.objectContaining({ key: 'a', status: 'added' })]);
    expect(diff.figures).toEqual([
      expect.objectContaining({ kind: 'added', before: null, after: '1.5x' }),
    ]);
  });

  it('flags a changed chart script outside every section', () => {
    const before = doc('<p>Chart</p><script>render([1,2,3])</script>');
    const after = doc('<p>Chart</p><script>render([1,2,4])</script>');

    const diff = diffInsightVersions(before, after);

    expect(diff.summary.scriptsChanged).toBe(true);
    expect(diff.summary.hasChanges).toBe(true);
    expect(formatDiffSummary(diff.summary)).toBe('chart or page scripts changed');
  });
});

describe('diffInsightVersions — table figures', () => {
  const table = (rows: string[][], caption = '') =>
    `<table>${caption ? `<caption>${caption}</caption>` : ''}<thead><tr><th>Company</th><th>Revenue</th><th>EBITDA margin</th></tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;

  it('keys a cell by row label and column header', () => {
    const before = doc(section('peers', `<h2>Peers</h2>${table([['Adaro', '$6.5bn', '32%'], ['Bukit', 'Rp 38.5tn', '18%']])}`));
    const after = doc(section('peers', `<h2>Peers</h2>${table([['Adaro', '$6.9bn', '32%'], ['Bukit', 'Rp 38.5tn', '21%']])}`));

    const diff = diffInsightVersions(before, after);

    expect(diff.figures).toEqual([
      { sectionKey: 'peers', sectionHeading: 'Peers', label: 'Adaro · Revenue', before: '$6.5bn', after: '$6.9bn', kind: 'changed' },
      { sectionKey: 'peers', sectionHeading: 'Peers', label: 'Bukit · EBITDA margin', before: '18%', after: '21%', kind: 'changed' },
    ]);
    expect(formatDiffSummary(diff.summary)).toBe('1 section changed · 2 figures changed');
  });

  it('reads a reordered row as no figure changes', () => {
    const rows = [
      ['Adaro', '$6.5bn', '32%'],
      ['Bukit', 'Rp 38.5tn', '18%'],
      ['Indika', '$3.0bn', '12%'],
    ];
    const before = doc(section('peers', table(rows)));
    const after = doc(section('peers', table([rows[2], rows[0], rows[1]])));

    const diff = diffInsightVersions(before, after);

    expect(diff.figures).toEqual([]);
    // The order changed, so the section did — but no figure did.
    expect(diff.sections[0].status).toBe('changed');
  });

  it('lists an added and a removed row as added and removed figures', () => {
    const before = doc(section('peers', table([['Adaro', '$6.5bn', '32%'], ['Bukit', '$2.4bn', '18%']])));
    const after = doc(section('peers', table([['Adaro', '$6.5bn', '32%'], ['Indika', '$3.0bn', '12%']])));

    const kinds = diffInsightVersions(before, after).figures.map((f) => `${f.kind}:${f.label}:${f.before}->${f.after}`);

    expect(kinds).toEqual([
      'added:Indika · Revenue:null->$3.0bn',
      'added:Indika · EBITDA margin:null->12%',
      'removed:Bukit · Revenue:$2.4bn->null',
      'removed:Bukit · EBITDA margin:18%->null',
    ]);
  });

  it('ignores unavailable cells and source references', () => {
    const before = doc(
      section(
        'output',
        `<table><tr><th>Mine</th><th>Output</th><th>Quota</th></tr><tr><td>Tutupan</td><td>62.1 Mt${sourceRefHtml('S1')}</td>${unavailableMarkerHtml('Quota letters not public')}</tr></table>` +
          sourcesSectionHtml([{ id: 'S1', kind: 'web', retrieved: '2026-09-01', feeds: 'output', name: 'ESDM', locator: 'https://modi.esdm.go.id/' }]),
      ),
    );
    const after = doc(
      section(
        'output',
        `<table><tr><th>Mine</th><th>Output</th><th>Quota</th></tr><tr><td>Tutupan</td><td>62.1 Mt${sourceRefHtml('S2')}</td>${unavailableMarkerHtml('Quota letters withheld (2026)')}</tr></table>` +
          sourcesSectionHtml([{ id: 'S2', kind: 'valyu', retrieved: '2026-09-24', feeds: 'output 2025', name: 'Valyu', locator: 'valyu_search: Adaro 2025 output 68 Mt' }]),
      ),
    );

    const diff = diffInsightVersions(before, after);

    expect(diff.figures).toEqual([]);
    expect(diff.sections.map((s) => s.status)).toContain('changed');
  });
});

describe('diffInsightVersions — prose figures', () => {
  it('aligns prose numbers within a section and labels them with the preceding words', () => {
    const before = doc(
      section('summary', '<h2>Summary</h2><p>Revenue grew to $5.2bn in FY2025, with EBITDA margin of 31.5% and net debt at 1.2x.</p>'),
    );
    const after = doc(
      section('summary', '<h2>Summary</h2><p>Revenue grew to $5.4bn in FY2025, with EBITDA margin of 31.5% and net debt at 1.4x.</p>'),
    );

    const diff = diffInsightVersions(before, after);

    expect(diff.figures).toEqual([
      expect.objectContaining({ label: 'Revenue grew to', before: '$5.2bn', after: '$5.4bn', kind: 'changed' }),
      expect.objectContaining({ label: 'and net debt at', before: '1.2x', after: '1.4x', kind: 'changed' }),
    ]);
  });

  it('labels a KPI tile value with its tile label', () => {
    const tiles = (rev: string, ebitda: string) =>
      doc(section('kpis', `<div class="kpi"><div>Revenue</div><div>${rev}</div></div><div class="kpi"><div>EBITDA</div><div>${ebitda}</div></div>`));

    const diff = diffInsightVersions(tiles('US$5.2bn', 'US$1.1bn'), tiles('US$5.2bn', 'US$1.3bn'));

    expect(diff.figures).toEqual([
      expect.objectContaining({ label: 'EBITDA', before: 'US$1.1bn', after: 'US$1.3bn', kind: 'changed' }),
    ]);
  });

  it('lists an inserted sentence figure as added without shifting the others', () => {
    const before = doc(section('s', '<p>Sales were 120k units. Margin held at 20%.</p>'));
    const after = doc(section('s', '<p>Sales were 120k units. Exports reached 45k units. Margin held at 20%.</p>'));

    expect(diffInsightVersions(before, after).figures).toEqual([
      expect.objectContaining({ label: 'Exports reached', before: null, after: '45k', kind: 'added' }),
    ]);
  });

  it('does not read dates, years or fiscal labels as figures', () => {
    const before = doc(section('s', '<p>As of 2026-09-01 (Q3 2026, FY2025) on 1 Sep 2026 at 10:30, data from 2024.</p>'));
    const after = doc(section('s', '<p>As of 2026-09-24 (Q4 2026, FY2026) on 24 Sep 2026 at 11:45, data from 2025.</p>'));

    const diff = diffInsightVersions(before, after);

    expect(diff.figures).toEqual([]);
    expect(diff.sections[0].status).toBe('changed');
  });
});

describe('diffInsightVersions — bounds', () => {
  it(`caps the figure list at ${MAX_FIGURE_CHANGES} and counts the rest`, () => {
    const rows = (offset: number) =>
      Array.from({ length: 150 }, (_, i) => `<tr><td>Co ${i}</td><td>${i + offset}%</td><td>${i + offset}.5x</td></tr>`).join('');
    const tableDoc = (offset: number) =>
      doc(section('big', `<table><tr><th>Co</th><th>Share</th><th>Multiple</th></tr>${rows(offset)}</table>`));

    const diff = diffInsightVersions(tableDoc(1000), tableDoc(2000));

    expect(diff.figures).toHaveLength(MAX_FIGURE_CHANGES);
    expect(diff.summary.figuresChanged).toBe(300);
    expect(diff.summary.figuresOmitted).toBe(100);
  });
});

describe('formatDiffSummary', () => {
  it('names the noun once and joins sections and figures', () => {
    expect(
      formatDiffSummary({
        sectionsChanged: 3,
        sectionsAdded: 1,
        sectionsRemoved: 0,
        sectionsUnchanged: 4,
        figuresChanged: 7,
        figuresAdded: 0,
        figuresRemoved: 2,
        figuresOmitted: 0,
        scriptsChanged: false,
        hasChanges: true,
      }),
    ).toBe('3 sections changed, 1 added · 7 figures changed, 2 removed');
  });
});

describe('highlightPreviewHtml', () => {
  it('outlines changed and added sections without touching the rest of the document', () => {
    const before = doc(section('a', '<p>1%</p>') + section('b', '<p>same</p>'));
    const after = doc(section('a', '<p>2%</p>') + section('b', '<p>same</p>') + section('c', '<p>new</p>'));
    const diff = diffInsightVersions(before, after);

    const preview = highlightPreviewHtml(after, diff);

    expect(preview).toContain(`<section data-section="a" ${DIFF_HIGHLIGHT_ATTR}="changed">`);
    expect(preview).toContain(`<section data-section="c" ${DIFF_HIGHLIGHT_ATTR}="added">`);
    expect(preview).toContain('<section data-section="b">');
    expect(preview).toContain('<style data-insight-diff-style>');
    expect(preview.indexOf('<style data-insight-diff-style>')).toBeLessThan(preview.indexOf('</body>'));
    // Stripping the highlight gives back the candidate byte for byte.
    const stripped = preview
      .replace(/<style data-insight-diff-style>[\s\S]*?<\/style>/, '')
      .replace(new RegExp(` ${DIFF_HIGHLIGHT_ATTR}="(?:changed|added)"`, 'g'), '');
    expect(stripped).toBe(after);
  });

  it('returns the candidate unchanged when nothing is highlighted', () => {
    const html = doc(section('a', '<p>1%</p>'));
    expect(highlightPreviewHtml(html, diffInsightVersions(html, html))).toBe(html);
  });

  it('marks a self-closing element before its slash', () => {
    const after = '<p>Text</p><img src="a.png" />';
    const diff = diffInsightVersions('<p>Text</p>', after);
    expect(highlightPreviewHtml(after, diff)).toContain(`<img src="a.png"  ${DIFF_HIGHLIGHT_ATTR}="added"/>`);
  });
});
