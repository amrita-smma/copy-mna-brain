import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyNotFoundForCardError } from '@/lib/services/companyCardSlideService';

const { createContainer, exportElementsToPptx, buildByName, buildById } = vi.hoisted(() => ({
  createContainer: vi.fn(),
  exportElementsToPptx: vi.fn(),
  buildByName: vi.fn(),
  buildById: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer }));
vi.mock('@/lib/pptx/writePptx', () => ({ exportElementsToPptx }));

import { buildCompanyCardAttachment } from './emailArtifacts';

const slide = (title: string) => ({ title, elements: [] });

beforeEach(() => {
  buildByName.mockReset();
  buildById.mockReset();
  exportElementsToPptx.mockReset().mockResolvedValue(Buffer.from('PK-fake-pptx'));
  createContainer.mockReset().mockReturnValue({
    companyCardSlideService: { buildByName, buildById },
  });
});

describe('buildCompanyCardAttachment', () => {
  it('renders one card per company into a single deck, in the requested order', async () => {
    buildByName
      .mockResolvedValueOnce({
        companyId: 'c1',
        title: 'Acme',
        slides: [slide('Acme — Company Card')],
      })
      .mockResolvedValueOnce({
        companyId: 'c2',
        title: 'Beta',
        slides: [slide('Beta — Company Card'), slide('Beta — Company Card (cont. 1)')],
      });

    const artifact = await buildCompanyCardAttachment({ company_names: ['Acme', 'Beta'] });

    expect(artifact).not.toBeNull();
    expect(artifact!.companyTitles).toEqual(['Acme', 'Beta']);
    expect(artifact!.slideCount).toBe(3);
    expect(exportElementsToPptx.mock.calls[0][0].map((s: { title: string }) => s.title)).toEqual([
      'Acme — Company Card',
      'Beta — Company Card',
      'Beta — Company Card (cont. 1)',
    ]);
    expect(artifact!.attachment.contentType).toMatch(/presentationml/);
    expect(artifact!.attachment.content.toString()).toBe('PK-fake-pptx');
    expect(artifact!.notes).toEqual([]);
  });

  it('names the file after the single company when no title is given', async () => {
    buildByName.mockResolvedValue({
      companyId: 'c1',
      title: 'Acme Chemicals [Project London B]',
      slides: [slide('x')],
    });
    const artifact = await buildCompanyCardAttachment({ company_names: ['Acme'] });
    expect(artifact!.title).toBe('Acme Chemicals [Project London B] — Company Card');
    expect(artifact!.attachment.filename).toBe('acme-chemicals-project-london-b-company-card.pptx');
  });

  it('uses an explicit title for the filename when provided', async () => {
    buildByName.mockResolvedValue({ companyId: 'c1', title: 'Acme', slides: [slide('x')] });
    const artifact = await buildCompanyCardAttachment({
      company_names: ['Acme'],
      title: 'Q3 Pipeline Review',
    });
    expect(artifact!.attachment.filename).toBe('q3-pipeline-review.pptx');
  });

  it('skips names that do not resolve and reports them as a note', async () => {
    buildByName
      .mockRejectedValueOnce(new CompanyNotFoundForCardError('Ghost Co'))
      .mockResolvedValueOnce({ companyId: 'c1', title: 'Acme', slides: [slide('x')] });

    const artifact = await buildCompanyCardAttachment({
      company_names: ['Ghost Co', 'Acme'],
    });

    expect(artifact!.companyTitles).toEqual(['Acme']);
    expect(artifact!.notes).toEqual([
      'Could not resolve company for the Company Card deck: Ghost Co.',
    ]);
  });

  it('returns null without rendering a deck when nothing resolves', async () => {
    buildByName.mockRejectedValue(new CompanyNotFoundForCardError('Ghost Co'));
    const artifact = await buildCompanyCardAttachment({ company_names: ['Ghost Co'] });
    expect(artifact).toBeNull();
    expect(exportElementsToPptx).not.toHaveBeenCalled();
  });

  it('propagates unexpected errors instead of silently skipping the company', async () => {
    buildByName.mockRejectedValue(new Error('db down'));
    await expect(buildCompanyCardAttachment({ company_names: ['Acme'] })).rejects.toThrow(
      'db down',
    );
  });

  // company_ids is the handoff from query_companies: exact, no fuzzy matching.
  it('renders cards addressed by company_ids, in the requested order', async () => {
    buildById
      .mockResolvedValueOnce({ companyId: 'c1', title: 'Acme', slides: [slide('a')] })
      .mockResolvedValueOnce({ companyId: 'c2', title: 'Beta', slides: [slide('b')] });

    const artifact = await buildCompanyCardAttachment({ company_ids: ['c1', 'c2'] });

    expect(buildById.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    expect(artifact!.companyTitles).toEqual(['Acme', 'Beta']);
    expect(buildByName).not.toHaveBeenCalled();
  });

  it('renders ids first, then names, deduplicating a company named both ways', async () => {
    buildById.mockResolvedValue({ companyId: 'c1', title: 'Acme', slides: [slide('a')] });
    buildByName.mockResolvedValue({ companyId: 'c1', title: 'Acme', slides: [slide('a')] });

    const artifact = await buildCompanyCardAttachment({
      company_ids: ['c1'],
      company_names: ['Acme'],
    });

    expect(artifact!.companyTitles).toEqual(['Acme']);
    expect(artifact!.slideCount).toBe(1);
  });

  it('reports an unknown id as unresolved instead of failing the whole deck', async () => {
    buildById
      .mockRejectedValueOnce(new Error('Company c-missing not found'))
      .mockResolvedValueOnce({ companyId: 'c1', title: 'Acme', slides: [slide('a')] });

    const artifact = await buildCompanyCardAttachment({
      company_ids: ['c-missing', 'c1'],
    });

    expect(artifact!.companyTitles).toEqual(['Acme']);
    expect(artifact!.notes).toEqual([
      'Could not resolve company for the Company Card deck: c-missing.',
    ]);
  });

  it('propagates a render failure on an id rather than calling it unresolved', async () => {
    buildById.mockRejectedValue(new Error('pptx renderer exploded'));

    await expect(buildCompanyCardAttachment({ company_ids: ['c1'] })).rejects.toThrow(
      'pptx renderer exploded',
    );
  });

  it('rejects a spec with neither ids nor names', async () => {
    await expect(buildCompanyCardAttachment({})).rejects.toThrow(/company_ids/);
  });

  // Titles are not unique: two records can share a name, and an unnamed one
  // falls back to a placeholder. Deduping on title would drop the second card.
  it('keeps distinct companies that happen to share a display title', async () => {
    buildById
      .mockResolvedValueOnce({ companyId: 'c1', title: 'Company', slides: [slide('a')] })
      .mockResolvedValueOnce({ companyId: 'c2', title: 'Company', slides: [slide('b')] });

    const artifact = await buildCompanyCardAttachment({ company_ids: ['c1', 'c2'] });

    expect(artifact!.slideCount).toBe(2);
    expect(artifact!.companyTitles).toEqual(['Company', 'Company']);
  });
});
