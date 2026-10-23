import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CRMService,
  CorrespondentNotFoundError,
  DuplicateEmployerError,
  EmployerNoteNotFoundError,
  EmployerNotFoundError,
  InvalidTeamMemberError,
  pickEditableContactFields,
} from './crmService';

const employerRepo = {
  list: vi.fn(),
  count: vi.fn(),
  findById: vi.fn(),
  findByNormalizedName: vi.fn(),
  findByNormalizedNames: vi.fn(),
  upsertBatch: vi.fn(),
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
  findByEmails: vi.fn(),
  searchInEmployers: vi.fn(),
  insertMany: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findByIds: vi.fn(),
  countByEmployer: vi.fn(),
};

const noteRepo = {
  findByEmployerId: vi.fn(),
  findById: vi.fn(),
  createWithRevision: vi.fn(),
  editWithRevision: vi.fn(),
  softDeleteWithRevision: vi.fn(),
  listRevisions: vi.fn(),
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
  listWorkspaceMembers: vi.fn(),
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
  fillMany: vi.fn(),
  clear: vi.fn(),
};

const relatedCompanyRepo = {
  listForEmployer: vi.fn().mockResolvedValue([]),
  createManual: vi.fn(),
  deleteManual: vi.fn(),
  dismissAuto: vi.fn(),
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
  removeMembership: vi.fn(),
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
    correspondentRepo.searchInEmployers.mockResolvedValue([]);

    const out = await makeService().listEmployers({ search: 'gs' });

    expect(out).toEqual({
      data: [{ id: '1', name: 'GS', matched_contacts: [] }],
      total: 1,
    });
    expect(employerRepo.list).toHaveBeenCalledWith({ search: 'gs' }, WORKSPACE_ID);
    expect(employerRepo.count).toHaveBeenCalledWith({ search: 'gs' }, WORKSPACE_ID);
  });
});

