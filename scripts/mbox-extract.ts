/**
 * CLI driver for src/lib/services/mboxParser/extract.ts. Mirrors the original
 * mna-mbox-parser/extract.py so you can swap one for the other.
 *
 * Usage:
 *   pnpm tsx scripts/mbox-extract.ts [input] [options]
 *
 * Positional:
 *   input             Cleaned JSONL from `mbox:parse`. Defaults to emails.jsonl.
 *
 * Options:
 *   --contacts PATH         Output deduped contacts CSV (default: contacts.csv)
 *   --tagged PATH           Output per-email enrichment JSONL (default: emails_tagged.jsonl)
 *   --llm-queue PATH        Output LLM-ready queue JSONL (default: llm_queue.jsonl)
 *   --region CODE           Default region for phone parsing (default: ID)
 *   --body-chars N          Body truncation for LLM payload (default: 6000)
 *   -h, --help              Show this help
 *
 * Examples:
 *   pnpm mbox:extract out.jsonl
 *   pnpm mbox:extract out.jsonl --region US --body-chars 4000
 */
import { createReadStream, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  processEmail,
  updateContact,
  type ContactRow,
  type CountryCode,
  type EnrichedEmail,
  type ParsedEmail,
} from '../src/lib/services/mboxParser';

interface CliArgs {
  input: string;
  contacts: string;
  tagged: string;
  llmQueue: string;
  region: CountryCode;
  bodyChars: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: 'emails.jsonl',
    contacts: 'contacts.csv',
    tagged: 'emails_tagged.jsonl',
    llmQueue: 'llm_queue.jsonl',
    region: 'ID',
    bodyChars: 6000,
    help: false,
  };

  const takeValue = (flag: string, i: number): [string, number] => {
    const eq = argv[i].indexOf('=');
    if (eq !== -1) return [argv[i].slice(eq + 1), i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return [v, i + 1];
  };

  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (key) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--contacts': {
        const [v, ni] = takeValue('--contacts', i);
        args.contacts = v;
        i = ni;
        break;
      }
      case '--tagged': {
        const [v, ni] = takeValue('--tagged', i);
        args.tagged = v;
        i = ni;
        break;
      }
      case '--llm-queue': {
        const [v, ni] = takeValue('--llm-queue', i);
        args.llmQueue = v;
        i = ni;
        break;
      }
      case '--region': {
        const [v, ni] = takeValue('--region', i);
        args.region = v.toUpperCase() as CountryCode;
        i = ni;
        break;
      }
      case '--body-chars': {
        const [v, ni] = takeValue('--body-chars', i);
        args.bodyChars = parseInt(v, 10);
        i = ni;
        break;
      }
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
        if (positional === 0) {
          args.input = a;
          positional++;
        } else {
          throw new Error(`Unexpected positional argument: ${a}`);
        }
    }
  }

  return args;
}

const CSV_FIELDS = ['email', 'name', 'count', 'last_seen'] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowToCsv(row: ContactRow): string {
  return CSV_FIELDS.map((f) => csvEscape(String(row[f]))).join(',');
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

  const contacts = new Map<string, ContactRow>();
  let total = 0;
  let needLlm = 0;

  const taggedFd = openSync(args.tagged, 'w');
  const queueFd = openSync(args.llmQueue, 'w');

  try {
    const stream = createReadStream(args.input, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line) continue;
      const rec = JSON.parse(line) as ParsedEmail;
      const enriched: EnrichedEmail = processEmail(rec, {
        defaultRegion: args.region,
        bodyChars: args.bodyChars,
      });
      total++;

      updateContact(contacts, enriched.sender.email, enriched.sender.name, rec.date ?? '');
      for (const r of [...enriched.recipients, ...enriched.cc]) {
        updateContact(contacts, r.email, r.name, rec.date ?? '');
      }

      writeSync(taggedFd, JSON.stringify(enriched) + '\n');

      if (enriched.needs_llm) {
        needLlm++;
        writeSync(
          queueFd,
          JSON.stringify({
            message_id: enriched.message_id,
            subject: enriched.subject,
            sender_email: enriched.sender.email,
            domain_tag: enriched.domain_tag,
            payload: enriched.llm_payload,
          }) + '\n',
        );
      }
    }
  } finally {
    closeSync(taggedFd);
    closeSync(queueFd);
  }

  // Sort contacts by frequency desc, then by email asc.
  const sortedContacts = Array.from(contacts.values()).sort(
    (a, b) => b.count - a.count || a.email.localeCompare(b.email),
  );
  const contactsFd = openSync(args.contacts, 'w');
  try {
    writeSync(contactsFd, CSV_FIELDS.join(',') + '\n');
    for (const row of sortedContacts) writeSync(contactsFd, rowToCsv(row) + '\n');
  } finally {
    closeSync(contactsFd);
  }

  console.log(`Processed ${total} emails.`);
  console.log(
    `  Unique contacts (from headers, deterministic): ${contacts.size} → ${args.contacts}`,
  );
  console.log(`  Need LLM enrichment:                            ${needLlm} → ${args.llmQueue}`);
  console.log(`  Per-email tags:                                 ${total} → ${args.tagged}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
