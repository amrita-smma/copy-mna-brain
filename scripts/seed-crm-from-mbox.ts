/**
 * Populate the CRM tables (employers, correspondents, emails, email_participants,
 * email_topics, topics) from the mbox-derived JSONL files.
 *
 * Inputs:
 *   --emails PATH      Cleaned per-email records from mbox-parse (default: out.jsonl)
 *   --contacts PATH    Deduped contacts CSV from mbox-extract (default: contacts.csv)
 *   --enriched PATH    LLM-enriched records (default: enriched-haiku.jsonl)
 *   --domains PATH     Sender-domain → employer map (default: scripts/domains.json)
 *   --reset            Wipe employers seeded by this script before inserting (use with care)
 *
 * Re-runnable. Idempotent via:
 *   - topics:           UNIQUE on (slug) → upsert with no-op update
 *   - employers:        UNIQUE on (normalized_name) → upsert with no-op update
 *   - correspondents:   partial UNIQUE on (employer_id, email) → upsert
 *   - emails:           partial UNIQUE on (message_id) → INSERT ... ON CONFLICT DO NOTHING
 *   - email_participants: UNIQUE on (email_id, address, role) → DO NOTHING
 *   - email_topics:     UNIQUE on (email_id, topic_id) → DO NOTHING
 *
 * Requires migration 20260523000000_emails_add_message_id to have been applied
 * (run `pnpm db:migrate` first).
 *
 * Usage:
 *   pnpm mbox:ingest
 *   pnpm mbox:ingest --enriched enriched.jsonl
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

import {
  correspondents,
  emailParticipants,
  emails as emailsTable,
  emailTopics,
  employers,
  topics,
} from '../src/lib/db/schema';
import type {
  EnrichedPerson,
  EnrichedRecord,
  ParsedEmail,
} from '../src/lib/services/mboxParser';

// ─── CLI args ────────────────────────────────────────────────────────────────

interface CliArgs {
  emails: string;
  contacts: string;
  enriched: string;
  domains: string;
  domainsEnriched: string;
  reset: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    emails: 'out.jsonl',
    contacts: 'contacts.csv',
    enriched: 'enriched-haiku.jsonl',
    domains: 'scripts/domains.json',
    domainsEnriched: 'domains_enriched.json',
    reset: false,
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
      case '--contacts': args.contacts = val('--contacts'); break;
      case '--enriched': args.enriched = val('--enriched'); break;
      case '--domains': args.domains = val('--domains'); break;
      case '--domains-enriched': args.domainsEnriched = val('--domains-enriched'); break;
      case '--reset': args.reset = true; break;
      case '-h':
      case '--help':
        console.log(readFileSync(new URL(import.meta.url), 'utf-8')
          .split('\n').filter(l => l.startsWith(' *') || l.startsWith('/**'))
          .map(l => l.replace(/^ \*\/?|^\/\*\*/g, '').replace(/^ ?/, '')).join('\n').trim());
        process.exit(0);
      default:
        if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

// ─── Input readers ───────────────────────────────────────────────────────────

async function readJsonl<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line) out.push(JSON.parse(line) as T);
  }
  return out;
}

interface ContactRow {
  email: string;
  name: string;
  count: number;
  last_seen: string;
}

