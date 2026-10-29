/**
 * Re-applies INTERNAL_MAIL_DOMAINS to what was ingested before a domain joined
 * the list, so the stored data matches what a fresh ingest writes today:
 * - mail that is now internal-only is deleted. Ingest drops it
 *   (`shouldSkip` → `isInternalOnly`): a sender, at least one To/Cc, and every
 *   address at one of our domains. The FKs cascade the email's participants,
 *   topics, note, role signals and related-company evidence;
 * - auto-created contacts at an internal domain are deleted. Ingest never
 *   creates them (`skipCrmPerson`); their deal links and curation cascade, and
 *   the participant rows of mail that stays drop to correspondent_id NULL, as
 *   ingest writes them;
 * - a firm whose domains are all internal (or that has none and is found by
 *   an auto-created contact at one) and that has no contact left is
 *   deleted (`skipEmployerDomain`). A firm that keeps another domain or a
 *   contact only loses its internal employer_domains rows.
 *
 * Contacts a person added by hand (origin 'manual') are kept and reported,
 * and so are Smart Files whose source sender is at an internal domain.
 *
 * The stored participants have no Bcc, so mail whose only external address
 * was a Bcc counts as internal-only here although ingest kept it.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/repositories';
import { MartRepository, type MartView } from '../repositories/martRepository';
import { INTERNAL_MAIL_DOMAINS } from '../lib/mailDomains';

export interface InternalOnlyEmail {
  id: string;
  message_id: string | null;
  from_address: string;
  sent_at: string;
  custodian_email: string | null;
  participants: Array<{ address: string; role: string }>;
  note: {
    summary: string | null;
    key_points: unknown;
    next_step: string | null;
    next_step_status: string;
  } | null;
}

export interface InternalCorrespondent {
  id: string;
  employer_id: string;
  name: string;
  title: string | null;
  email: string;
  phone: string | null;
  origin: string;
  deal_links: number;
  /** Deal links a person made or confirmed (origin manual / confirmed_suggestion). */
  manual_deal_links: number;
}

export interface InternalEmployer {
  id: string;
  name: string;
  /** Its domains that are on the list being applied. */
  internal_domains: string[];
  other_domains: number;
  /** Contacts the refilter does not delete. */
  kept_correspondents: number;
  notes: Array<{ id: string; content: string; created_at: string; deleted_at: string | null }>;
  related_companies: number;
  /** Pipeline companies whose CRM firm link is cleared. */
  linked_companies: number;
}

export interface RefilterPlan {
  domains: string[];
  emails: InternalOnlyEmail[];
  /** Auto-created contacts, deleted. */
  correspondents: InternalCorrespondent[];
  /** Hand-added contacts, kept. */
  manualCorrespondents: InternalCorrespondent[];
  /** Firms deleted outright. */
  employers: InternalEmployer[];
  /** Firms kept; only their internal domains are removed. */
  keptEmployers: InternalEmployer[];
  /** Smart Files from a sender at an internal domain (reported, never deleted). */
  smartFiles: number;
}

export interface RefilterCounts {
  emails: number;
  correspondents: number;
  employers: number;
  employer_domains: number;
}

export interface RefilterResult {
  plan: RefilterPlan;
  deleted: RefilterCounts | null;
  martsRefreshed: MartView[];
}

/** Lower-case domain of an address, the same as the SQL `domainOf` below. */
export function domainOf(address: string): string {
  return address.match(/@([^@]*)$/)?.[1]?.toLowerCase() ?? '';
}

/**
 * The domains to apply: every internal domain, or the given subset. A domain
 * that is not on the list is refused — ingest would not drop its mail.
 */
