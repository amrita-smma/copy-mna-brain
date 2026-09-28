/**
 * Test-only fixtures shared by sectionEdit.test.ts and approvalSeam.test.ts.
 *
 * ADVERSARIAL_DOCUMENT holds everything that breaks naive HTML/regex handling
 * or an HTML-comment wire format: "-->" inside a script and a style, <tag>
 * inside a string, unicode, and ordinary HTML comments.
 */
export const ADVERSARIAL_SECTION = `<section data-section="market-overview">
    <h2>Market Overview</h2>
    <p>Original overview content.</p>
  </section>`;

export const ADVERSARIAL_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <!-- Chart.js, pinned to a major range -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    .kpi::after { content: "-->"; }
    .quote::before { content: '"'; }
  </style>
</head>
<body>
  <!-- header -->
  <h1>APAC Semiconductor Equipment — Sector Brief</h1>
  <p>Revenue "grew" 35% YoY &amp; margins held. 中文 · café · 🎉</p>
  ${ADVERSARIAL_SECTION}
  <script>
    // A bare "-->" inside a script is legal JavaScript in a comment
    const ok = 5 --> 3;
    document.title = "Brief <tag>";
  </script>
  <!-- footer -->
</body>
</html>`;
