import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generatePptxBuffer, findByNameFuzzy, findByCompanyId } = vi.hoisted(() => ({
  generatePptxBuffer: vi.fn(),
  findByNameFuzzy: vi.fn(),
  findByCompanyId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/pptx/generatePptxBuffer', () => ({ generatePptxBuffer }));
vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  return {
    ...actual,
    CompanyRepository: class {
      findByNameFuzzy = findByNameFuzzy;
    },
    CompanyAnalysisRepository: class {
      findByCompanyId = findByCompanyId;
    },
  };
});

// Avoid pulling excel/pdf heavy deps for this focused test — re-import only
// presentation builder after mocks.
import { buildPresentationAttachment } from './emailArtifacts';

describe('buildPresentationAttachment', () => {
  beforeEach(() => {
    generatePptxBuffer.mockReset();
    findByNameFuzzy.mockReset();
    findByCompanyId.mockReset();
    generatePptxBuffer.mockResolvedValue({
      buffer: Buffer.from('PK-fake-pptx'),
      removedPartNames: [],
    });
    findByNameFuzzy.mockResolvedValue(null);
  });

  it('calls generatePptxBuffer with a prompt containing title and brief', async () => {
    const artifact = await buildPresentationAttachment({
      title: 'Analyst Report',
      brief: 'Cover Mandiri vs BBCA.',
    });

    expect(generatePptxBuffer).toHaveBeenCalledTimes(1);
    const prompt = generatePptxBuffer.mock.calls[0][0] as string;
    expect(prompt).toContain('Analyst Report');
    expect(prompt).toContain('Cover Mandiri vs BBCA.');
    expect(artifact.attachment.filename).toMatch(/analyst-report\.pptx$/);
    expect(artifact.attachment.contentType).toMatch(/presentationml/);
    expect(artifact.attachment.content.toString()).toBe('PK-fake-pptx');
  });

  it('appends company context when company_names resolve', async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: 'c1',
      target: 'Bank Mandiri',
      segment: 'Banking',
    });
    findByCompanyId.mockResolvedValueOnce({
      business_overview: 'Large Indonesian bank',
    });

    const artifact = await buildPresentationAttachment({
      title: 'Banks',
      brief: 'Compare peers',
      company_names: ['Bank Mandiri'],
    });

    const prompt = generatePptxBuffer.mock.calls[0][0] as string;
    expect(prompt).toContain('Bank Mandiri');
    expect(prompt).toContain('Large Indonesian bank');
    expect(artifact.notes).toEqual([]);
  });

  it('notes unresolved company_names without failing the deck', async () => {
    findByNameFuzzy.mockResolvedValue(null);

    const artifact = await buildPresentationAttachment({
      title: 'Banks',
      brief: 'Compare peers',
      company_names: ['Missing Co'],
    });

    expect(artifact.notes.join(' ')).toMatch(/Could not resolve company.*Missing Co/);
    expect(generatePptxBuffer).toHaveBeenCalled();
  });
});
