import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CRMService,
  DuplicateEmployerError,
  EmployerNotFoundError,
} from './crmService';

const employerRepo = {
  list: vi.fn(),
  count: vi.fn(),
  findById: vi.fn(),
  findByNormalizedName: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findByIds: vi.fn(),
  countFlagged: vi.fn(),
  listFlagged: vi.fn(),
};

const correspondentRepo = {
  findByEmployerId: vi.fn(),
  findByEmployerIds: vi.fn(),
  findById: vi.fn(),
  findByEmployerAndEmail: vi.fn(),
  findByEmail: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findByIds: vi.fn(),
  countByEmployer: vi.fn(),
};

const noteRepo = {
  findByEmployerId: vi.fn(),
  findById: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const topicRepo = {
  listAll: vi.fn(),
  findByName: vi.fn(),
  findById: vi.fn(),
  findOrCreate: vi.fn(),
  listForEmployer: vi.fn(),
  assignToEmployer: vi.fn(),
  removeFromEmployer: vi.fn(),
  countEmployerTopics: vi.fn(),
  findByIds: vi.fn(),
  setDealRelated: vi.fn(),
};

const emailRepo = {
  findByEmployerId: vi.fn(),
  countByEmployer: vi.fn(),
  insert: vi.fn(),
  insertParticipants: vi.fn(),
  findById: vi.fn(),
  countSince: vi.fn(),
  listParticipants: vi.fn(),
  findByIds: vi.fn(),
  countStaleEmployers: vi.fn(),
};

const teamRepo = {
  listForEmployer: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  setMembers: vi.fn(),
  listAllTeamUsers: vi.fn(),
};

const employerCurationRepo = {
  findByEmployerId: vi.fn(),
  findManyByEmployerIds: vi.fn(),
  upsert: vi.fn(),
  clear: vi.fn(),
};

const correspondentCurationRepo = {
  findByCorrespondentId: vi.fn(),
  findManyByCorrespondentIds: vi.fn(),
  upsert: vi.fn(),
  clear: vi.fn(),
};

const relatedCompanyRepo = {
  listForEmployer: vi.fn().mockResolvedValue([]),
  createManual: vi.fn(),
  deleteManual: vi.fn(),
  findByCompanyId: vi.fn().mockResolvedValue([]),
  rankByRelatedCompanyCount: vi.fn(),
};

const companyRepo = {
  findById: vi.fn(),
};

const workspaceCorrespondentRepo = {
  addMembership: vi.fn(),
  addMemberships: vi.fn(),
  listVisibleCorrespondentIds: vi.fn(),
  isVisible: vi.fn(),
};

const WORKSPACE_ID = 'ws-1';

function makeService(): CRMService {
  return new CRMService(
    employerRepo as never,
    correspondentRepo as never,
    noteRepo as never,
    topicRepo as never,
    emailRepo as never,
    teamRepo as never,
    employerCurationRepo as never,
    correspondentCurationRepo as never,
    relatedCompanyRepo as never,
    companyRepo as never,
    workspaceCorrespondentRepo as never,
    WORKSPACE_ID,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CRMService.listEmployers', () => {
  it('returns aggregated rows and total in parallel', async () => {
    employerRepo.list.mockResolvedValue([{ id: '1', name: 'GS' }]);
    employerRepo.count.mockResolvedValue(1);

    const out = await makeService().listEmployers({ search: 'gs' });

    expect(out).toEqual({ data: [{ id: '1', name: 'GS' }], total: 1 });
    expect(employerRepo.list).toHaveBeenCalledWith({ search: 'gs' }, WORKSPACE_ID);
    expect(employerRepo.count).toHaveBeenCalledWith({ search: 'gs' }, WORKSPACE_ID);
  });
});

describe('CRMService.getBankersByRelatedCompanyCount', () => {
  it('delegates to the repository ranking, scoped to the workspace', async () => {
    const ranked = [
      {
        employerId: 'e1',
        employerName: 'Golden Sacks',
        relatedCompanyCount: 12,
        matchedCompanyCount: 7,
        lastSeenAt: '2026-06-01T00:00:00.000Z',
      },
    ];
    relatedCompanyRepo.rankByRelatedCompanyCount.mockResolvedValue(ranked);

    const out = await makeService().getBankersByRelatedCompanyCount();

    expect(relatedCompanyRepo.rankByRelatedCompanyCount).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(out).toBe(ranked);
  });
});

describe('CRMService.getEmployerDetail', () => {
  it('throws EmployerNotFoundError when the employer is missing', async () => {
    employerRepo.findById.mockResolvedValue(undefined);
    await expect(makeService().getEmployerDetail('x')).rejects.toBeInstanceOf(
      EmployerNotFoundError,
    );
  });

  it('aggregates correspondents, notes, topics, team and primary PIC', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'GS' });
    const primary = { id: 'c1', name: 'James', is_primary: true };
    correspondentRepo.findByEmployerId.mockResolvedValue([
      { id: 'c0', name: 'Sara', is_primary: false },
      primary,
    ]);
    noteRepo.findByEmployerId.mockResolvedValue([{ id: 'n1' }]);
    topicRepo.listForEmployer.mockResolvedValue([{ id: 't1' }]);
    teamRepo.listForEmployer.mockResolvedValue([{ id: 'u1' }]);
    emailRepo.countByEmployer.mockResolvedValue(7);
    emailRepo.findByEmployerId.mockResolvedValue([
      { sent_at: '2026-05-01T00:00:00Z' },
    ]);

    const detail = await makeService().getEmployerDetail('e1');

    expect(detail.primary_pic).toEqual(primary);
    expect(detail.email_count).toBe(7);
    expect(detail.last_contact_at).toBe('2026-05-01T00:00:00Z');
    expect(detail.notes).toHaveLength(1);
    expect(detail.topics).toHaveLength(1);
    expect(detail.team).toHaveLength(1);
  });

  it('collapses auto + manual rows for the same company into one (manual wins, evidence merged)', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'GS' });
    correspondentRepo.findByEmployerId.mockResolvedValue([]);
    noteRepo.findByEmployerId.mockResolvedValue([]);
    topicRepo.listForEmployer.mockResolvedValue([]);
    teamRepo.listForEmployer.mockResolvedValue([]);
    emailRepo.countByEmployer.mockResolvedValue(0);
    emailRepo.findByEmployerId.mockResolvedValue([]);
    relatedCompanyRepo.listForEmployer.mockResolvedValue([
      {
        id: 'rc-auto',
        company_id: 'co-1',
        normalized_company_name: 'techslurry',
        source: 'auto',
        evidence: [{ id: 'ev-1' }],
      },
      {
        id: 'rc-manual',
        company_id: 'co-1',
        normalized_company_name: 'techslurry',
        source: 'manual',
        evidence: [],
      },
    ]);

    const detail = await makeService().getEmployerDetail('e1');

    expect(detail.related_companies).toHaveLength(1);
    expect(detail.related_companies[0].id).toBe('rc-manual'); // manual wins
    expect(detail.related_companies[0].evidence).toHaveLength(1); // auto evidence absorbed
    expect(detail.related_companies[0].evidence_count).toBe(1);
  });
});