describe('CRMService.listEmployers (person search)', () => {
  it('attaches each firm\'s matching contacts from one batched lookup', async () => {
    employerRepo.list.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    employerRepo.count.mockResolvedValue(2);
    correspondentRepo.searchInEmployers.mockResolvedValue([
      { id: 'c1', employer_id: 'e1', name: 'Jane A' },
      { id: 'c2', employer_id: 'e1', name: 'Jane B' },
    ]);

    const out = await makeService().listEmployers({ search: ' jane ' });

    expect(correspondentRepo.searchInEmployers).toHaveBeenCalledTimes(1);
    expect(correspondentRepo.searchInEmployers).toHaveBeenCalledWith(
      ['e1', 'e2'],
      'jane',
      WORKSPACE_ID,
    );
    expect(out.data).toEqual([
      {
        id: 'e1',
        matched_contacts: [
          { id: 'c1', employer_id: 'e1', name: 'Jane A' },
          { id: 'c2', employer_id: 'e1', name: 'Jane B' },
        ],
      },
      // Matched on its own name/domain — no people to narrow to.
      { id: 'e2', matched_contacts: [] },
    ]);
  });

  it('skips the contact lookup when there is no search', async () => {
    employerRepo.list.mockResolvedValue([{ id: 'e1' }]);
    employerRepo.count.mockResolvedValue(1);

    const out = await makeService().listEmployers({});

    expect(correspondentRepo.searchInEmployers).not.toHaveBeenCalled();
    expect(out.data).toEqual([{ id: 'e1' }]);
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
  it('hard-deletes a manual link and dismisses an auto one, both scoped to the workspace', async () => {
    await makeService().removeRelatedCompanyFromEmployer('e1', 'rc-1');
    // Each repo call is guarded to its own source, so exactly one of them
    // touches a given row.
    expect(relatedCompanyRepo.deleteManual).toHaveBeenCalledWith('e1', 'rc-1', WORKSPACE_ID);
    expect(relatedCompanyRepo.dismissAuto).toHaveBeenCalledWith('e1', 'rc-1', WORKSPACE_ID);
  });
});

describe('CRMService.deleteContact', () => {
  it('unlinks the contact from this workspace and never deletes the shared row', async () => {
    workspaceCorrespondentRepo.removeMembership.mockResolvedValue(true);
    await makeService().deleteContact('c1');
    expect(workspaceCorrespondentRepo.removeMembership).toHaveBeenCalledWith(WORKSPACE_ID, 'c1');
    expect(correspondentRepo.delete).not.toHaveBeenCalled();
  });

  it('throws CorrespondentNotFoundError when the contact is not visible here', async () => {
    workspaceCorrespondentRepo.removeMembership.mockResolvedValue(false);
    await expect(makeService().deleteContact('c1')).rejects.toBeInstanceOf(
      CorrespondentNotFoundError,
    );
  });
});

describe('CRMService notes', () => {
  it('addNote stamps the workspace and the signed-in author, and writes through the audited path', async () => {
    noteRepo.createWithRevision.mockResolvedValue({ id: 'n1' });
    await makeService().addNote({ employer_id: 'e1', content: 'Met at conf', userId: 'u1' });
    expect(noteRepo.createWithRevision).toHaveBeenCalledWith({
      employer_id: 'e1',
      workspace_id: WORKSPACE_ID,
      content: 'Met at conf',
      author_user_id: 'u1',
    });
  });

  it('updateNote edits through the audited path with the editor', async () => {
    noteRepo.editWithRevision.mockResolvedValue({ id: 'n1', content: 'new' });
    const row = await makeService().updateNote('n1', 'new', 'u2');
    expect(noteRepo.editWithRevision).toHaveBeenCalledWith('n1', WORKSPACE_ID, 'new', 'u2');
    expect(row).toEqual({ id: 'n1', content: 'new' });
  });

  it('updateNote throws EmployerNoteNotFoundError for a missing or deleted note', async () => {
    noteRepo.editWithRevision.mockResolvedValue(undefined);
    await expect(makeService().updateNote('n1', 'x', 'u2')).rejects.toBeInstanceOf(
      EmployerNoteNotFoundError,
    );
  });

  it('deleteNote soft-deletes through the audited path', async () => {
    noteRepo.softDeleteWithRevision.mockResolvedValue(true);
    await makeService().deleteNote('n1', 'u3');
    expect(noteRepo.softDeleteWithRevision).toHaveBeenCalledWith('n1', WORKSPACE_ID, 'u3');
  });

  it('deleteNote throws EmployerNoteNotFoundError when nothing was deleted', async () => {
    noteRepo.softDeleteWithRevision.mockResolvedValue(false);
    await expect(makeService().deleteNote('n1', 'u3')).rejects.toBeInstanceOf(
      EmployerNoteNotFoundError,
    );
  });

  it('listNoteRevisions reads the trail scoped to the workspace', async () => {
    noteRepo.listRevisions.mockResolvedValue([{ id: 'r1', action: 'create' }]);
    expect(await makeService().listNoteRevisions('n1')).toEqual([{ id: 'r1', action: 'create' }]);
    expect(noteRepo.listRevisions).toHaveBeenCalledWith('n1', WORKSPACE_ID);
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
    correspondentRepo.findByEmails.mockResolvedValue([{ id: 'c1', email: 'a@b.com', employer_id: 'e1' }]);
    correspondentRepo.findById.mockResolvedValue({ id: 'c1', name: 'Updated' });

    await makeService().createContact({
      employerId: 'e1',
      name: 'Updated',
      email: 'a@b.com',
    });

    // Editing an existing contact routes the name change to the overlay, not
    // the base table.
    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
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
    correspondentRepo.findByEmails.mockResolvedValue([]);
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
    correspondentRepo.findByEmails.mockResolvedValue([]);
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
    correspondentRepo.findByEmails.mockResolvedValue([{ id: 'dupe-c', email: 'a@b.com', employer_id: 'e1' }]);
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

describe('CRMService.createContact (profile fields)', () => {
  it('writes the banker profile fields onto a brand-new contact row', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmails.mockResolvedValue([]);
    correspondentRepo.insert.mockResolvedValue({ id: 'c-new' });

    await makeService().createContact({
      employerId: 'e1',
      name: 'Jane Banker',
      email: 'jane@bank.com',
      department: 'M&A',
      specialization: 'Semiconductors',
      seniority: 'Managing Director',
      coverageRegion: 'Asia Pacific',
      linkedinUrl: 'https://linkedin.com/in/jane',
      bio: 'Covers our semi mandates.',
    });

    expect(correspondentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        department: 'M&A',
        specialization: 'Semiconductors',
        seniority: 'Managing Director',
        coverage_region: 'Asia Pacific',
        linkedin_url: 'https://linkedin.com/in/jane',
        bio: 'Covers our semi mandates.',
      }),
      WORKSPACE_ID,
    );
  });

  it('routes profile fields of a duplicate (employer, email) to the overlay', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmails.mockResolvedValue([{ id: 'c1', email: 'jane@bank.com', employer_id: 'e1' }]);
    correspondentRepo.findById.mockResolvedValue({ id: 'c1' });

    await makeService().createContact({
      employerId: 'e1',
      name: 'Jane Banker',
      email: 'jane@bank.com',
      department: 'ECM',
      seniority: 'Director',
    });

    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c1',
      { name: 'Jane Banker', department: 'ECM', seniority: 'Director' },
      null,
    );
    expect(correspondentRepo.insert).not.toHaveBeenCalled();
  });
});

describe('CRMService.updateContact', () => {
  it('routes every profile field to the curation overlay, not the base table', async () => {
    correspondentRepo.findById.mockResolvedValue({ id: 'c1' });

    await makeService().updateContact('c1', {
      name: 'Jane B.',
      title: 'MD, TMT',
      phone: '+65 1234',
      type: 'external',
      department: 'M&A',
      specialization: 'Semis',
      seniority: 'Managing Director',
      coverage_region: 'SEA',
      linkedin_url: 'https://linkedin.com/in/jane',
      bio: 'Ex-Lazard.',
    });

    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c1',
      {
        name: 'Jane B.',
        title: 'MD, TMT',
        phone: '+65 1234',
        type: 'external',
        department: 'M&A',
        specialization: 'Semis',
        seniority: 'Managing Director',
        coverage_region: 'SEA',
        linkedin_url: 'https://linkedin.com/in/jane',
        bio: 'Ex-Lazard.',
      },
      null,
    );
    expect(correspondentRepo.update).not.toHaveBeenCalled();
  });

  it('clears an overlay field when it is explicitly set to null', async () => {
    correspondentRepo.findById.mockResolvedValue({ id: 'c1' });

    await makeService().updateContact('c1', { department: null });

    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c1',
      { department: null },
      null,
    );
  });

  it('keeps email on the base table and stamps the editor', async () => {
    correspondentRepo.update.mockResolvedValue({ id: 'c1' });
    correspondentRepo.findById.mockResolvedValue({ id: 'c1' });

    await makeService().updateContact('c1', {
      email: 'new@bank.com',
      department: 'DCM',
      last_edited_by_user_id: 'u-1',
    });

    expect(correspondentRepo.update).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        email: 'new@bank.com',
        last_edited_by_user_id: 'u-1',
        last_edited_at: expect.any(String),
      }),
      WORKSPACE_ID,
    );
    // department must NOT leak onto the base row.
    expect(correspondentRepo.update.mock.calls[0][1]).not.toHaveProperty(
      'department',
    );
    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c1',
      { department: 'DCM' },
      'u-1',
    );
  });

  it('skips the overlay write entirely when no overlay field is present', async () => {
    correspondentRepo.update.mockResolvedValue({ id: 'c1' });
    correspondentRepo.findById.mockResolvedValue({ id: 'c1' });

    await makeService().updateContact('c1', { email: 'only@mail.com' });

    expect(correspondentCurationRepo.upsert).not.toHaveBeenCalled();
  });

  it('throws when the correspondent is not visible to this workspace', async () => {
    correspondentRepo.findById.mockResolvedValue(undefined);

    await expect(
      makeService().updateContact('c1', { department: 'M&A' }),
    ).rejects.toThrow(/Correspondent c1 not found/);
  });
});

