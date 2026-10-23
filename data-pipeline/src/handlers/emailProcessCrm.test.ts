import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedPerson } from '../mboxParser';

const repo = vi.hoisted(() => ({
  listOverrides: vi.fn(),
  findByNormalizedNames: vi.fn(),
  employerUpsertBatch: vi.fn(),
  correspondentUpsertBatch: vi.fn(),
  emailInsertBatch: vi.fn(async (rows: Array<{ message_id: string }>) =>
    rows.map((r, i) => ({ id: `email-${i}`, message_id: r.message_id })),
  ),
  findUsersByEmails: vi.fn(),
  findWorkspaceIdsBySyncedEmail: vi.fn(),
  addTeam: vi.fn(),
}));

vi.mock('@/lib/repositories', () => {
  const asyncEmpty = () => vi.fn().mockResolvedValue([]);
  class EmployerOverrideRepository { listAll = repo.listOverrides; }
  class EmployerDomainRepository {
    loadMap = vi.fn().mockResolvedValue(new Map());
    persistMany = vi.fn().mockResolvedValue(undefined);
  }
  class UserRepository { findByEmails = repo.findUsersByEmails; }
  class UserWorkspaceRepository { findWorkspaceIdsBySyncedEmail = repo.findWorkspaceIdsBySyncedEmail; }
  class TopicRepository { upsertBatch = asyncEmpty(); }
  class EmployerRepository {
    findByNormalizedNames = repo.findByNormalizedNames;
    upsertBatch = repo.employerUpsertBatch;
  }
  class EmailRepository {
    insertBatchIgnoringDupes = repo.emailInsertBatch;
    insertParticipantsBatch = asyncEmpty();
    insertTopicsBatch = asyncEmpty();
  }
  class CorrespondentRepository {
    findByEmails = asyncEmpty();
    upsertBatch = repo.correspondentUpsertBatch;
  }
  class WorkspaceCorrespondentRepository { addMemberships = asyncEmpty(); }
  class EmployerTeamRepository { addMany = repo.addTeam; }
  class EmployerRelatedCompanyRepository {}
  class CompanyRepository {}
  return {
    CompanyRepository,
    CorrespondentRepository,
    EmailRepository,
    EmployerDomainRepository,
    EmployerOverrideRepository,
    EmployerRepository,
    EmployerRelatedCompanyRepository,
    EmployerTeamRepository,
    TopicRepository,
    UserRepository,
    UserWorkspaceRepository,
    WorkspaceCorrespondentRepository,
  };
});

import {
  collectCorrespondentCandidates,
  llmCompanyByDomain,
  skipCrmPerson,
  skipEmployerDomain,
  upsertEphemeralCrmBatch,
  upsertEmailNotes,
  type EphemeralCrmMessage,
} from './emailProcessCrm';

describe('emailProcessCrm domain gates', () => {
  const excluded = new Set(['blocked.example', 'hr-vendor.com']);

  it('skips internal, personal, and curated excluded addresses', () => {
    expect(skipCrmPerson('a@starcapital.co.id', excluded)).toBe(true);
    expect(skipCrmPerson('a@gmail.com', excluded)).toBe(true);
    expect(skipCrmPerson('x@blocked.example', excluded)).toBe(true);
    expect(skipCrmPerson('banker@goldman.com', excluded)).toBe(false);
  });

  it('skips employer creation for excluded domains on To/Cc', () => {
    expect(skipEmployerDomain('blocked.example', excluded)).toBe(true);
    expect(skipEmployerDomain('hr-vendor.com', excluded)).toBe(true);
    expect(skipEmployerDomain('goldman.com', excluded)).toBe(false);
    expect(skipEmployerDomain('gmail.com', excluded)).toBe(true);
  });
});

function person(p: Partial<EnrichedPerson>): EnrichedPerson {
  return { name: null, role: null, company: null, email: null, phone: null, ...p };
}

describe('collectCorrespondentCandidates', () => {
  const employers = new Map([['gs.com', 'emp-gs']]);
  const none = new Set<string>();
  const ccJane = {
    from_address: 'me@starcapital.co.id',
    from_display_name: 'Me',
    to_addresses: ['other@gs.com'],
    cc_addresses: ['jane@gs.com'],
  };
  const fromJane = {
    from_address: 'jane@gs.com',
    from_display_name: 'Jane Doe',
    to_addresses: ['me@starcapital.co.id'],
    cc_addresses: [],
  };

  it('upgrades a raw-address sighting to a later sender display name', () => {
    const out = collectCorrespondentCandidates([ccJane, fromJane], [[], []], employers, none);
    expect(out.get('jane@gs.com')?.name).toBe('Jane Doe');
  });

  it('keeps the real name when the raw-address sighting comes second', () => {
    const out = collectCorrespondentCandidates([fromJane, ccJane], [[], []], employers, none);
    expect(out.get('jane@gs.com')?.name).toBe('Jane Doe');
  });

  it('keeps the first real name and fills title/phone from later sightings', () => {
    const out = collectCorrespondentCandidates(
      [fromJane, { ...fromJane, from_display_name: 'J. Doe' }],
      [[], [person({ email: 'jane@gs.com', role: 'MD', phone: '+1 555' })]],
      employers,
      none,
    );
    expect(out.get('jane@gs.com')).toMatchObject({
      name: 'Jane Doe',
      title: 'MD',
      phone: '+1 555',
      employer_id: 'emp-gs',
    });
  });

  it('prefers a real display name over an address-like LLM name', () => {
    const out = collectCorrespondentCandidates(
      [fromJane],
      [[person({ email: 'jane@gs.com', name: 'jane@gs.com' })]],
      employers,
      none,
    );
    expect(out.get('jane@gs.com')?.name).toBe('Jane Doe');
  });

  it('falls back to the address when no name is known', () => {
    const out = collectCorrespondentCandidates([ccJane], [[]], employers, none);
    expect(out.get('other@gs.com')?.name).toBe('other@gs.com');
  });
});