describe('CRMService.addRelatedCompanyToEmployer', () => {
  it('links a company from public.companies, snapshotting its target name', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'GS' });
    companyRepo.findById.mockResolvedValue({ id: 'co-1', target: 'TechSlurry Inc.' });
    relatedCompanyRepo.findByCompanyId.mockResolvedValue([]);
    relatedCompanyRepo.listForEmployer.mockResolvedValue([]);

    await makeService().addRelatedCompanyToEmployer('e1', 'co-1');

    expect(relatedCompanyRepo.createManual).toHaveBeenCalledWith(
      expect.objectContaining({
        employer_id: 'e1',
        workspace_id: WORKSPACE_ID,
        company_id: 'co-1',
        company_name: 'TechSlurry Inc.',
        normalized_company_name: 'techslurry', // legal suffix stripped by shared normalizer
      }),
    );
  });

  it('rejects when the company is already linked (auto or manual)', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'GS' });
    companyRepo.findById.mockResolvedValue({ id: 'co-1', target: 'TechSlurry' });
    relatedCompanyRepo.findByCompanyId.mockResolvedValue([{ id: 'rc-auto' }]);

    await expect(
      makeService().addRelatedCompanyToEmployer('e1', 'co-1'),
    ).rejects.toThrow(/already linked/);
    expect(relatedCompanyRepo.createManual).not.toHaveBeenCalled();
  });

  it('throws when the company does not exist', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'GS' });
    companyRepo.findById.mockResolvedValue(undefined);
    await expect(
      makeService().addRelatedCompanyToEmployer('e1', 'missing'),
    ).rejects.toThrow(/not found/);
  });
});

