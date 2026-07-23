import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';

import { rawEmails as rawEmailsTable } from '@/lib/db/schema';
import { DomainClassificationRepository } from '../repositories';
import {
  EmployerOverrideRepository,
} from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { modelSupportsTemperature } from '../lib/modelParams';

export const VAULT_CRM_DOMAIN_CLASSIFY_TIMEOUT_SECONDS = 600; // 10 minutes
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_LIMIT = 100;
export const DEFAULT_CHUNK_SIZE = 30;
export const MAX_LIMIT = 500;

export interface CrmDomainClassifyPayload {
  limit?: number;
  chunkSize?: number;
  force?: boolean;
  model?: string;
}

export interface CrmDomainClassifyResult {
  domains_input: number;
  domains_classified: number;
  chunks_called: number;
  errors: number;
}

const log = (msg: string) => console.log(`[crm-domain-classify] ${msg}`);

// Personal-mail providers we never bother classifying — these are individuals,
// not employers.
export const PERSONAL_MAIL_DOMAINS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

// Internal company domains we never classify — these are our own people, not
// external employers. (These are always ignored regardless of employer_overrides.)
// Kept as a hardcoded belt-and-suspenders alongside employer_overrides: a brand
// new internal domain must be caught here at ingest time, before anyone has a
// chance to curate it in employer_overrides — the DB table today has no product
// UI, so populating it requires the same code-change-and-deploy cycle as this
// list, with none of this list's advantage of blocking on day one.
export const INTERNAL_MAIL_DOMAINS = new Set<string>([
  'starcapital.co.id',
  'starcapitalholdings.com',
  'smma.id',
  'sinarmasmining.com',
  'techconnect.co.id',
  'starhousecapital.sg',
  'frontiergroup.sg',
  'hosanco.com',
  'ebergroup.com',
  'partners97.com',
  'kbru.co.id',
  'outlook.com',
  'starinvestama.co.id',
  'sunterra.id',
  'theolivelink.com',
  'sinarmas.co.id',
  'sinarmas.org',
  'startechgv.com',
  // Previously only marked internal via employer_overrides (pre-single-source-
  // of-truth); folded in here so removing that column's read path doesn't
  // regress them back into being tracked as external companies.
  'aldiracita.com',
  'adivira.com',
  'lifewithsun.com',
]);

const SYSTEM_PROMPT = `You identify companies from their email domain — both the proper name and the industry.

Rules:
- Return JSON: a map keyed by each input domain. Each value: {name, industry, confidence}.
- name: the company's proper canonical name with correct casing and spacing.
  GOOD: "Goldman Sachs", "JPMorgan Chase", "Morgan Stanley", "Latham & Watkins",
        "EY-Parthenon", "Boston Consulting Group", "Hana Financial Group"
  BAD:  "Goldmansachs" (no spaces), "jpmorgan" (lowercase), "Lw" (acronym from domain).
  Use null when you can't identify the company.
- industry: 1-3 words, e.g. "Investment Banking", "Private Equity", "Semiconductors",
  "Asset Management", "Legal Services", "Management Consulting", "Insurance",
  "Real Estate", "Oil & Gas", "Mining", "Automotive", "Telecommunications".
  Use null when you can't tell.
- confidence: applies to BOTH name and industry together.
  "high"   = well-known company you can identify with certainty (Samsung, Goldman, LW)
  "medium" = reasonable guess from domain shape or TLD context
  "low"    = unsure; usually both fields should be null
- NEVER invent. Better to return null than guess wildly. Confidence drives whether
  the downstream ingest trusts the name — "low" never overrides existing data.`;