describe('llmCompanyByDomain', () => {
  it('picks the most frequent company per domain, ties to the first seen', () => {
    const out = llmCompanyByDomain([
      [
        person({ email: 'a@gs.com', company: 'Goldman Sachs' }),
        person({ email: 'b@ms.com', company: 'Morgan Stanley' }),
        person({ email: 'c@ms.com', company: 'MS Asia' }),
      ],
      [
        person({ email: 'd@gs.com', company: 'GS' }),
        person({ email: 'e@gs.com', company: 'goldman  sachs' }),
      ],
    ]);
    expect(out.get('gs.com')).toBe('Goldman Sachs');
    expect(out.get('ms.com')).toBe('Morgan Stanley');
  });

  it('ignores empty, address-like and email-less entries', () => {
    const out = llmCompanyByDomain([
      [
        person({ email: 'a@x.com', company: '  ' }),
        person({ email: 'b@y.com', company: 'b@y.com' }),
        person({ phone: '+1', company: 'Phone Only Co' }),
      ],
    ]);
    expect(out.size).toBe(0);
  });
});

describe('upsertEphemeralCrmBatch new-employer naming', () => {
  const db = {
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  const message: EphemeralCrmMessage = {
    message_id: '<m1@gs.com>',
    from_address: 'jane@gs.com',
    from_display_name: 'Jane Doe',
    to_addresses: ['me@starcapital.co.id'],
    cc_addresses: [],
    subject: null,
    sent_at: '2026-10-01T00:00:00Z',
    in_reply_to: '<root@gs.com>',
    custodian_email: 'me@starcapital.co.id',
    direction: 'inbound',
    candidates: [{ type: 'email', value: 'jane@gs.com' }] as EphemeralCrmMessage['candidates'],
    llm: {
      topics: [],
      related_companies: [],
      people: [
        { name: 'Jane Doe', role: 'MD', company: 'Goldman Sachs', candidate_indices: [0] },
      ],
      email_note: {
        summary: '',
        key_points: [],
        sentiment: 'neutral',
        next_step: null,
        next_step_status: 'none',
        counterparty_roles: [],
      },
    },
  };

  beforeEach(() => {
    repo.listOverrides.mockReset().mockResolvedValue([]);
    repo.findByNormalizedNames.mockReset();
    repo.employerUpsertBatch.mockReset().mockResolvedValue([]);
    repo.correspondentUpsertBatch.mockReset().mockResolvedValue([]);
    repo.findUsersByEmails.mockReset().mockResolvedValue([]);
    repo.findWorkspaceIdsBySyncedEmail.mockReset().mockResolvedValue([]);
    repo.addTeam.mockReset().mockResolvedValue(0);
  });

  it("files the batch's auto tags and team coverage under each workspace the custodian syncs into", async () => {
    const executed: string[] = [];
    const testDb = {
      execute: vi.fn(async (query: unknown) => {
        executed.push(JSON.stringify(query));
        return [];
      }),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(testDb)),
    };
    repo.findByNormalizedNames.mockResolvedValue([
      { id: 'emp-gs', normalized_name: 'goldman-sachs', name: 'Goldman Sachs' },
    ]);
    repo.findUsersByEmails.mockResolvedValue([{ id: 'user-me', email: 'me@starcapital.co.id' }]);
    repo.findWorkspaceIdsBySyncedEmail.mockResolvedValue(['ws-a', 'ws-b']);

    await upsertEphemeralCrmBatch([message], { db: testDb as never });

    const tagInsert = executed.filter((q) => q.includes('INSERT INTO employer_topics'));
    expect(tagInsert).toHaveLength(1);
    expect(tagInsert[0]).toContain('ws-a');
    expect(tagInsert[0]).toContain('ws-b');
    expect(tagInsert[0]).toContain('ON CONFLICT (workspace_id, employer_id, topic_id)');
    expect(repo.addTeam).toHaveBeenCalledWith([
      { workspace_id: 'ws-a', employer_id: 'emp-gs', user_id: 'user-me' },
      { workspace_id: 'ws-b', employer_id: 'emp-gs', user_id: 'user-me' },
    ]);
  });

  it('writes no tags or coverage when the custodian syncs into no workspace', async () => {
    const executed: string[] = [];
    const testDb = {
      execute: vi.fn(async (query: unknown) => {
        executed.push(JSON.stringify(query));
        return [];
      }),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(testDb)),
    };
    repo.findByNormalizedNames.mockResolvedValue([
      { id: 'emp-gs', normalized_name: 'goldman-sachs', name: 'Goldman Sachs' },
    ]);
    repo.findUsersByEmails.mockResolvedValue([{ id: 'user-me', email: 'me@starcapital.co.id' }]);

    await upsertEphemeralCrmBatch([message], { db: testDb as never });

    expect(executed.filter((q) => q.includes('INSERT INTO employer_topics'))).toHaveLength(0);
    expect(repo.addTeam).toHaveBeenCalledWith([]);
  });

  it('creates a new employer under the LLM company name', async () => {
    repo.findByNormalizedNames.mockResolvedValue([]);
    repo.employerUpsertBatch.mockResolvedValue([
      { id: 'emp-new', normalized_name: 'goldman-sachs' },
    ]);
    await upsertEphemeralCrmBatch([message], { db: db as never });
    expect(repo.employerUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Goldman Sachs', normalized_name: 'goldman-sachs' }),
    ]);
    expect(repo.correspondentUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ employer_id: 'emp-new', email: 'jane@gs.com', name: 'Jane Doe' }),
    ]);
  });

  it('links to an existing employer with that name without upserting (never renames it)', async () => {
    repo.findByNormalizedNames.mockResolvedValue([
      { id: 'emp-existing', normalized_name: 'goldman-sachs', name: 'Goldman Sachs Group' },
    ]);
    await upsertEphemeralCrmBatch([message], { db: db as never });
    expect(repo.employerUpsertBatch).toHaveBeenCalledWith([]);
    expect(repo.correspondentUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ employer_id: 'emp-existing' }),
    ]);
  });

  it('names a new employer by its curated override before the LLM company', async () => {
    repo.findByNormalizedNames.mockResolvedValue([]);
    repo.listOverrides.mockResolvedValue([
      { domain: 'GS.com', employer_name: 'Goldman Sachs (Asia)', excluded: false },
    ]);
    await upsertEphemeralCrmBatch([message], { db: db as never });
    expect(repo.employerUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Goldman Sachs (Asia)' }),
    ]);
  });

  it('falls back to the capitalised domain label when no company is known', async () => {
    repo.findByNormalizedNames.mockResolvedValue([]);
    await upsertEphemeralCrmBatch([{ ...message, llm: { ...message.llm!, people: [] } }], {
      db: db as never,
    });
    expect(repo.employerUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Gs', normalized_name: 'gs' }),
    ]);
  });

  it('writes the notes and roles of the whole batch in one statement per table', async () => {
    const executed: string[] = [];
    const testDb = {
      execute: vi.fn(async (query: unknown) => {
        executed.push(JSON.stringify(query));
        return [];
      }),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(testDb)),
    };
    const withRole = (message_id: string): EphemeralCrmMessage => ({
      ...message,
      message_id,
      llm: {
        ...message.llm!,
        email_note: {
          ...message.llm!.email_note,
          summary: 'Jane is running the sell-side process.',
          counterparty_roles: [
            { address: 'jane@gs.com', label: 'advisory', confidence: 'high', evidence: 'Runs the sale.' },
          ],
        },
      },
    });
    repo.findByNormalizedNames.mockResolvedValue([]);
    await upsertEphemeralCrmBatch([withRole('<a@gs.com>'), withRole('<b@gs.com>')], {
      db: testDb as never,
    });
    expect(executed.filter((s) => s.includes('analytics.email_notes'))).toHaveLength(1);
    expect(executed.filter((s) => s.includes('analytics.email_role_signals'))).toHaveLength(1);
  });
});

describe('upsertEmailNotes', () => {
  it('writes note + role rows in one statement per table', async () => {
    const executedSql: string[] = [];
    const testDb = {
      execute: vi.fn((query: unknown) => {
        executedSql.push(JSON.stringify(query));
        return Promise.resolve([]);
      }),
    };

    await upsertEmailNotes(testDb as never, [
      {
        emailId: '00000000-0000-0000-0000-000000000001',
        note: {
          summary: 'Summary text',
          key_points: ['Point 1'],
          next_step: null,
          next_step_status: 'none',
          sentiment: 'neutral',
          counterparty_roles: [
            {
              address: 'partner@fund.com',
              label: 'funding',
              confidence: 'high',
              evidence: 'Lead equity partner.',
            },
          ],
        },
        model: 'claude-haiku-5-5',
      },
      {
        emailId: '00000000-0000-0000-0000-000000000002',
        note: null,
        model: 'claude-haiku-5-5',
      },
    ]);

    const noteCalls = executedSql.filter((s) => s.includes('analytics.email_notes'));
    const roleCalls = executedSql.filter((s) => s.includes('analytics.email_role_signals'));

    expect(noteCalls).toHaveLength(1);
    expect(roleCalls).toHaveLength(1);
  });

});

