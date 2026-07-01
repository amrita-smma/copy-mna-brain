/**
 * Company Matching — fills `employers.industry` (the Industry Focus column in
 * the CRM table) by asking an LLM to look at each banker's email context and
 * cross-reference it against the live `companies` (deals) table.
 *
 * For each employer the script:
 *   1. Pulls the N most recent emails (subject + truncated body) belonging to
 *      that employer's correspondents.
 *   2. Fetches a candidate list of deals from `companies` (id, target,
 *      project_name, segment, geography).
 *   3. Calls Claude with a single tool (`record_industry_focus`) whose output
 *      schema forces a structured decision: matched_company_ids[] + industry
 *      string + confidence.
 *   4. Writes the `industry` string back onto `employers.industry`. The
 *      matched-company list is reported on stdout for the run but NOT
 *      persisted (no schema change — keep the output simple per the scope
 *      decision in MB-XX).
 *
 * Usage:
 *   pnpm match-companies                              # backfill empties
 *   pnpm match-companies --all                        # re-run every employer
 *   pnpm match-companies --employer "Goldman Sachs"   # single firm
 *   pnpm match-companies --dry-run                    # don't write, just log
 *   pnpm match-companies --limit 5 --max-emails 20
 *
 * Env: ANTHROPIC_API_KEY plus the usual DB_* vars (same as `pnpm db:seed`).
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import Anthropic from '@anthropic-ai/sdk';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';

import {
  companies,
  correspondents,
  emailParticipants,
  emails,
  employers,
} from '../src/lib/db/schema';
import { modelSupportsTemperature } from '../src/lib/ai/modelParams';

// ─── CLI args ───────────────────────────────────────────────────────────────

interface CliArgs {
  all: boolean;
  dryRun: boolean;
  employer: string | null;
  limit: number;
  maxEmails: number;
  maxCompanies: number;
  model: string;
  bodyChars: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    all: false,
    dryRun: false,
    employer: null,
    limit: 0,
    maxEmails: 30,
    maxCompanies: 200,
    model: 'claude-haiku-4-5',
    bodyChars: 600,
  };
  const take = (i: number, flag: string): [string, number] => {
    const a = argv[i];
    const eq = a.indexOf('=');
    if (eq !== -1) return [a.slice(eq + 1), i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (key) {
      case '--all': args.all = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--employer': { const [v, ni] = take(i, '--employer'); args.employer = v; i = ni; break; }
      case '--limit': { const [v, ni] = take(i, '--limit'); args.limit = parseInt(v, 10); i = ni; break; }
      case '--max-emails': { const [v, ni] = take(i, '--max-emails'); args.maxEmails = parseInt(v, 10); i = ni; break; }
      case '--max-companies': { const [v, ni] = take(i, '--max-companies'); args.maxCompanies = parseInt(v, 10); i = ni; break; }
      case '--model': { const [v, ni] = take(i, '--model'); args.model = v; i = ni; break; }
      case '--body-chars': { const [v, ni] = take(i, '--body-chars'); args.bodyChars = parseInt(v, 10); i = ni; break; }
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm match-companies [flags]

Flags:
  --all                 Re-match every employer, not just those with no industry
  --dry-run             Print decisions without writing to the database
  --employer NAME       Match a single employer by exact name
  --limit N             Process at most N employers (0 = no limit)
  --max-emails N        Most-recent emails per employer fed to the model (default 30)
  --max-companies N     Candidate companies per call (default 200)
  --body-chars N        Truncate each email body to N chars (default 600)
  --model NAME          Anthropic model (default claude-haiku-4-5)
`);
}

// ─── Tool schema (Anthropic tool_use forces structured JSON) ────────────────

const RECORD_TOOL_NAME = 'record_industry_focus';

const RECORD_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    industry: {
      type: 'string',
      description:
        'A single short industry-focus label for this banker, derived from the deals they correspond about. Use Title Case, ≤ 4 words (e.g. "Management Consulting", "Specialty Chemicals", "Energy"). If the email context is too thin to decide, return an empty string.',
    },
    matched_company_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'IDs (UUIDs) from the candidate list that this banker is most likely involved with based on the emails. Empty array if nothing aligns.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        'high = clear sectoral overlap with at least one matched deal. medium = plausible alignment from email language but no direct company hit. low = no strong signal; consider returning industry="" so the column stays empty.',
    },
    reasoning: {
      type: 'string',
      description: 'One short sentence explaining the decision (logged, not persisted).',
    },
  },
  required: ['industry', 'matched_company_ids', 'confidence', 'reasoning'],
} as const;

interface RecordDecision {
  industry: string;
  matched_company_ids: string[];
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

const SYSTEM_PROMPT = `You match M&A bankers ("employers") to the sectors they actually work in, by reading their recent email correspondence and cross-referencing the firms they discuss against the user's live deal pipeline.

You will be given:
  - The banker's firm name.
  - A list of recent emails (subject + truncated body) where someone from that firm was a participant.
  - A candidate list of deals (id, target name, project name if any, segment, geography) from our pipeline.

Your job: decide a single short industry-focus label for the banker, plus pick which candidate deals their emails are most consistent with. Be conservative — if signals are thin, return an empty industry string with confidence "low". Do not invent companies that are not in the candidate list.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface EmployerRow {
  id: string;
  name: string;
  industry: string | null;
}

interface CandidateCompany {
  id: string;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
}

interface EmployerEmail {
  sent_at: string;
  subject: string | null;
  body_text: string | null;
}

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= n ? collapsed : collapsed.slice(0, n) + '…';
}

function formatEmails(rows: EmployerEmail[], bodyChars: number): string {
  if (rows.length === 0) return '(no emails on file)';
  return rows
    .map((e, i) => {
      const subject = (e.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)';
      const body = truncate(e.body_text, bodyChars) || '(empty body)';
      return `Email ${i + 1} [${e.sent_at}]\nSubject: ${subject}\nBody: ${body}`;
    })
    .join('\n\n');
}

function formatCompanies(rows: CandidateCompany[]): string {
  if (rows.length === 0) return '(no deals in pipeline)';
  return rows
    .map((c) => {
      const target = c.target ?? c.project_name ?? '(unnamed)';
      const segment = c.segment ?? '—';
      const geography = c.geography ?? '—';
      const project = c.project_name && c.project_name !== c.target ? ` aka "${c.project_name}"` : '';
      return `- ${c.id} | ${target}${project} | segment: ${segment} | geo: ${geography}`;
    })
    .join('\n');
}

// ─── Anthropic call ────────────────────────────────────────────────────────

async function decideIndustry(
  client: Anthropic,
  model: string,
  employerName: string,
  emails: EmployerEmail[],
  candidates: CandidateCompany[],
  bodyChars: number,
): Promise<RecordDecision> {
  const userPrompt = `Banker firm: ${employerName}

Recent emails (most recent first):
${formatEmails(emails, bodyChars)}

Candidate deals (pick from these IDs — do not invent new ones):
${formatCompanies(candidates)}

Call ${RECORD_TOOL_NAME} with your decision.`;

  const msg = await client.messages.create({
    model,
    max_tokens: 600,
    ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: RECORD_TOOL_NAME,
        description: 'Record the industry focus + matched deals for this banker.',
        input_schema: RECORD_TOOL_SCHEMA as unknown as { type: 'object'; [k: string]: unknown },
      },
    ],
    tool_choice: { type: 'tool', name: RECORD_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = msg.content.find(
    (b): b is Extract<typeof msg.content[number], { type: 'tool_use' }> => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error('Model returned no tool_use block');
  return toolUse.input as RecordDecision;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('error: ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Dynamic import so dotenv config has already run before db.ts reads env.
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({ prepare: false });
  const db = drizzle(client);
  const anthropic = new Anthropic();

  try {
    // 1. Pick employers in scope. By default only fill empties; --all overrides.
    const employerWhere = args.employer
      ? eq(employers.name, args.employer)
      : args.all
        ? undefined
        : or(isNull(employers.industry), eq(employers.industry, ''));

    const employerRows: EmployerRow[] = await db
      .select({ id: employers.id, name: employers.name, industry: employers.industry })
      .from(employers)
      .where(employerWhere)
      .orderBy(asc(employers.name));

    const inScope = args.limit > 0 ? employerRows.slice(0, args.limit) : employerRows;
    console.log(`Found ${employerRows.length} employer(s) in scope; processing ${inScope.length}.`);
    if (inScope.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // 2. Candidate companies: pull a single shared list per run to keep token use
    // bounded. Newest first, capped at --max-companies. Future: per-employer
    // pre-filter (e.g. ILIKE against email body keywords) if the cap is hit.
    const candidateRows = await db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
        segment: companies.segment,
        geography: companies.geography,
      })
      .from(companies)
      .where(and(sql`${companies.target} IS NOT NULL OR ${companies.project_name} IS NOT NULL`))
      .orderBy(desc(companies.updated_at))
      .limit(args.maxCompanies);

    console.log(`Candidate deal pool: ${candidateRows.length} companies\n`);

    // 3. Walk each employer.
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const emp of inScope) {
      processed++;
      const tag = `[${processed}/${inScope.length}]`;
      try {
        // Most-recent emails this employer's correspondents participated in.
        const emailRows = await db
          .selectDistinct({
            id: emails.id,
            sent_at: emails.sent_at,
            subject: emails.subject,
            body_text: emails.body_text,
          })
          .from(emails)
          .innerJoin(emailParticipants, eq(emailParticipants.email_id, emails.id))
          .innerJoin(correspondents, eq(correspondents.id, emailParticipants.correspondent_id))
          .where(eq(correspondents.employer_id, emp.id))
          .orderBy(desc(emails.sent_at))
          .limit(args.maxEmails);

        if (emailRows.length === 0) {
          console.log(`${tag} ${emp.name}: no emails — skipped`);
          skipped++;
          continue;
        }

        const decision = await decideIndustry(
          anthropic,
          args.model,
          emp.name,
          emailRows.map((e) => ({
            sent_at: e.sent_at,
            subject: e.subject,
            body_text: e.body_text,
          })),
          candidateRows,
          args.bodyChars,
        );

        const industry = decision.industry.trim();
        const matchedNames = decision.matched_company_ids
          .map((id) => {
            const c = candidateRows.find((row) => row.id === id);
            return c ? c.target ?? c.project_name ?? '(unnamed)' : `?(${id.slice(0, 8)})`;
          })
          .filter(Boolean);

        const summary = `industry='${industry || '—'}' [${decision.confidence}] matched: ${matchedNames.length} (${matchedNames.slice(0, 3).join(', ')}${matchedNames.length > 3 ? ', …' : ''})`;
        console.log(`${tag} ${emp.name}: ${summary}`);
        console.log(`        reasoning: ${decision.reasoning}`);

        if (args.dryRun) continue;

        // Persist only when we have non-empty text. Empty string means the
        // model was unsure — leave the column as-is rather than wiping
        // a previously-correct manual value.
        if (industry.length === 0) {
          skipped++;
          continue;
        }

        // Only overwrite a non-empty industry when --all (explicit re-run);
        // backfill mode (--all=false) is naturally limited to NULL/'' rows
        // by the WHERE above, so this guard is for the --employer override.
        if (!args.all && emp.industry && emp.industry.trim().length > 0) {
          console.log(`        (already set to "${emp.industry}", skipping)`);
          skipped++;
          continue;
        }

        await db
          .update(employers)
          .set({ industry, updated_at: new Date().toISOString() })
          .where(eq(employers.id, emp.id));
        updated++;
      } catch (err) {
        errors++;
        console.error(`${tag} ${emp.name}: ERROR ${(err as Error).message}`);
      }
    }

    console.log(`\nDone. processed=${processed} updated=${updated} skipped=${skipped} errors=${errors}${args.dryRun ? ' (dry-run)' : ''}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