const DOMAIN_CLASSIFY_SCHEMA = {
  type: 'object',
  description: 'Map of domain → { name, industry, confidence }.',
  additionalProperties: {
    type: 'object',
    properties: {
      name: { type: ['string', 'null'] },
      industry: { type: ['string', 'null'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['name', 'industry', 'confidence'],
  },
} as const;

interface ClassifyResult {
  name: string | null;
  industry: string | null;
  confidence: 'high' | 'medium' | 'low';
}

// MB-205: excluded domains come from the curatable `employer_overrides` table,
// not scripts/domains.json. Internal domains are INTERNAL_MAIL_DOMAINS above —
// employer_overrides.internal is no longer read (see that set's comment).
async function loadExcludedDomains(
  overrideRepo: EmployerOverrideRepository,
): Promise<Set<string>> {
  const excluded = await overrideRepo.listExcludedDomains();
  return new Set(excluded.map((d) => d.toLowerCase()));
}

/**
 * Returns the set of sender domains seen in raw_emails (lowercased), sorted by
 * volume descending — highest-signal domains first.
 */
async function collectDomainVolumes(db: DbClient): Promise<string[]> {
  const rows = await db.execute<{ domain: string; n: number }>(sql`
    SELECT lower(split_part(${rawEmailsTable.from_address}, '@', 2)) AS domain,
           COUNT(*)::int AS n
    FROM ${rawEmailsTable}
    WHERE ${rawEmailsTable.from_address} IS NOT NULL
    GROUP BY 1
    ORDER BY n DESC
  `);
  const list = (rows as unknown as Array<{ domain: string; n: number }>) ?? [];
  return list.map((r) => r.domain).filter((d) => d && d.length > 0);
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
    ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'classify_domains',
        description: 'Return industry classifications for the given domains.',
        input_schema: DOMAIN_CLASSIFY_SCHEMA as unknown as {
          type: 'object';
          [k: string]: unknown;
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_domains' },
    messages: [{ role: 'user', content: userPrompt }],
  });
  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('no tool_use block in response');
  }
  return toolUse.input as Record<string, ClassifyResult>;
}

export async function runCrmDomainClassify(
  payload: CrmDomainClassifyPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<CrmDomainClassifyResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const limit = Math.max(1, Math.min(MAX_LIMIT, payload.limit ?? DEFAULT_LIMIT));
  const chunkSize = Math.max(1, Math.min(50, payload.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const model = payload.model ?? DEFAULT_MODEL;
  const force = payload.force === true;

  const client = new Anthropic({ apiKey });
  const repo = new DomainClassificationRepository(deps.db);
  const overrideRepo = new EmployerOverrideRepository(deps.db);
  const excluded = await loadExcludedDomains(overrideRepo);

  // 1. Find candidate domains.
  let candidates = await collectDomainVolumes(deps.db);
  candidates = candidates.filter(
    (d) =>
      !PERSONAL_MAIL_DOMAINS.has(d) &&
      !INTERNAL_MAIL_DOMAINS.has(d) &&
      !excluded.has(d),
  );

  // 2. Subtract already-classified unless force=true.
  if (!force) {
    candidates = await repo.listUnknownDomains(candidates);
  }

  if (candidates.length > limit) candidates = candidates.slice(0, limit);

  log(
    `starting job=${deps.job.id} candidates=${candidates.length} chunkSize=${chunkSize} force=${force} model=${model}`,
  );

  const result: CrmDomainClassifyResult = {
    domains_input: candidates.length,
    domains_classified: 0,
    chunks_called: 0,
    errors: 0,
  };

  if (candidates.length === 0) {
    log('nothing to classify');
    return result;
  }

  // 3. Chunk + classify + upsert.
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    try {
      const out = await classifyChunk(client, model, chunk);
      result.chunks_called++;
      const rows = chunk.map((domain) => {
        const r = out[domain] ?? { name: null, industry: null, confidence: 'low' as const };
        return {
          domain,
          name: r.name ?? null,
          industry: r.industry ?? null,
          confidence: r.confidence ?? 'low',
          source: 'llm',
        };
      });
      const upserted = await repo.upsertBatch(rows);
      result.domains_classified += upserted.length;
    } catch (err) {
      console.error(`[crm-domain-classify] chunk ${i}-${i + chunk.length} failed:`, err);
      result.errors++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
