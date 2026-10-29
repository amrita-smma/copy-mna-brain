import { describe, it, expect, vi } from 'vitest';
import {
  domainOf,
  resolveRefilterDomains,
  listInternalOnlyEmails,
  listInternalCorrespondents,
  listInternalEmployers,
  countInternalSmartFiles,
  planInternalMailRefilter,
  applyInternalMailRefilter,
  refilterInternalMail,
  type InternalCorrespondent,
  type InternalEmployer,
  type InternalOnlyEmail,
  type RefilterPlan,
} from './internalMailRefilter';
import { INTERNAL_MAIL_DOMAINS } from '../lib/mailDomains';

function email(overrides: Partial<InternalOnlyEmail> = {}): InternalOnlyEmail {
  return {
    id: '00000000-0000-0000-0000-0000000000e1',
    message_id: '<m1@starcapital.co.id>',
    from_address: 'analyst@starcapital.co.id',
    sent_at: '2026-10-14T03:00:00Z',
    custodian_email: 'analyst@starcapital.co.id',
    participants: [
      { address: 'analyst@starcapital.co.id', role: 'from' },
      { address: 'jamial.salim@starwealth.vip', role: 'to' },
    ],
    note: null,
    ...overrides,
  };
}

function contact(overrides: Partial<InternalCorrespondent> = {}): InternalCorrespondent {
  return {
    id: '00000000-0000-0000-0000-0000000000c1',
    employer_id: '00000000-0000-0000-0000-0000000000f1',
    name: 'Jamial Salim',
    title: null,
    email: 'jamial.salim@starwealth.vip',
    phone: null,
    origin: 'auto',
    deal_links: 0,
    manual_deal_links: 0,
    ...overrides,
  };
}

function firm(overrides: Partial<InternalEmployer> = {}): InternalEmployer {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    name: 'Starwealth',
    internal_domains: ['starwealth.vip'],
    other_domains: 0,
    kept_correspondents: 0,
    notes: [],
    related_companies: 0,
    linked_companies: 0,
    ...overrides,
  };
}

function plan(overrides: Partial<RefilterPlan> = {}): RefilterPlan {
  return {
    domains: ['starwealth.vip'],
    emails: [],
    correspondents: [],
    manualCorrespondents: [],
    employers: [],
    keptEmployers: [],
    smartFiles: 0,
    ...overrides,
  };
}

/**
 * A db that answers each refilter SELECT with the given rows, a DELETE with one
 * row per id it was planned to delete, and records every statement in order.
 */
function dbServing(rows: {
  emails?: InternalOnlyEmail[];
  contacts?: InternalCorrespondent[];
  firms?: InternalEmployer[];
  smartFiles?: number;
} = {}) {
  const executed: string[] = [];
  const execute = vi.fn(async (query: unknown) => {
    const text = JSON.stringify(query);
    executed.push(text);
    if (text.includes('DELETE FROM')) {
      const ids = text.match(/\{[^}]*\}::uuid\[\]/)?.[0] ?? '';
      return { rows: ids.split(',').map((id) => ({ id })) };
    }
    if (text.includes('REFRESH MATERIALIZED VIEW')) return { rows: [] };
    if (text.includes('e.message_id, e.from_address')) return { rows: rows.emails ?? [] };
    if (text.includes('c.employer_id::text AS employer_id')) return { rows: rows.contacts ?? [] };
    if (text.includes('AS internal_domains')) return { rows: rows.firms ?? [] };
    if (text.includes('FROM files f')) return { rows: [{ n: rows.smartFiles ?? 0 }] };
    throw new Error(`unexpected query: ${text.slice(0, 200)}`);
  });
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }));
  return { db: { execute, transaction } as never, executed, execute, transaction };
}

describe('domainOf', () => {
  it('returns the lower-cased part after the last @', () => {
    expect(domainOf('Jamial.Salim@StarWealth.VIP')).toBe('starwealth.vip');
    expect(domainOf('no-at-sign')).toBe('');
  });
});

describe('resolveRefilterDomains', () => {
  it('defaults to every internal domain, starwealth.vip included', () => {
    const domains = resolveRefilterDomains();
    expect(domains).toHaveLength(INTERNAL_MAIL_DOMAINS.size);
    expect(domains).toContain('starwealth.vip');
  });

  it('narrows to the given domains, trimmed, lower-cased and de-duplicated', () => {
    expect(resolveRefilterDomains([' StarWealth.vip', 'starwealth.vip', 'gear.com.sg'])).toEqual([
      'gear.com.sg',
      'starwealth.vip',
    ]);
  });

  it('refuses a domain that is not on the internal list', () => {
    expect(() => resolveRefilterDomains(['bank.example'])).toThrow(/bank\.example not in INTERNAL_MAIL_DOMAINS/);
  });
});

