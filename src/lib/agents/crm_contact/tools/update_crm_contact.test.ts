import { afterEach, describe, expect, it, vi } from 'vitest';

const findCorrespondentById = vi.fn();
const updateContact = vi.fn();

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({ crmService: { updateContact } })),
}));
vi.mock('@/lib/repositories', () => ({
  CorrespondentRepository: function CorrespondentRepository() {
    return { findById: findCorrespondentById };
  },
}));

import { isNameCorrection, updateCrmContact, updateCrmContactSchema } from './update_crm_contact';

const EMPTY_CONTACT = {
  id: 'corr-1',
  name: 'Jane Doe',
  email: 'jane@evercore.com',
  title: null,
  phone: null,
  type: null,
  department: null,
  specialization: null,
  seniority: null,
  coverage_region: null,
  linkedin_url: null,
  bio: null,
};

const SOURCES = ['https://evercore.com/team/jane-doe'];

afterEach(() => vi.clearAllMocks());

describe('updateCrmContact', () => {
  it('writes empty fields through CRMService, which routes them to the overlay', async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);
    updateContact.mockResolvedValue({});

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      department: 'M&A',
      sources: SOURCES,
    })) as string;

    expect(updateContact).toHaveBeenCalledWith('corr-1', {
      title: 'Managing Director',
      department: 'M&A',
    });
    expect(result).toContain('2 field(s) written to the CRM overlay');
    expect(result).toContain('title = "Managing Director"');
  });

  it("stamps the edit with the run's owner so the CRM can show who changed it", async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);
    updateContact.mockResolvedValue({});

    await updateCrmContact.invoke(
      { correspondent_id: 'corr-1', title: 'Managing Director', sources: SOURCES },
      { configurable: { triggered_by_user_id: 'user-7' } },
    );

    expect(updateContact).toHaveBeenCalledWith('corr-1', {
      title: 'Managing Director',
      last_edited_by_user_id: 'user-7',
    });
  });

  it('leaves the stamp alone on an ownerless run rather than clearing it', async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);
    updateContact.mockResolvedValue({});

    await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      sources: SOURCES,
    });

    expect(updateContact).toHaveBeenCalledWith('corr-1', {
      title: 'Managing Director',
    });
  });

  it('skips a field that already holds a value instead of flattening it', async () => {
    findCorrespondentById.mockResolvedValue({
      ...EMPTY_CONTACT,
      title: 'Director',
    });
    updateContact.mockResolvedValue({});

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      department: 'M&A',
      sources: SOURCES,
    })) as string;

    expect(updateContact).toHaveBeenCalledWith('corr-1', { department: 'M&A' });
    expect(result).toContain('Skipped:');
    expect(result).toContain('title — already "Director"');
  });

  it('replaces a filled field only when the model named it in overwrite', async () => {
    findCorrespondentById.mockResolvedValue({
      ...EMPTY_CONTACT,
      title: 'Director',
    });
    updateContact.mockResolvedValue({});

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      sources: SOURCES,
      overwrite: ['title'],
    })) as string;

    expect(updateContact).toHaveBeenCalledWith('corr-1', {
      title: 'Managing Director',
    });
    expect(result).toContain('Overwrote:');
    expect(result).toContain('title: "Director" → "Managing Director"');
  });

  it('writes nothing when every proposed field is already filled', async () => {
    findCorrespondentById.mockResolvedValue({
      ...EMPTY_CONTACT,
      title: 'Director',
    });

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      sources: SOURCES,
    })) as string;

    expect(updateContact).not.toHaveBeenCalled();
    expect(result).toContain('**Nothing written.**');
  });

  it('refuses a call that proposes no field at all', async () => {
    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      sources: SOURCES,
    })) as string;

    expect(result).toContain('**Nothing to write.**');
    expect(findCorrespondentById).not.toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('writes nothing when the contact is not visible in this workspace', async () => {
    findCorrespondentById.mockResolvedValue(undefined);

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      sources: SOURCES,
    })) as string;

    expect(result).toContain('Nothing was written');
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('reports a write failure as a string rather than throwing into the agent', async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);
    updateContact.mockRejectedValue(new Error('db down'));

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      title: 'Managing Director',
      sources: SOURCES,
    })) as string;

    expect(result).toContain('**Error:** db down — nothing was written.');
  });
});