function readContactsCsv(path: string): ContactRow[] {
  const raw = readFileSync(path, 'utf-8').trim().split('\n');
  const rows: ContactRow[] = [];
  // Skip header.
  for (let i = 1; i < raw.length; i++) {
    const line = raw[i];
    // Naive CSV split — our writer escapes via quotes; for the fields we need
    // (email, count, last_seen), simple comma-split would corrupt names with
    // commas. We only really need the email/count, so handle quoted fields.
    const fields = parseCsvLine(line);
    if (fields.length < 4) continue;
    rows.push({
      email: (fields[0] || '').toLowerCase(),
      name: fields[1] || '',
      count: parseInt(fields[2] || '0', 10),
      last_seen: fields[3] || '',
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

interface DomainEntry { name: string; internal?: boolean; industry?: string | null }
type DomainMap = Record<string, DomainEntry | string | string[] | { _comment?: string }>;

interface DomainConfig {
  map: Map<string, DomainEntry>;
  excluded: Set<string>;
}

function loadDomainMap(path: string): DomainConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as DomainMap;
  const map = new Map<string, DomainEntry>();
  const excluded = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_excluded' && Array.isArray(v)) {
      for (const d of v) excluded.add(String(d).toLowerCase());
      continue;
    }
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') map.set(k.toLowerCase(), { name: v });
    else if (typeof v === 'object' && v !== null && 'name' in v) {
      map.set(k.toLowerCase(), v as DomainEntry);
    }
  }
  return { map, excluded };
}

// Optional LLM-classified industry per domain (from `pnpm mbox:domain-enrich`).
// Curated `domains.json` always wins on conflict.
function loadDomainsEnriched(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<
    string,
    { industry: string | null; confidence?: string }
  >;
  const m = new Map<string, string>();
  for (const [domain, entry] of Object.entries(raw)) {
    if (entry && typeof entry.industry === 'string' && entry.industry.length > 0) {
      m.set(domain.toLowerCase(), entry.industry);
    }
  }
  return m;
}

// ─── Derivation helpers ──────────────────────────────────────────────────────

function domainOf(email: string): string {
  const i = email.indexOf('@');
  return i === -1 ? '' : email.slice(i + 1).toLowerCase();
}

function resolveEmployer(
  domain: string,
  domainMap: Map<string, DomainEntry>,
  enrichedIndustries: Map<string, string>,
) {
  const hit = domainMap.get(domain);
  if (hit) {
    // Curated `industry` wins; otherwise fall back to enriched JSON; otherwise null.
    const industry = hit.industry ?? enrichedIndustries.get(domain) ?? null;
    return { name: hit.name, internal: !!hit.internal, industry };
  }
  // Auto-fallback: titlecase the first label of the domain.
  const first = (domain.split('.')[0] || domain).toLowerCase();
  return {
    name: first.charAt(0).toUpperCase() + first.slice(1),
    internal: false,
    industry: enrichedIndustries.get(domain) ?? null,
  };
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Build a (lowercased-email → best-known EnrichedPerson) index. If multiple
// records mention the same email, prefer the one with the richest fields.
function buildPersonIndex(records: EnrichedRecord[]): Map<string, EnrichedPerson> {
  const idx = new Map<string, EnrichedPerson>();
  const score = (p: EnrichedPerson) =>
    (p.name ? 1 : 0) + (p.role ? 1 : 0) + (p.company ? 1 : 0) + (p.phone ? 1 : 0);
  for (const rec of records) {
    if (!rec || 'error' in rec) continue;
    for (const p of rec.people ?? []) {
      if (!p.email) continue;
      const key = p.email.toLowerCase();
      const existing = idx.get(key);
      if (!existing || score(p) > score(existing)) idx.set(key, p);
    }
  }
  return idx;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Load everything into memory.
  console.log('Loading inputs…');
  const emailsList = await readJsonl<ParsedEmail>(args.emails);
  const contacts = readContactsCsv(args.contacts);
  const enriched = await readJsonl<EnrichedRecord>(args.enriched);
  const domainConfig = loadDomainMap(args.domains);
  const domainMap = domainConfig.map;
  const excludedDomains = domainConfig.excluded;
  const enrichedIndustries = loadDomainsEnriched(args.domainsEnriched);
  console.log(`  emails:       ${emailsList.length}`);
  console.log(`  contacts:     ${contacts.length}`);
  console.log(`  enriched:     ${enriched.length}`);
  console.log(`  domain map:   ${domainMap.size} curated`);
  console.log(`  industries:   ${enrichedIndustries.size} from ${args.domainsEnriched}`);
  console.log(`  excluded:     ${excludedDomains.size} domains`);

  // 2. Derived state.
  const enrichedByMid = new Map(enriched.filter(r => !('error' in r)).map(r => [r.message_id, r]));
  const personByEmail = buildPersonIndex(enriched);

  // The set of message_ids we have enrichment for — only ingest those rows.
  // Without an enrichment record we'd miss topics/people and pollute the
  // CRM with bare emails. For a smoke test with 20 records this keeps the
  // first ingest tight; the full run will use the full enriched.jsonl.
  const enrichedMids = new Set(enriched.map(r => r.message_id));
  const isExcluded = (email: string | undefined | null) =>
    excludedDomains.has(domainOf(email ?? ''));
  const emailsToIngest = emailsList.filter(e =>
    enrichedMids.has(e.message_id) && !isExcluded(e.sender?.email),
  );
  const excludedCount = emailsList.filter(e =>
    enrichedMids.has(e.message_id) && isExcluded(e.sender?.email),
  ).length;
  console.log(`  emails matching enrichment: ${emailsToIngest.length} (excluded ${excludedCount} by domain)`);

  // Unique domains we'll need (from senders + every participant).
  const uniqueDomains = new Set<string>();
  for (const e of emailsToIngest) {
    const sd = domainOf(e.sender?.email ?? '');
    if (sd) uniqueDomains.add(sd);
    for (const r of [...(e.recipients ?? []), ...(e.cc ?? [])]) {
      const rd = domainOf(r.email);
      if (rd) uniqueDomains.add(rd);
    }
  }
  console.log(`  unique domains touched: ${uniqueDomains.size}`);

  // Unique slugs from enrichment topics — normalized to lowercase kebab.
  const uniqueSlugs = new Set<string>();
  for (const rec of enriched) {
    if ('error' in rec) continue;
    for (const t of rec.topics ?? []) {
      const slug = normalize(t);
      if (slug) uniqueSlugs.add(slug);
    }
  }
  console.log(`  unique topic slugs: ${uniqueSlugs.size}`);

  // 3. Connect. Use the project's helper so SSL + RDS IAM auth + connection
  // string parsing all behave the same as the rest of the app. Dynamic import
  // because db.ts has module-level state that must run after dotenv.
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({ prepare: false });
  const db = drizzle(client);

  // 4. Ingest, single transaction.
  console.log('\nIngesting…');
  let stats = {
    topicsUpserted: 0,
    employersUpserted: 0,
    correspondentsUpserted: 0,
    emailsInserted: 0,
    emailsSkippedDuplicate: 0,
    participantsInserted: 0,
    emailTopicsInserted: 0,
    employerTopicsInserted: 0,
  };

  try {
    await db.transaction(async (tx) => {
      // 4a. Topics. Upsert via "DO UPDATE SET name = EXCLUDED.name" — a no-op
      // that forces RETURNING for both inserts AND existing rows.
      console.log('  [1/6] upserting topics…');
      const slugToId = new Map<string, string>();
      if (uniqueSlugs.size > 0) {
        const rows = await tx
          .insert(topics)
          .values([...uniqueSlugs].map(slug => ({ name: slug, slug })))
          .onConflictDoUpdate({
            target: topics.slug,
            set: { name: sql`EXCLUDED.name` },
          })
          .returning({ id: topics.id, slug: topics.slug });
        for (const r of rows) slugToId.set(r.slug, r.id);
        stats.topicsUpserted = rows.length;
      }

      // 4b. Employers. One row per unique domain.
      console.log('  [2/6] upserting employers…');
      const domainToEmployerId = new Map<string, string>();
      const domainToInternal = new Map<string, boolean>();
      if (uniqueDomains.size > 0) {
        const values = [...uniqueDomains].map(d => {
          const r = resolveEmployer(d, domainMap, enrichedIndustries);
          domainToInternal.set(d, r.internal);
          return {
            name: r.name,
            normalized_name: normalize(r.name),
            industry: r.industry,
          };
        });
        // Dedupe by normalized_name (multiple domains can resolve to the same
        // employer name). Prefer values that have a non-null industry.
        const byNorm = new Map<string, typeof values[number]>();
        for (const v of values) {
          const prev = byNorm.get(v.normalized_name);
          if (!prev || (v.industry && !prev.industry)) byNorm.set(v.normalized_name, v);
        }
        const dedupedValues = [...byNorm.values()];
        const rows = await tx
          .insert(employers)
          .values(dedupedValues)
          .onConflictDoUpdate({
            target: employers.normalized_name,
            set: {
              name: sql`EXCLUDED.name`,
              // Only overwrite industry when we have one — never clobber an
              // existing value with null (so manual UI edits survive re-runs).
              industry: sql`COALESCE(EXCLUDED.industry, ${employers.industry})`,
            },
          })
          .returning({ id: employers.id, normalized_name: employers.normalized_name });
        const normToId = new Map(rows.map(r => [r.normalized_name, r.id]));
        for (const d of uniqueDomains) {
          const r = resolveEmployer(d, domainMap, enrichedIndustries);
          const id = normToId.get(normalize(r.name));
          if (id) domainToEmployerId.set(d, id);
        }
        stats.employersUpserted = rows.length;
      }

      // 4c. Correspondents. One per unique email address (sender + each
      // recipient/cc) we saw. Pull title/phone from enrichment when present.
      console.log('  [3/6] upserting correspondents…');
      const allParticipantEmails = new Map<string, { name: string; domain: string }>();
      for (const e of emailsToIngest) {
        if (e.sender?.email && !isExcluded(e.sender.email)) {
          allParticipantEmails.set(e.sender.email.toLowerCase(), {
            name: e.sender.name || '',
            domain: domainOf(e.sender.email),
          });
        }
        for (const r of [...(e.recipients ?? []), ...(e.cc ?? [])]) {
          if (r.email && !isExcluded(r.email)) {
            const key = r.email.toLowerCase();
            const existing = allParticipantEmails.get(key);
            if (!existing) allParticipantEmails.set(key, { name: r.name || '', domain: domainOf(r.email) });
            // Keep the longest name we've seen.
            else if (r.name && r.name.length > existing.name.length) existing.name = r.name;
          }
        }
      }
      const emailToCorrId = new Map<string, string>();
      const corrRows: typeof correspondents.$inferInsert[] = [];
      for (const [email, meta] of allParticipantEmails) {
        const employerId = domainToEmployerId.get(meta.domain);
        if (!employerId) continue;
        const enrichPerson = personByEmail.get(email);
        const internal = domainToInternal.get(meta.domain) ?? false;
        corrRows.push({
          employer_id: employerId,
          email,
          name: enrichPerson?.name || meta.name || email,
          title: enrichPerson?.role ?? null,
          phone: enrichPerson?.phone ?? null,
          type: internal ? 'internal' : 'external',
          source: 'mbox',
        });
      }
      if (corrRows.length > 0) {
        const rows = await tx
          .insert(correspondents)
          .values(corrRows)
          .onConflictDoUpdate({
            // Partial unique index on (employer_id, email) WHERE email IS NOT NULL.
            // Postgres needs the predicate to match the partial index — without
            // `targetWhere`, infer_arbiter_indexes can't pick it.
            target: [correspondents.employer_id, correspondents.email],
            targetWhere: sql`email IS NOT NULL`,
            set: {
              name: sql`EXCLUDED.name`,
              title: sql`COALESCE(EXCLUDED.title, ${correspondents.title})`,
              phone: sql`COALESCE(EXCLUDED.phone, ${correspondents.phone})`,
              type: sql`EXCLUDED.type`,
              source: sql`EXCLUDED.source`,
              updated_at: sql`now()`,
            },
          })
          .returning({ id: correspondents.id, email: correspondents.email });
        for (const r of rows) {
          if (r.email) emailToCorrId.set(r.email.toLowerCase(), r.id);
        }
        stats.correspondentsUpserted = rows.length;
      }

      // 4d. Emails. Dedup by message_id. Direction = outbound if sender's
      // domain is marked internal in the domain map; else inbound.
      console.log('  [4/6] inserting emails…');
      const emailInserts: typeof emailsTable.$inferInsert[] = [];
      for (const e of emailsToIngest) {
        const senderEmail = (e.sender?.email ?? '').toLowerCase();
        const senderDomain = domainOf(senderEmail);
        const employerId = domainToEmployerId.get(senderDomain) ?? null;
        const internal = domainToInternal.get(senderDomain) ?? false;
        emailInserts.push({
          message_id: e.message_id || null,
          employer_id: employerId,
          from_address: senderEmail,
          from_display_name: e.sender?.name || null,
          subject: e.subject || null,
          body_text: e.body || null,
          sent_at: e.date ?? new Date().toISOString(),
          direction: internal ? 'outbound' : 'inbound',
          filter_status: 'processed',
          processed_at: new Date().toISOString(),
        });
      }
      const insertedEmailRows = await tx
        .insert(emailsTable)
        .values(emailInserts)
        .onConflictDoNothing({
          // Partial unique index on (message_id) WHERE message_id IS NOT NULL.
          // Quirk: in drizzle 0.45.2, `onConflictDoNothing` honors `where`
          // (deprecated for doUpdate) but silently ignores `targetWhere`. So
          // we must use `where` here for the partial-index predicate to land
          // in the generated SQL.
          target: emailsTable.message_id,
          where: sql`message_id IS NOT NULL`,
        })
        .returning({ id: emailsTable.id, message_id: emailsTable.message_id });
      stats.emailsInserted = insertedEmailRows.length;
      stats.emailsSkippedDuplicate = emailInserts.length - insertedEmailRows.length;

      const midToEmailId = new Map<string, string>();
      for (const r of insertedEmailRows) {
        if (r.message_id) midToEmailId.set(r.message_id, r.id);
      }

      // 4e. Participants. Only for newly-inserted emails (re-runs don't
      // create duplicates anyway thanks to UNIQUE(email_id, address, role)).
      console.log('  [5/6] inserting participants…');
      const partRows: typeof emailParticipants.$inferInsert[] = [];
      for (const e of emailsToIngest) {
        const emailId = midToEmailId.get(e.message_id);
        if (!emailId) continue;
        if (e.sender?.email && !isExcluded(e.sender.email)) {
          partRows.push({
            email_id: emailId,
            correspondent_id: emailToCorrId.get(e.sender.email.toLowerCase()) ?? null,
            address: e.sender.email.toLowerCase(),
            display_name: e.sender.name || null,
            role: 'from',
          });
        }
        for (const r of e.recipients ?? []) {
          if (isExcluded(r.email)) continue;
          partRows.push({
            email_id: emailId,
            correspondent_id: emailToCorrId.get(r.email.toLowerCase()) ?? null,
            address: r.email.toLowerCase(),
            display_name: r.name || null,
            role: 'to',
          });
        }
        for (const r of e.cc ?? []) {
          if (isExcluded(r.email)) continue;
          partRows.push({
            email_id: emailId,
            correspondent_id: emailToCorrId.get(r.email.toLowerCase()) ?? null,
            address: r.email.toLowerCase(),
            display_name: r.name || null,
            role: 'cc',
          });
        }
      }
      if (partRows.length > 0) {
        const inserted = await tx
          .insert(emailParticipants)
          .values(partRows)
          .onConflictDoNothing()
          .returning({ id: emailParticipants.id });
        stats.participantsInserted = inserted.length;
      }

      // 4f. Email topics.
      console.log('  [6/6] inserting email_topics…');
      const etRows: typeof emailTopics.$inferInsert[] = [];
      for (const e of emailsToIngest) {
        const emailId = midToEmailId.get(e.message_id);
        if (!emailId) continue;
        const enrichRec = enrichedByMid.get(e.message_id);
        if (!enrichRec) continue;
        for (const t of enrichRec.topics ?? []) {
          const topicId = slugToId.get(normalize(t));
          if (topicId) etRows.push({ email_id: emailId, topic_id: topicId });
        }
      }
      if (etRows.length > 0) {
        const inserted = await tx
          .insert(emailTopics)
          .values(etRows)
          .onConflictDoNothing()
          .returning({ id: emailTopics.id });
        stats.emailTopicsInserted = inserted.length;
      }

      // 4g. Employer topics — derive by aggregating email_topics by employer.
      // The CRM card UI reads employer.topics from this table; without it,
      // every card shows "No tags" even when per-email topics exist. source
      // = 'auto' distinguishes these from manual UI-set tags. Idempotent via
      // the existing uq_employer_topic (employer_id, topic_id) constraint.
      console.log('  [7/7] deriving employer_topics from email_topics…');
      const employerTopicRows = (await tx.execute(sql`
        INSERT INTO employer_topics (employer_id, topic_id, source)
        SELECT DISTINCT e.employer_id, et.topic_id, 'auto'
        FROM emails e
        JOIN email_topics et ON et.email_id = e.id
        WHERE e.employer_id IS NOT NULL
        ON CONFLICT (employer_id, topic_id) DO NOTHING
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      stats.employerTopicsInserted = Array.isArray(employerTopicRows)
        ? employerTopicRows.length
        : 0;
    });

    console.log('\nDone.');
    console.log(`  topics upserted:           ${stats.topicsUpserted}`);
    console.log(`  employers upserted:        ${stats.employersUpserted}`);
    console.log(`  correspondents upserted:   ${stats.correspondentsUpserted}`);
    console.log(`  emails inserted:           ${stats.emailsInserted}`);
    console.log(`  emails skipped (dup):      ${stats.emailsSkippedDuplicate}`);
    console.log(`  participants inserted:     ${stats.participantsInserted}`);
    console.log(`  email_topics inserted:     ${stats.emailTopicsInserted}`);
    console.log(`  employer_topics derived:   ${stats.employerTopicsInserted}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
