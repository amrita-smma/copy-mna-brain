/**
 * CLI driver for src/lib/services/mboxParser. Mirrors the original
 * mna-mbox-parser/main.py so you can swap one for the other.
 *
 * Usage:
 *   pnpm tsx scripts/mbox-parse.ts [paths...] [options]
 *
 * Positional:
 *   paths             One or more .mbox files or directories. Defaults to test.mbox.
 *
 * Options:
 *   -o, --output PATH        Output file (.jsonl or .csv). Default: emails.jsonl
 *   --csv PATH               Also write CSV alongside JSONL output
 *   --no-recursive           Don't recurse when scanning directories
 *   --min-chars N            Skip emails with body shorter than this (default 20)
 *   --drop-urls              Strip URLs from body
 *   --limit N                Max emails to process (0 = all)
 *   --no-filter              Disable PRD filtering (keep auto-replies, newsletters, etc.)
 *   --audit-filter           Keep filtered emails but tag them with filter_reason
 *   --our-domains LIST       Team domains, comma-separated (e.g. smma.id,aldiracita.com)
 *   --drop-internal-only     Also filter emails where sender + all recipients are in --our-domains
 *   -h, --help               Show this help
 *
 * Examples:
 *   pnpm tsx scripts/mbox-parse.ts ./mboxes -o out.jsonl
 *   pnpm tsx scripts/mbox-parse.ts a.mbox b.mbox -o out.csv --drop-urls
 *   pnpm tsx scripts/mbox-parse.ts ./mboxes --audit-filter --our-domains smma.id
 */
import { readFileSync, createReadStream, statSync, readdirSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import {
  streamParseAndFilter,
  type AuditedEmail,
  type ParseAndFilterOptions,
} from '../src/lib/services/mboxParser';

interface CliArgs {
  paths: string[];
  output: string;
  csvPath: string | null;
  noRecursive: boolean;
  minChars: number;
  dropUrls: boolean;
  limit: number;
  noFilter: boolean;
  auditFilter: boolean;
  ourDomains: string[];
  dropInternalOnly: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    output: 'emails.jsonl',
    csvPath: null,
    noRecursive: false,
    minChars: 20,
    dropUrls: false,
    limit: 0,
    noFilter: false,
    auditFilter: false,
    ourDomains: [],
    dropInternalOnly: false,
    help: false,
  };

  const takeValue = (flag: string, i: number): [string, number] => {
    const eq = argv[i].indexOf('=');
    if (eq !== -1) return [argv[i].slice(eq + 1), i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return [v, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (key) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-o':
      case '--output': {
        const [v, ni] = takeValue('-o/--output', i);
        args.output = v;
        i = ni;
        break;
      }
      case '--csv': {
        const [v, ni] = takeValue('--csv', i);
        args.csvPath = v;
        i = ni;
        break;
      }
      case '--no-recursive':
        args.noRecursive = true;
        break;
      case '--min-chars': {
        const [v, ni] = takeValue('--min-chars', i);
        args.minChars = parseInt(v, 10);
        i = ni;
        break;
      }
      case '--drop-urls':
        args.dropUrls = true;
        break;
      case '--limit': {
        const [v, ni] = takeValue('--limit', i);
        args.limit = parseInt(v, 10);
        i = ni;
        break;
      }
      case '--no-filter':
        args.noFilter = true;
        break;
      case '--audit-filter':
        args.auditFilter = true;
        break;
      case '--our-domains': {
        const [v, ni] = takeValue('--our-domains', i);
        args.ourDomains = v
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean);
        i = ni;
        break;
      }
      case '--drop-internal-only':
        args.dropInternalOnly = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
        args.paths.push(a);
    }
  }

  if (args.paths.length === 0) args.paths = ['test.mbox'];
  return args;
}

function resolveMboxFiles(paths: string[], recursive: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) {
      console.warn(`[warn] not found: ${p}`);
      continue;
    }
    const stat = statSync(p);
    if (stat.isDirectory()) {
      const entries = readdirSync(p, { recursive, withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (extname(e.name).toLowerCase() !== '.mbox') continue;
        const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath
          ?? (e as unknown as { path?: string }).path
          ?? p;
        out.push(join(parent, e.name));
      }
    } else if (stat.isFile()) {
      out.push(p);
    }
  }
  const ordered: string[] = [];
  for (const f of out) {
    const abs = resolve(f);
    if (!seen.has(abs)) {
      seen.add(abs);
      ordered.push(f);
    }
  }
  return ordered.sort();
}

