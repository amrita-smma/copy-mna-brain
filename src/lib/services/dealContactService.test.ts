import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DealCompanyNotFoundError,
  DealContactLinkNotFoundError,
  DealContactService,
  EMAIL_MENTION_LINK_LIMIT,
  InvalidDealContactRoleError,
  InvalidEmailMentionSinceError,
  SMART_FILE_LINK_RECONCILE_LIMIT,
} from './dealContactService';
import { ContactNotFoundError } from './crmContactEnrichmentService';
import { INTERNAL_MAIL_DOMAINS } from '@/lib/crm/mailDomains';

const mocks = vi.hoisted(() => ({
  listForContacts: vi.fn(),
  upsertLink: vi.fn(),
  setStatus: vi.fn(),
  insertFileSourceLinks: vi.fn(),
  insertEmailMentionLinks: vi.fn(),
  findContact: vi.fn(),
  findCompany: vi.fn(),
  listStages: vi.fn(),
}));

class MockDealContactRepo {
  listForContacts = mocks.listForContacts;
  upsertLink = mocks.upsertLink;
  setStatus = mocks.setStatus;
  insertFileSourceLinks = mocks.insertFileSourceLinks;
  insertEmailMentionLinks = mocks.insertEmailMentionLinks;
}
class MockCorrespondentRepo {
  findById = mocks.findContact;
}
class MockCompanyRepo {
  findByIdOrNull = mocks.findCompany;
}
class MockStageRepo {
  list = mocks.listStages;
}

const CONTACT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';

function makeService() {
  return new DealContactService(
    new MockDealContactRepo() as never,
    new MockCorrespondentRepo() as never,
    new MockCompanyRepo() as never,
    new MockStageRepo() as never,
    'w1',
  );
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    workspace_id: 'w1',
    company_id: COMPANY,
    correspondent_id: CONTACT,
    role: 'involved',
    origin: 'manual',
    status: 'active',
    evidence_message_id: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    workspaceId: 'w1',
    companyId: COMPANY,
    correspondentId: CONTACT,
    role: 'involved',
    origin: 'email_attachment',
    status: 'active',
    evidenceMessageId: null,
    createdBy: null,
    createdAt: '2026-10-01 00:00:00+00',
    updatedAt: '2026-10-01 00:00:00+00',
    companyName: 'Acme',
    pipelineStage: 'L0',
    companyStatus: 'active',
    droppedAt: null,
    companyCreatedAt: '2026-09-03 00:00:00+00',
    geography: 'Indonesia',
    segment: 'Fintech &amp; Payments',
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findContact.mockResolvedValue({ id: CONTACT, email: 'jimmy@bank.example' });
  mocks.findCompany.mockResolvedValue({ id: COMPANY });
  mocks.listForContacts.mockResolvedValue([]);
  mocks.insertFileSourceLinks.mockResolvedValue([]);
  mocks.insertEmailMentionLinks.mockResolvedValue([]);
  mocks.listStages.mockResolvedValue([
    { key: 'L0', code: 'L0', name: 'Screening', description: '', position: 0, deleted_at: null },
    { key: 'L1', code: 'L1', name: 'Initial Review', description: '', position: 1, deleted_at: null },
    { key: 'L3', code: 'L3', name: 'Due Diligence', description: '', position: 3, deleted_at: null },
  ]);
});

