/**
 * Generates `src/lib/changelog.data.ts` from the repo's git history, which
 * drives the in-app "What's new" widget.
 *
 * Runs in the "Update changelog" GitHub Action (.github/workflows/changelog.yml)
 * on every push to `main`; the workflow commits the regenerated file back to
 * `main`. Can also be run locally (`pnpm changelog:generate`) to preview.
 *
 * Accounting model: `changelog.data.ts` records EVERY commit read from git,
 * each flagged `skipped` or not. The first step is a cross-check — read the full
 * git history, then keep only commits whose hash is not already present in the
 * data file ("unaccounted"). Everything already in the file (shown or skipped)
 * is left untouched and never re-examined, so noise and too-vague commits are
 * checked exactly once, ever.
 *
 * For unaccounted commits, this script submits the non-noise ones as a single
 * Anthropic Message Batch (parallel, 50 % cheaper than individual calls). Each
 * request asks claude-haiku to rewrite the raw commit subject into a user-facing
 * sentence, optionally enriched with the associated PR title + summary fetched
 * in parallel via `gh api`. Commits the model judges too vague are recorded with
 * `skipped: true` (reason `vague`) so they are not re-checked next run.
 *
 * Noise filter (in src/lib/changelog.ts): merge commits, reverts, hotfixes,
 * [skip-ci], github-actions/bot authors, and undateable commits are recorded
 * with `skipped: true` (reason `noise`) — never sent to the API.
 *
 * Falls back to regex-cleaned subjects when ANTHROPIC_API_KEY is not set.
 *
 * Usage: pnpm changelog:generate
 */
import Anthropic from '@anthropic-ai/sdk';
import { exec as execCallback, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  classifyCommit,
  sortChangelogEntries,
  cleanSubject,
  type RawCommit,
  type ChangelogEntry,
} from '../src/lib/changelog';

// Load .env.local first (Next.js convention), then .env, then fall back to
// whatever is already in the environment (CI injects ANTHROPIC_API_KEY as a secret).
dotenvConfig({ path: join(process.cwd(), '.env.local'), override: false });
dotenvConfig({ path: join(process.cwd(), '.env'), override: false });

const OUT_FILE = join(process.cwd(), 'src/lib/changelog.data.ts');
const FS = '\x1f';
const POLL_INTERVAL_MS = 5_000;
const USE_BATCH = process.argv.includes('--batch');

/** Read the full commit history (newest first, no merge commits) via git. */
function readCommits(): RawCommit[] {
  const out = execSync(
    `git log --no-merges --pretty=format:%H${FS}%cI${FS}%an${FS}%s`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [hash, date, author, ...subjectParts] = line.split(FS);
      return { hash, date, author, subject: subjectParts.join(FS) };
    });
}

/**
 * Parse the existing output file and return every stored entry (shown and
 * skipped alike). These are the already-accounted-for commits: they are kept
 * verbatim and never re-examined.
 */
function readExistingEntries(): ChangelogEntry[] {
  try {
    const content = readFileSync(OUT_FILE, 'utf8');
    const match = /export const GENERATED_CHANGELOG[^=]+=\s*(\[[\s\S]*?\]);/.exec(content);
    if (!match) return [];
    return JSON.parse(match[1]) as ChangelogEntry[];
  } catch {
    return [];
  }
}

interface PrInfo {
  title: string;
  body: string;
}

/** Fetch the first merged PR associated with a commit hash via `gh api`. */
async function fetchPr(hash: string): Promise<PrInfo | null> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  try {
    const { stdout } = await exec(
      `gh api "repos/${repo}/commits/${hash}/pulls" --jq '.[0] | {title: .title, body: (.body // "")}'`,
      { timeout: 10_000 },
    );
    const raw = stdout.trim();
    if (!raw || raw === 'null') return null;
    const pr = JSON.parse(raw) as PrInfo;
    return pr.title ? pr : null;
  } catch {
    return null;
  }
}

/** Extract the # Summary and # Changes sections from a PR body. */
function extractPrContext(body: string): string {
  const lines = body.split('\n');
  const relevant: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#\s+(Summary|Changes)\b/i.test(line)) {
      inSection = true;
      relevant.push(line);
      continue;
    }
    if (/^#\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection && line.trim() && !line.startsWith('`MR Description`') && !line.startsWith('- ...')) {
      relevant.push(line);
    }
  }
  return relevant.join('\n').trim().slice(0, 600);
}

