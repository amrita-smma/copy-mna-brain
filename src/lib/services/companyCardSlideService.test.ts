import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompanyCardSlideService,
  CompanyNotFoundForCardError,
} from './companyCardSlideService';
import type { CompanyService } from './companyService';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { InvestmentThesisService } from './investmentThesisService';
import type { TrackVariableService } from './trackVariableService';
import type { WorkspaceService } from './workspaceService';
import type { PptxSlide, PptxText } from '@/lib/pptx/pptxElements';

/** All text on a slide, joined — the element-level equivalent of "the HTML". */
const slideText = (slide: PptxSlide): string =>
  slide.elements
    .filter((e): e is PptxText => e.type === 'text')
    .map((t) => t.text)
    .join('\n');

const findText = (slide: PptxSlide, needle: string): PptxText | undefined =>
  slide.elements
    .filter((e): e is PptxText => e.type === 'text')
    .find((t) => t.text.includes(needle));

const findByIdDTO = vi.fn();
const findByNameFuzzy = vi.fn();
const findByCompanyId = vi.fn();
const listTracks = vi.fn();
const findAllVariables = vi.fn();
const getDefaultCurrency = vi.fn();

const company = {
  id: 'c1',
  target: 'Acme Chemicals',
  project_name: 'London B',
  segment: 'Mining Solutions',
  geography: 'Indonesia',
  pipeline_stage: 'L1',
  deal_type: 'minority',
  stake: null,
  deal_size: null,
  ev_2024: 1250,
  ownership: 'Carve-out',
  banker: 'Citibank',
  entered_by_name: 'Nico',
  advisor: null,
  is_live: null,
  nbo_date: null,
  source: 'inbound',
  deal_sponsor_name: null,
  deal_captain_name: null,
  matched_track_ids: ['t1'],
  track_specific_variables: { t1: { v1: '92' } },
  slide_track_variable_ids: ['v1'],
  financials_raw: [],
};

function makeService(): CompanyCardSlideService {
  return new CompanyCardSlideService(
    { findByIdDTO, findByNameFuzzy } as unknown as CompanyService,
    { findByCompanyId } as unknown as CompanyAnalysisService,
    { list: listTracks } as unknown as InvestmentThesisService,
    { findAll: findAllVariables } as unknown as TrackVariableService,
    { getDefaultCurrency } as unknown as WorkspaceService,
    'ws-1',
  );
}

beforeEach(() => {
  findByIdDTO.mockReset().mockResolvedValue(company);
  findByNameFuzzy.mockReset().mockResolvedValue({ id: 'c1' });
  findByCompanyId.mockReset().mockResolvedValue({
    business_overview: '- **Primary Products**: Flotation reagents.',
    investment_highlights: null,
    business_model_summary: null,
    investment_risks: null,
    diligence_priorities: null,
  });
  listTracks.mockReset().mockResolvedValue([{ id: 't1', title: 'Chemicals', content: '', pic: 'Dicki Sujadi' }]);
  findAllVariables
    .mockReset()
    .mockResolvedValue([{ id: 'v1', track_id: 't1', name: 'Recovery rate', unit: '%' }]);
  getDefaultCurrency.mockReset().mockResolvedValue('IDR');
});

describe('CompanyCardSlideService.buildById', () => {
  it('renders the card with the workspace currency and the company display title', async () => {
    const deck = await makeService().buildById('c1');

    expect(deck.title).toBe('Acme Chemicals [Project London B]');
    expect(deck.slides.length).toBeGreaterThan(0);
    expect(slideText(deck.slides[0])).toContain('Indicative Financials (IDR m)');
    expect(slideText(deck.slides[0])).toContain('Flotation reagents');
    expect(getDefaultCurrency).toHaveBeenCalledWith('ws-1');
  });

  it('falls back to the matched track PIC for the deal lead', async () => {
    const deck = await makeService().buildById('c1');
    expect(slideText(deck.slides[0])).toContain('Deal Sponsor: Dicki Sujadi');
  });

  it('pairs surfaced track variables with their definitions and stored values', async () => {
    const deck = await makeService().buildById('c1');
    expect(slideText(deck.slides[0])).toContain('Recovery rate (%): 92');
  });

  it('does not hit the track-variable table when nothing was surfaced', async () => {
    findByIdDTO.mockResolvedValue({ ...company, slide_track_variable_ids: [] });
    await makeService().buildById('c1');
    expect(findAllVariables).not.toHaveBeenCalled();
  });

  it('renders placeholders when the company has no AI card yet', async () => {
    findByCompanyId.mockResolvedValue(null);
    const deck = await makeService().buildById('c1');
    expect(slideText(deck.slides[0])).toContain('Target overview will appear here');
  });
});