describe('DealContactService.listContactDeals', () => {
  it('throws ContactNotFoundError when the contact is not visible in the workspace', async () => {
    mocks.findContact.mockResolvedValueOnce(undefined);
    await expect(makeService().listContactDeals(CONTACT)).rejects.toBeInstanceOf(
      ContactNotFoundError,
    );
    expect(mocks.listForContacts).not.toHaveBeenCalled();
  });

  it('treats a non-uuid id as an unknown contact without querying', async () => {
    await expect(makeService().listContactDeals('nope')).rejects.toBeInstanceOf(
      ContactNotFoundError,
    );
    expect(mocks.findContact).not.toHaveBeenCalled();
  });

  it('resolves pending Smart Files links for the contact before reading', async () => {
    await makeService().listContactDeals(CONTACT);

    expect(mocks.insertFileSourceLinks).toHaveBeenCalledWith('w1', {
      correspondentIds: [CONTACT],
      excludedSenderDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: SMART_FILE_LINK_RECONCILE_LIMIT,
    });
    expect(mocks.insertFileSourceLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listForContacts.mock.invocationCallOrder[0],
    );
  });

  it('writes the contact\'s email-mention links before reading', async () => {
    await makeService().listContactDeals(CONTACT);

    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledWith('w1', {
      correspondentIds: [CONTACT],
      excludedDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: EMAIL_MENTION_LINK_LIMIT,
    });
    expect(mocks.insertEmailMentionLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listForContacts.mock.invocationCallOrder[0],
    );
  });

  it('still links email mentions and answers when the Smart Files reconcile fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.insertFileSourceLinks.mockRejectedValueOnce(new Error('boom'));

    await makeService().listContactDeals(CONTACT);

    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('logs an email-mention linking failure and still answers', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.insertEmailMentionLinks.mockRejectedValueOnce(new Error('boom'));
    mocks.listForContacts.mockResolvedValueOnce([linkRow({ origin: 'auto_email' })]);

    const result = await makeService().listContactDeals(CONTACT);

    expect(result).toEqual({ deals: [expect.objectContaining({ origin: 'auto_email' })] });
    expect(errSpy).toHaveBeenCalledWith(
      '[dealContactService] email-mention link failed:',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('still answers when the reconcile fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.insertFileSourceLinks.mockRejectedValueOnce(new Error('boom'));
    mocks.listForContacts.mockResolvedValueOnce([linkRow()]);

    const result = await makeService().listContactDeals(CONTACT);

    expect(result.deals).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('skips the visibility read for a contact the caller has already found', async () => {
    mocks.listForContacts.mockResolvedValueOnce([linkRow()]);

    const result = await makeService().listDealsOfVisibleContact(CONTACT);

    expect(mocks.findContact).not.toHaveBeenCalled();
    expect(mocks.insertFileSourceLinks).toHaveBeenCalledTimes(1);
    expect(result.deals).toHaveLength(1);
  });

  it('returns active links only, source first, with stage labels and the dropped flag', async () => {
    mocks.listForContacts.mockResolvedValueOnce([
      linkRow({ companyId: 'a', companyName: 'Alpha', role: 'involved', pipelineStage: 'L1' }),
      linkRow({ companyId: 'b', companyName: 'Bravo', role: 'source', pipelineStage: 'L3' }),
      linkRow({ companyId: 'c', companyName: 'Charlie', status: 'dismissed' }),
      linkRow({
        companyId: 'd',
        companyName: 'Delta',
        role: 'source',
        pipelineStage: 'unreviewed',
        companyStatus: 'dropped',
      }),
    ]);

    const { deals } = await makeService().listContactDeals(CONTACT);

    expect(deals.map((d) => [d.companyId, d.role, d.stageLabel, d.isDropped])).toEqual([
      ['b', 'source', 'L3 · Due Diligence', false],
      ['d', 'source', 'Pending Confirmation', true],
      ['a', 'involved', 'L1 · Initial Review', false],
    ]);
    expect(deals[0]).toEqual({
      companyId: 'b',
      companyName: 'Bravo',
      role: 'source',
      origin: 'email_attachment',
      stage: 'L3',
      stageLabel: 'L3 · Due Diligence',
      isDropped: false,
      linkedAt: '2026-10-01T00:00:00.000Z',
      geography: 'Indonesia',
      segment: 'Fintech & Payments',
      openedAt: '2026-09-03T00:00:00.000Z',
    });
  });

  it('gives null geography, segment and opened date when the company has none', async () => {
    mocks.listForContacts.mockResolvedValueOnce([
      linkRow({ geography: '  ', segment: null, companyCreatedAt: null }),
    ]);

    const { deals } = await makeService().listContactDeals(CONTACT);

    expect(deals[0]).toMatchObject({ geography: null, segment: null, openedAt: null });
  });

  it('decodes HTML entities in deal names, and sorts on the decoded name', async () => {
    mocks.listForContacts.mockResolvedValueOnce([
      // Raw, '&#90;ulu' would sort first; decoded, 'Zulu' sorts last.
      linkRow({ companyId: 'z', companyName: '&#90;ulu', role: 'source' }),
      linkRow({ companyId: 'b', companyName: 'Beta', role: 'source' }),
      linkRow({ companyId: 's', companyName: 'Smith &amp;amp; Co', role: 'source' }),
    ]);

    const { deals } = await makeService().listContactDeals(CONTACT);

    expect(deals.map((d) => d.companyName)).toEqual(['Beta', 'Smith & Co', 'Zulu']);
  });

  it('returns deals only — there are no suggestions to confirm', async () => {
    const result = await makeService().listContactDeals(CONTACT);

    expect(Object.keys(result)).toEqual(['deals']);
    const service = makeService() as unknown as Record<string, unknown>;
    expect(service.confirmSuggestion).toBeUndefined();
    expect(service.dismissSuggestion).toBeUndefined();
  });
});

describe('DealContactService.addLink', () => {
  it('rejects an unknown role', async () => {
    await expect(makeService().addLink(CONTACT, COMPANY, 'banker', 'u1')).rejects.toBeInstanceOf(
      InvalidDealContactRoleError,
    );
    expect(mocks.upsertLink).not.toHaveBeenCalled();
  });

  it('rejects a company outside the workspace', async () => {
    mocks.findCompany.mockResolvedValueOnce(null);
    await expect(makeService().addLink(CONTACT, COMPANY, 'source', 'u1')).rejects.toBeInstanceOf(
      DealCompanyNotFoundError,
    );
  });

  it('writes an active manual link, which reactivates a dismissed row (manual wins)', async () => {
    mocks.upsertLink.mockResolvedValueOnce(record({ role: 'source', origin: 'manual' }));

    const state = await makeService().addLink(CONTACT, COMPANY, 'source', 'u1');

    expect(mocks.upsertLink).toHaveBeenCalledWith({
      workspaceId: 'w1',
      companyId: COMPANY,
      correspondentId: CONTACT,
      role: 'source',
      origin: 'manual',
      status: 'active',
      createdBy: 'u1',
    });
    expect(state).toEqual({
      companyId: COMPANY,
      correspondentId: CONTACT,
      role: 'source',
      origin: 'manual',
      status: 'active',
    });
  });
});

describe('DealContactService.removeLink', () => {
  it('dismisses the link instead of deleting it', async () => {
    mocks.setStatus.mockResolvedValueOnce(record({ status: 'dismissed' }));

    const state = await makeService().removeLink(CONTACT, COMPANY);

    expect(mocks.setStatus).toHaveBeenCalledWith('w1', COMPANY, CONTACT, 'dismissed');
    expect(state.status).toBe('dismissed');
  });

  it('throws DealContactLinkNotFoundError when there is no link', async () => {
    mocks.setStatus.mockResolvedValueOnce(undefined);
    await expect(makeService().removeLink(CONTACT, COMPANY)).rejects.toBeInstanceOf(
      DealContactLinkNotFoundError,
    );
  });
});

describe('DealContactService.linkFromSmartFile', () => {
  it('writes the file links set-based, excluding our own domains', async () => {
    mocks.insertFileSourceLinks.mockResolvedValueOnce([
      { companyId: 'created', correspondentId: CONTACT, role: 'source' },
      { companyId: 'matched', correspondentId: CONTACT, role: 'involved' },
    ]);

    const links = await makeService().linkFromSmartFile('f1');

    expect(mocks.insertFileSourceLinks).toHaveBeenCalledWith('w1', {
      fileIds: ['f1'],
      excludedSenderDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: SMART_FILE_LINK_RECONCILE_LIMIT,
    });
    expect(INTERNAL_MAIL_DOMAINS.size).toBeGreaterThan(0);
    // The auto-created company is a `source` link, the matched one `involved`.
    expect(links).toEqual([
      { companyId: 'created', correspondentId: CONTACT, role: 'source' },
      { companyId: 'matched', correspondentId: CONTACT, role: 'involved' },
    ]);
    // Auto never upserts: existing rows (a dismissed one included) are left alone.
    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});

describe('DealContactService.reconcileSmartFileLinks', () => {
  it('scans the whole workspace when no contacts are given', async () => {
    await makeService().reconcileSmartFileLinks();
    expect(mocks.insertFileSourceLinks).toHaveBeenCalledWith('w1', {
      excludedSenderDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: SMART_FILE_LINK_RECONCILE_LIMIT,
    });
  });

  it('narrows to distinct contact ids, and skips the DB for an empty list', async () => {
    await makeService().reconcileSmartFileLinks({ correspondentIds: ['c1', 'c1', 'c2'] });
    expect(mocks.insertFileSourceLinks).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ correspondentIds: ['c1', 'c2'] }),
    );

    mocks.insertFileSourceLinks.mockClear();
    await expect(makeService().reconcileSmartFileLinks({ correspondentIds: [] })).resolves.toEqual([]);
    expect(mocks.insertFileSourceLinks).not.toHaveBeenCalled();
  });

  it('resolves a link for a contact that appeared after the file', async () => {
    // First pass: the sender has no contact yet, so nothing can be written.
    mocks.insertFileSourceLinks.mockResolvedValueOnce([]);
    await expect(makeService().linkFromSmartFile('f1')).resolves.toEqual([]);

    // The contact now exists; the reconcile run for it writes the link.
    mocks.insertFileSourceLinks.mockResolvedValueOnce([
      { companyId: COMPANY, correspondentId: CONTACT, role: 'source' },
    ]);
    mocks.listForContacts.mockResolvedValueOnce([linkRow({ role: 'source' })]);

    const { deals } = await makeService().listContactDeals(CONTACT);

    expect(mocks.insertFileSourceLinks).toHaveBeenLastCalledWith(
      'w1',
      expect.objectContaining({ correspondentIds: [CONTACT] }),
    );
    expect(deals.map((d) => d.role)).toEqual(['source']);
  });
});

describe('DealContactService.linkEmailMentions', () => {
  it('links the whole workspace when no scope is given, excluding our own domains', async () => {
    mocks.insertEmailMentionLinks.mockResolvedValueOnce([
      { companyId: COMPANY, correspondentId: CONTACT },
    ]);

    const links = await makeService().linkEmailMentions();

    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledWith('w1', {
      excludedDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: EMAIL_MENTION_LINK_LIMIT,
    });
    expect(links).toEqual([{ companyId: COMPANY, correspondentId: CONTACT }]);
    // Auto never upserts: existing rows (a dismissed one included) are left alone.
    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('narrows to distinct contact ids, and skips the DB for an empty list', async () => {
    await makeService().linkEmailMentions({ correspondentIds: ['c1', 'c1', 'c2'] });
    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ correspondentIds: ['c1', 'c2'] }),
    );

    mocks.insertEmailMentionLinks.mockClear();
    await expect(makeService().linkEmailMentions({ correspondentIds: [] })).resolves.toEqual([]);
    expect(mocks.insertEmailMentionLinks).not.toHaveBeenCalled();
  });

  it('passes since as an ISO timestamp, for every contact', async () => {
    await makeService().linkEmailMentions({ since: '2026-10-25T07:00:00+07:00' });

    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledWith('w1', {
      since: '2026-10-25T00:00:00.000Z',
      excludedDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: EMAIL_MENTION_LINK_LIMIT,
    });
  });

  it('rejects an unparseable since without querying', async () => {
    await expect(makeService().linkEmailMentions({ since: 'yesterday-ish' })).rejects.toBeInstanceOf(
      InvalidEmailMentionSinceError,
    );
    expect(mocks.insertEmailMentionLinks).not.toHaveBeenCalled();
  });
});

describe('DealContactService.linkEmailMentionsSince', () => {
  it('returns the number of links written since the given time', async () => {
    mocks.insertEmailMentionLinks.mockResolvedValueOnce([
      { companyId: 'a', correspondentId: 'c1' },
      { companyId: 'b', correspondentId: 'c2' },
    ]);

    await expect(makeService().linkEmailMentionsSince('2026-10-25T00:00:00Z')).resolves.toBe(2);
    expect(mocks.insertEmailMentionLinks).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ since: '2026-10-25T00:00:00.000Z' }),
    );
    expect(mocks.insertEmailMentionLinks.mock.calls[0][1]).not.toHaveProperty('correspondentIds');
  });

  it('logs a failure and returns null instead of throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.insertEmailMentionLinks.mockRejectedValueOnce(new Error('db down'));

    await expect(makeService().linkEmailMentionsSince('2026-10-25T00:00:00Z')).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