describe('pickEditableContactFields', () => {
  it('drops machine-owned columns a client might smuggle into the body', () => {
    expect(
      pickEditableContactFields({
        name: 'Jane',
        department: 'M&A',
        employer_id: 'other-employer',
        origin: 'auto',
        source: 'ingest',
        is_primary: true,
        id: 'c-other',
      }),
    ).toEqual({ name: 'Jane', department: 'M&A' });
  });

  it('trims values and turns a blank string into null so the field clears', () => {
    expect(
      pickEditableContactFields({ department: '  M&A  ', title: '   ' }),
    ).toEqual({ department: 'M&A', title: null });
  });

  it('drops the bio: it is the AI-generated profile and not editable by hand', () => {
    expect(
      pickEditableContactFields({ department: 'M&A', bio: 'Hand-written bio' }),
    ).toEqual({ department: 'M&A' });
    expect(pickEditableContactFields({ bio: null })).toEqual({});
  });

  it('passes an explicit null through and omits absent fields', () => {
    expect(pickEditableContactFields({ seniority: null })).toEqual({
      seniority: null,
    });
  });

  it('ignores non-string values rather than writing them', () => {
    expect(pickEditableContactFields({ department: 42, title: { a: 1 } })).toEqual(
      {},
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
      WORKSPACE_ID,
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
      WORKSPACE_ID,
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
      WORKSPACE_ID,
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
    correspondentRepo.findByEmails.mockResolvedValue([{ id: 'c1', email: 'james@goldman.com', employer_id: 'e1' }]);
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
    correspondentRepo.findByEmails.mockResolvedValue([]);
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

describe('CRMService.createContact (email join key)', () => {
  it('merges into a contact ingested under a different employer, matching email case-insensitively', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e-manual' });
    correspondentRepo.findByEmails.mockResolvedValue([
      { id: 'c-ingested', email: 'jane@bank.com', employer_id: 'e-domain' },
    ]);
    correspondentRepo.findById.mockResolvedValue({ id: 'c-ingested' });

    const out = await makeService().createContact({
      employerId: 'e-manual',
      name: 'Jane Banker',
      email: '  Jane@Bank.COM ',
    });

    expect(correspondentRepo.findByEmails).toHaveBeenCalledWith(['jane@bank.com']);
    expect(correspondentRepo.insert).not.toHaveBeenCalled();
    expect(correspondentCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c-ingested',
      { name: 'Jane Banker' },
      null,
    );
    expect(out).toEqual({ id: 'c-ingested' });
  });

  it('prefers the match already under the chosen employer when one email has several rows', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmails.mockResolvedValue([
      { id: 'c-other', email: 'a@b.com', employer_id: 'e2' },
      { id: 'c-here', email: 'a@b.com', employer_id: 'e1' },
    ]);
    correspondentRepo.findById.mockResolvedValue({ id: 'c-here' });

    await makeService().createContact({ employerId: 'e1', name: 'A', email: 'a@b.com' });

    expect(workspaceCorrespondentRepo.addMembership).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'c-here',
      'manual',
    );
  });

  it('stores a new contact\'s email lowercased so later ingests join on it', async () => {
    employerRepo.findById.mockResolvedValue({ id: 'e1' });
    correspondentRepo.findByEmails.mockResolvedValue([]);
    correspondentRepo.insert.mockResolvedValue({ id: 'c-new' });

    await makeService().createContact({ employerId: 'e1', name: 'A', email: 'A@B.com' });

    expect(correspondentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', origin: 'manual' }),
      WORKSPACE_ID,
    );
  });
});

describe('CRMService.importContacts', () => {
  beforeEach(() => {
    correspondentRepo.findByEmails.mockResolvedValue([]);
    employerRepo.findByNormalizedNames.mockResolvedValue([]);
    employerRepo.upsertBatch.mockResolvedValue([]);
    correspondentRepo.insertMany.mockResolvedValue([]);
  });

  it('merges a row whose email already exists into that contact via the overlay, without inserting', async () => {
    correspondentRepo.findByEmails.mockResolvedValue([
      { id: 'c1', email: 'jane@bank.com', employer_id: 'e-domain' },
    ]);

    const out = await makeService().importContacts(
      [{ name: 'Jane Banker', firm: 'Some Bank', email: 'Jane@Bank.com', title: 'MD' }],
      'u1',
    );

    expect(out).toEqual({ created: 0, merged: 1, skipped: 0, errors: [] });
    expect(correspondentCurationRepo.fillMany).toHaveBeenCalledWith(
      WORKSPACE_ID,
      [{ correspondentId: 'c1', edit: { name: 'Jane Banker', title: 'MD' } }],
      'u1',
    );
    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([]);
    expect(workspaceCorrespondentRepo.addMemberships).toHaveBeenCalledWith([
      { workspaceId: WORKSPACE_ID, correspondentId: 'c1', source: 'manual' },
    ]);
  });

  it('creates new manual contacts, reusing existing employers and batch-creating missing ones', async () => {
    employerRepo.findByNormalizedNames.mockResolvedValue([
      { id: 'e-gs', normalized_name: 'goldman sachs' },
    ]);
    employerRepo.upsertBatch.mockResolvedValue([
      { id: 'e-new', normalized_name: 'new firm' },
    ]);
    correspondentRepo.insertMany.mockResolvedValue([
      { id: 'c-a', email: 'a@gs.com' },
      { id: 'c-b', email: null },
    ]);

    const out = await makeService().importContacts([
      { name: 'A', firm: 'Goldman  Sachs', email: 'a@gs.com' },
      { name: 'B', firm: 'New Firm' },
    ]);

    expect(employerRepo.findByNormalizedNames).toHaveBeenCalledTimes(1);
    expect(employerRepo.findByNormalizedNames.mock.calls[0][0].sort()).toEqual([
      'goldman sachs',
      'new firm',
    ]);
    expect(employerRepo.upsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'New Firm', normalized_name: 'new firm' }),
    ]);
    const inserted = correspondentRepo.insertMany.mock.calls[0][0];
    expect(inserted).toHaveLength(2);
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employer_id: 'e-gs', email: 'a@gs.com', origin: 'manual', source: 'manual' }),
        expect.objectContaining({ employer_id: 'e-new', name: 'B', origin: 'manual' }),
      ]),
    );
    expect(out).toMatchObject({ created: 2, merged: 0, skipped: 0 });
  });

  it('collapses repeated emails within one file and counts the repeats as skipped', async () => {
    correspondentRepo.insertMany.mockResolvedValue([{ id: 'c1', email: 'a@x.com' }]);
    employerRepo.findByNormalizedNames.mockResolvedValue([
      { id: 'e1', normalized_name: 'x' },
    ]);

    const out = await makeService().importContacts([
      { name: 'A', firm: 'X', email: 'a@x.com', phone: '1' },
      { name: 'A Again', email: 'A@X.com', title: 'VP' },
    ]);

    expect(correspondentRepo.findByEmails).toHaveBeenCalledWith(['a@x.com']);
    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'A Again', phone: '1', title: 'VP', employer_id: 'e1' }),
    ]);
    expect(out).toMatchObject({ created: 1, skipped: 1 });
  });

  it('falls back to the email domain as the firm, and skips rows with neither firm nor email', async () => {
    employerRepo.upsertBatch.mockResolvedValue([
      { id: 'e-dom', normalized_name: 'morganstanley' },
    ]);
    correspondentRepo.insertMany.mockResolvedValue([{ id: 'c1', email: 'x@morganstanley.com' }]);

    const out = await makeService().importContacts([
      { name: 'X', email: 'x@morganstanley.com' },
      { name: 'Nobody' },
    ]);

    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ employer_id: 'e-dom' }),
    ]);
    expect(out.skipped).toBe(1);
    expect(out.errors).toEqual(['Nobody: no firm or email to file it under.']);
  });
});

