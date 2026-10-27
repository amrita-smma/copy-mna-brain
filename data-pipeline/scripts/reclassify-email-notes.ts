/**
 * Re-judge every kept email note against DEAL_NOTE_RUBRIC with Haiku and blank
 * the ones that are not deal-related (MB-888). New notes are already gated at
 * extraction; this clears the notes written before that rule.
 *
 * Dry run by default: classifies and writes the notes it WOULD blank to the
 * backup file, changes nothing. Review that file, then re-run with --apply.
 * --apply writes each page's dropped notes to the backup BEFORE blanking them —
 * the email body is not retained, so the backup is the only copy.
 *
 * Usage (from repo root; `--filter` cwd is data-pipeline/):
 *   pnpm --filter data-pipeline reclassify-notes                  # dry run, all notes
 *   pnpm --filter data-pipeline reclassify-notes --limit 200      # dry-run sample
 *   pnpm --filter data-pipeline reclassify-notes --apply
 *   pnpm --filter data-pipeline reclassify-notes --restore <backup.jsonl>
 *
 * Optional:
 *   --after <email_id>   resume after the cursor a previous run printed
 *   --backup <path>      JSONL file for dropped notes (default: the OS temp dir,
 *                        never the repo — it holds private note text)
 *
 * --restore writes the notes in a backup file back, only where they are still
 * blank, so it undoes an --apply without overwriting a note re-extracted since.
 *
 * Env (loaded from .env.local then .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (or RDS_IAM_DB_AUTH=true)
 *   ANTHROPIC_API_KEY
 *
 * Relationship overviews built from a blanked note read as stale afterwards
 * (their note-input hash changes) and regenerate on their next request.
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
      : join(tmpdir(), `email-notes-dropped-${stamp}.jsonl`),
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
    const notes = readFileSync(restore, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    console.log(
      `RESTORING ${notes.length} notes from ${restore} on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`,
    );
    const { pgClient, db } = await createLambdaDb();
    try {
      let restored = 0;
      for (let i = 0; i < notes.length; i += 500) {
        restored += await restoreEmailNotes(db as never, notes.slice(i, i + 500));
      }
      console.log(`done — restored ${restored} (the rest were no longer blank)`);
    } finally {
      await pgClient.end();
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  console.log(
    `${apply ? 'APPLYING' : 'DRY RUN'} on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`,
  );
  console.log(`dropped notes → ${backup}`);

  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await reclassifyEmailNotes(db as never, {
      apply,
      limit,
      after,
      onDropped: (notes) => {
        appendFileSync(backup, notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
      },
      onProgress: (p) => {
        console.log(
          `examined ${p.examined} · kept ${p.kept} · ${apply ? 'blanked' : 'would blank'} ${p.dropped} · no verdict ${p.unclassified} · cursor ${p.cursor}`,
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