export function resolveRefilterDomains(only: string[] = []): string[] {
  const wanted = [...new Set(only.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return [...INTERNAL_MAIL_DOMAINS].sort();
  const unknown = wanted.filter((d) => !INTERNAL_MAIL_DOMAINS.has(d));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(', ')} not in INTERNAL_MAIL_DOMAINS (src/lib/crm/mailDomains.ts) — add it there first`,
    );
  }
  return wanted.sort();
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** One `text[]` / `uuid[]` parameter, so long lists never hit the bind limit. */
function pgArray(values: readonly string[], type: 'text' | 'uuid'): SQL {
  const literal = `{${values.map((v) => `"${v.replace(/[\\"]/g, '\\$&')}"`).join(',')}}`;
  return type === 'uuid' ? sql`${literal}::uuid[]` : sql`${literal}::text[]`;
}

function domainOfSql(column: SQL): SQL {
  return sql`COALESCE(lower(substring(${column} from '@([^@]*)$')), '')`;
}

export async function listInternalOnlyEmails(
  db: DbClient,
  domains: string[],
): Promise<InternalOnlyEmail[]> {
  if (domains.length === 0) return [];
  const internal = pgArray([...INTERNAL_MAIL_DOMAINS], 'text');
  const target = pgArray(domains, 'text');
  const domain = domainOfSql(sql`p.address`);
  return queryRows<InternalOnlyEmail>(
    await db.execute(sql`
      SELECT e.id::text AS id, e.message_id, e.from_address, e.sent_at, e.custodian_email,
        (SELECT json_agg(json_build_object('address', p.address, 'role', p.role)
                         ORDER BY p.role, p.address)
           FROM analytics.email_participants p WHERE p.email_id = e.id) AS participants,
        (SELECT json_build_object('summary', n.summary, 'key_points', n.key_points,
                                  'next_step', n.next_step, 'next_step_status', n.next_step_status)
           FROM analytics.email_notes n WHERE n.email_id = e.id) AS note
      FROM analytics.emails e
      WHERE EXISTS (SELECT 1 FROM analytics.email_participants p
                    WHERE p.email_id = e.id AND p.role = 'from')
        AND EXISTS (SELECT 1 FROM analytics.email_participants p
                    WHERE p.email_id = e.id AND p.role <> 'from')
        AND NOT EXISTS (SELECT 1 FROM analytics.email_participants p
                        WHERE p.email_id = e.id AND NOT (${domain} = ANY(${internal})))
        AND EXISTS (SELECT 1 FROM analytics.email_participants p
                    WHERE p.email_id = e.id AND ${domain} = ANY(${target}))
      ORDER BY e.sent_at, e.id
    `),
  ).map((r) => ({ ...r, participants: r.participants ?? [] }));
}

export async function listInternalCorrespondents(
  db: DbClient,
  domains: string[],
): Promise<InternalCorrespondent[]> {
  if (domains.length === 0) return [];
  return queryRows<InternalCorrespondent>(
    await db.execute(sql`
      SELECT c.id::text AS id, c.employer_id::text AS employer_id, c.name, c.title,
             c.email, c.phone, c.origin,
        (SELECT count(*) FROM deal_contacts d WHERE d.correspondent_id = c.id)::int AS deal_links,
        (SELECT count(*) FROM deal_contacts d
          WHERE d.correspondent_id = c.id
            AND d.origin IN ('manual', 'confirmed_suggestion'))::int AS manual_deal_links
      FROM correspondents c
      WHERE ${domainOfSql(sql`c.email`)} = ANY(${pgArray(domains, 'text')})
      ORDER BY lower(c.email), c.id
    `),
  );
}

export async function listInternalEmployers(
  db: DbClient,
  domains: string[],
): Promise<InternalEmployer[]> {
  if (domains.length === 0) return [];
  const target = pgArray(domains, 'text');
  const contactDomain = domainOfSql(sql`c.email`);
  return queryRows<InternalEmployer>(
    await db.execute(sql`
      SELECT e.id::text AS id, e.name,
        COALESCE(array_agg(lower(ed.domain) ORDER BY lower(ed.domain))
          FILTER (WHERE lower(ed.domain) = ANY(${target})), '{}') AS internal_domains,
        (count(ed.id) FILTER (WHERE NOT (lower(ed.domain) = ANY(${target}))))::int AS other_domains,
        (SELECT count(*) FROM correspondents c
          WHERE c.employer_id = e.id
            AND NOT (c.origin = 'auto' AND ${contactDomain} = ANY(${target})))::int
          AS kept_correspondents,
        COALESCE((SELECT json_agg(json_build_object('id', n.id, 'content', n.content,
                                                    'created_at', n.created_at,
                                                    'deleted_at', n.deleted_at)
                                  ORDER BY n.created_at)
                    FROM employer_notes n WHERE n.employer_id = e.id), '[]'::json) AS notes,
        (SELECT count(*) FROM employer_related_companies r
          WHERE r.employer_id = e.id)::int AS related_companies,
        (SELECT count(*) FROM companies co WHERE co.crm_employer_id = e.id)::int AS linked_companies
      FROM employers e
      LEFT JOIN employer_domains ed ON ed.employer_id = e.id
      -- A firm is found by an internal domain, or, when it has no domain row,
      -- by an auto-created contact at one.
      WHERE EXISTS (SELECT 1 FROM employer_domains t
                    WHERE t.employer_id = e.id AND lower(t.domain) = ANY(${target}))
         OR EXISTS (SELECT 1 FROM correspondents c
                    WHERE c.employer_id = e.id AND c.origin = 'auto'
                      AND ${contactDomain} = ANY(${target}))
      GROUP BY e.id, e.name
      ORDER BY e.name, e.id
    `),
  );
}

export async function countInternalSmartFiles(db: DbClient, domains: string[]): Promise<number> {
  if (domains.length === 0) return 0;
  const [row] = queryRows<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM files f
      WHERE ${domainOfSql(sql`f.source_sender_email`)} = ANY(${pgArray(domains, 'text')})
    `),
  );
  return row?.n ?? 0;
}

