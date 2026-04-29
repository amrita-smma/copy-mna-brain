import { afterEach, describe, expect, it, vi } from 'vitest';

const dealNoteInsertMock = vi.fn();
const findNotesByIdMock = vi.fn();
const updateNotesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  DealNoteRepository: function DealNoteRepository() {
    return { insert: dealNoteInsertMock };
  },
  PastAcquisitionRepository: function PastAcquisitionRepository() {
    return { findNotesById: findNotesByIdMock, updateNotes: updateNotesMock };
  },
}));

import { addCompanyNoteTool } from './add_company_note';

afterEach(() => vi.clearAllMocks());

describe('addCompanyNoteTool', () => {
  it('inserts a deal_note for company-typed records', async () => {
    dealNoteInsertMock.mockResolvedValue(undefined);

    const result = (await addCompanyNoteTool.invoke({
      id: 'company-1',
      type: 'company',
      content: 'Met with founder',
      stage: 'L1',
    })) as string;

    expect(dealNoteInsertMock).toHaveBeenCalledWith({
      deal_id: 'company-1',
      content: 'Met with founder',
      stage: 'L1',
    });
    expect(result).toBe('Successfully added note to company company-1');
  });

  it('defaults the stage to "File" when not provided', async () => {
    dealNoteInsertMock.mockResolvedValue(undefined);

    await addCompanyNoteTool.invoke({
      id: 'company-1',
      type: 'company',
      content: 'Note',
    });

    expect(dealNoteInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'File' }),
    );
  });

  it('appends to existing notes for past acquisitions', async () => {
    findNotesByIdMock.mockResolvedValue('Existing note');
    updateNotesMock.mockResolvedValue(undefined);

    await addCompanyNoteTool.invoke({
      id: 'pa-1',
      type: 'past_acquisition',
      content: 'New observation',
    });

    expect(updateNotesMock).toHaveBeenCalledWith('pa-1', 'Existing note\n---\nNew observation');
  });

  it('writes the note as-is when there are no existing notes', async () => {
    findNotesByIdMock.mockResolvedValue(null);
    updateNotesMock.mockResolvedValue(undefined);

    await addCompanyNoteTool.invoke({
      id: 'pa-2',
      type: 'past_acquisition',
      content: 'First note',
    });

    expect(updateNotesMock).toHaveBeenCalledWith('pa-2', 'First note');
  });

  it('returns a formatted error when the repository call throws', async () => {
    dealNoteInsertMock.mockRejectedValue(new Error('db down'));

    const result = (await addCompanyNoteTool.invoke({
      id: 'company-x',
      type: 'company',
      content: 'note',
    })) as string;

    expect(result).toContain('Error adding note: db down');
  });
});