describe('updateCrmContact — name', () => {
  it('completes a partial name for the same person, routed to the overlay', async () => {
    findCorrespondentById.mockResolvedValue({ ...EMPTY_CONTACT, name: 'Jane' });
    updateContact.mockResolvedValue({});

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      name: 'Jane Doe',
      sources: SOURCES,
    })) as string;

    expect(updateContact).toHaveBeenCalledWith('corr-1', { name: 'Jane Doe' });
    expect(result).toContain('name: "Jane" → "Jane Doe"');
  });

  it('writes the name alongside profile fields in one call', async () => {
    findCorrespondentById.mockResolvedValue({ ...EMPTY_CONTACT, name: 'J. Doe' });
    updateContact.mockResolvedValue({});

    await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      name: 'Jane Doe',
      phone: '+62 811 000 000',
      sources: SOURCES,
    });

    expect(updateContact).toHaveBeenCalledWith('corr-1', {
      name: 'Jane Doe',
      phone: '+62 811 000 000',
    });
  });

  it('refuses a rename to a different person and writes nothing', async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      name: 'John Smith',
      sources: SOURCES,
    })) as string;

    expect(updateContact).not.toHaveBeenCalled();
    expect(result).toContain('**Nothing written.**');
    expect(result).toContain('reads as a different person');
  });

  it('treats an unchanged name as nothing to write', async () => {
    findCorrespondentById.mockResolvedValue(EMPTY_CONTACT);

    const result = (await updateCrmContact.invoke({
      correspondent_id: 'corr-1',
      name: 'Jane Doe',
      sources: SOURCES,
    })) as string;

    expect(updateContact).not.toHaveBeenCalled();
    expect(result).toContain('**Nothing written.**');
  });
});

describe('isNameCorrection', () => {
  it('accepts a fuller or re-spelled form that shares a word', () => {
    expect(isNameCorrection('Jane', 'Jane Doe', null)).toBe(true);
    expect(isNameCorrection('J. Doe', 'Jane Doe', null)).toBe(true);
    expect(isNameCorrection('José Ramírez', 'Jose Ramirez Garcia', null)).toBe(true);
  });

  it('accepts any name when the stored one is only the email or its local part', () => {
    expect(isNameCorrection('jdoe', 'Jane Doe', 'jdoe@evercore.com')).toBe(true);
    expect(isNameCorrection('jdoe@evercore.com', 'Jane Doe', 'jdoe@evercore.com')).toBe(true);
  });

  it('rejects a name that shares no word with the one on file', () => {
    expect(isNameCorrection('Jane Doe', 'John Smith', 'jane@evercore.com')).toBe(false);
    expect(isNameCorrection('J. D.', 'Jane Doe', null)).toBe(false);
  });
});

describe('updateCrmContactSchema', () => {
  it('requires at least one source — a value with no provenance cannot be written', () => {
    expect(
      updateCrmContactSchema.safeParse({
        correspondent_id: 'corr-1',
        title: 'MD',
        sources: [],
      }).success,
    ).toBe(false);
  });

  it('strips email outright, so a stray key cannot reach the DB', () => {
    const parsed = updateCrmContactSchema.parse({
      correspondent_id: 'corr-1',
      title: 'MD',
      email: 'someone@else.com',
      sources: SOURCES,
    }) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty('email');
  });

  it('rejects a LinkedIn value that is not a URL', () => {
    expect(
      updateCrmContactSchema.safeParse({
        correspondent_id: 'corr-1',
        linkedin_url: 'jane-doe',
        sources: SOURCES,
      }).success,
    ).toBe(false);
  });

  it('only allows writable fields in overwrite', () => {
    expect(
      updateCrmContactSchema.safeParse({
        correspondent_id: 'corr-1',
        title: 'MD',
        sources: SOURCES,
        overwrite: ['email'],
      }).success,
    ).toBe(false);
  });
});