describe('CRMService.removeRelatedCompanyFromEmployer', () => {
  it('delegates to the repo hard-delete, scoped to the workspace', async () => {
    await makeService().removeRelatedCompanyFromEmployer('e1', 'rc-manual');
    expect(relatedCompanyRepo.deleteManual).toHaveBeenCalledWith(
      'e1',
      'rc-manual',
      WORKSPACE_ID,
    );
  });
});

describe('CRMService.createEmployer', () => {
  it('rejects duplicates by normalized name', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue({ id: 'old', name: 'GS' });
    await expect(
      makeService().createEmployer({ name: 'GS' }),
    ).rejects.toBeInstanceOf(DuplicateEmployerError);
    expect(employerRepo.insert).not.toHaveBeenCalled();
  });

  it('normalizes the name before inserting', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue(undefined);
    employerRepo.insert.mockResolvedValue({ id: 'new', name: '  Goldman Sachs  ' });
    await makeService().createEmployer({ name: '  Goldman Sachs  ' });
    expect(employerRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ normalized_name: 'goldman sachs' }),
    );
  });
});

describe('CRMService.createContact', () => {
  it('updates rather than duplicates when (employer, email) already exists', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue({ id: 'c1' });
    correspondentRepo.findById.mockResolvedValue({ id: 'c1', name: 'Updated' });

    await makeService().createContact({
      employerId: 'e1',
      name: 'Updated',
      email: 'a@b.com',
    });

    // Editing an existing contact routes the name change to the overlay, not
    // the base table.
    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      'c1',
      { name: 'Updated' },
      null,
    );
    expect(correspondentRepo.insert).not.toHaveBeenCalled();
  });

  it('throws if no employerId or firmName is provided', async () => {
    await expect(
      makeService().createContact({ name: 'X' }),
    ).rejects.toThrow(/employerId or firmName/);
  });

  it('creates an employer on the fly when only firmName is provided', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue(undefined);
    employerRepo.insert.mockResolvedValue({ id: 'new-emp' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue(undefined);
    correspondentRepo.insert.mockResolvedValue({ id: 'new-c' });

    await makeService().createContact({
      firmName: 'New Firm',
      name: 'John',
      email: 'john@new.com',
    });

    expect(employerRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Firm' }),
    );
    expect(correspondentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ employer_id: 'new-emp', email: 'john@new.com' }),
      WORKSPACE_ID,
    );
  });

  it('grants the creating workspace visibility into a brand-new contact', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue(undefined);
    employerRepo.insert.mockResolvedValue({ id: 'new-emp' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue(undefined);
    correspondentRepo.insert.mockResolvedValue({ id: 'new-c' });

    await makeService().createContact({
      firmName: 'New Firm',
      name: 'John',
      email: 'john@new.com',
    });

    expect(workspaceCorrespondentRepo.addMembership).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'new-c',
      'manual',
    );
  });

  it('grants the creating workspace visibility into a pre-existing (dupe) contact too', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue({ id: 'dupe-c' });
    correspondentRepo.findById.mockResolvedValue({ id: 'dupe-c', name: 'Updated' });

    await makeService().createContact({
      employerId: 'e1',
      name: 'Updated',
      email: 'a@b.com',
    });

    expect(workspaceCorrespondentRepo.addMembership).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'dupe-c',
      'manual',
    );
  });
});

describe('CRMService.addTopicToEmployer', () => {
  it('rejects when the employer already has 20 topics', async () => {
    topicRepo.listForEmployer.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, name: `t${i}` })),
    );
    await expect(
      makeService().addTopicToEmployer('e1', 'new'),
    ).rejects.toThrow(/Maximum/);
  });

  it('rejects duplicates case-insensitively', async () => {
    topicRepo.listForEmployer.mockResolvedValue([
      { id: '1', name: 'CMP slurry' },
    ]);
    await expect(
      makeService().addTopicToEmployer('e1', 'cmp slurry'),
    ).rejects.toThrow(/already/);
  });

  it('returns the refreshed topic list after assigning', async () => {
    topicRepo.listForEmployer
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 't', name: 'NewTopic' }]);
    topicRepo.findOrCreate.mockResolvedValue({ id: 'topic-1' });
    topicRepo.assignToEmployer.mockResolvedValue({ id: 'et1' });

    const out = await makeService().addTopicToEmployer('e1', 'NewTopic');
    expect(topicRepo.assignToEmployer).toHaveBeenCalledWith(
      'e1',
      'topic-1',
      expect.objectContaining({ source: 'manual' }),
    );
    expect(out).toEqual([{ id: 't', name: 'NewTopic' }]);
  });

  it('passes is_deal_related to findOrCreate when adding a manual deal tag', async () => {
    topicRepo.listForEmployer
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 't', name: 'acquisition' }]);
    topicRepo.findOrCreate.mockResolvedValue({ id: 'topic-1' });
    topicRepo.assignToEmployer.mockResolvedValue({ id: 'et1' });

    await makeService().addTopicToEmployer('e1', 'acquisition', {
      is_deal_related: true,
    });
    expect(topicRepo.findOrCreate).toHaveBeenCalledWith(
      'acquisition',
      { is_deal_related: true },
      WORKSPACE_ID,
    );
  });
});

