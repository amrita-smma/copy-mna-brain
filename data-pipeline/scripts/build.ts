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
  crmIngest: 'crm-ingest',
  crmLlmSubmit: 'crm-llm-submit',
  crmLlmFetch: 'crm-llm-fetch',
  crmDomainClassify: 'crm-domain-classify',
  vaultParse: 'vault-parse',
  vaultArchiveStart: 'vault-archive-start',
  vaultArchivePoll: 'vault-archive-poll',
  attachmentGate: 'attachment-gate',
  attachmentFetch: 'attachment-fetch',
  attachmentTriage: 'attachment-triage',
  attachmentUpload: 'attachment-upload',
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
      external: [
        '@aws-sdk/client-s3',
        '@aws-sdk/client-ssm',
        '@aws-sdk/client-sns',
        '@aws-sdk/client-sqs',
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/client-sts',
        '@aws-sdk/client-lambda',
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
