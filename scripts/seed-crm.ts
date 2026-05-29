/**
 * Populates dummy CRM data — employers + correspondents + topics + emails +
 * team members + notes + a few flagged records for the curation queue.
 *
 * Re-runnable: identifies seed rows by `employers.name` and wipes the matching
 * rows (cascades take care of children) before re-inserting.
 *
 * Usage:
 *   pnpm tsx scripts/seed-crm.ts
 *
 * Env: same connection vars as `pnpm run db:seed` (DB_HOST, DB_PORT, …).
 */
import { config } from 'dotenv';
// Must call config() before importing anything that touches db.ts — its
// module-level client creation reads process.env at import time.
config({ path: '.env.local' });
config();

import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import {
  correspondents,
  emailParticipants,
  emails,
  employerNotes,
  employerTeamMembers,
  employerTopics,
  employers,
  topics,
  users,
} from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/services/password';

// ─── Seed users (Brain 2.0 internal team) ────────────────────────────────────

const SEED_USERS = [
  { name: 'Alwan Abdurrafi', email: 'alwan.abdurrafi@smma.id', role: 'analyst' },
  { name: 'Sarah Chen', email: 'sarah.chen@smma.id', role: 'analyst' },
  { name: 'David Kim', email: 'david.kim@smma.id', role: 'analyst' },
  { name: 'Maria Park', email: 'maria.park@smma.id', role: 'director' },
  { name: 'James Tan', email: 'james.tan@smma.id', role: 'partner' },
] as const;

// ─── Topics dictionary ───────────────────────────────────────────────────────

const SEED_TOPICS = [
  'CMP slurry',
  'lithography',
  'wet processing',
  'acquisition',
  'mandate',
  'TIM',
  'carve-out',
  'financing',
  'buy-side',
  'PE exit',
  'packaging',
  'Korea',
  'Japan',
  'specialty chem',
  'semiconductors',
  'advanced packaging',
  'APAC',
  'deal flow',
  'sourcing',
  'wafer',
];

// ─── Employers ───────────────────────────────────────────────────────────────

type SeedEmployer = {
  name: string;
  industry: string;
  status: 'inbound' | 'outbound';
  curation_status?: 'published' | 'flagged';
  contacts: Array<{
    name: string;
    title: string;
    email: string;
    phone?: string;
    type?: string;
    is_primary?: boolean;
  }>;
  /** Topic name → { source, highlight } */
  topics: Array<{
    name: string;
    source: 'auto' | 'manual';
    highlight?: boolean;
  }>;
  team: string[]; // user emails
  notes?: string[];
  /** Days ago for each email’s sent_at. Negative = future. */
  emailsDaysAgo: number[];
  emailDirection?: 'inbound' | 'outbound';
  notePrefix?: string;
};