describe('CRMService.addContactsToEmployer', () => {
  beforeEach(() => {
    correspondentRepo.findByEmployerId.mockResolvedValue([]);
    correspondentRepo.findByEmails.mockResolvedValue([]);
    correspondentCurationRepo.findManyByCorrespondentIds.mockResolvedValue([]);
    correspondentRepo.insertMany.mockImplementation(async (rows: Array<{ name: string }>) =>
      rows.map((r, i) => ({ id: `new-${i}`, ...r })),
    );
  });

  it('inserts new people under the employer as manual contacts with the given source', async () => {
    const out = await makeService().addContactsToEmployer(
      'emp-1',
      [{ name: 'Jane Doe', title: 'CEO', email: 'Jane@Acme.co.id' }],
      { source: 'crm_contact', editedBy: 'u1' },
    );

    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        employer_id: 'emp-1',
        name: 'Jane Doe',
        email: 'jane@acme.co.id',
        title: 'CEO',
        origin: 'manual',
        source: 'crm_contact',
        last_edited_by_user_id: 'u1',
      }),
    ]);
    expect(out.createdIds).toEqual(['new-0']);
    expect(workspaceCorrespondentRepo.addMemberships).toHaveBeenCalledWith([
      { workspaceId: WORKSPACE_ID, correspondentId: 'new-0', source: 'manual' },
    ]);
  });

  it("judges an email match's empty fields by this workspace's curation, so a colleague's edit is never overwritten", async () => {
    // The shared row has no title, but this workspace curated one.
    correspondentRepo.findByEmails.mockResolvedValue([
      { id: 'c9', employer_id: 'emp-1', name: 'Jane Doe', email: 'jane@acme.co.id', title: null, phone: null, origin: 'auto' },
    ]);
    correspondentCurationRepo.findManyByCorrespondentIds.mockResolvedValue([
      { correspondent_id: 'c9', title: 'Managing Director', phone: null },
    ]);

    await makeService().addContactsToEmployer('emp-1', [
      { name: 'Jane Doe', email: 'jane@acme.co.id', title: 'CEO', phone: '+62 21 1234' },
    ]);

    expect(correspondentCurationRepo.findManyByCorrespondentIds).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ['c9'],
    );
    // Title stays the curated one; only the genuinely empty phone is filled.
    expect(correspondentCurationRepo.fillMany).toHaveBeenCalledWith(
      WORKSPACE_ID,
      [{ correspondentId: 'c9', edit: { phone: '+62 21 1234' } }],
      null,
    );
  });

  it('merges by name within the employer, filling only empty fields and never the name', async () => {
    correspondentRepo.findByEmployerId.mockResolvedValue([
      { id: 'c1', name: 'Jane  Doe', title: 'Chief Executive', linkedin_url: null, email: null },
    ]);

    const out = await makeService().addContactsToEmployer('emp-1', [
      { name: 'jane doe', title: 'CEO', linkedinUrl: 'https://linkedin.com/in/jane' },
    ]);

    expect(correspondentCurationRepo.fillMany).toHaveBeenCalledWith(
      WORKSPACE_ID,
      [{ correspondentId: 'c1', edit: { linkedin_url: 'https://linkedin.com/in/jane' } }],
      null,
    );
    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([]);
    expect(out.merged.map((c) => c.id)).toEqual(['c1']);
  });

  it('merges by email across employers before falling back to name', async () => {
    correspondentRepo.findByEmails.mockResolvedValue([
      { id: 'c-mail', name: 'J. Doe', email: 'jane@acme.co.id', employer_id: 'emp-other', title: null },
    ]);

    await makeService().addContactsToEmployer('emp-1', [
      { name: 'Jane Doe', email: 'jane@acme.co.id', title: 'CEO' },
    ]);

    expect(correspondentCurationRepo.fillMany).toHaveBeenCalledWith(
      WORKSPACE_ID,
      [{ correspondentId: 'c-mail', edit: { title: 'CEO' } }],
      null,
    );
    expect(correspondentRepo.insertMany).toHaveBeenCalledWith([]);
  });

  it('drops a person repeated within the batch', async () => {
    await makeService().addContactsToEmployer('emp-1', [
      { name: 'Jane Doe', title: 'CEO' },
      { name: 'JANE DOE', title: 'President' },
    ]);

    expect(correspondentRepo.insertMany.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('CRMService.setPrimaryContact', () => {
  it("records this workspace's PIC pick after checking the contact is visible and at this firm", async () => {
    correspondentRepo.findById.mockResolvedValue({ id: 'c2', employer_id: 'e1' });
    await makeService().setPrimaryContact('e1', 'c2', 'u1');
    expect(correspondentRepo.findById).toHaveBeenCalledWith('c2', WORKSPACE_ID);
    expect(employerCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'e1',
      { primary_correspondent_id: 'c2' },
      'u1',
    );
  });

  it('refuses a contact that works at another firm', async () => {
    correspondentRepo.findById.mockResolvedValue({ id: 'c2', employer_id: 'other' });
    await expect(makeService().setPrimaryContact('e1', 'c2', 'u1')).rejects.toBeInstanceOf(
      CorrespondentNotFoundError,
    );
    expect(employerCurationRepo.upsert).not.toHaveBeenCalled();
  });

  it('refuses a contact this workspace cannot see', async () => {
    correspondentRepo.findById.mockResolvedValue(undefined);
    await expect(makeService().setPrimaryContact('e1', 'c2', 'u1')).rejects.toBeInstanceOf(
      CorrespondentNotFoundError,
    );
  });

  it('clears the pick (back to the oldest contact) without a lookup', async () => {
    await makeService().setPrimaryContact('e1', null, 'u1');
    expect(correspondentRepo.findById).not.toHaveBeenCalled();
    expect(employerCurationRepo.upsert).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'e1',
      { primary_correspondent_id: null },
      'u1',
    );
  });
});

describe('CRMService.setTeam', () => {
  it("replaces this workspace's coverage with members of this workspace", async () => {
    teamRepo.listWorkspaceMembers.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    teamRepo.listForEmployer.mockResolvedValue([{ id: 'u1' }]);
    await makeService().setTeam('e1', ['u1', 'u1']);
    expect(teamRepo.setMembers).toHaveBeenCalledWith(WORKSPACE_ID, 'e1', ['u1']);
  });

  it('keeps someone already on the team even if they are no longer a member', async () => {
    teamRepo.listWorkspaceMembers.mockResolvedValue([{ id: 'u1' }]);
    teamRepo.listForEmployer.mockResolvedValue([{ id: 'ex-member' }]);
    await makeService().setTeam('e1', ['u1', 'ex-member']);
    expect(teamRepo.setMembers).toHaveBeenCalledWith(WORKSPACE_ID, 'e1', ['u1', 'ex-member']);
  });

  it('rejects someone who is not a member of this workspace and writes nothing', async () => {
    teamRepo.listForEmployer.mockResolvedValue([]);
    teamRepo.listWorkspaceMembers.mockResolvedValue([{ id: 'u1' }]);
    await expect(makeService().setTeam('e1', ['u1', 'stranger'])).rejects.toBeInstanceOf(
      InvalidTeamMemberError,
    );
    expect(teamRepo.setMembers).not.toHaveBeenCalled();
  });

  it('clears the team without a membership lookup', async () => {
    teamRepo.listForEmployer.mockResolvedValue([]);
    await makeService().setTeam('e1', []);
    expect(teamRepo.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(teamRepo.setMembers).toHaveBeenCalledWith(WORKSPACE_ID, 'e1', []);
  });
});