function buildPrompt(rawSubject: string, pr: PrInfo | null): string {
  const prSection = pr
    ? `\n\nPR title: ${pr.title}\nPR context:\n${extractPrContext(pr.body)}`
    : '';
  return (
    `You write user-facing release notes for an M&A deal-tracking platform used by investment bankers. ` +
    `Given the commit message and optional PR details, write ONE concise changelog entry ` +
    `(a single sentence, max 80 characters). Focus on the user-visible change — not implementation ` +
    `details, filenames, or internal jargon. Do not start with "This", "We", or "I". ` +
    `Return ONLY the entry text — no bullet points, no dashes, no quotes, no trailing period.\n\n` +
    `If the commit is too vague or internal to produce a meaningful user-facing entry, ` +
    `return exactly the word SKIP and nothing else.\n\n` +
    `Commit: ${rawSubject}${prSection}`
  );
}

/** Returns true when the model's response is not a usable changelog entry. */
function shouldSkip(text: string): boolean {
  if (text === 'SKIP') return true;
  // Guard against multi-sentence deflections the model may return despite instructions.
  if (text.length > 160) return true;
  if (text.includes('\n')) return true;
  return false;
}

function renderFile(entries: ChangelogEntry[]): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-changelog.ts — DO NOT EDIT BY HAND.
// Committed by the "Update changelog" GitHub Action from the repo's git history
// on \`main\`.
import type { ChangelogEntry } from './changelog';