/** Everything the refilter would delete or leave, read-only. */
export async function planInternalMailRefilter(
  db: DbClient,
  domains: string[],
): Promise<RefilterPlan> {
  const emails = await listInternalOnlyEmails(db, domains);
  const contacts = await listInternalCorrespondents(db, domains);
  const firms = await listInternalEmployers(db, domains);
  const smartFiles = await countInternalSmartFiles(db, domains);
  return {
    domains,
    emails,
    correspondents: contacts.filter((c) => c.origin === 'auto'),
    manualCorrespondents: contacts.filter((c) => c.origin !== 'auto'),
    employers: firms.filter((e) => e.other_domains === 0 && e.kept_correspondents === 0),
    keptEmployers: firms.filter((e) => e.other_domains > 0 || e.kept_correspondents > 0),
    smartFiles,
  };
}

function deletedCount(result: unknown): number {
  return queryRows(result).length;
}

/**
 * Deletes what the plan lists, in one transaction. Each statement re-checks
 * the rule it was planned under, so a contact added by hand since the plan is
 * not deleted and keeps its firm.
 */
export async function applyInternalMailRefilter(
  db: DbClient,
  plan: RefilterPlan,
): Promise<RefilterCounts> {
  const target = pgArray(plan.domains, 'text');
  return db.transaction(async (tx) => {
    const counts: RefilterCounts = { emails: 0, correspondents: 0, employers: 0, employer_domains: 0 };
    if (plan.emails.length > 0) {
      counts.emails = deletedCount(
        await tx.execute(sql`
          DELETE FROM analytics.emails
          WHERE id = ANY(${pgArray(plan.emails.map((e) => e.id), 'uuid')})
          RETURNING id
        `),
      );
    }
    if (plan.correspondents.length > 0) {
      counts.correspondents = deletedCount(
        await tx.execute(sql`
          DELETE FROM correspondents
          WHERE id = ANY(${pgArray(plan.correspondents.map((c) => c.id), 'uuid')})
            AND origin = 'auto'
          RETURNING id
        `),
      );
    }
    if (plan.keptEmployers.length > 0) {
      counts.employer_domains = deletedCount(
        await tx.execute(sql`
          DELETE FROM employer_domains
          WHERE employer_id = ANY(${pgArray(plan.keptEmployers.map((e) => e.id), 'uuid')})
            AND lower(domain) = ANY(${target})
          RETURNING id
        `),
      );
    }
    if (plan.employers.length > 0) {
      counts.employers = deletedCount(
        await tx.execute(sql`
          DELETE FROM employers e
          WHERE e.id = ANY(${pgArray(plan.employers.map((x) => x.id), 'uuid')})
            AND NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.employer_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM employer_domains ed
                            WHERE ed.employer_id = e.id AND NOT (lower(ed.domain) = ANY(${target})))
          RETURNING id
        `),
      );
    }
    return counts;
  });
}

/**
 * Plans the refilter and, with `apply`, hands the plan to `onPlan` (the
 * script's backup) before deleting, then refreshes the marts so CRM email
 * counts and last-contact dates drop the deleted mail.
 */
export async function refilterInternalMail(
  db: DbClient,
  opts: {
    apply: boolean;
    domains: string[];
    onPlan?: (plan: RefilterPlan) => void | Promise<void>;
  },
): Promise<RefilterResult> {
  const plan = await planInternalMailRefilter(db, opts.domains);
  await opts.onPlan?.(plan);
  if (!opts.apply) return { plan, deleted: null, martsRefreshed: [] };

  const deleted = await applyInternalMailRefilter(db, plan);
  const changed = deleted.emails + deleted.correspondents + deleted.employers > 0;
  // CONCURRENTLY runs outside the transaction above, after it commits.
  const martsRefreshed = changed ? await new MartRepository(db).refreshAll() : [];
  return { plan, deleted, martsRefreshed };
}
