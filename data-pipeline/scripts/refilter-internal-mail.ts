/**
 * Re-apply INTERNAL_MAIL_DOMAINS to mail and CRM cards ingested before a
 * domain joined the list (src/lib/crm/mailDomains.ts): delete the mail that is
 * now internal-only, the auto-created contacts at those domains, and the firms
 * left with nothing but internal domains. See
 * src/handlers/internalMailRefilter.ts for the exact rules.
 *
 * Dry run by default: prints what it WOULD delete and changes nothing. Review
 * it, then re-run with --apply. --apply writes everything it is about to
 * delete to the backup file first — the email body is not retained, so a
 * deleted note cannot be regenerated, and the backup is the only copy.
 *
 * Usage (from repo root; `--filter` cwd is data-pipeline/):
 *   pnpm --filter data-pipeline refilter-internal-mail                            # dry run, every internal domain
 *   pnpm --filter data-pipeline refilter-internal-mail --domain starwealth.vip    # dry run, one domain
 *   pnpm --filter data-pipeline refilter-internal-mail --domain starwealth.vip --apply
 *
 * Optional:
 *   --domain <d>[,<d>]   only these domains (repeatable); each must already be
 *                        in INTERNAL_MAIL_DOMAINS. Mail is internal-only against
 *                        the whole list either way.
 *   --backup <path>      JSONL file for deleted rows (default: the OS temp dir,
 *                        never the repo — it holds private note text)
 *
 * Env (loaded from .env.local then .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (or RDS_IAM_DB_AUTH=true)
 *
 * Relationship overviews built from a deleted note read as stale afterwards
 * (their note count changes) and regenerate on their next request.
 */
import { config } from 'dotenv';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

/** Rows listed in full; the rest are counted. */
const SHOW = 25;

function parseArgs(argv: string[]): { apply: boolean; only: string[]; backup: string } {
  const args = argv.slice(2);
  const only: string[] = [];
  args.forEach((arg, i) => {
    if (arg === '--domain') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--domain needs a value');
      only.push(...value.split(','));
    }
  });
  const backupIdx = args.indexOf('--backup');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    apply: args.includes('--apply'),
    only,
    backup:
      backupIdx !== -1 && args[backupIdx + 1]
        ? resolve(process.cwd(), args[backupIdx + 1])
        : join(tmpdir(), `internal-mail-refilter-${stamp}.jsonl`),
  };
}

function listed<T>(rows: T[], line: (row: T) => string): void {
  for (const row of rows.slice(0, SHOW)) console.log(`    ${line(row)}`);
  if (rows.length > SHOW) console.log(`    … and ${rows.length - SHOW} more`);
}

async function main(): Promise<void> {
  const { apply, only, backup } = parseArgs(process.argv);

  const { createLambdaDb } = await import('../src/db');
  const { refilterInternalMail, resolveRefilterDomains, domainOf } = await import(
    '../src/handlers/internalMailRefilter'
  );
  type RefilterPlan = Awaited<ReturnType<typeof refilterInternalMail>>['plan'];

  const domains = resolveRefilterDomains(only);
  console.log(
    `${apply ? 'APPLYING' : 'DRY RUN'} on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`,
  );
  console.log(`domains: ${domains.join(', ')}`);
  if (apply) console.log(`deleted rows → ${backup}`);

  const report = (plan: RefilterPlan): void => {
    const verb = apply ? 'deleting' : 'would delete';
    const byDomain = new Map<string, number>();
    for (const e of plan.emails) {
      const touched = new Set(
        e.participants.map((p) => domainOf(p.address)).filter((d) => domains.includes(d)),
      );
      for (const d of touched) byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
    }
    const notes = plan.emails.filter((e) => e.note?.summary).length;
    console.log(`\n${verb} ${plan.emails.length} internal-only emails (${notes} with a CRM note)`);
    for (const [d, n] of [...byDomain].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${d}: ${n}`);
    }

    const dealLinks = plan.correspondents.reduce((n, c) => n + c.deal_links, 0);
    const manualLinks = plan.correspondents.reduce((n, c) => n + c.manual_deal_links, 0);
    console.log(
      `\n${verb} ${plan.correspondents.length} contacts (${dealLinks} deal links go with them, ${manualLinks} made or confirmed by a person)`,
    );
    listed(plan.correspondents, (c) => `${c.name} <${c.email}>`);

    console.log(`\n${verb} ${plan.employers.length} firms`);
    listed(plan.employers, (e) => {
      const live = e.notes.filter((n) => !n.deleted_at).length;
      return `${e.name} [${e.internal_domains.join(', ')}] · ${live} notes · ${e.related_companies} related companies · ${e.linked_companies} pipeline companies unlinked`;
    });

    if (plan.keptEmployers.length > 0) {
      console.log(`\nkeeping ${plan.keptEmployers.length} firms, ${verb} only their internal domains`);
      listed(
        plan.keptEmployers,
        (e) =>
          `${e.name} [${e.internal_domains.join(', ')}] · ${e.other_domains} other domains · ${e.kept_correspondents} contacts kept`,
      );
    }
    if (plan.manualCorrespondents.length > 0) {
      console.log(
        `\nkeeping ${plan.manualCorrespondents.length} hand-added contacts at an internal domain — delete in the CRM if unwanted`,
      );
      listed(plan.manualCorrespondents, (c) => `${c.name} <${c.email}>`);
    }
    if (plan.smartFiles > 0) {
      console.log(
        `\nleaving ${plan.smartFiles} Smart Files sent from an internal domain — this script does not delete files`,
      );
    }
  };

  const writeBackup = (plan: RefilterPlan): void => {
    const lines = [
      ...plan.emails.map((e) => ({ kind: 'email', ...e })),
      ...plan.correspondents.map((c) => ({ kind: 'correspondent', ...c })),
      ...plan.employers.map((e) => ({ kind: 'employer', ...e })),
      ...plan.keptEmployers.map((e) => ({
        kind: 'employer_domains',
        employer_id: e.id,
        name: e.name,
        domains: e.internal_domains,
      })),
    ];
    if (lines.length === 0) return;
    // Owner-only: the lines hold private note text.
    appendFileSync(backup, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  };

  const { pgClient, db } = await createLambdaDb();
  try {
    const result = await refilterInternalMail(db as never, {
      apply,
      domains,
      onPlan: (plan) => {
        report(plan);
        if (apply) writeBackup(plan);
      },
    });
    if (result.deleted) {
      console.log(`\ndone — deleted ${JSON.stringify(result.deleted)}`);
      console.log(`marts refreshed: ${result.martsRefreshed.join(', ') || 'none'}`);
    } else {
      console.log('\ndry run — nothing changed; re-run with --apply');
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
