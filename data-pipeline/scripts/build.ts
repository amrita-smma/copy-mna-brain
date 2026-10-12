/**
 * Bundle each Lambda entrypoint into dist/<kebab>/index.js (+ a deploy zip).
 *
 * - Resolves the `@/*` alias to the app's ./src so shared repos/schema/s3
 *   bundle in.
 * - CJS output with `index.handler` so the Lambda runtime + SAM can invoke it.
 * - aws-sdk v3 is provided by the nodejs20 Lambda runtime → kept external.
 *
 * Output naming uses the kebab-case keys that data-pipeline/terraform/pipeline-compute
 * expects (dist/<kebab>.zip).
 *
 * Usage: pnpm --filter data-pipeline build
 */
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import AdmZip from 'adm-zip';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..'); // data-pipeline/
const repoRoot = resolve(pkgRoot, '..'); // repo root
const srcAlias = resolve(repoRoot, 'src');
const distDir = resolve(pkgRoot, 'dist');

// entrypoint file (camelCase) → terraform key (kebab-case)
const ENTRIES: Record<string, string> = {
  vaultArchiveStart: 'vault-archive-start',
  vaultArchivePoll: 'vault-archive-poll',
  rssPoll: 'rss-poll',
  rssEnrich: 'rss-enrich',
};

async function main() {
  rmSync(distDir, { recursive: true, force: true });

  for (const [entry, kebab] of Object.entries(ENTRIES)) {
    const outdir = resolve(distDir, kebab);
    const outfile = resolve(outdir, 'index.js');

    await build({
      entryPoints: [resolve(pkgRoot, `src/lambda/${entry}.ts`)],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      sourcemap: false,
      minify: false,
      alias: { '@': srcAlias },
      // Core AWS SDK v3 clients are in the nodejs20 Lambda runtime — keep external.
      // Helper packages NOT in the runtime must be bundled (rds-signer, lib-storage).
      //
      // `canvas` is a native (.node) optional dependency of `linkedom`, which is
      // pulled in solely by `@extractus/article-extractor` — the HTML-to-text
      // extractor `rssEnrich` uses to fetch selected articles' full body text.
      // (`react-pdf`/`pdfjs-dist` also depend on `canvas`, but those are frontend
      // packages unreachable from any Lambda entrypoint — not the source here.)
      // esbuild can't bundle a .node binary, and it isn't needed at runtime:
      // linkedom's own `commonjs/canvas.cjs` wraps `require('canvas')` in
      // try/catch and falls back to a no-op `canvas-shim.cjs` stub when the
      // module is absent — which it deliberately is here, since rssEnrich only
      // strips/parses HTML text and never renders to a real <canvas>.
      //
      // `mem0ai` is the CoPilot's memory library (src/lib/memory). No Lambda
      // calls it, but esbuild still follows the dynamic `import('mem0ai/oss')`
      // in `memory/client.ts`, which every entrypoint reaches by accident:
      // `@/lib/repositories` → flFundRepository → features/overrides →
      // workspace → session → auth → services/container → userMemoryService.
      // Bundling it fails, because mem0 lazy-imports ~40 optional vector-store
      // and LLM SDKs (oracledb, ollama, groq-sdk, cohere-ai, ...) that we do
      // not install. Keeping it external leaves the import unresolved in a
      // branch no Lambda executes — the same treatment `canvas` gets above, and
      // the counterpart of `serverExternalPackages: ['mem0ai']` in next.config.ts.
      external: [
        'mem0ai',
        '@aws-sdk/client-s3',
        '@aws-sdk/client-ssm',
        '@aws-sdk/client-sns',
        '@aws-sdk/client-sqs',
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/client-sts',
        '@aws-sdk/client-lambda',
        'canvas',
      ],
      logLevel: 'warning',
    });

    // Zip the function dir → dist/<kebab>.zip (terraform source_code_hash target)
    const zip = new AdmZip();
    zip.addLocalFolder(outdir);
    zip.writeZip(resolve(distDir, `${kebab}.zip`));
    console.log(`✓ ${entry} → dist/${kebab}/index.js + dist/${kebab}.zip`);
  }

  console.log(`\nBuilt ${Object.keys(ENTRIES).length} functions into ${distDir}`);
}

main().catch((err) => {
  console.error('✗ build failed:', err);
  process.exit(1);
});
