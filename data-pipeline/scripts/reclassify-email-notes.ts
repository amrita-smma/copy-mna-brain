/**
 * Re-judge every kept email note with Haiku (MB-888): blank the ones that are
 * not deal-related under DEAL_NOTE_RUBRIC, and rewrite the deal notes that give
 * a meeting's date, time, place or link, or a "confirm the slot" next step, so
 * they follow MEETING_NOTE_RULE. New notes are already held to both rules at
 * extraction; this fixes the notes written before them.
 *
 * Dry run by default: judges and writes the notes it WOULD change to the backup
 * file, changes nothing. Review that file, then re-run with --apply. --apply
 * writes each page's changes to the backup BEFORE making them — the email body
 * is not retained, so the backup is the only copy of the original text.
 *
 * Backup lines are JSON: the original note plus `action` — "blanked", or
 * "rewritten" with the new text under `rewritten`. Lines with no `action`
 * (files written before rewrites existed) are blanked notes.
 *
 * Usage (from repo root; `--filter` cwd is data-pipeline/):
 *   pnpm --filter data-pipeline reclassify-notes                  # dry run, all notes
 *   pnpm --filter data-pipeline reclassify-notes --limit 200      # dry-run sample
 *   pnpm --filter data-pipeline reclassify-notes --apply
 *   pnpm --filter data-pipeline reclassify-notes --restore <backup.jsonl>
 *
 * Optional:
 *   --after <email_id>   resume after the cursor a previous run printed
 *   --backup <path>      JSONL file for changed notes (default: the OS temp dir,
 *                        never the repo — it holds private note text)
 *
 * --restore writes the original notes in a backup file back, only where the
 * row still holds what --apply left (blank, or the rewritten summary), so it
 * undoes an --apply without overwriting a note re-extracted since.
 *
 * Env (loaded from .env.local then .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (or RDS_IAM_DB_AUTH=true)
 *   ANTHROPIC_API_KEY
 *
 * Relationship overviews built from a blanked note read as stale afterwards
 * (their note count changes) and regenerate on their next request. A rewrite
 * leaves the count alone, so an overview that already repeats a meeting's
 * details keeps them until it is rebuilt for another reason.
 */
import { config } from 'dotenv';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

function parseArgs(argv: string[]): {
  apply: boolean;
  limit?: number;
  after: string | null;
  backup: string;
  restore: string | null;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const rawLimit = get('--limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    apply: args.includes('--apply'),
    limit,
    after: get('--after') ?? null,
    backup: get('--backup')
      ? resolve(process.cwd(), get('--backup')!)
      : join(tmpdir(), `email-notes-reclassified-${stamp}.jsonl`),
    restore: get('--restore') ? resolve(process.cwd(), get('--restore')!) : null,
  };
}

async function main(): Promise<void> {
  const { apply, limit, after, backup, restore } = parseArgs(process.argv);

  const { createLambdaDb } = await import('../src/db');
  const { reclassifyEmailNotes, restoreEmailNotes } = await import(
    '../src/handlers/emailNoteReclassify'
  );

  if (restore) {
    const entries = readFileSync(restore, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const { action, rewritten, ...note } = JSON.parse(line);
        return {
          note,
          current_summary: action === 'rewritten' ? (rewritten.summary as string) : null,
        };
      });
    console.log(
      `RESTORING ${entries.length} notes from ${restore} on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`,
    );
    const { pgClient, db } = await createLambdaDb();
    try {
      let restored = 0;
      for (let i = 0; i < entries.length; i += 500) {
        restored += await restoreEmailNotes(db as never, entries.slice(i, i + 500));
      }
      console.log(`done — restored ${restored} (the rest have changed since)`);
    } finally {
      await pgClient.end();
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  console.log(
    `${apply ? 'APPLYING' : 'DRY RUN'} on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`,
  );
  console.log(`changed notes → ${backup}`);

  const appendBackup = (lines: object[]): void => {
    // Owner-only: the lines hold private note text.
    appendFileSync(backup, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  };

  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await reclassifyEmailNotes(db as never, {
      apply,
      limit,
      after,
      onDropped: (notes) => {
        appendBackup(notes.map((n) => ({ ...n, action: 'blanked' })));
      },
      onRewritten: (rewrites) => {
        appendBackup(
          rewrites.map(({ original, rewritten }) => ({
            ...original,
            action: 'rewritten',
            rewritten: {
              summary: rewritten.summary,
              key_points: rewritten.key_points,
              next_step: rewritten.next_step,
              next_step_status: rewritten.next_step_status,
            },
          })),
        );
      },
      onProgress: (p) => {
        console.log(
          `examined ${p.examined} · kept ${p.kept} · ${apply ? 'blanked' : 'would blank'} ${p.dropped} · ${apply ? 'rewrote' : 'would rewrite'} ${p.rewritten} · no verdict ${p.unclassified} · cursor ${p.cursor}`,
        );
      },
    });
    console.log(`\ndone — ${JSON.stringify(result)}`);
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