describe('internal mail queries', () => {
  it('return nothing without hitting the DB when there are no domains', async () => {
    const { db, execute } = dbServing();
    expect(await listInternalOnlyEmails(db, [])).toEqual([]);
    expect(await listInternalCorrespondents(db, [])).toEqual([]);
    expect(await listInternalEmployers(db, [])).toEqual([]);
    expect(await countInternalSmartFiles(db, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('select mail the ingest drops as internal-only: a sender, a recipient, and every address internal', async () => {
    const { db, executed } = dbServing({ emails: [email()] });
    await listInternalOnlyEmails(db, ['starwealth.vip']);
    const [text] = executed;
    expect(text).toContain("p.role = 'from'");
    expect(text).toContain("p.role <> 'from'");
    expect(text).toContain('AND NOT EXISTS');
    // Every address is checked against the whole list, not just the narrowed domains.
    expect(text).toContain('starcapital.co.id');
    expect(text).toContain('starwealth.vip');
  });

  it('give an email with no participant rows an empty participant list', async () => {
    const { db } = dbServing({ emails: [email({ participants: null as never })] });
    const [row] = await listInternalOnlyEmails(db, ['starwealth.vip']);
    expect(row.participants).toEqual([]);
  });

  it('bind the domain list as one array parameter', async () => {
    const { db, executed } = dbServing();
    await listInternalCorrespondents(db, ['starwealth.vip', 'gear.com.sg']);
    expect(executed[0]).toContain('{\\"starwealth.vip\\",\\"gear.com.sg\\"}');
    expect(executed[0]).toContain('::text[]');
  });
});

describe('planInternalMailRefilter', () => {
  it('deletes auto-created contacts and keeps hand-added ones', async () => {
    const manual = contact({ id: 'c2', origin: 'manual', email: 'hand@starwealth.vip' });
    const { db } = dbServing({ contacts: [contact(), manual] });
    const result = await planInternalMailRefilter(db, ['starwealth.vip']);
    expect(result.correspondents.map((c) => c.id)).toEqual([contact().id]);
    expect(result.manualCorrespondents).toEqual([manual]);
  });

  it('finds a firm with no domain row by its auto-created contact at an internal domain', async () => {
    const { db, executed } = dbServing({ firms: [firm({ internal_domains: [] })] });
    const result = await planInternalMailRefilter(db, ['starwealth.vip']);
    const firmQuery = executed.find((t) => t.includes('AS internal_domains')) ?? '';
    expect(firmQuery).toContain('LEFT JOIN employer_domains ed');
    expect(firmQuery).toContain("c.origin = 'auto'");
    expect(result.employers).toHaveLength(1);
  });

  it('deletes a firm only when every domain is internal and no contact is left', async () => {
    const onlyInternal = firm();
    const mixed = firm({ id: 'f2', name: 'Mixed', other_domains: 1 });
    const keepsContact = firm({ id: 'f3', name: 'Has manual', kept_correspondents: 1 });
    const { db } = dbServing({ firms: [onlyInternal, mixed, keepsContact], smartFiles: 3 });
    const result = await planInternalMailRefilter(db, ['starwealth.vip']);
    expect(result.employers).toEqual([onlyInternal]);
    expect(result.keptEmployers).toEqual([mixed, keepsContact]);
    expect(result.smartFiles).toBe(3);
  });
});

describe('applyInternalMailRefilter', () => {
  it('deletes emails, contacts, internal domains of kept firms, then firms, in one transaction', async () => {
    const { db, executed, transaction } = dbServing();
    const counts = await applyInternalMailRefilter(
      db,
      plan({
        emails: [email()],
        correspondents: [contact()],
        employers: [firm()],
        keptEmployers: [firm({ id: '00000000-0000-0000-0000-0000000000f2', other_domains: 1 })],
      }),
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executed.map((t) => t.match(/DELETE FROM [\w.]+/)?.[0])).toEqual([
      'DELETE FROM analytics.emails',
      'DELETE FROM correspondents',
      'DELETE FROM employer_domains',
      'DELETE FROM employers',
    ]);
    expect(counts).toEqual({ emails: 1, correspondents: 1, employers: 1, employer_domains: 1 });
  });

  it('re-checks the rules: only auto contacts, and only firms with no contact or other domain left', async () => {
    const { db, executed } = dbServing();
    await applyInternalMailRefilter(db, plan({ correspondents: [contact()], employers: [firm()] }));
    expect(executed[0]).toContain("AND origin = 'auto'");
    expect(executed[1]).toContain('NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.employer_id = e.id)');
    expect(executed[1]).toContain('NOT EXISTS (SELECT 1 FROM employer_domains ed');
  });

  it('runs no statement for an empty plan', async () => {
    const { db, execute } = dbServing();
    const counts = await applyInternalMailRefilter(db, plan());
    expect(execute).not.toHaveBeenCalled();
    expect(counts).toEqual({ emails: 0, correspondents: 0, employers: 0, employer_domains: 0 });
  });
});

describe('refilterInternalMail', () => {
  it('changes nothing on a dry run but still hands the plan to onPlan', async () => {
    const { db, executed } = dbServing({ emails: [email()], contacts: [contact()], firms: [firm()] });
    const onPlan = vi.fn();
    const result = await refilterInternalMail(db, { apply: false, domains: ['starwealth.vip'], onPlan });
    expect(onPlan).toHaveBeenCalledWith(result.plan);
    expect(result.deleted).toBeNull();
    expect(executed.some((t) => t.includes('DELETE FROM') || t.includes('REFRESH'))).toBe(false);
  });

  it('hands the plan to onPlan before deleting, then refreshes the marts', async () => {
    const { db, executed } = dbServing({ emails: [email()], contacts: [contact()], firms: [firm()] });
    let statementsAtPlan = -1;
    const result = await refilterInternalMail(db, {
      apply: true,
      domains: ['starwealth.vip'],
      onPlan: () => {
        statementsAtPlan = executed.length;
      },
    });
    expect(executed.slice(0, statementsAtPlan).some((t) => t.includes('DELETE FROM'))).toBe(false);
    expect(result.deleted).toEqual({ emails: 1, correspondents: 1, employers: 1, employer_domains: 0 });
    expect(executed.filter((t) => t.includes('REFRESH MATERIALIZED VIEW'))).toHaveLength(5);
    expect(result.martsRefreshed).toContain('mart_contact_email_totals');
  });

  it('skips the mart refresh when nothing was deleted', async () => {
    const { db, executed } = dbServing();
    const result = await refilterInternalMail(db, { apply: true, domains: ['starwealth.vip'] });
    expect(result.martsRefreshed).toEqual([]);
    expect(executed.some((t) => t.includes('REFRESH'))).toBe(false);
  });
});
