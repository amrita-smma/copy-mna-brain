/**
 * Classify the industry of each employer domain by asking Haiku directly —
 * no scraping, just "given this domain, what industry?". Cheap and fast: one
 * batched API call (chunked if many domains).
 *
 * Inputs:
 *   --emails PATH      Cleaned mbox JSONL (default: out.jsonl) — used to count
 *                      email volume per sender domain so we hit the highest-
 *                      signal ones first.
 *   --domains PATH     Domain map with curation + exclusions (default: scripts/domains.json)
 *   --output PATH      Output JSON (default: domains_enriched.json)
 *   --model NAME       Anthropic model (default: claude-haiku-4-5-20251001)
 *   --limit N          Cap on number of domains to classify (default: 0 = all)
 *   --chunk N          Domains per API call (default: 30 — keeps output token
 *                      usage well under Haiku's max_tokens budget)
 *
 * Skips:
 *   - Domains listed in domains.json `_excluded`
 *   - Domains marked `internal: true` (custodians — no industry needed)
 *   - Personal-mail domains (gmail.com, outlook.com, yahoo.com, hotmail.com)
 *
 * Re-runnable: merges into the existing output, only re-classifies missing
 * domains. Use --force to re-classify everything.
 *
 * Usage:
 *   pnpm mbox:domain-enrich
 *   pnpm mbox:domain-enrich --limit 100
 *   pnpm mbox:domain-enrich --force
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import Anthropic from '@anthropic-ai/sdk';

import type { ParsedEmail } from '../src/lib/services/mboxParser';

// ─── arg parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  emails: string;
  domains: string;
  output: string;
  model: string;
  limit: number;
  chunk: number;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    emails: 'out.jsonl',
    domains: 'scripts/domains.json',
    output: 'domains_enriched.json',
    model: 'claude-haiku-4-5-20251001',
    limit: 0,
    chunk: 30,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    const val = (flag: string) => {
      const eq = argv[i].indexOf('=');
      if (eq !== -1) return argv[i].slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      i++;
      return v;
    };
    switch (key) {
      case '--emails': args.emails = val('--emails'); break;
      case '--domains': args.domains = val('--domains'); break;
      case '--output': args.output = val('--output'); break;
      case '--model': args.model = val('--model'); break;
      case '--limit': args.limit = parseInt(val('--limit'), 10); break;
      case '--chunk': args.chunk = parseInt(val('--chunk'), 10); break;
      case '--force': args.force = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default: if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

// ─── domain collection ──────────────────────────────────────────────────────

const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.id', 'yahoo.co.jp', 'yahoo.co.uk',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com',
  'aol.com',
]);

function domainOf(email: string): string {
  const i = email.indexOf('@');
  return i === -1 ? '' : email.slice(i + 1).toLowerCase();
}

async function collectDomainVolumes(emailsPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const rl = createInterface({
    input: createReadStream(emailsPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const e = JSON.parse(line) as ParsedEmail;
    const d = domainOf(e.sender?.email ?? '');
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return counts;
}

interface DomainEntry { name?: string; internal?: boolean }

function loadDomainConfig(path: string): { internal: Set<string>; excluded: Set<string> } {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const internal = new Set<string>();
  const excluded = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_excluded' && Array.isArray(v)) {
      for (const d of v) excluded.add(String(d).toLowerCase());
      continue;
    }
    if (k.startsWith('_')) continue;
    if (typeof v === 'object' && v !== null) {
      const e = v as DomainEntry;
      if (e.internal) internal.add(k.toLowerCase());
    }
  }
  return { internal, excluded };
}

// ─── LLM call ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You classify the industry of companies given only their email domain.

Rules:
- Return JSON: a map keyed by each input domain. Each value: {industry, confidence}.
- industry: 1-3 words, e.g. "Investment Banking", "Private Equity", "Semiconductors", "Asset Management", "Legal Services", "Management Consulting", "Insurance", "Real Estate", "Oil & Gas", "Mining", "Automotive", "Telecommunications".
- confidence: "high" if the domain is a well-known company you can identify; "medium" if you can make a reasonable guess from the domain or its TLD; "low" if you're unsure.
- Use null for industry when you genuinely cannot tell (treat unknown regional / obscure domains as null with "low" confidence).
- Never invent. Better to return null than guess wildly.`;

const DOMAIN_CLASSIFY_SCHEMA = {
  type: 'object',
  description: 'Map of domain → { industry, confidence }.',
  additionalProperties: {
    type: 'object',
    properties: {
      industry: { type: ['string', 'null'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['industry', 'confidence'],
  },
} as const;

interface ClassifyResult {
  industry: string | null;
  confidence: 'high' | 'medium' | 'low';
}

async function classifyChunk(
  client: Anthropic,
  model: string,
  domains: string[],
): Promise<Record<string, ClassifyResult>> {
  const userPrompt = `Domains to classify:\n${domains.map((d) => `- ${d}`).join('\n')}`;
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'classify_domains',
        description: 'Return industry classifications for the given domains.',
        // The SDK's InputSchema requires `type: 'object'` at the root. The
        // generic `Record<string, unknown>` cast erases that literal, so be
        // explicit here.
        input_schema: DOMAIN_CLASSIFY_SCHEMA as unknown as { type: 'object'; [k: string]: unknown },
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_domains' },
    messages: [{ role: 'user', content: userPrompt }],
  });
  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('No tool_use in response');
  }
  return toolUse.input as Record<string, ClassifyResult>;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf-8')
      .split('\n').filter(l => l.startsWith(' *') || l.startsWith('/**'))
      .map(l => l.replace(/^ \*\/?|^\/\*\*/g, '').replace(/^ ?/, '')).join('\n').trim());
    process.exit(0);
  }

  console.log('Collecting domains…');
  const volumes = await collectDomainVolumes(args.emails);
  const { internal, excluded } = loadDomainConfig(args.domains);
  console.log(`  unique domains in corpus: ${volumes.size}`);
  console.log(`  internal:                 ${internal.size} (skipped)`);
  console.log(`  excluded:                 ${excluded.size} (skipped)`);
  console.log(`  personal mail:            ${PERSONAL_MAIL_DOMAINS.size} known patterns (skipped)`);

  // Load existing output so we can skip already-classified domains.
  const existing: Record<string, ClassifyResult> = args.force
    ? {}
    : existsSync(args.output)
      ? JSON.parse(readFileSync(args.output, 'utf-8'))
      : {};

  // Eligible domains: in corpus, not internal, not excluded, not personal mail.
  // Sort by volume desc so we hit high-signal domains first.
  const eligible = [...volumes.entries()]
    .filter(([d]) => !internal.has(d) && !excluded.has(d) && !PERSONAL_MAIL_DOMAINS.has(d))
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);

  const toClassify = eligible.filter((d) => !(d in existing));
  const capped = args.limit > 0 ? toClassify.slice(0, args.limit) : toClassify;
  console.log(`  eligible:                 ${eligible.length}`);
  console.log(`  already classified:       ${eligible.length - toClassify.length}`);
  console.log(`  to classify this run:     ${capped.length}`);

  if (capped.length === 0) {
    console.log('\nNothing to do.');
    if (!existsSync(args.output)) writeFileSync(args.output, JSON.stringify(existing, null, 2));
    return;
  }

  const client = new Anthropic();
  const out: Record<string, ClassifyResult> = { ...existing };
  const start = Date.now();

  for (let i = 0; i < capped.length; i += args.chunk) {
    const chunk = capped.slice(i, i + args.chunk);
    process.stdout.write(`  classifying [${i + 1}-${i + chunk.length}/${capped.length}]… `);
    try {
      const result = await classifyChunk(client, args.model, chunk);
      // Only accept keys we actually asked about — guards against the model
      // inventing extra domains.
      for (const d of chunk) {
        const r = result[d];
        if (r && typeof r === 'object') {
          out[d] = {
            industry: r.industry ?? null,
            confidence: ['high', 'medium', 'low'].includes(r.confidence)
              ? r.confidence
              : 'low',
          };
        } else {
          out[d] = { industry: null, confidence: 'low' };
        }
      }
      console.log('ok');
    } catch (err) {
      console.log(`error: ${(err as Error).message}`);
      // On chunk error, mark these as low/null so we can retry later.
      for (const d of chunk) {
        if (!(d in out)) out[d] = { industry: null, confidence: 'low' };
      }
    }
    // Persist after each chunk so a mid-run crash doesn't lose progress.
    writeFileSync(args.output, JSON.stringify(out, null, 2));
  }

  const elapsedSec = (Date.now() - start) / 1000;
  const total = Object.keys(out).length;
  const high = Object.values(out).filter((v) => v.confidence === 'high').length;
  const medium = Object.values(out).filter((v) => v.confidence === 'medium').length;
  const low = Object.values(out).filter((v) => v.confidence === 'low').length;
  const known = Object.values(out).filter((v) => v.industry !== null).length;
  console.log(
    `\nDone in ${elapsedSec.toFixed(1)}s. ${total} domains in ${args.output}.`,
  );
  console.log(`  with industry: ${known}/${total}`);
  console.log(`  confidence:    high=${high}  medium=${medium}  low=${low}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