const CSV_FIELDS = [
  'message_id',
  'date',
  'sender_email',
  'sender_name',
  'to',
  'cc',
  'subject',
  'body',
  'filter_reason',
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function recordToCsvRow(rec: AuditedEmail): string {
  const fmt = (addrs: { name: string; email: string }[]) =>
    addrs.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join('; ');
  const row: Record<(typeof CSV_FIELDS)[number], string> = {
    message_id: rec.message_id ?? '',
    date: rec.date ?? '',
    sender_email: rec.sender?.email ?? '',
    sender_name: rec.sender?.name ?? '',
    to: fmt(rec.recipients),
    cc: fmt(rec.cc),
    subject: rec.subject ?? '',
    body: rec.body,
    filter_reason: rec.filter_reason ?? '',
  };
  return CSV_FIELDS.map((f) => csvEscape(row[f])).join(',');
}

function printHelp(): void {
  const help = readFileSync(new URL(import.meta.url), 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith(' *') || l.startsWith('/**'))
    .map((l) => l.replace(/^ \*\/?|^\/\*\*/g, '').replace(/^ ?/, ''))
    .join('\n')
    .trim();
  console.log(help);
}

async function main() {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const outputIsCsv = args.output.toLowerCase().endsWith('.csv');
  const jsonlPath = outputIsCsv ? null : args.output;
  const csvPath = args.csvPath ?? (outputIsCsv ? args.output : null);

  const mboxFiles = resolveMboxFiles(args.paths, !args.noRecursive);
  if (mboxFiles.length === 0) {
    console.error('No .mbox files found.');
    process.exit(1);
  }
  console.log(`Found ${mboxFiles.length} mbox file(s):`);
  for (const f of mboxFiles) console.log(`  ${f}`);

  const opts: ParseAndFilterOptions = {
    minChars: args.minChars,
    dropUrls: args.dropUrls,
    noFilter: args.noFilter,
    auditFilter: args.auditFilter,
    ourDomains: args.ourDomains.length > 0 ? new Set(args.ourDomains) : undefined,
    dropInternalOnly: args.dropInternalOnly,
  };

  const jsonlFd = jsonlPath ? openSync(jsonlPath, 'w') : null;
  const csvFd = csvPath ? openSync(csvPath, 'w') : null;
  if (csvFd !== null) writeSync(csvFd, CSV_FIELDS.join(',') + '\n');

  let totalWritten = 0;
  let totalSkipped = 0;
  let totalDupes = 0;
  const filterCounts: Record<string, number> = {};
  const seenMessageIds = new Set<string>();

  try {
    for (let i = 0; i < mboxFiles.length; i++) {
      const path = mboxFiles[i];
      console.log(`\n[${i + 1}/${mboxFiles.length}] ${path} ...`);

      const remaining = args.limit > 0 ? Math.max(0, args.limit - totalWritten) : undefined;
      const fileOpts: ParseAndFilterOptions = remaining !== undefined ? { ...opts, limit: remaining } : opts;

      let fileWritten = 0;
      let fileFiltered = 0;
      const stream = createReadStream(path);
      for await (const rec of streamParseAndFilter(stream, fileOpts, {
        onFilter: (reason) => {
          filterCounts[reason] = (filterCounts[reason] ?? 0) + 1;
          fileFiltered++;
        },
        onSkip: (kind) => {
          if (kind === 'dupe') totalDupes++;
          else totalSkipped++;
        },
      })) {
        // Cross-file dedupe; streamParseAndFilter already dedupes within file.
        if (rec.message_id) {
          if (seenMessageIds.has(rec.message_id)) {
            totalDupes++;
            continue;
          }
          seenMessageIds.add(rec.message_id);
        }
        if (jsonlFd !== null) writeSync(jsonlFd, JSON.stringify(rec) + '\n');
        if (csvFd !== null) writeSync(csvFd, recordToCsvRow(rec) + '\n');
        totalWritten++;
        fileWritten++;
      }

      console.log(`  → wrote ${fileWritten}, filtered ${fileFiltered}`);

      if (args.limit > 0 && totalWritten >= args.limit) break;
    }
  } finally {
    if (jsonlFd !== null) closeSync(jsonlFd);
    if (csvFd !== null) closeSync(csvFd);
  }

  const outputs = [jsonlPath, csvPath].filter(Boolean).join(', ');
  console.log(
    `\nWrote ${totalWritten} emails to ${outputs} (skipped ${totalSkipped}, dupes ${totalDupes}).`,
  );
  const totalFiltered = Object.values(filterCounts).reduce((a, b) => a + b, 0);
  if (totalFiltered > 0) {
    console.log(`Filtered ${totalFiltered} emails by PRD rules:`);
    const sorted = Object.entries(filterCounts).sort((a, b) => b[1] - a[1]);
    for (const [reason, n] of sorted) {
      console.log(`  ${reason.padEnd(20)} ${String(n).padStart(5)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