describe('CRMService.reclassifyTopic', () => {
  it('delegates to topicRepo.setDealRelated', async () => {
    await makeService().reclassifyTopic('topic-1', true);
    expect(topicRepo.setDealRelated).toHaveBeenCalledWith('topic-1', true);
  });
});

describe('CRMService.curateEmployer', () => {
  it('publishes on approve; name correction goes to the overlay, not the base merge key', async () => {
    employerRepo.update.mockResolvedValue({ id: 'e1' });
    employerRepo.findById.mockResolvedValue({ id: 'e1', name: 'Goldman Sachs' });
    await makeService().curateEmployer('e1', 'approve', {
      name: 'Goldman Sachs',
    });
    // name → overlay (normalized_name, the merge key, is NOT touched — RFC §4.2)
    expect(employerCurationRepo.upsert).toHaveBeenCalledWith(
      'e1',
      { name: 'Goldman Sachs' },
      null,
    );
    // base gets only the workflow field
    expect(employerRepo.update).toHaveBeenCalledWith('e1', {
      curation_status: 'published',
    });
  });

  it('on skip, just bumps updated_at without changing curation_status', async () => {
    employerRepo.update.mockResolvedValue({ id: 'e1' });
    await makeService().curateEmployer('e1', 'skip');
    expect(employerRepo.update).toHaveBeenCalledWith('e1', {});
  });

  it('on approve with a primary_pic patch, edits the existing primary via the overlay (email stays base)', async () => {
    employerRepo.update.mockResolvedValue({ id: 'e1' });
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmployerId.mockResolvedValue([
      { id: 'c-other', name: 'Other', is_primary: false },
      { id: 'c-primary', name: 'Old', is_primary: true },
    ]);
    correspondentRepo.update.mockResolvedValue({ id: 'c-primary' });
    correspondentRepo.findById.mockResolvedValue({ id: 'c-primary', name: 'New Name' });

    await makeService().curateEmployer('e1', 'approve', {
      primary_pic: { name: 'New Name', title: 'MD', email: null, phone: '+1 555' },
    });

    // name/title/phone → overlay; email (the natural key) → base.
    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      'c-primary',
      { name: 'New Name', title: 'MD', phone: '+1 555' },
      null,
    );
    expect(correspondentRepo.update).toHaveBeenCalledWith(
      'c-primary',
      { email: null },
      WORKSPACE_ID,
    );
    expect(correspondentRepo.insert).not.toHaveBeenCalled();
  });

  it('on approve with no primary, inserts a new primary correspondent when one is given', async () => {
    employerRepo.update.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmployerId.mockResolvedValue([]);
    correspondentRepo.insert.mockResolvedValue({ id: 'c-new' });

    await makeService().curateEmployer('e1', 'approve', {
      primary_pic: { name: 'Brand New', email: 'b@n.com' },
    });

    expect(correspondentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        employer_id: 'e1',
        name: 'Brand New',
        email: 'b@n.com',
        source: 'manual',
      }),
      WORKSPACE_ID,
    );
    expect(workspaceCorrespondentRepo.addMembership).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c-new',
      'manual',
    );
  });

  it('on skip, never touches correspondents even when primary_pic is in the patch', async () => {
    employerRepo.update.mockResolvedValue({ id: 'e1' });
    await makeService().curateEmployer('e1', 'skip', {
      primary_pic: { name: 'Ignored' },
    });
    expect(correspondentRepo.findByEmployerId).not.toHaveBeenCalled();
    expect(correspondentRepo.update).not.toHaveBeenCalled();
    expect(correspondentRepo.insert).not.toHaveBeenCalled();
  });
});

