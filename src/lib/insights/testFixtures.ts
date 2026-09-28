export function generateWords(count: number): string {
  const words = [
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
    'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi',
    'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
  ];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(words[i % words.length]);
  }
  return result.join(' ');
}

export function makeValidReport(overrides?: {
  summaryContent?: string;
  detailsContent?: string;
  appendixContent?: string;
}): string {
  const summary =
    overrides?.summaryContent ??
    `<p>${generateWords(180)}</p>`;

  const details =
    overrides?.detailsContent ??
    `
      <h2>Financial Performance</h2>
      <div data-counter-case>
        <p>${generateWords(50)}</p>
      </div>
      <p>${generateWords(20)}</p>
      <table>
        <tr><th>Metric</th><th>2025</th></tr>
        <tr><td>Revenue</td><td>$100M</td></tr>
      </table>
      <p>${generateWords(25)}</p>
      <canvas id="growthChart"></canvas>
      <p>${generateWords(18)}</p>
    `;

  const appendix =
    overrides?.appendixContent ??
    `
      <h2>Appendix</h2>
      <p>${generateWords(20)}</p>
      <figure>
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>
        <figcaption>Figure caption</figcaption>
      </figure>
      <p>${generateWords(20)}</p>
    `;

  return `
    <!DOCTYPE html>
    <html>
      <head><title>Test Report</title></head>
      <body>
        <section data-section="summary">
          ${summary}
        </section>
        <section data-section="details">
          ${details}
        </section>
        <section data-section="appendix">
          ${appendix}
        </section>
      </body>
    </html>
  `;
}

/**
 * A candidate cut off mid-document, the way an output-token limit cuts one
 * (MB-555): its figures cite `[S1]`, but the Sources section and the closing
 * `</body></html>` never arrived. The render check must refuse it before the
 * marker check can misreport it as a dangling source reference.
 */
export function makeTruncatedCandidate(): string {
  return `<!DOCTYPE html><html><head><style>body{font-family:sans-serif}</style></head><body>
<section data-section="output"><h2>Output</h2>
<table><tr><th>Mine</th><th>FY2025 output</th></tr>
<tr><td>Tutupan</td><td>62.1 Mt<sup data-source-ref="S1">[S1]</sup></td></tr>
<tr><td>Wara</td><td>18.4 Mt<sup data-source-ref="S1">[S1]</sup></td></tr>`;
}

/** A section fragment cut off inside its chart script (MB-555). */
export function makeTruncatedFragment(): string {
  return `<section data-section="chart"><h2>Chart</h2><div id="c"></div><script>draw([62.1, 18.4,`;
}
