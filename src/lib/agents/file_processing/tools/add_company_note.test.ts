import { afterEach, describe, expect, it, vi } from 'vitest';

const dealNoteInsertMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  DealNoteRepository: function DealNoteRepository() {
    return { insert: dealNoteInsertMock };
  },
}));

import { addCompanyNoteTool } from './add_company_note';

afterEach(() => vi.clearAllMocks());

describe('addCompanyNoteTool', () => {
  it('inserts a deal_note for the company', async () => {
    dealNoteInsertMock.mockResolvedValue(undefined);

    const result = (await addCompanyNoteTool.invoke({
      id: 'company-1',
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
      content: 'Note',
    });

    expect(dealNoteInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'File' }),
    );
  });

  it('returns a formatted error when the repository call throws', async () => {
    dealNoteInsertMock.mockRejectedValue(new Error('db down'));

    const result = (await addCompanyNoteTool.invoke({
      id: 'company-x',
      content: 'note',
    })) as string;

    expect(result).toContain('Error adding note: db down');
  });
});