describe('CompanyCardSlideService — "Open in Brain" link', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('links to the pipeline page under the localhost fallback when no app URL env var is set', async () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXTAUTH_URL;
    const deck = await makeService().buildById('c1');
    const link = findText(deck.slides[0], 'Open in Brain');
    expect(link?.hyperlink).toEqual({
      url: 'http://localhost:3000/pipeline/c1',
      tooltip: 'Open in Brain',
    });
  });

  it('builds the link from APP_URL when set, stripping a trailing slash', async () => {
    process.env.APP_URL = 'https://mna.sqe.co.id/';
    const deck = await makeService().buildById('c1');
    const link = findText(deck.slides[0], 'Open in Brain');
    expect(link?.hyperlink?.url).toBe('https://mna.sqe.co.id/pipeline/c1');
  });
});

describe('CompanyCardSlideService.buildByName', () => {
  it('resolves the company by fuzzy name then builds by id', async () => {
    const deck = await makeService().buildByName('  Acme  ');
    expect(findByNameFuzzy).toHaveBeenCalledWith('Acme');
    expect(findByIdDTO).toHaveBeenCalledWith('c1');
    expect(deck.title).toBe('Acme Chemicals [Project London B]');
  });

  it('throws CompanyNotFoundForCardError when the name does not resolve', async () => {
    findByNameFuzzy.mockResolvedValue(null);
    await expect(makeService().buildByName('Nope')).rejects.toBeInstanceOf(
      CompanyNotFoundForCardError,
    );
    expect(findByIdDTO).not.toHaveBeenCalled();
  });

  it('does not query at all for a blank name', async () => {
    await expect(makeService().buildByName('   ')).rejects.toBeInstanceOf(
      CompanyNotFoundForCardError,
    );
    expect(findByNameFuzzy).not.toHaveBeenCalled();
  });
});

describe('CompanyCardSlideService.buildById — workspace stages', () => {
  function makeServiceWithStages(list: ReturnType<typeof vi.fn>) {
    return new CompanyCardSlideService(
      { findByIdDTO, findByNameFuzzy } as unknown as CompanyService,
      { findByCompanyId } as unknown as CompanyAnalysisService,
      { list: listTracks } as unknown as InvestmentThesisService,
      { findAll: findAllVariables } as unknown as TrackVariableService,
      { getDefaultCurrency } as unknown as WorkspaceService,
      'ws-1',
      { list } as never,
    );
  }

  const stageRow = (key: string, code: string, position: number, deleted = false) => ({
    key,
    code,
    name: key,
    description: '',
    position,
    deleted_at: deleted ? '2026-10-01T00:00:00Z' : null,
  });

  it("draws the workspace's live stages and labels an added stage after L3 as Deal Captain", async () => {
    const list = vi.fn().mockResolvedValue([
      stageRow('L0', 'L0', 0),
      stageRow('L2', 'L2', 2, true),
      stageRow('L3', 'L3', 3),
      stageRow('stg-post', 'L6', 4),
    ]);
    findByIdDTO.mockResolvedValue({ ...company, pipeline_stage: 'stg-post', deal_sponsor_name: 'Sam Sponsor' });

    const deck = await makeServiceWithStages(list).buildById('c1');
    const [slide] = deck.slides;

    expect(findText(slide, 'L6')?.color).toBe('FFFFFF');
    expect(findText(slide, 'L2')).toBeUndefined();
    expect(slideText(slide)).toContain('Deal Captain: Sam Sponsor');
  });

  it('reads the stage list once when building several cards', async () => {
    const list = vi.fn().mockResolvedValue([stageRow('L0', 'L0', 0), stageRow('L1', 'L1', 1)]);
    const service = makeServiceWithStages(list);

    await service.buildById('c1');
    await service.buildById('c1');

    expect(list).toHaveBeenCalledTimes(1);
  });
});
