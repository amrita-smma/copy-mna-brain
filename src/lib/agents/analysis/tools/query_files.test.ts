import { afterEach, describe, expect, it, vi } from 'vitest';

const searchForAgentMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  FileRepository: function FileRepository() {
    return { searchForAgent: searchForAgentMock };
  },
}));

import { formatNotesResults, queryMeetingNotes } from './query_files';

afterEach(() => vi.clearAllMocks());

describe('queryMeetingNotes', () => {
  it('returns the empty-state message when no files match', async () => {
    searchForAgentMock.mockResolvedValue([]);

    const result = (await queryMeetingNotes.invoke({ company_name: 'Acme' })) as string;

    expect(result).toBe('No files found matching your criteria.');
    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyName: 'Acme', limit: 10 }),
    );
  });

  it('renders matching files with metadata', async () => {
    searchForAgentMock.mockResolvedValue([
      {
        id: 'f1',
        file_name: 'Q1 Memo.pdf',
        file_link: 'uploads/q1.pdf',
        file_date: '2024-03-01',
        tags: ['M&A', 'Strategy'],
        structured_notes: { summary: 'Quarterly summary', key_points: ['p1', 'p2'] },
        raw_notes: null,
        matched_companies: [],
      },
    ]);

    const result = (await queryMeetingNotes.invoke({})) as string;

    expect(result).toContain('Files Results (1 records)');
    expect(result).toContain('Q1 Memo.pdf');
    expect(result).toContain('M&A, Strategy');
    expect(result).toContain('Quarterly summary');
    expect(result).toContain('FILES_JSON:');
  });
});

describe('formatNotesResults', () => {
  it('falls back to a raw_notes excerpt when structured notes are absent', () => {
    const longText = 'a'.repeat(250);
    const result = formatNotesResults([
      {
        id: 'f1',
        file_name: 'Notes.txt',
        file_link: 'uploads/n.txt',
        file_date: null,
        tags: [],
        structured_notes: null,
        raw_notes: longText,
        matched_companies: [],
      },
    ]);

    expect(result).toContain('Excerpt');
    expect(result).toContain('...');
  });
});