export const GENERATED_CHANGELOG: ChangelogEntry[] = ${JSON.stringify(entries, null, 2)};
`;
}

async function main(): Promise<void> {
  let rawCommits: RawCommit[];
  try {
    rawCommits = readCommits();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[changelog] Could not read git history — keeping existing file: ${message}`);
    return;
  }

  const existingEntries = readExistingEntries();
  const accounted = new Set(existingEntries.map((e) => e.hash));
  const rawCommitByHash = new Map(rawCommits.map((c) => [c.hash, c]));

  // Step 1 — cross-check: keep only commits not already recorded in the data
  // file. Everything else (shown or skipped) is already accounted for.
  const unaccounted = rawCommits.filter((c) => !accounted.has(c.hash));

  if (unaccounted.length === 0) {
    console.log(
      `[changelog] All ${rawCommits.length} commit(s) already accounted for — nothing to do.`,
    );
    return;
  }

  // Classify every unaccounted commit. Noise/undateable come back flagged
  // `skipped` (reason `noise`) and never hit the API; the rest are candidates
  // for the model to reformat.
  const classified = unaccounted.map(classifyCommit);
  const candidates = classified.filter((e) => !e.skipped);
  const noiseCount = classified.length - candidates.length;

  console.log(
    `[changelog] ${unaccounted.length} unaccounted commit(s): ` +
      `${candidates.length} to reformat, ${noiseCount} filtered as noise.`,
  );

  if (candidates.length === 0) {
    // Only noise — record it so it is never re-checked, then finish.
    const finalEntries = sortChangelogEntries([...existingEntries, ...classified]);
    writeFileSync(OUT_FILE, renderFile(finalEntries), 'utf8');
    console.log(`[changelog] Recorded ${noiseCount} noise commit(s); no reformatting needed.`);
    return;
  }

  // Fetch PR info for all candidates in parallel.
  const prs = await Promise.all(candidates.map((e) => fetchPr(e.hash)));

  // Map of hash → Haiku-reformatted subject for candidates only.
  const reformattedSubjects = new Map<string, string>();
  const skippedHashes = new Set<string>();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[changelog] ANTHROPIC_API_KEY not set — using regex-cleaned subjects as fallback.');
    for (const entry of candidates) {
      const raw = rawCommitByHash.get(entry.hash);
      reformattedSubjects.set(entry.hash, cleanSubject(raw?.subject ?? entry.subject));
    }
  } else if (USE_BATCH) {
    // --batch: submit all requests as a single Message Batch and poll for results.
    // Cheaper (50% discount) but asynchronous — takes ~1 min to complete.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const batchRequests = candidates.map((entry, i) => {
      const raw = rawCommitByHash.get(entry.hash);
      const prompt = buildPrompt(raw?.subject ?? entry.subject, prs[i] ?? null);
      return {
        custom_id: entry.hash,
        params: {
          model: 'claude-haiku-5-5' as const,
          // Haiku 5.5 thinks by default and thinking tokens count against
          // max_tokens, so 100 could be spent before any text block.
          max_tokens: 500,
          output_config: { effort: 'low' as const },
          messages: [{ role: 'user' as const, content: prompt }],
        },
      };
    });

    console.log(`[changelog] Submitting batch of ${batchRequests.length} request(s)…`);
    let batch = await anthropic.messages.batches.create({ requests: batchRequests });
    console.log(`[changelog] Batch ${batch.id} created (status: ${batch.processing_status}).`);

    while (batch.processing_status !== 'ended') {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      batch = await anthropic.messages.batches.retrieve(batch.id);
      const { processing, succeeded, errored } = batch.request_counts;
      console.log(`[changelog] Batch ${batch.id}: ${batch.processing_status} — ${processing} processing, ${succeeded} done, ${errored} errored.`);
    }

    for await (const result of await anthropic.messages.batches.results(batch.id)) {
      const raw = rawCommitByHash.get(result.custom_id);
      if (result.result.type === 'succeeded') {
        const block = result.result.message.content.find((b) => b.type === 'text');
        const text = block?.type === 'text' ? block.text.trim() : '';
        if (shouldSkip(text)) {
          skippedHashes.add(result.custom_id);
        } else {
          reformattedSubjects.set(result.custom_id, text);
        }
      } else {
        console.warn(`[changelog] Request ${result.custom_id} ${result.result.type} — using fallback.`);
        reformattedSubjects.set(result.custom_id, cleanSubject(raw?.subject ?? result.custom_id));
      }
    }
  } else {
    // Default: fire all requests in parallel via Promise.all. Faster (results in seconds),
    // standard API pricing.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    console.log(`[changelog] Sending ${candidates.length} request(s) in parallel…`);
    const results = await Promise.all(
      candidates.map(async (entry, i) => {
        const raw = rawCommitByHash.get(entry.hash);
        const prompt = buildPrompt(raw?.subject ?? entry.subject, prs[i] ?? null);
        try {
          const msg = await anthropic.messages.create({
            model: 'claude-haiku-5-5',
            max_tokens: 500,
            output_config: { effort: 'low' },
            messages: [{ role: 'user', content: prompt }],
          });
          const block = msg.content.find((b) => b.type === 'text');
          const text = block?.type === 'text' ? block.text.trim() : '';
          if (shouldSkip(text)) {
            return { hash: entry.hash, subject: null };
          }
          return { hash: entry.hash, subject: text };
        } catch (err) {
          console.warn(`[changelog] Request for ${entry.hash} failed — using fallback. ${err}`);
          return { hash: entry.hash, subject: cleanSubject(raw?.subject ?? entry.subject) };
        }
      }),
    );

    for (const { hash, subject } of results) {
      if (subject === null) {
        skippedHashes.add(hash);
      } else {
        reformattedSubjects.set(hash, subject);
      }
    }
  }

  // Apply the model's verdict to each candidate: adopt the reformatted subject,
  // or flag it skipped (reason `vague`) so it is recorded but hidden and never
  // re-checked.
  for (const entry of candidates) {
    if (skippedHashes.has(entry.hash)) {
      entry.skipped = true;
      entry.skipReason = 'vague';
      continue;
    }
    const subject = reformattedSubjects.get(entry.hash);
    if (subject) entry.subject = subject;
  }

  // Merge the already-accounted entries (untouched) with the freshly classified
  // ones, then sort newest-first. Skipped entries are persisted too.
  const finalEntries = sortChangelogEntries([...existingEntries, ...classified]);

  const mode = !process.env.ANTHROPIC_API_KEY ? 'fallback' : USE_BATCH ? 'batch' : 'parallel';
  writeFileSync(OUT_FILE, renderFile(finalEntries), 'utf8');
  const shown = finalEntries.filter((e) => !e.skipped).length;
  console.log(
    `[changelog] Wrote ${finalEntries.length} entr${finalEntries.length === 1 ? 'y' : 'ies'} ` +
      `(${shown} shown, ${finalEntries.length - shown} skipped) — this run: ` +
      `${reformattedSubjects.size} reformatted via Haiku [${mode}], ` +
      `${noiseCount} noise` +
      (skippedHashes.size > 0 ? `, ${skippedHashes.size} skipped as too vague` : '') +
      `.`,
  );
}

main().catch((err) => {
  console.error('[changelog] Fatal error:', err);
  process.exit(1);
});