const SEED_EMPLOYERS: SeedEmployer[] = [
  {
    name: 'Goldman Sachs',
    industry: 'SemiCon',
    status: 'inbound',
    contacts: [
      {
        name: 'James Chen',
        title: 'MD, Industrials',
        email: 'james.chen@goldmansachs.com',
        phone: '+1 212 555 0101',
        type: 'Bankers',
        is_primary: true,
      },
      {
        name: 'Sarah Thompson',
        title: 'VP, M&A',
        email: 's.thompson@goldmansachs.com',
        type: 'Bankers',
      },
      {
        name: 'Michael Lee',
        title: 'Associate, Materials',
        email: 'm.lee@goldmansachs.com',
        type: 'Bankers',
      },
    ],
    topics: [
      { name: 'CMP slurry', source: 'auto', highlight: true },
      { name: 'acquisition', source: 'auto' },
      { name: 'semiconductors', source: 'auto' },
      { name: 'financing', source: 'auto' },
      { name: 'lithography', source: 'auto' },
      { name: 'mandate', source: 'manual' },
    ],
    team: ['alwan.abdurrafi@smma.id', 'sarah.chen@smma.id'],
    notes: [
      'Key relationship. James is primary deal flow for semicon materials at GS. Prefers email. Connected us to TechSlurry in May.',
    ],
    emailsDaysAgo: [2, 5, 8, 12, 14, 18, 21, 26, 30, 34, 40, 45, 60, 70],
  },
  {
    name: 'JP Morgan',
    industry: 'Chemical',
    status: 'inbound',
    contacts: [
      {
        name: 'Sarah Thompson',
        title: 'ED, Chemicals',
        email: 'sarah.thompson@jpmorgan.com',
        phone: '+1 212 555 0102',
        type: 'Bankers',
        is_primary: true,
      },
      {
        name: 'Robert Kim',
        title: 'Associate, M&A',
        email: 'r.kim@jpmorgan.com',
        type: 'Bankers',
      },
    ],
    topics: [
      { name: 'lithography', source: 'auto', highlight: true },
      { name: 'mandate', source: 'auto' },
      { name: 'specialty chem', source: 'manual' },
      { name: 'APAC', source: 'manual' },
      { name: 'acquisition', source: 'auto' },
    ],
    team: ['alwan.abdurrafi@smma.id'],
    notes: ['Good source for lithography deal flow. Sarah well-connected in APAC.'],
    emailsDaysAgo: [5, 10, 15, 22, 33, 48, 70],
  },
  {
    name: 'Morgan Stanley',
    industry: 'SemiCon',
    status: 'inbound',
    contacts: [
      {
        name: 'Michael Lee',
        title: 'VP, Technology M&A',
        email: 'michael.lee@morganstanley.com',
        phone: '+1 212 555 0103',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [
      { name: 'TIM', source: 'auto', highlight: true },
      { name: 'carve-out', source: 'auto' },
    ],
    team: ['james.tan@smma.id'],
    notes: ['Dormant relationship. Reconnect before next weekly meeting.'],
    emailsDaysAgo: [21, 45], // stale
  },
  {
    name: 'Credit Suisse',
    industry: 'Financial Services',
    status: 'outbound',
    contacts: [
      {
        name: 'Robert Kim',
        title: 'Director, APAC M&A',
        email: 'robert.kim@creditsuisse.com',
        phone: '+65 6212 0104',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [{ name: 'financing', source: 'manual', highlight: true }],
    team: ['maria.park@smma.id'],
    notes: ['Outbound relationship. Reached out re: financing for Project Cobalt.'],
    emailsDaysAgo: [42, 55], // stale
  },
  {
    name: 'Evercore',
    industry: 'SemiCon',
    status: 'inbound',
    contacts: [
      {
        name: 'Lisa Wang',
        title: 'MD, Industrials',
        email: 'l.wang@evercore.com',
        phone: '+1 212 555 0105',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [
      { name: 'CMP slurry', source: 'auto', highlight: true },
      { name: 'buy-side', source: 'auto' },
      { name: 'mandate', source: 'auto' },
      { name: 'Korea', source: 'auto' },
      { name: 'deal flow', source: 'manual' },
    ],
    team: ['alwan.abdurrafi@smma.id', 'david.kim@smma.id'],
    notes: ['Strong buy-side focus on CMP. Follow up on Korea pipeline.'],
    emailsDaysAgo: [7, 12, 19, 26, 38],
  },
  {
    name: 'BofA Merrill Lynch',
    industry: 'SemiCon',
    status: 'inbound',
    contacts: [
      {
        name: 'Andrew Hartono',
        title: 'Director, Asia Pacific M&A',
        email: 'andrew.hartono@baml.com',
        phone: '+62 21 555 0106',
        type: 'Bankers',
        is_primary: true,
      },
      {
        name: 'Jenny Liu',
        title: 'VP, Materials & Mining',
        email: 'jenny.liu@baml.com',
        type: 'Bankers',
      },
    ],
    topics: [
      { name: 'packaging', source: 'auto', highlight: true },
      { name: 'PE exit', source: 'auto' },
      { name: 'advanced packaging', source: 'auto' },
      { name: 'APAC', source: 'manual' },
      { name: 'deal flow', source: 'manual' },
      { name: 'carve-out', source: 'auto' },
      { name: 'financing', source: 'auto' },
    ],
    team: [
      'sarah.chen@smma.id',
      'alwan.abdurrafi@smma.id',
      'david.kim@smma.id',
      'james.tan@smma.id',
      'maria.park@smma.id',
    ],
    notes: ['Key APAC relationship. Andrew covers advanced packaging extensively.'],
    emailsDaysAgo: [3, 6, 10, 14, 19, 26, 35, 48, 60],
  },
  {
    name: 'Lazard',
    industry: 'Chemical',
    status: 'inbound',
    contacts: [
      {
        name: 'Priya Mehta',
        title: 'VP, Chemicals & Materials',
        email: 'p.mehta@lazard.com',
        phone: '+44 20 7555 0107',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [{ name: 'specialty chem', source: 'auto', highlight: true }],
    team: ['maria.park@smma.id'],
    notes: ['Niche boutique focus on specialty chem. Low activity — re-engage.'],
    emailsDaysAgo: [49], // stale
  },
  {
    name: 'Citigroup',
    industry: 'SemiCon',
    status: 'inbound',
    contacts: [
      {
        name: 'David Tan',
        title: 'Director, Southeast Asia M&A',
        email: 'david.tan@citi.com',
        phone: '+65 6657 0108',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [
      { name: 'wet processing', source: 'auto', highlight: true },
      { name: 'Korea', source: 'auto' },
      { name: 'semiconductors', source: 'auto' },
      { name: 'sourcing', source: 'manual' },
      { name: 'deal flow', source: 'manual' },
      { name: 'APAC', source: 'auto' },
    ],
    team: ['james.tan@smma.id', 'alwan.abdurrafi@smma.id'],
    notes: ['Strong Korea network. Useful for APAC wet processing sourcing.'],
    emailsDaysAgo: [4, 9, 15, 22, 30, 38],
  },
  // ─── Flagged records (curation queue) ────────────────────────────────────
  {
    name: 'Houlihan Lokey',
    industry: 'Financial Services',
    status: 'inbound',
    curation_status: 'flagged',
    contacts: [
      {
        name: 'J. Rodriguez',
        title: '',
        email: 'j.rodriguez@hl.com',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [],
    team: [],
    emailsDaysAgo: [3],
  },
  {
    name: 'PJT Partners',
    industry: '',
    status: 'inbound',
    curation_status: 'flagged',
    contacts: [
      {
        name: 'A. Patel',
        title: '',
        email: 'a.patel@pjtpartners.com',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [],
    team: [],
    emailsDaysAgo: [5],
  },
  {
    name: 'Centerview',
    industry: '',
    status: 'inbound',
    curation_status: 'flagged',
    contacts: [
      {
        name: 'M. Schultz',
        title: '',
        email: 'm.schultz@centerview.com',
        type: 'Bankers',
        is_primary: true,
      },
    ],
    topics: [],
    team: [],
    emailsDaysAgo: [8],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(client);

  console.log(
    `seeding CRM at ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}...`,
  );

  try {
    // ─── Users ──────────────────────────────────────────────────────────────
    const seedUserEmails = SEED_USERS.map((u) => u.email);
    const passwordHash = await hashPassword('password');
    const userByEmail = new Map<string, string>();

    for (const u of SEED_USERS) {
      const [row] = await db
        .insert(users)
        .values({
          name: u.name,
          email: u.email,
          password: passwordHash,
          role: u.role,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { name: u.name, role: u.role },
        })
        .returning({ id: users.id, email: users.email });
      if (row.email) userByEmail.set(row.email, row.id);
    }
    console.log(`  ✓ ${SEED_USERS.length} internal users`);

    // ─── Topics dictionary ──────────────────────────────────────────────────
    const topicByName = new Map<string, string>();
    for (const name of SEED_TOPICS) {
      const [row] = await db
        .insert(topics)
        .values({ name, slug: slugify(name) })
        .onConflictDoUpdate({
          target: topics.name,
          set: { slug: slugify(name) },
        })
        .returning({ id: topics.id, name: topics.name });
      topicByName.set(row.name, row.id);
    }
    console.log(`  ✓ ${SEED_TOPICS.length} topics`);

    // ─── Wipe seeded employers (cascade clears children) ────────────────────
    const seedEmployerNames = SEED_EMPLOYERS.map((e) => e.name);
    await db
      .delete(employers)
      .where(inArray(employers.name, seedEmployerNames));

    // ─── Insert employers + everything else ─────────────────────────────────
    let totalContacts = 0;
    let totalEmails = 0;
    let totalNotes = 0;
    let totalTopicAssigns = 0;
    let totalTeamRows = 0;

    for (const [empIdx, e] of SEED_EMPLOYERS.entries()) {
      const [emp] = await db
        .insert(employers)
        .values({
          name: e.name,
          normalized_name: normalize(e.name),
          industry: e.industry || null,
          status: e.status,
          curation_status: e.curation_status ?? 'published',
        })
        .returning({ id: employers.id });

      // Contacts
      const correspondentByEmail = new Map<string, string>();
      for (const c of e.contacts) {
        const [row] = await db
          .insert(correspondents)
          .values({
            employer_id: emp.id,
            name: c.name,
            title: c.title || null,
            email: c.email,
            phone: c.phone ?? null,
            type: c.type ?? null,
            is_primary: !!c.is_primary,
            source: 'auto',
          })
          .returning({ id: correspondents.id, email: correspondents.email });
        if (row.email) correspondentByEmail.set(row.email, row.id);
        totalContacts++;
      }

      // Topic assignments
      for (const t of e.topics) {
        const topicId = topicByName.get(t.name);
        if (!topicId) continue;
        await db
          .insert(employerTopics)
          .values({
            employer_id: emp.id,
            topic_id: topicId,
            source: t.source,
            is_highlight: !!t.highlight,
          })
          .onConflictDoNothing();
        totalTopicAssigns++;
      }

      // Team
      for (const userEmail of e.team) {
        const userId = userByEmail.get(userEmail);
        if (!userId) continue;
        await db
          .insert(employerTeamMembers)
          .values({ employer_id: emp.id, user_id: userId })
          .onConflictDoNothing();
        totalTeamRows++;
      }

      // Notes
      for (const note of e.notes ?? []) {
        await db.insert(employerNotes).values({
          employer_id: emp.id,
          content: note,
          author_user_id: userByEmail.get('alwan.abdurrafi@smma.id') ?? null,
        });
        totalNotes++;
      }

      // Emails + participants — pick a rotating SEED_USER as this employer's
      // custodian so that the team-member filter (which surfaces users seen as
      // role='from' on at least one email) has every seed user represented.
      // Half the dummy emails are outbound (custodian → contact, custodian
      // becomes the sender), the other half stay inbound (contact → custodian).
      const primary = e.contacts.find((c) => c.is_primary) ?? e.contacts[0];
      const custodian = SEED_USERS[empIdx % SEED_USERS.length];
      const custodianEmail = custodian.email;
      const custodianName = custodian.name;
      const custodianUserId = userByEmail.get(custodianEmail) ?? null;
      if (primary) {
        for (const [dayIdx, days] of e.emailsDaysAgo.entries()) {
          // Force outbound on alternating indices unless the employer hard-codes
          // a direction. Ensures each employer produces ≥1 row where the
          // custodian is the sender (role='from').
          const direction: 'inbound' | 'outbound' =
            e.emailDirection ?? (dayIdx % 2 === 0 ? 'outbound' : 'inbound');
          const sentAt = daysAgoIso(days);
          const [emailRow] = await db
            .insert(emails)
            .values({
              employer_id: emp.id,
              from_address:
                direction === 'inbound' ? primary.email : custodianEmail,
              from_display_name:
                direction === 'inbound' ? primary.name : custodianName,
              subject: `Touchpoint #${days} — ${e.name}`,
              body_text: `Auto-generated dummy email for ${e.name}.`,
              sent_at: sentAt,
              direction,
              filter_status: 'processed',
              processed_at: sentAt,
            })
            .returning({ id: emails.id });

          await db.insert(emailParticipants).values([
            {
              email_id: emailRow.id,
              address:
                direction === 'inbound' ? primary.email : custodianEmail,
              display_name:
                direction === 'inbound' ? primary.name : custodianName,
              user_id: direction === 'inbound' ? null : custodianUserId,
              correspondent_id:
                direction === 'inbound'
                  ? correspondentByEmail.get(primary.email) ?? null
                  : null,
              role: 'from',
            },
            {
              email_id: emailRow.id,
              address:
                direction === 'inbound' ? custodianEmail : primary.email,
              display_name:
                direction === 'inbound' ? custodianName : primary.name,
              user_id: direction === 'inbound' ? custodianUserId : null,
              correspondent_id:
                direction === 'inbound'
                  ? null
                  : correspondentByEmail.get(primary.email) ?? null,
              role: 'to',
            },
          ]);
          totalEmails++;
        }
      }
    }

    console.log(`  ✓ ${SEED_EMPLOYERS.length} employers`);
    console.log(`  ✓ ${totalContacts} correspondents`);
    console.log(`  ✓ ${totalTopicAssigns} topic assignments`);
    console.log(`  ✓ ${totalTeamRows} team-member rows`);
    console.log(`  ✓ ${totalNotes} notes`);
    console.log(`  ✓ ${totalEmails} emails (+ 2 participants each)`);
    console.log('done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('seed-crm failed:');
  console.error(err);
  process.exit(1);
});
