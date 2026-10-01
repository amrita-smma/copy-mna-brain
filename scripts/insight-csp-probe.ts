/**
 * Browser-level proof that an insight's CSP holds against hostile documents.
 *
 * Renders each document through buildInsightSrcDoc in a real sandboxed
 * iframe (Chromium, INSIGHT_SANDBOX) and counts the fetch and image beacons
 * that reach a local server. A control frame with no policy must leak, or the
 * probe proves nothing. srcdoc.test.ts only string-checks the policy — run
 * this whenever srcdoc.ts changes:
 *
 *   pnpm exec tsx scripts/insight-csp-probe.ts
 *
 * Exits non-zero when any hostile document leaks or the control does not.
 */
import http from 'node:http';
import { chromium } from '@playwright/test';
import { buildInsightSrcDoc, INSIGHT_SANDBOX } from '../src/lib/insights/srcdoc';

const beacon = (tag: string, port: number) =>
  `fetch('http://127.0.0.1:${port}/exfil/${tag}/fetch').catch(()=>{});` +
  `new Image().src='http://127.0.0.1:${port}/exfil/${tag}/img';`;

function hostileDocuments(port: number): Record<string, string> {
  const b = (tag: string) => `<script>${beacon(tag, port)}</script>`;
  return {
    'head-in-comment': `<!-- <head> -->${b('head-in-comment')}<html><head></head><body>x</body></html>`,
    'head-in-script-string': `<script>var s="<head>";${beacon('head-in-script-string', port)}</script><html><head></head><body>x</body></html>`,
    'head-in-attribute': `<div title="<head>"></div>${b('head-in-attribute')}`,
    'html-in-comment': `<!-- <html> -->${b('html-in-comment')}<p>x</p>`,
    'script-before-head': `<!DOCTYPE html>${b('script-before-head')}<html><head></head><body>x</body></html>`,
    'script-in-head': `<!DOCTYPE html><html><head>${b('script-in-head')}</head><body>x</body></html>`,
    'img-tag': `<p>x</p><img src="http://127.0.0.1:${port}/exfil/img-tag/img">`,
  };
}

async function main() {
  const hits = new Set<string>();
  const server = http.createServer((req, res) => {
    const tag = req.url?.match(/^\/exfil\/([^/]+)\//)?.[1];
    if (tag) hits.add(tag);
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? '<!doctype html><html><body></body></html>' : 'ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const frames: { name: string; srcdoc: string }[] = [
    ...Object.entries(hostileDocuments(port)).map(([name, html]) => ({
      name,
      srcdoc: buildInsightSrcDoc(html),
    })),
    // No policy: this one must leak.
    { name: 'control', srcdoc: `<script>${beacon('control', port)}</script>` },
  ];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(
      ({ frames, sandbox }) => {
        for (const f of frames) {
          const el = document.createElement('iframe');
          el.setAttribute('sandbox', sandbox);
          el.srcdoc = f.srcdoc;
          document.body.appendChild(el);
        }
      },
      { frames, sandbox: INSIGHT_SANDBOX },
    );
    await page.waitForTimeout(2000);
  } finally {
    await browser.close();
    server.close();
  }

  const leaked = frames.map((f) => f.name).filter((n) => n !== 'control' && hits.has(n));
  console.log(`control leaked: ${hits.has('control')}`);
  console.log(`hostile documents leaked: ${leaked.length ? leaked.join(', ') : 'none'}`);
  if (!hits.has('control') || leaked.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