describe('CRMService.listFlaggedEmployerDetails', () => {
  it('returns each flagged employer with its primary correspondent', async () => {
    employerRepo.listFlagged.mockResolvedValue([
      { id: 'e1', name: 'GS', industry: 'IB', status: 'inbound' },
      { id: 'e2', name: 'MS', industry: null, status: 'outbound' },
    ]);
    // Batched: one call returns all flagged employers' correspondents, keyed
    // by employer_id. e2 has none → its primary_pic is null.
    correspondentRepo.findByEmployerIds.mockResolvedValue([
      { id: 'c1', employer_id: 'e1', name: 'James', title: 'MD', email: 'j@gs.com', phone: null, is_primary: true },
    ]);

    const out = await makeService().listFlaggedEmployerDetails();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'e1',
      name: 'GS',
      industry: 'IB',
      primary_pic: { id: 'c1', name: 'James', email: 'j@gs.com' },
    });
    expect(out[1].primary_pic).toBeNull();
  });
});

describe('CRMService.insights', () => {
  it('passes vault context through to the response', async () => {
    emailRepo.countStaleEmployers.mockResolvedValue(2);
    employerRepo.countFlagged.mockResolvedValue(1);
    emailRepo.countSince.mockResolvedValue(7);

    const out = await makeService().insights({
      vaultCustodianCount: 4,
      lastVaultSyncedAt: '2026-05-24T12:00:00.000Z',
      vaultSyncCadenceMs: 24 * 60 * 60 * 1000,
    });

    expect(out).toEqual({
      stale_employers: 2,
      flagged_records: 1,
      emails_today: 7,
      email_accounts: 4,
      last_synced_at: '2026-05-24T12:00:00.000Z',
      next_sync_at: '2026-05-25T12:00:00.000Z',
    });
  });

  it('returns nulls for sync state when no vault context is provided', async () => {
    emailRepo.countStaleEmployers.mockResolvedValue(0);
    employerRepo.countFlagged.mockResolvedValue(0);
    emailRepo.countSince.mockResolvedValue(0);

    const out = await makeService().insights();
    expect(out.email_accounts).toBeNull();
    expect(out.last_synced_at).toBeNull();
    expect(out.next_sync_at).toBeNull();
  });
});

describe('CRMService.ingestEmails', () => {
  it('reuses an existing employer and creates an email + from-participant', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue({ id: 'e1', name: 'Goldman' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue({ id: 'c1' });
    emailRepo.insert.mockResolvedValue({ id: 'em1' });
    emailRepo.insertParticipants.mockResolvedValue([]);

    const out = await makeService().ingestEmails([
      {
        from_email: 'james@goldman.com',
        direction: 'inbound',
        company: 'Goldman',
      },
    ]);

    expect(out).toEqual({ employers_created: 0, emails_added: 1 });
    expect(employerRepo.insert).not.toHaveBeenCalled();
    expect(emailRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ employer_id: 'e1', from_address: 'james@goldman.com' }),
    );
    expect(emailRepo.insertParticipants).toHaveBeenCalledWith([
      expect.objectContaining({ role: 'from', correspondent_id: 'c1' }),
    ]);
    // Existing (dupe) correspondent still gets a membership row for this
    // workspace, so re-ingesting a known contact doesn't leave it invisible.
    // 'direct', not 'ingest' — this path (Vault export / file-extracted
    // communications) has no mailbox/message_id and must stay durable
    // regardless of is_email_synced.
    expect(workspaceCorrespondentRepo.addMembership).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c1',
      'direct',
    );
  });

  it('creates the employer when one is missing', async () => {
    employerRepo.findByNormalizedName.mockResolvedValue(undefined);
    employerRepo.insert.mockResolvedValue({ id: 'new-emp' });
    correspondentRepo.findByEmployerAndEmail.mockResolvedValue(undefined);
    correspondentRepo.insert.mockResolvedValue({ id: 'c1' });
    emailRepo.insert.mockResolvedValue({ id: 'em1' });
    emailRepo.insertParticipants.mockResolvedValue([]);

    const out = await makeService().ingestEmails([
      {
        from_email: 'x@morgan.com',
        direction: 'inbound',
        company: 'Morgan Stanley',
      },
    ]);

    expect(out.employers_created).toBe(1);
    expect(employerRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Morgan Stanley' }),
    );
  });
});
